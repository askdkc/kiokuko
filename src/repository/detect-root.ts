import { execFileSync } from 'node:child_process';
import { existsSync, realpathSync, statSync } from 'node:fs';
import path from 'node:path';
import { KiokukoError } from '../errors.js';
import { resolveRepositoryRoot } from './resolve-root.js';

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

export function canonicalDirectory(directory: string): string {
  if (!path.isAbsolute(directory)) {
    throw new KiokukoError('VALIDATION_ERROR', 'Directory path must be absolute');
  }
  try {
    const resolved = realpathSync(directory);
    if (!statSync(resolved).isDirectory()) {
      throw new KiokukoError('VALIDATION_ERROR', 'Repository root must be a directory');
    }
    return resolved;
  } catch (error) {
    if (error instanceof KiokukoError) throw error;
    const code = error instanceof Error && 'code' in error
      ? (error as NodeJS.ErrnoException).code
      : undefined;
    if (code === 'ENOENT' || code === 'ENOTDIR') {
      throw new KiokukoError('NOT_FOUND', 'Directory was not found');
    }
    if (code === 'EACCES' || code === 'EPERM') {
      throw new KiokukoError('VALIDATION_ERROR', 'Directory is not accessible');
    }
    throw error;
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
  return resolveRepositoryRoot(cwd, options.root === undefined ? undefined : canonicalDirectory(options.root),
    options.allowDirectory === true, { exists: existsSync, gitRoot });
}
