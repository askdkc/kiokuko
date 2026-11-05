import { setTimeout } from 'node:timers/promises';
import { lstat, stat } from 'node:fs/promises';
import { createConnection } from 'node:net';
import path from 'node:path';
import type { SqliteDatabase } from '../db/adapter.js';
import { readCompletedDesktopTurn, type DesktopReplayBinding } from '../assurance/codex-desktop-turn.js';

export type DesktopReviewTurn = NonNullable<ReturnType<typeof readCompletedDesktopTurn>>;
export function desktopReplayBinding(database: SqliteDatabase, runId: string, root: string): DesktopReplayBinding | undefined {
  return database.prepare(`SELECT b.session_id AS sessionId, b.turn_id AS turnId, b.transcript_path AS transcriptPath
    FROM codex_desktop_replay_bindings b JOIN codex_hook_requests h ON h.identity_digest = b.identity_digest
    WHERE b.run_id = ? AND h.repository_root = ? AND h.stop_notified = 0
      AND ((h.run_id = b.run_id AND h.state = 'bound') OR (h.run_id IS NULL AND h.state = 'pending'))`).get<DesktopReplayBinding & Record<string, string>>(runId, root);
}

async function sealRecordedTurn(socketPath: string, cwd: string, binding: DesktopReplayBinding, signal: AbortSignal): Promise<string | null | undefined> {
  const socketFile = await lstat(socketPath);
  const parent = await lstat(path.dirname(socketPath));
  if (!socketFile.isSocket() || !parent.isDirectory() || !process.getuid
    || socketFile.uid !== process.getuid() || parent.uid !== process.getuid()
    || (socketFile.mode & 0o077) !== 0 || (parent.mode & 0o077) !== 0) return null;
  const response = await new Promise<string>((resolve, reject) => {
    const connection = createConnection({ path: socketPath, signal });
    connection.setEncoding('utf8');
    connection.setTimeout(4000, () => connection.destroy(new Error('recorder_timeout')));
    connection.on('error', reject);
    connection.on('connect', () => connection.write(JSON.stringify({
      cwd, sessionId: binding.sessionId, turnId: binding.turnId,
    }) + '\n'));
    let result = '';
    connection.on('data', chunk => {
      result += chunk;
      if (result.length > 8192) connection.destroy(new Error('recorder_reply_too_large'));
    });
    connection.on('end', () => resolve(result));
  });
  const reply = JSON.parse(response) as { status?: string; traceDirectory?: unknown };
  if (reply.status === 'pending') return undefined;
  return reply.status === 'sealed' && typeof reply.traceDirectory === 'string' && path.isAbsolute(reply.traceDirectory)
    ? reply.traceDirectory : null;
}

export async function prepareDesktopReview(
  cwd: string, socketPath: string,
  resolveBinding: () => Promise<DesktopReplayBinding | undefined>, signal: AbortSignal,
): Promise<{ traceDirectory: string; turn: DesktopReviewTurn } | null> {
  let lastVersion = '';
  let completed: DesktopReviewTurn | null = null;
  const deadline = Date.now() + 120_000;
  const reviewSignal = AbortSignal.any([signal, AbortSignal.timeout(120_000)]);
  while (Date.now() < deadline) {
    reviewSignal.throwIfAborted();
    const binding = await resolveBinding();
    if (!binding) {
      await setTimeout(500, undefined, { signal: reviewSignal, ref: false });
      continue;
    }
    if (!completed) {
      const info = await stat(binding.transcriptPath);
      const version = `${info.ino}:${info.size}:${info.mtimeMs}`;
      if (version !== lastVersion) {
        lastVersion = version;
        completed = readCompletedDesktopTurn(binding, cwd);
      }
    }
    if (completed) {
      const sealed = await sealRecordedTurn(socketPath, cwd, binding, reviewSignal);
      if (sealed !== undefined) return sealed ? { traceDirectory: sealed, turn: completed } : null;
    }
    await setTimeout(500, undefined, { signal: reviewSignal, ref: false });
  }
  return null;
}
