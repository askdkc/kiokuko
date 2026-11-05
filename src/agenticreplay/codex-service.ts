import { execFile } from 'node:child_process';
import { readFile, realpath, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod/v4';
import { codexProjectWorktrees, refreshCodexProject } from '../setup/codex-projects.js';
import { detectGitWorktree } from '../repository/detect-root.js';

const runningService = z.object({
  status: z.literal('running'),
  socketPath: z.string().refine(path.isAbsolute),
  worktrees: z.array(z.string().refine(path.isAbsolute)).max(64),
});
const serviceError = z.object({ error: z.object({ message: z.string().min(1).max(2048) }) });

async function installedRecorderBin(): Promise<string> {
  // The package exports its module entry, not package.json or the CLI bin.
  let directory = path.dirname(fileURLToPath(import.meta.resolve('agenticreplay')));
  while (path.dirname(directory) !== directory) {
    if (path.basename(directory) === 'agenticreplay' && path.basename(path.dirname(directory)) === 'node_modules') {
      const manifest = JSON.parse(await readFile(path.join(directory, 'package.json'), 'utf8'));
      if (manifest.name === 'agenticreplay' && manifest.bin?.agenticreplay === 'bin/agenticreplay.js') {
        const root = await realpath(directory);
        const bin = path.join(root, 'bin', 'agenticreplay.js');
        if (await realpath(bin) === bin && (await stat(bin)).isFile()) return bin;
      }
      break;
    }
    directory = path.dirname(directory);
  }
  throw new Error('The installed AgenticReplay package has no valid CLI bin.');
}

async function runService(
  cwd: string, args: string[], timeout: number, signal?: AbortSignal, env?: NodeJS.ProcessEnv,
): Promise<unknown> {
  const bin = await installedRecorderBin();
  return new Promise((resolve, reject) => {
    execFile(process.execPath, [bin, 'codex-service', ...args, '--json'], {
      cwd, timeout, signal, env, encoding: 'utf8', maxBuffer: 128 * 1024,
    }, (error, stdout) => {
      let response: unknown;
      try {
        response = JSON.parse(stdout);
      } catch {
        reject(new Error('AgenticReplay returned no valid service response. Check that the installed version supports codex-service.'));
        return;
      }
      const failure = serviceError.safeParse(response);
      if (failure.success) reject(new Error(failure.data.error.message));
      else if (error) reject(new Error('AgenticReplay could not complete the service command.'));
      else resolve(response);
    });
  });
}

export async function registerCodexDock(cwd: string, configPath: string, env?: NodeJS.ProcessEnv): Promise<void> {
  const result = runningService.safeParse(await runService(cwd, ['register', '--config', configPath], 45_000, undefined, env));
  if (!result.success || !result.data.worktrees.includes(cwd)) {
    throw new Error('AgenticReplay did not confirm an active recorder for this Git worktree. Check codex-service status.');
  }
}

export async function discoverCodexDockSocket(cwd: string, signal: AbortSignal): Promise<string | undefined> {
  try {
    const result = runningService.safeParse(await runService(cwd, ['status'], 4000, signal));
    return result.success && result.data.worktrees.includes(cwd) ? result.data.socketPath : undefined;
  } catch {
    return undefined;
  }
}

/** Existing Codex hooks extend an enabled recorder when a newly added project is used. */
export async function syncCodexDockProject(cwd: string, configPath: string, databasePath: string): Promise<void> {
  const root = detectGitWorktree(cwd);
  if (!root || !(await codexProjectWorktrees(configPath)).includes(root)) return;
  const result = runningService.safeParse(await runService(root, ['status'], 4000));
  if (!result.success) return; // Explicit disable must remain disabled.
  await refreshCodexProject(root, databasePath);
  if (!result.data.worktrees.includes(root)) await registerCodexDock(root, configPath);
}
