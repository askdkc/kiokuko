import path from 'node:path';
import { createHash } from 'node:crypto';
import { mkdir, lstat, readFile } from 'node:fs/promises';
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

/** Codex discovers personal skills from ~/.agents/skills, independently of CODEX_HOME. */
export function getCodexSkillsDirectory(options: PathEnvironment = {}): string {
  const { home, join } = requireHome(options);
  return join(home, '.agents', 'skills');
}

/** Claude Code's documented personal configuration directory. */
export function getClaudeConfigDirectory(options: PathEnvironment = {}): string {
  const { env } = selectedEnvironment(options);
  if (env.CLAUDE_CONFIG_DIR) return env.CLAUDE_CONFIG_DIR;
  const { home, join } = requireHome(options);
  return join(home, '.claude');
}

/**
 * Claude Code stores personal MCP servers in ~/.claude.json. When
 * CLAUDE_CONFIG_DIR is set, the equivalent state file is .claude.json inside
 * that directory.
 */
export function getClaudeMcpConfigPath(options: PathEnvironment = {}): string {
  const { platform, env } = selectedEnvironment(options);
  if (env.CLAUDE_CONFIG_DIR) {
    const join = platform === 'win32' ? path.win32.join : path.posix.join;
    return join(env.CLAUDE_CONFIG_DIR, '.claude.json');
  }
  const { home, join } = requireHome(options);
  return join(home, '.claude.json');
}

export function getClaudeInstructionsPath(options: PathEnvironment = {}): string {
  const { platform } = selectedEnvironment(options);
  const join = platform === 'win32' ? path.win32.join : path.posix.join;
  return join(getClaudeConfigDirectory(options), 'CLAUDE.md');
}

export function getClaudeSkillsDirectory(options: PathEnvironment = {}): string {
  const { platform } = selectedEnvironment(options);
  const join = platform === 'win32' ? path.win32.join : path.posix.join;
  return join(getClaudeConfigDirectory(options), 'skills');
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

export function getOpenCodeLoopGuardPath(options: PathEnvironment = {}): string {
  const { platform } = selectedEnvironment(options);
  const join = platform === 'win32' ? path.win32.join : path.posix.join;
  return join(getOpenCodeConfigDirectory(options), 'plugins', 'kiokuko-loop-guard.js');
}

export function getOpenCodeSkillsDirectory(options: PathEnvironment = {}): string {
  const { platform } = selectedEnvironment(options);
  const join = platform === 'win32' ? path.win32.join : path.posix.join;
  return join(getOpenCodeConfigDirectory(options), 'skills');
}

function getHermesRoot(options: PathEnvironment): string {
  const { platform, env } = selectedEnvironment(options);
  const join = platform === 'win32' ? path.win32.join : path.posix.join;
  if (env.HERMES_HOME) return env.HERMES_HOME;

  if (platform === 'win32') {
    const localAppData = env.LOCALAPPDATA ?? (env.USERPROFILE ? join(env.USERPROFILE, 'AppData', 'Local') : undefined);
    if (!localAppData) throw new KiokukoError('VALIDATION_ERROR', 'A Hermes home directory is unavailable');
    return join(localAppData, 'hermes');
  }

  if (!env.HOME) throw new KiokukoError('VALIDATION_ERROR', 'A Hermes home directory is unavailable');
  return join(env.HOME, '.hermes');
}

function isProfileShapedHermesHome(home: string, platform: NodeJS.Platform): boolean {
  const platformPath = platform === 'win32' ? path.win32 : path.posix;
  const normalized = platformPath.normalize(home);
  const profileName = platformPath.basename(normalized);
  return profileName.length > 0
    && profileName !== '.'
    && profileName !== '..'
    && platformPath.basename(platformPath.dirname(normalized)) === 'profiles';
}

/** Resolve the effective Hermes profile home without consulting or mutating the active Hermes profile. */
export async function getHermesHome(options: PathEnvironment = {}): Promise<string> {
  const { platform, env } = selectedEnvironment(options);
  const root = getHermesRoot(options);
  if (env.HERMES_HOME && isProfileShapedHermesHome(root, platform)) return root;

  const join = platform === 'win32' ? path.win32.join : path.posix.join;
  let activeProfile: string;
  try {
    activeProfile = (await readFile(join(root, 'active_profile'), 'utf8')).trim();
  } catch (error) {
    if (error instanceof Error && 'code' in error && (error as NodeJS.ErrnoException).code === 'ENOENT') return root;
    throw new KiokukoError('VALIDATION_ERROR', 'Hermes active profile marker is unavailable');
  }

  if (!/^[a-z0-9][a-z0-9_-]{0,63}$/.test(activeProfile)) {
    throw new KiokukoError('VALIDATION_ERROR', 'Hermes active profile marker is invalid');
  }
  if (activeProfile === 'default') return root;

  const profileHome = join(root, 'profiles', activeProfile);
  try {
    if (!(await lstat(profileHome)).isDirectory()) throw new Error('not a directory');
  } catch {
    throw new KiokukoError('VALIDATION_ERROR', 'Hermes active profile directory is unavailable');
  }
  return profileHome;
}

export async function getHermesConfigPath(options: PathEnvironment = {}): Promise<string> {
  const { platform } = selectedEnvironment(options);
  const join = platform === 'win32' ? path.win32.join : path.posix.join;
  return join(await getHermesHome(options), 'config.yaml');
}

export async function getHermesSkillsDirectory(options: PathEnvironment = {}): Promise<string> {
  const { platform } = selectedEnvironment(options);
  const join = platform === 'win32' ? path.win32.join : path.posix.join;
  return join(await getHermesHome(options), 'skills');
}

export async function ensurePlatformDataDirectory(options: PathEnvironment = {}): Promise<string> {
  const directory = getPlatformDataDirectory(options);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  return directory;
}
