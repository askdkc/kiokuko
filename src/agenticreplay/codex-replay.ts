import { setTimeout } from 'node:timers/promises';
import { lstat, stat } from 'node:fs/promises';
import { createConnection } from 'node:net';
import path from 'node:path';
import { readCompletedDesktopTurn, type DesktopReplayBinding } from '../assurance/codex-desktop-turn.js';

export type DesktopReviewTurn = NonNullable<ReturnType<typeof readCompletedDesktopTurn>>;

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


export async function waitForCompletedDesktopTurn(
  cwd: string, resolveBinding: () => Promise<DesktopReplayBinding | undefined>, signal: AbortSignal,
): Promise<{ binding: DesktopReplayBinding; turn: DesktopReviewTurn }> {
  let lastVersion = '';
  for (;;) {
    signal.throwIfAborted();
    const binding = await resolveBinding();
    if (binding) {
      const info = await stat(binding.transcriptPath).catch((error: NodeJS.ErrnoException) => {
        if (error.code !== 'ENOENT') throw error;
        return undefined;
      });
      if (info) {
        const version = `${binding.transcriptPath}:${binding.turnId}:${info.ino}:${info.size}:${info.mtimeMs}`;
        if (version !== lastVersion) {
          lastVersion = version;
          const turn = readCompletedDesktopTurn(binding, cwd);
          if (turn) return { binding, turn };
        }
      }
    }
    await setTimeout(250, undefined, { signal });
  }
}

export async function waitForSealedDesktopTrace(
  cwd: string, socketPath: string, binding: DesktopReplayBinding, signal: AbortSignal,
): Promise<string | null> {
  for (;;) {
    signal.throwIfAborted();
    const sealed = await sealRecordedTurn(socketPath, cwd, binding, signal);
    if (sealed !== undefined) return sealed;
    await setTimeout(250, undefined, { signal });
  }
}
