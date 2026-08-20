import path from 'node:path';
import { createHash } from 'node:crypto';
import { mkdir } from 'node:fs/promises';
import { KiokukoError } from '../errors.js';

export interface PathEnvironment {
  platform?: NodeJS.Platform;
  env?: NodeJS.ProcessEnv;
}

function selectedEnvironment({ platform = process.platform, env = process.env }: PathEnvironment): {
  platform: NodeJS.Platform;
  env: NodeJS.ProcessEnv;
} {
  return { platform, env };
}

export function getPlatformDataDirectory(options: PathEnvironment = {}): string {
  const { platform, env } = selectedEnvironment(options);
  const join = platform === 'win32' ? path.win32.join : path.posix.join;

  if (platform === 'win32') {
    const root = env.LOCALAPPDATA ?? env.APPDATA ?? env.USERPROFILE;
    if (!root) {
      throw new KiokukoError('VALIDATION_ERROR', 'A Windows user data directory is unavailable');
    }
    return join(root, 'kiokuko');
  }

  if (platform === 'darwin') {
    const home = env.HOME;
    if (!home) throw new KiokukoError('VALIDATION_ERROR', 'HOME is unavailable');
    return join(home, 'Library', 'Application Support', 'kiokuko');
  }

  const root = env.XDG_DATA_HOME || (env.HOME ? join(env.HOME, '.local', 'share') : undefined);
  if (!root) throw new KiokukoError('VALIDATION_ERROR', 'XDG_DATA_HOME or HOME is unavailable');
  return join(root, 'kiokuko');
}

export function getRuntimeDirectory(options: PathEnvironment = {}): string {
  const { platform, env } = selectedEnvironment(options);
  const join = platform === 'win32' ? path.win32.join : path.posix.join;

  if (platform === 'linux' && env.XDG_RUNTIME_DIR) {
    return join(env.XDG_RUNTIME_DIR, 'kiokuko');
  }

  return getPlatformDataDirectory(options);
}

export function getRuntimeDescriptorPath(options: PathEnvironment = {}): string {
  const { platform } = selectedEnvironment(options);
  const join = platform === 'win32' ? path.win32.join : path.posix.join;
  return join(getRuntimeDirectory(options), 'server.json');
}

export function getDatabaseLockPath(databasePath: string, options: PathEnvironment = {}): string {
  const { platform } = selectedEnvironment(options);
  const platformPath = platform === 'win32' ? path.win32 : path.posix;
  const resolvedPath = platformPath.resolve(databasePath);
  const fingerprint = createHash('sha256').update(resolvedPath, 'utf8').digest('hex');
  const join = platform === 'win32' ? path.win32.join : path.posix.join;
  return join(getRuntimeDirectory(options), `${fingerprint}.lock`);
}

export function getGlobalDatabasePath(options: PathEnvironment = {}): string {
  const { platform } = selectedEnvironment(options);
  const join = platform === 'win32' ? path.win32.join : path.posix.join;
  return join(getPlatformDataDirectory(options), 'kiokuko.sqlite3');
}

function requireHome(options: PathEnvironment): { home: string; join: typeof path.posix.join } {
  const { platform, env } = selectedEnvironment(options);
  const home = platform === 'win32' ? (env.USERPROFILE ?? env.HOME) : env.HOME;
  if (!home) throw new KiokukoError('VALIDATION_ERROR', 'The user home directory is unavailable');
  return { home, join: platform === 'win32' ? path.win32.join : path.posix.join };
}

/** Global Codex configuration directory. CODEX_HOME intentionally takes precedence. */
export function getCodexHome(options: PathEnvironment = {}): string {
  const { platform, env } = selectedEnvironment(options);
  if (env.CODEX_HOME) return env.CODEX_HOME;
  const { home, join } = requireHome(options);
  return join(home, '.codex');
}

export function getCodexConfigPath(options: PathEnvironment = {}): string {
  const { platform } = selectedEnvironment(options);
  const join = platform === 'win32' ? path.win32.join : path.posix.join;
  return join(getCodexHome(options), 'config.toml');
}

export function getCodexInstructionsPath(options: PathEnvironment = {}): string {
  const { platform } = selectedEnvironment(options);
  const join = platform === 'win32' ? path.win32.join : path.posix.join;
  return join(getCodexHome(options), 'AGENTS.md');
}

/** OpenCode's documented global configuration directory. */
export function getOpenCodeConfigDirectory(options: PathEnvironment = {}): string {
  const { platform, env } = selectedEnvironment(options);
  const join = platform === 'win32' ? path.win32.join : path.posix.join;
  if (platform === 'win32') {
    const root = env.APPDATA ?? env.LOCALAPPDATA;
    if (root) return join(root, 'opencode');
  }
  if (env.XDG_CONFIG_HOME) return join(env.XDG_CONFIG_HOME, 'opencode');
  const { home } = requireHome(options);
  return join(home, '.config', 'opencode');
}

export function getOpenCodeInstructionsPath(options: PathEnvironment = {}): string {
  const { platform } = selectedEnvironment(options);
  const join = platform === 'win32' ? path.win32.join : path.posix.join;
  return join(getOpenCodeConfigDirectory(options), 'AGENTS.md');
}

export async function ensurePlatformDataDirectory(options: PathEnvironment = {}): Promise<string> {
  const directory = getPlatformDataDirectory(options);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  return directory;
}
