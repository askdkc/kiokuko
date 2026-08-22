import { constants } from 'node:fs';
import { access, stat } from 'node:fs/promises';
import path from 'node:path';
import type { PathEnvironment } from '../config/paths.js';

async function exists(filePath: string): Promise<boolean> {
  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
}

function hermesRoots(options: PathEnvironment): { platform: NodeJS.Platform; roots: string[]; pathModule: typeof path.posix } {
  const platform = options.platform ?? process.platform;
  const env = options.env ?? process.env;
  const pathModule = platform === 'win32' ? path.win32 : path.posix;
  const roots = new Set<string>();

  if (env.HERMES_HOME) roots.add(env.HERMES_HOME);
  const home = platform === 'win32' ? (env.USERPROFILE ?? env.HOME) : env.HOME;
  if (home) roots.add(pathModule.join(home, '.hermes'));

  return { platform, roots: [...roots], pathModule };
}

async function hasHermesProfileState(root: string, pathModule: typeof path.posix): Promise<boolean> {
  for (const marker of ['config.yaml', 'active_profile', 'profiles']) {
    if (await exists(pathModule.join(root, marker))) return true;
  }
  return false;
}

async function hasHermesExecutable(
  platform: NodeJS.Platform,
  pathModule: typeof path.posix,
  env: NodeJS.ProcessEnv,
): Promise<boolean> {
  const pathValue = env.PATH;
  if (!pathValue) return false;
  const pathDelimiter = platform === 'win32' ? ';' : ':';
  const executableNames = platform === 'win32'
    ? ['hermes.exe', 'hermes.cmd', 'hermes.bat', 'hermes']
    : ['hermes'];

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

/** Detect an existing Hermes profile or Hermes executable without mutating client state. */
export async function isHermesAgentInstalled(options: PathEnvironment = {}): Promise<boolean> {
  const { platform, roots, pathModule } = hermesRoots(options);
  for (const root of roots) {
    if (await hasHermesProfileState(root, pathModule)) return true;
  }
  return hasHermesExecutable(platform, pathModule, options.env ?? process.env);
}
