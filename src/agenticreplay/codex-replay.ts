import { setTimeout } from 'node:timers/promises';
import { lstat, realpath, stat } from 'node:fs/promises';
import { createConnection } from 'node:net';
import path from 'node:path';
import { readCompletedDesktopTurn, type DesktopReplayBinding } from '../assurance/codex-desktop-turn.js';
import { turnReceiptSchema, type TurnReceipt } from './turn-receipt.js';

export type DesktopReviewTurn = NonNullable<ReturnType<typeof readCompletedDesktopTurn>>;

/** Optional capability on the same private recorder socket. No model input. */
export async function readRecorderTurnReceipt(socketPath: string, cwd: string,
  binding: Pick<DesktopReplayBinding, 'sessionId' | 'turnId'>, signal: AbortSignal): Promise<TurnReceipt | undefined> {
  const socketFile = await lstat(socketPath);
  const parent = await lstat(path.dirname(socketPath));
  if (!socketFile.isSocket() || !parent.isDirectory() || !process.getuid
    || socketFile.uid !== process.getuid() || parent.uid !== process.getuid()
    || (socketFile.mode & 0o077) !== 0 || (parent.mode & 0o077) !== 0
    || await realpath(socketPath) !== socketPath) throw new Error('receipt_transport_untrusted');
  const reply = await new Promise<unknown>((resolve, reject) => {
    const connection = createConnection({ path: socketPath, signal });
    connection.setEncoding('utf8');
    connection.setTimeout(1000, () => connection.destroy(new Error('receipt_transport_timeout')));
    connection.on('error', reject);
    connection.on('connect', () => connection.write(JSON.stringify({ action: 'receipt', cwd, ...binding }) + '\n'));
    let response = '';
    connection.on('data', chunk => {
      response += chunk;
      if (Buffer.byteLength(response) > 16384) connection.destroy(new Error('receipt_reply_bound'));
    });
    connection.on('end', () => {
      try { resolve(JSON.parse(response)); } catch { reject(new Error('receipt_reply_invalid')); }
    });
  });
  if (!reply || typeof reply !== 'object' || !('status' in reply)) throw new Error('receipt_reply_invalid');
  if (reply.status === 'pending' || reply.status === 'unavailable') return undefined;
  if (reply.status !== 'finalized' || !('receipt' in reply)) throw new Error('receipt_reply_invalid');
  const parsed = turnReceiptSchema.safeParse(reply.receipt);
  if (!parsed.success) throw new Error('receipt_schema_invalid');
  return parsed.data;
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
