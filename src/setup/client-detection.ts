import { constants } from 'node:fs';
import { access, stat } from 'node:fs/promises';
import path from 'node:path';
import type { PathEnvironment } from '../config/paths.js';

export const DETECTABLE_CLIENTS = ['codex', 'opencode', 'claude', 'hermes'] as const;
export type DetectableClient = (typeof DETECTABLE_CLIENTS)[number];

async function hasExecutable(
  platform: NodeJS.Platform,
  pathModule: typeof path.posix,
  env: NodeJS.ProcessEnv,
  executableBaseName: string,
): Promise<boolean> {
  const pathValue = env.PATH;
  if (!pathValue) return false;
  const pathDelimiter = platform === 'win32' ? ';' : ':';
  const executableNames = platform === 'win32'
    ? [`${executableBaseName}.exe`, `${executableBaseName}.cmd`, `${executableBaseName}.bat`, executableBaseName]
    : [executableBaseName];

  for (const directory of pathValue.split(pathDelimiter).filter(Boolean)) {
    for (const executableName of executableNames) {
      const executable = pathModule.join(directory, executableName);
      try {
        const info = await stat(executable);
        if (!info.isFile()) continue;
        await access(executable, platform === 'win32' ? constants.F_OK : constants.X_OK);
        return true;
      } catch {
        // Continue checking the remaining PATH candidates.
      }
    }
  }
  return false;
}

/** Detect supported client executables without mutating client state. */
export async function detectInstalledClients(options: PathEnvironment = {}): Promise<DetectableClient[]> {
  const platform = options.platform ?? process.platform;
  const pathModule = platform === 'win32' ? path.win32 : path.posix;
  const env = options.env ?? process.env;
  const installed: DetectableClient[] = [];
  for (const client of DETECTABLE_CLIENTS) {
    if (await hasExecutable(platform, pathModule, env, client)) installed.push(client);
  }
  return installed;
}

/** Detect an installed Hermes executable without mutating client state. */
export async function isHermesAgentInstalled(options: PathEnvironment = {}): Promise<boolean> {
  return (await detectInstalledClients(options)).includes('hermes');
}
