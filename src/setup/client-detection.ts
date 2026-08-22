import { constants } from 'node:fs';
import { access, stat } from 'node:fs/promises';
import path from 'node:path';
import type { PathEnvironment } from '../config/paths.js';

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

/** Detect an installed Hermes executable without mutating client state. */
export async function isHermesAgentInstalled(options: PathEnvironment = {}): Promise<boolean> {
  const platform = options.platform ?? process.platform;
  const pathModule = platform === 'win32' ? path.win32 : path.posix;
  return hasHermesExecutable(platform, pathModule, options.env ?? process.env);
}
