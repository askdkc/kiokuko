import { execFileSync } from 'node:child_process';
import { lstatSync, realpathSync } from 'node:fs';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { KiokukoError } from '../errors.js';

interface GitProvenanceExecOptions {
  cwd: string;
  encoding: 'utf8';
  stdio: ['ignore', 'pipe', 'pipe'];
  timeout: number;
  maxBuffer: number;
  killSignal: 'SIGKILL';
  env: NodeJS.ProcessEnv;
}
type GitProvenanceExecutor = (executable: string, args: string[], options: GitProvenanceExecOptions) => string;
const executeGit: GitProvenanceExecutor = (executable, args, options) => execFileSync(executable, args, options);
const unavailable = () => new KiokukoError('SERVICE_UNAVAILABLE', 'Git checkpoint provenance could not be resolved');

function processText(error: Record<string, unknown>, field: 'stdout' | 'stderr'): string | undefined {
  const value = error[field];
  return typeof value === 'string' ? value : Buffer.isBuffer(value) ? value.toString('utf8') : undefined;
}

function exitedWith(error: unknown, status: number): error is Record<string, unknown> {
  if (typeof error !== 'object' || error === null) return false;
  const failure = error as Record<string, unknown>;
  return failure.status === status && failure.signal === null && failure.code == null
    && failure.killed !== true && failure.error == null && processText(failure, 'stdout') === '';
}

function diagnostic(error: unknown): string | undefined {
  if (!exitedWith(error, 128)) return undefined;
  return processText(error, 'stderr')?.replaceAll('\r\n', '\n').replace(/\n$/u, '');
}

function nonRepositoryBoundary(error: unknown): string | null | undefined {
  const text = diagnostic(error);
  if (text === 'fatal: not a git repository (or any of the parent directories): .git') return null;
  const match = /^fatal: not a git repository \(or any parent up to mount point ([^\r\n]+)\)\nStopping at filesystem boundary \(GIT_DISCOVERY_ACROSS_FILESYSTEM not set\)\.$/u.exec(text ?? '');
  return match && path.isAbsolute(match[1]!) ? match[1]! : undefined;
}

/** lstat also detects dangling links. Only a missing path is an expected absence. */
function pathPresent(file: string): boolean {
  try { lstatSync(file); return true; }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  }
}

function assertNoRepositoryMarker(cwd: string, boundary: string | null, env: NodeJS.ProcessEnv, checkDeadline: () => void): void {
  // Explicit but unusable Git locations are configuration errors, not absent repositories.
  if (['GIT_DIR', 'GIT_WORK_TREE', 'GIT_COMMON_DIR'].some((key) => env[key] !== undefined)) throw unavailable();
  const ceilings = (env.GIT_CEILING_DIRECTORIES ?? '').split(path.delimiter).filter(path.isAbsolute).map((directory) => {
    try { return realpathSync(directory); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return directory;
      throw error;
    }
  });
  let directory = realpathSync(cwd);
  for (;;) {
    checkDeadline();
    if (pathPresent(path.join(directory, '.git'))) throw unavailable();
    const objects = pathPresent(path.join(directory, 'objects'));
    const refs = pathPresent(path.join(directory, 'refs'));
    // objects/refs by themselves are also ordinary application directory names.
    // A bare repository has HEAD, or retains config if HEAD was damaged/deleted.
    if ((objects || refs) && pathPresent(path.join(directory, 'HEAD'))
      || objects && refs && pathPresent(path.join(directory, 'config'))) throw unavailable();
    const parent = path.dirname(directory);
    if (parent === directory || directory === boundary || ceilings.includes(parent)) return;
    directory = parent;
  }
}

function singleLine(output: string): string {
  const line = output.replace(/(?:\r\n|\n)$/u, '');
  if (!line || /[\r\n\0]/u.test(line)) throw unavailable();
  return line;
}

function confirmAbsentCommit(
  error: unknown,
  cwd: string,
  env: NodeJS.ProcessEnv,
  run: (args: string[]) => string,
  checkDeadline: () => void,
): void {
  const boundary = nonRepositoryBoundary(error);
  const unborn = diagnostic(error) === 'fatal: Needed a single revision';
  if (boundary === undefined && !unborn) throw unavailable();
  try {
    if (!path.isAbsolute(singleLine(run(['rev-parse', '--absolute-git-dir'])))) throw unavailable();
  } catch (probeError) {
    if (boundary === undefined || nonRepositoryBoundary(probeError) === undefined) throw unavailable();
    assertNoRepositoryMarker(cwd, boundary, env, checkDeadline);
    return;
  }
  if (!unborn) throw unavailable(); // Repository changed during the probes.
  const ref = singleLine(run(['symbolic-ref', '--quiet', 'HEAD']));
  if (!ref.startsWith('refs/heads/')) throw unavailable();
  run(['check-ref-format', ref]);
  try { run(['show-ref', '--verify', '--quiet', ref]); }
  catch (probeError) {
    if (!exitedWith(probeError, 1) || processText(probeError, 'stderr') !== '') throw unavailable();
    // Git's quiet lookup also returns 1 for malformed/empty loose refs. Resolve the
    // common-dir aware storage path (including linked worktrees) before accepting absence.
    const refPath = singleLine(run(['rev-parse', '--git-path', ref]));
    if (pathPresent(path.resolve(cwd, refPath))) throw unavailable();
    return;
  }
  throw unavailable(); // A ref exists but HEAD could not resolve to a commit.
}

/** Resolve immutable provenance; only observed non-repository/unborn states have no commit. */
export function resolveCheckpointSourceCommit(repositoryRoot: string, execute: GitProvenanceExecutor = executeGit): string | null {
  const deadline = performance.now() + 5_000;
  const env = { ...process.env, LC_ALL: 'C', LANG: 'C' };
  const remaining = () => {
    const budget = Math.ceil(deadline - performance.now());
    if (budget <= 0) throw unavailable();
    return budget;
  };
  const run = (args: string[]) => {
    const output = execute('git', args, { cwd: repositoryRoot, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
      timeout: remaining(), maxBuffer: 64 * 1024, killSignal: 'SIGKILL', env });
    remaining();
    return output;
  };
  let output: string;
  try { output = run(['rev-parse', '--verify', 'HEAD^{commit}']); }
  catch (error) {
    try { confirmAbsentCommit(error, repositoryRoot, env, run, remaining); remaining(); return null; }
    catch { throw unavailable(); }
  }
  const commit = output.replace(/(?:\r\n|\n)$/u, '');
  if (!/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/u.test(commit)) {
    throw new KiokukoError('INTEGRITY_ERROR', 'Git checkpoint provenance is invalid');
  }
  return commit;
}
