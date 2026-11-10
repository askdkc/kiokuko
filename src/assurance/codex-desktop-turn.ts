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

const desktopOriginator = (value: unknown): boolean => value === 'codex_work_desktop' || value === 'Codex Desktop';

/** Codex Desktop appends a second host session ID when a chat is resumed. */
function desktopRolloutFilename(filename: string, sessionId: string): boolean {
  if (!/^[\w-]{1,128}$/u.test(sessionId) || !filename.startsWith('rollout-') || !filename.endsWith('.jsonl')) return false;
  const stem = filename.slice(0, -'.jsonl'.length);
  const sessionSuffix = `-${sessionId}`;
  if (stem.endsWith(sessionSuffix)) return true;
  const resumedMarker = `${sessionSuffix}_`;
  const markerAt = stem.lastIndexOf(resumedMarker);
  return markerAt >= 'rollout-'.length
    && /^[\w-]{1,128}$/u.test(stem.slice(markerAt + resumedMarker.length));
}

function readDesktopRollout(binding: DesktopReplayBinding, root: string, mode: 'header' | 'lifecycle' | 'subagent-lifecycle' | 'review' | 'checkpoint') {
  let fd: number | undefined;
  try {
    const sessions = realpathSync(path.join(process.env.CODEX_HOME ?? path.join(homedir(), '.codex'), 'sessions'));
    const file = realpathSync(binding.transcriptPath);
    if (!file.startsWith(sessions + path.sep) || lstatSync(binding.transcriptPath).isSymbolicLink()
      || !desktopRolloutFilename(path.basename(file), binding.sessionId)) return null;
    fd = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const stat = fstatSync(fd);
    if (!stat.isFile() || (process.getuid && stat.uid !== process.getuid()) || (stat.mode & 0o022) !== 0) return null;
    const head = Buffer.alloc(Math.min(stat.size, 64 * 1024));
    if (readSync(fd, head, 0, head.length, 0) !== head.length || head.indexOf(10) < 0) return null;
    const header = object(JSON.parse(head.subarray(0, head.indexOf(10)).toString('utf8')));
    const session = object(header?.payload);
    if (header?.type !== 'session_meta' || session?.id !== binding.sessionId || typeof session.cwd !== 'string'
      || realpathSync(session.cwd) !== root) return null;
    if (!desktopOriginator(session.originator)) return null;
    if (mode === 'header') return { session, entries: [] };
    let minimumOrdinal: number | undefined;
    // Codex rollout ordinals identify the copied parent prefix even when a child
    // has a referenced history_base; line numbers are not equivalent to ordinals.
    if (mode === 'subagent-lifecycle' && (session.history_mode === 'paginated'
      || session.forked_from_id != null || session.subagent_history_start_ordinal !== undefined)) {
      const boundary = session.subagent_history_start_ordinal;
      if (typeof boundary !== 'number' || !Number.isSafeInteger(boundary) || boundary < 0) return null;
      minimumOrdinal = boundary;
    }
    if (mode !== 'checkpoint') return { session, entries: readTurnEntries(fd, stat.size, binding.turnId, mode === 'review', minimumOrdinal) };
    const offset = Math.max(0, stat.size - 8 * 1024 * 1024);
    const tail = Buffer.alloc(stat.size - offset);
    if (readSync(fd, tail, 0, tail.length, offset) !== tail.length || tail[tail.length - 1] !== 10) return null;
    const lines = tail.subarray(offset === 0 ? 0 : tail.indexOf(10) + 1, -1).toString('utf8').split('\n');
    if (lines.length > 16_384) return null;
    const entries: unknown[] = lines.map(line => JSON.parse(line));
    if (!desktopOriginator(session.originator)) return null;
    return { session, entries };
  } catch {
    return null;
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

export function readDesktopCheckpoint(binding: DesktopReplayBinding, root: string): string | undefined {
  const rollout = readDesktopRollout(binding, root, 'checkpoint');
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
export function hasDesktopTranscript(binding: DesktopReplayBinding, root: string): boolean {
  return readDesktopRollout(binding, root, 'header') !== null;
}

export function readCompletedDesktopTurn(
  binding: DesktopReplayBinding, root: string,
): (CompletedDesktopTurn & { userTextDigests: string[] }) | null {
  const rollout = readDesktopRollout(binding, root, 'review');
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

/** Scan with bounded memory, retaining only this turn's lifecycle and optional user messages. */
function readTurnEntries(fd: number, size: number, turnId: string, includeUserMessages: boolean, minimumOrdinal?: number): unknown[] {
  if (size > 512 * 1024 * 1024) throw new Error('transcript_read_bound');
  const entries: unknown[] = [];
  const buffer = Buffer.alloc(64 * 1024);
  let parts: Buffer[] = [];
  let length = 0;
  let retainedBytes = 0;
  for (let offset = 0; offset < size;) {
    const count = readSync(fd, buffer, 0, Math.min(buffer.length, size - offset), offset);
    if (!count) throw new Error('transcript_changed');
    offset += count;
    let from = 0;
    for (let newline = buffer.subarray(0, count).indexOf(10, from); newline !== -1; newline = buffer.subarray(0, count).indexOf(10, from)) {
      const segment = buffer.subarray(from, newline);
      length += segment.length;
      if (length > 16 * 1024 * 1024) throw new Error('transcript_line_bound');
      const line = Buffer.concat([...parts, segment], length);
      const row = object(JSON.parse(line.toString('utf8')));
      const payload = object(row?.payload);
      if (payload?.turn_id === turnId && (row?.type === 'turn_context' || (row?.type === 'event_msg' &&
        (['task_started', 'task_complete', 'turn_aborted'].includes(String(payload.type))
          || (includeUserMessages && payload.type === 'item_completed' && object(payload.item)?.type === 'UserMessage'))))) {
        if (minimumOrdinal !== undefined && (typeof row.ordinal !== 'number'
          || !Number.isSafeInteger(row.ordinal) || row.ordinal < 0)) throw new Error('lifecycle_ordinal_missing');
        if (minimumOrdinal === undefined || (row.ordinal as number) >= minimumOrdinal) {
          retainedBytes += length;
          if (entries.length >= 4096 || retainedBytes > 8 * 1024 * 1024) throw new Error('lifecycle_entry_bound');
          entries.push(row);
        }
      }
      parts = []; length = 0; from = newline + 1;
    }
    if (from < count) { const rest = Buffer.from(buffer.subarray(from, count)); parts.push(rest); length += rest.length; }
    if (length > 16 * 1024 * 1024) throw new Error('transcript_line_bound');
  }
  if (length) throw new Error('transcript_incomplete_line');
  return entries;
}

/** Recording completion is independent of memory checkpoints and proposal extraction. */
export function readDesktopTurnOutcome(binding: DesktopReplayBinding, root: string): 'completed' | 'interrupted' | null {
  const rollout = readDesktopRollout(binding, root, 'lifecycle');
  if (!rollout) return null;
  let started = false;
  let workspace = false;
  let interrupted = false;
  for (const entry of rollout.entries) {
    const row = object(entry);
    const event = object(row?.payload);
    if (event?.turn_id !== binding.turnId) continue;
    if (row?.type === 'event_msg' && event.type === 'task_started') {
      if (started || event.root_turn_id !== binding.turnId
        || !Number.isSafeInteger(event.started_at)) return null;
      started = true;
    }
    if (!started) continue;
    if (row?.type === 'turn_context') {
      try {
        if (typeof event.cwd !== 'string' || realpathSync(event.cwd) !== root) return null;
      } catch { return null; }
      workspace = true;
    }
    if (row?.type === 'event_msg' && event.type === 'turn_aborted') interrupted = true;
  }
  if (!started || !workspace) return null;
  if (interrupted) return 'interrupted';
  return completedDesktopTurn(rollout.session, rollout.entries, binding) ? 'completed' : null;
}

/** Child hook session_id belongs to the root session; agent_id is verified against host metadata.
 * Host ordinals exclude inherited parent history before selecting the hook's exact child turn.
 * This separate contract must not relax root-turn completion or memory review validation.
 */
export function readDesktopSubagentTurnOutcome(
  binding: DesktopReplayBinding & { parentSessionId: string }, root: string,
): 'completed' | 'interrupted' | null {
  const rollout = readDesktopRollout(binding, root, 'subagent-lifecycle');
  if (!rollout) return null;
  const { session, entries } = rollout;
  const spawn = object(object(object(session.source)?.subagent)?.thread_spawn);
  if (session.session_id !== binding.parentSessionId || session.id === binding.parentSessionId
    || typeof spawn?.parent_thread_id !== 'string' || !/^[\w-]{1,128}$/u.test(spawn.parent_thread_id)
    || spawn.parent_thread_id === session.id || session.parent_thread_id !== spawn.parent_thread_id) return null;
  let startedAt: number | undefined;
  let rootTurnId: string | undefined;
  let workspace = false;
  let outcome: 'completed' | 'interrupted' | null = null;
  for (const entry of entries) {
    const row = object(entry);
    const event = object(row?.payload);
    if (event?.turn_id !== binding.turnId) continue;
    if (outcome) return null; // Duplicate/conflicting terminal evidence or a restarted turn is ambiguous.
    if (row?.type === 'event_msg' && event.type === 'task_started') {
      if (startedAt !== undefined || typeof event.root_turn_id !== 'string'
        || !/^[\w-]{1,128}$/u.test(event.root_turn_id)
        || typeof event.started_at !== 'number' || !Number.isSafeInteger(event.started_at)) return null;
      startedAt = event.started_at;
      rootTurnId = event.root_turn_id;
    } else if (row?.type === 'turn_context') {
      if (startedAt === undefined) return null;
      try {
        if (typeof event.cwd !== 'string' || realpathSync(event.cwd) !== root) return null;
      } catch { return null; }
      workspace = true;
    } else if (row?.type === 'event_msg' && ['task_complete', 'turn_aborted'].includes(String(event.type))) {
      if (startedAt === undefined || !workspace || event.root_turn_id !== rootTurnId
        || (event.started_at !== undefined && event.started_at !== startedAt)) return null;
      if (event.type === 'task_complete' && (typeof event.completed_at !== 'number'
        || !Number.isSafeInteger(event.completed_at) || event.completed_at < startedAt)) return null;
      outcome = event.type === 'task_complete' ? 'completed' : 'interrupted';
    }
  }
  return outcome;
}

/** A Stop hook can continue the turn. Only the host's terminal event establishes completion. */
export function completedDesktopTurn(
  session: unknown, entries: readonly unknown[], identity: DesktopTurnIdentity,
): CompletedDesktopTurn | null {
  const meta = object(session);
  if (!desktopOriginator(meta?.originator) || meta?.id !== identity.sessionId) return null;
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
