export interface DesktopTurnIdentity {
  sessionId: string;
  turnId: string;
}

export interface CompletedDesktopTurn extends DesktopTurnIdentity {
  startedAt: number;
  completedAt: number;
}

export interface DesktopReplayBinding extends DesktopTurnIdentity {
  transcriptPath: string;
}

function readDesktopRollout(binding: DesktopReplayBinding, root: string) {
  let fd: number | undefined;
  try {
    const sessions = realpathSync(path.join(process.env.CODEX_HOME ?? path.join(homedir(), '.codex'), 'sessions'));
    const file = realpathSync(binding.transcriptPath);
    if (!file.startsWith(sessions + path.sep) || lstatSync(binding.transcriptPath).isSymbolicLink()
      || !path.basename(file).startsWith('rollout-') || !path.basename(file).endsWith(`-${binding.sessionId}.jsonl`)) return null;
    fd = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const stat = fstatSync(fd);
    if (!stat.isFile() || (process.getuid && stat.uid !== process.getuid()) || (stat.mode & 0o022) !== 0) return null;
    const head = Buffer.alloc(Math.min(stat.size, 64 * 1024));
    if (readSync(fd, head, 0, head.length, 0) !== head.length || head.indexOf(10) < 0) return null;
    const header = object(JSON.parse(head.subarray(0, head.indexOf(10)).toString('utf8')));
    const session = object(header?.payload);
    if (header?.type !== 'session_meta' || session?.id !== binding.sessionId || typeof session.cwd !== 'string'
      || realpathSync(session.cwd) !== root) return null;
    const offset = Math.max(0, stat.size - 8 * 1024 * 1024);
    const tail = Buffer.alloc(stat.size - offset);
    if (readSync(fd, tail, 0, tail.length, offset) !== tail.length || tail[tail.length - 1] !== 10) return null;
    const lines = tail.subarray(offset === 0 ? 0 : tail.indexOf(10) + 1, -1).toString('utf8').split('\n');
    if (lines.length > 16_384) return null;
    const entries: unknown[] = lines.map(line => JSON.parse(line));
    if (session.originator !== 'codex_work_desktop') return null;
    return { session, entries };
  } catch {
    return null;
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

export function readDesktopCheckpoint(binding: DesktopReplayBinding, root: string): string | undefined {
  const rollout = readDesktopRollout(binding, root);
  if (!rollout) return;
  const prepared = new Set<string>();
  let started = false;
  let verifiedWorktree = false;
  let checkpoint: string | undefined;
  for (const entry of rollout.entries) {
    const row = object(entry);
    const event = object(row?.payload);
    if (event?.turn_id !== binding.turnId) continue;
    if (row?.type === 'event_msg' && event.type === 'task_started') {
      if (started || event.root_turn_id !== binding.turnId) return;
      started = true;
    }
    if (!started) continue;
    if (row?.type === 'turn_context') {
      try {
        if (typeof event.cwd !== 'string' || realpathSync(event.cwd) !== root) return;
      } catch { return; }
      verifiedWorktree = true;
    }
    if (row?.type !== 'event_msg') continue;
    if (event.type === 'turn_aborted') return;
    if (event.type === 'task_complete') break;
    const item = object(event.item);
    if (event.type !== 'item_completed' || event.thread_id !== binding.sessionId
      || item?.type !== 'McpToolCall' || item.server !== 'kiokuko' || item.status !== 'completed') continue;
    const result = object(item.result);
    const run = object(object(result?.structuredContent)?.run);
    if (result?.isError === true || typeof run?.runId !== 'string') continue;
    if (item.tool === 'task_prepare') prepared.add(run.runId);
    if (item.tool === 'memory_checkpoint' && prepared.has(run.runId)
      && object(item.arguments)?.runId === run.runId && ['completed', 'failed'].includes(String(run.status))) {
      if (checkpoint !== undefined) return;
      checkpoint = run.runId;
    }
  }
  return verifiedWorktree ? checkpoint : undefined;
}

/** Returns only verified host data from the rollout named by the installed hook. */
export function readCompletedDesktopTurn(
  binding: DesktopReplayBinding, root: string,
): (CompletedDesktopTurn & { userTextDigests: string[] }) | null {
  const rollout = readDesktopRollout(binding, root);
  if (!rollout) return null;
  const { session, entries } = rollout;
  const turn = completedDesktopTurn(session, entries, binding);
  if (!turn) return null;
  try {
    const userTextDigests = new Set<string>();
    let insideTurn = false;
    let verifiedWorktree = false;
    for (const entry of entries) {
      const record = object(entry);
      const event = object(record?.payload);
      if (event?.turn_id !== binding.turnId) continue;
      if (record?.type === 'event_msg' && event.type === 'task_started') insideTurn = true;
      if (!insideTurn) continue;
      if (record?.type === 'turn_context') {
        if (typeof event.cwd !== 'string' || realpathSync(event.cwd) !== root) return null;
        verifiedWorktree = true;
      }
      if (record?.type !== 'event_msg') continue;
      if (event.type === 'task_complete') break;
      const item = object(event.item);
      if (event.type === 'item_completed' && event.thread_id === binding.sessionId
        && item?.type === 'UserMessage' && Array.isArray(item.content) && userTextDigests.size < 20) {
        const text = item.content.map(object).filter(part => part?.type === 'text')
          .map(part => typeof part?.text === 'string' ? part.text : '').join('\n');
        if (text) userTextDigests.add(createHash('sha256').update(text).digest('hex'));
      }
    }
    return verifiedWorktree ? { ...turn, userTextDigests: [...userTextDigests] } : null;
  } catch {
    return null;
  }
}

function object(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

/** A Stop hook can continue the turn. Only the host's terminal event establishes completion. */
export function completedDesktopTurn(
  session: unknown, entries: readonly unknown[], identity: DesktopTurnIdentity,
): CompletedDesktopTurn | null {
  const meta = object(session);
  if (meta?.originator !== 'codex_work_desktop' || meta.id !== identity.sessionId) return null;
  let startedAt: number | undefined;
  let completedAt: number | undefined;
  for (const entry of entries) {
    const record = object(entry);
    if (record?.type !== 'event_msg') continue;
    const event = object(record.payload);
    if (event?.turn_id !== identity.turnId) continue;
    if (event.type === 'turn_aborted') return null;
    if (event.type === 'task_started') {
      if (startedAt !== undefined || event.root_turn_id !== identity.turnId
        || typeof event.started_at !== 'number' || !Number.isSafeInteger(event.started_at)) return null;
      startedAt = event.started_at;
    }
    if (event.type === 'task_complete') {
      if (startedAt === undefined || completedAt !== undefined || event.root_turn_id !== identity.turnId
        || typeof event.completed_at !== 'number' || !Number.isSafeInteger(event.completed_at)
        || event.completed_at < startedAt) return null;
      completedAt = event.completed_at;
    }
  }
  return startedAt === undefined || completedAt === undefined ? null : {
    sessionId: identity.sessionId, turnId: identity.turnId, startedAt, completedAt,
  };
}
import { closeSync, constants, fstatSync, lstatSync, openSync, readSync, realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';

import { createHash } from 'node:crypto';
