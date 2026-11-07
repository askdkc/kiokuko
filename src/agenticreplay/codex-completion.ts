import { spawn } from 'node:child_process';
import { lstat, realpath } from 'node:fs/promises';
import { createConnection } from 'node:net';
import path from 'node:path';
import { setTimeout } from 'node:timers/promises';
import type { parseCodexHookInput } from '../assurance/codex-hooks.js';
import { readDesktopTurnOutcome } from '../assurance/codex-desktop-turn.js';
import { discoverCodexDockSocket } from './codex-service.js';

type HookInput = ReturnType<typeof parseCodexHookInput>;
function recordingBinding(input: HookInput) {
  if (!['Stop', 'Interrupt'].includes(input.hook_event_name) || input.agent_id
    || typeof input.transcript_path !== 'string' || input.transcript_path.length > 4096
    || !path.isAbsolute(input.transcript_path)
    || typeof input.turn_id !== 'string'
    || !/^[\w-]{1,128}$/u.test(input.session_id) || !/^[\w-]{1,128}$/u.test(input.turn_id)) return;
  return { sessionId: input.session_id, turnId: input.turn_id, transcriptPath: input.transcript_path };
}

/** The host writes task_complete after Stop returns, so the hook cannot await it. */
export function spawnRecordingCompletion(input: HookInput, database: string): void {
  if (!recordingBinding(input) || !process.argv[1]) return;
  const child = spawn(process.execPath, [...process.execArgv.filter(arg => !arg.startsWith('--test')),
    process.argv[1], 'codex-hook', '--finish-recording', '--database', database], {
    detached: true, stdio: ['pipe', 'ignore', 'ignore'],
  });
  child.on('error', () => {});
  child.stdin.on('error', () => {});
  child.stdin.end(JSON.stringify({ hook_event_name: input.hook_event_name, cwd: input.cwd,
    session_id: input.session_id, turn_id: input.turn_id, transcript_path: input.transcript_path }));
  child.unref();
}

async function notify(socketPath: string, payload: object, signal: AbortSignal): Promise<string> {
  const socketFile = await lstat(socketPath);
  const directory = await lstat(path.dirname(socketPath));
  if (!socketFile.isSocket() || !directory.isDirectory() || !process.getuid
    || socketFile.uid !== process.getuid() || directory.uid !== process.getuid()
    || (socketFile.mode & 0o077) !== 0 || (directory.mode & 0o077) !== 0
    || await realpath(socketPath) !== socketPath) return 'unavailable';
  return new Promise((resolve, reject) => {
    const connection = createConnection({ path: socketPath, signal });
    connection.setEncoding('utf8');
    connection.setTimeout(4000, () => connection.destroy(Object.assign(new Error('recorder_timeout'), { code: 'ETIMEDOUT' })));
    connection.on('error', reject);
    connection.on('connect', () => connection.write(JSON.stringify(payload) + '\n'));
    let response = '';
    connection.on('data', chunk => {
      response += chunk;
      if (response.length > 8192) connection.destroy(new Error('recorder_reply_too_large'));
    });
    connection.on('end', () => {
      try { resolve(JSON.parse(response).status ?? 'unavailable'); }
      catch { reject(Object.assign(new Error('recorder_reply_invalid'), { code: response === '' ? 'ECONNRESET' : 'EPROTO' })); }
    });
  });
}

/** Bounded background handoff; never scans or reopens historical recordings. */
export async function finishCodexRecording(input: HookInput): Promise<void> {
  const binding = recordingBinding(input);
  if (!binding) return;
  const root = await realpath(input.cwd);
  const signal = AbortSignal.timeout(120_000);
  const explicitSocket = process.env.AGENTICREPLAY_CODEX_REVIEW_SOCKET;
  let lastVersion = '';
  let outcome: ReturnType<typeof readDesktopTurnOutcome> = null;
  while (!signal.aborted) {
    try {
      const info = await lstat(binding.transcriptPath);
      const version = `${info.ino}:${info.size}:${info.mtimeMs}`;
      if (version !== lastVersion) {
        outcome = readDesktopTurnOutcome(binding, root);
        lastVersion = version;
      }
      if (outcome) {
        const socket = explicitSocket && path.isAbsolute(explicitSocket)
          ? explicitSocket : await discoverCodexDockSocket(root, signal);
        if (socket) {
          const status = await notify(socket, { action: 'finish', outcome, cwd: root,
            sessionId: binding.sessionId, turnId: binding.turnId }, signal);
          if (status === 'finalized' || status === 'unavailable') return;
          if (status !== 'pending' && status !== 'accepted') return;
        }
      }
    } catch (error) {
      if (signal.aborted) return;
      if (!['ENOENT', 'ECONNREFUSED', 'ECONNRESET', 'EPIPE', 'ETIMEDOUT'].includes(String((error as NodeJS.ErrnoException).code))) throw error;
    }
    try { await setTimeout(250, undefined, { signal }); }
    catch { if (signal.aborted) return; throw new Error('recorder_wait_failed'); }
  }
}
