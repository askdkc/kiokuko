import path from 'node:path';
import { KiokukoError } from '../errors.js';
import type { DetectedRepositoryRoot } from './detect-root.js';

/** Internal decision boundary. Inputs have already been canonicalized by the filesystem adapter. */
export function resolveRepositoryRoot(
  cwd: string,
  explicitRoot: string | undefined,
  allowDirectory: boolean,
  observations: { exists: (file: string) => boolean; gitRoot: (cwd: string) => string | undefined },
): DetectedRepositoryRoot {
  if (explicitRoot !== undefined) return { root: explicitRoot, source: 'explicit' };
  const ancestors: string[] = [];
  for (let directory = cwd;; directory = path.dirname(directory)) {
    ancestors.push(directory);
    if (directory === path.dirname(directory)) break;
  }
  for (const directory of ancestors) {
    if (observations.exists(path.join(directory, '.kiokuko.json'))) return { root: directory, source: 'binding' };
  }
  const git = observations.gitRoot(cwd);
  if (git !== undefined) return { root: git, source: 'git' };
  for (const directory of ancestors) {
    if (observations.exists(path.join(directory, '.git'))) return { root: directory, source: 'git-marker' };
  }
  if (allowDirectory) return { root: cwd, source: 'directory' };
  throw new KiokukoError('NOT_FOUND', 'No repository root found; pass --root or --allow-directory');
}
