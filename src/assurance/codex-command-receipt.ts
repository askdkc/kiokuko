import { closeSync, constants, fstatSync, lstatSync, openSync, readSync, realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

interface CommandIdentity {
  session_id: string;
  turn_id: string;
  cwd: string;
  tool_name?: string | undefined;
  tool_use_id?: string | undefined;
  transcript_path?: unknown;
  tool_input?: unknown;
}
export interface CodexCommandReceipt { callId: string; processId: string; exitCode: number; }
function object(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}
function commandDirectory(value: string): string {
  if (!value.startsWith('file:')) return realpathSync(value);
  const url = new URL(value);
  if (url.search || url.hash) throw new Error('Invalid command directory URL');
  return realpathSync(fileURLToPath(url));
}

/** The path comes only from the client hook, never a model-facing evidence API.
 * Read the session header and a bounded tail; retain no transcript or stdout.
 * Unfamiliar, missing, ambiguous or unfinished host records provide no evidence.
 */
export function readCodexCommandReceipt(input: CommandIdentity, repositoryRoot: string): CodexCommandReceipt | null {
  if (!['exec_command','Bash','write_stdin'].includes(input.tool_name ?? '') || typeof input.transcript_path !== 'string'
    || !path.isAbsolute(input.transcript_path)) return null;
  let fd: number | undefined;
  try {
    const sessions = realpathSync(path.join(process.env.CODEX_HOME ?? path.join(homedir(), '.codex'), 'sessions'));
    const file = realpathSync(input.transcript_path);
    if (!file.startsWith(sessions + path.sep) || lstatSync(input.transcript_path).isSymbolicLink()
      || !path.basename(file).startsWith('rollout-') || !path.basename(file).endsWith(`-${input.session_id}.jsonl`)) return null;
    fd = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const stat = fstatSync(fd);
    if (!stat.isFile() || (process.getuid && stat.uid !== process.getuid()) || (stat.mode & 0o022) !== 0) return null;
    const head = Buffer.alloc(Math.min(stat.size, 64 * 1024));
    readSync(fd, head, 0, head.length, 0);
    const headEnd = head.indexOf(10);
    if (headEnd < 0) return null;
    const header = object(JSON.parse(head.subarray(0, headEnd).toString('utf8')));
    const session = object(header.payload);
    if (header.type !== 'session_meta' || session.id !== input.session_id || typeof session.cwd !== 'string'
      || realpathSync(session.cwd) !== repositoryRoot) return null;
    const offset = Math.max(0, stat.size - 2 * 1024 * 1024);
    const tail = Buffer.alloc(stat.size - offset);
    readSync(fd, tail, 0, tail.length, offset);
    if (tail[tail.length - 1] !== 10) return null;
    // Ignore only the partial first record of a bounded tail.
    const start = offset === 0 ? 0 : tail.indexOf(10) + 1;
    const end = tail.lastIndexOf(10);
    if (start < 0 || end < start) return null;
    const lines = tail.subarray(start, end).toString('utf8').split('\n');
    if (lines.length > 4096) return null;
    const args = object(input.tool_input);
    let found: CodexCommandReceipt | null = null;
    for (const line of lines) {
      const record = object(JSON.parse(line));
      const event = object(record.payload);
      const item = object(event.item);
      if (record.type !== 'event_msg' || event.type !== 'item_completed' || event.thread_id !== input.session_id
        || event.turn_id !== input.turn_id || item.type !== 'CommandExecution' || item.source !== 'unified_exec_startup') continue;
      const matches = input.tool_name === 'write_stdin'
        ? (typeof args.session_id === 'number' || typeof args.session_id === 'string') && item.process_id === String(args.session_id)
        : item.id === input.tool_use_id;
      if (!matches) continue;
      if (typeof item.id !== 'string' || !item.id.length || typeof item.process_id !== 'string' || !item.process_id.length
        || typeof item.cwd !== 'string' || commandDirectory(item.cwd) !== realpathSync(input.cwd)
        || typeof item.exit_code !== 'number' || !Number.isSafeInteger(item.exit_code)
        || (item.status !== 'completed' && item.status !== 'failed')
        || (item.status === 'completed') !== (item.exit_code === 0)) return null;
      const receipt = {callId:item.id,processId:item.process_id,exitCode:item.exit_code};
      if (found && JSON.stringify(found) !== JSON.stringify(receipt)) return null;
      found = receipt;
    }
    return found;
  } catch { return null; }
  finally { if (fd !== undefined) closeSync(fd); }
}
