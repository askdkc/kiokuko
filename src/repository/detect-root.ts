import { execFileSync } from 'node:child_process';
import { existsSync, realpathSync, statSync } from 'node:fs';
import path from 'node:path';
import { KiokukoError } from '../errors.js';

export type RootSource = 'explicit' | 'binding' | 'git' | 'git-marker' | 'directory';

export interface DetectedRepositoryRoot {
  root: string;
  source: RootSource;
}

export interface DetectRepositoryRootOptions {
  cwd?: string;
  root?: string;
  allowDirectory?: boolean;
}

function canonicalDirectory(directory: string): string {
  const resolved = realpathSync(directory);
  if (!statSync(resolved).isDirectory()) throw new KiokukoError('VALIDATION_ERROR', 'Repository root must be a directory');
  return resolved;
}

function ancestorDirectories(start: string): string[] {
  const directories: string[] = [];
  let current = canonicalDirectory(start);
  for (;;) {
    directories.push(current);
    const parent = path.dirname(current);
    if (parent === current) return directories;
    current = parent;
  }
}

function gitRoot(cwd: string): string | undefined {
  try {
    const output = execFileSync('git', ['rev-parse', '--show-toplevel'], {
      cwd,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
    return output ? canonicalDirectory(output) : undefined;
  } catch {
    return undefined;
  }
}

export function detectRepositoryRoot(options: DetectRepositoryRootOptions = {}): DetectedRepositoryRoot {
  const cwd = canonicalDirectory(options.cwd ?? process.cwd());
  if (options.root !== undefined) {
    return { root: canonicalDirectory(options.root), source: 'explicit' };
  }

  for (const directory of ancestorDirectories(cwd)) {
    if (existsSync(path.join(directory, '.kiokuko.json'))) {
      return { root: directory, source: 'binding' };
    }
  }

  const discoveredGitRoot = gitRoot(cwd);
  if (discoveredGitRoot) return { root: discoveredGitRoot, source: 'git' };

  for (const directory of ancestorDirectories(cwd)) {
    if (existsSync(path.join(directory, '.git'))) {
      return { root: directory, source: 'git-marker' };
    }
  }

  if (options.allowDirectory) return { root: cwd, source: 'directory' };
  throw new KiokukoError('NOT_FOUND', 'No repository root found; pass --root or --allow-directory');
}
