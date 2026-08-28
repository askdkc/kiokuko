import { createHash } from 'node:crypto';
import { spawn, type ChildProcessByStdio } from 'node:child_process';
import type { Readable } from 'node:stream';
import { performance } from 'node:perf_hooks';
import { canonicalDirectory } from '../repository/detect-root.js';
import { assertVerifierCwd, parseVerifierSpec } from './schemas.js';
import type { VerifierRunResult, VerifierSpec } from './types.js';

const MAX_PREVIEW_BYTES = 8 * 1024;

export interface VerifierDependencies {
  spawn?: typeof spawn;
  now?: () => number;
}

function appendPreview(current: Buffer<ArrayBufferLike>, chunk: Buffer<ArrayBufferLike>): Buffer<ArrayBufferLike> {
  if (current.byteLength >= MAX_PREVIEW_BYTES) return current;
  return Buffer.concat([current, chunk.subarray(0, MAX_PREVIEW_BYTES - current.byteLength)]);
}

function digestHex(hash: ReturnType<typeof createHash>): string {
  return hash.digest('hex');
}

export async function runVerifier(
  rawVerifier: VerifierSpec,
  repositoryRoot: string,
  dependencies: VerifierDependencies = {},
): Promise<VerifierRunResult> {
  const verifier = parseVerifierSpec(rawVerifier);
  const canonicalRoot = canonicalDirectory(repositoryRoot);
  const canonicalCwd = canonicalDirectory(verifier.cwd);
  const normalized = { ...verifier, cwd: canonicalCwd };
  assertVerifierCwd(canonicalRoot, normalized);

  const start = dependencies.now?.() ?? performance.now();
  const stdoutHash = createHash('sha256');
  const stderrHash = createHash('sha256');
  let stdoutPreview: Buffer<ArrayBufferLike> = Buffer.alloc(0);
  let stderrPreview: Buffer<ArrayBufferLike> = Buffer.alloc(0);
  let child: ChildProcessByStdio<null, Readable, Readable>;
  try {
    child = (dependencies.spawn ?? spawn)(normalized.executable, normalized.args, {
      cwd: normalized.cwd,
      shell: false,
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });
  } catch {
    return {
      verifier: normalized,
      status: 'spawn_failed',
      exitCode: null,
      signal: null,
      durationMs: Math.max(0, Math.round((dependencies.now?.() ?? performance.now()) - start)),
      stdoutPreview: '',
      stderrPreview: '',
      stdoutDigest: createHash('sha256').digest('hex'),
      stderrDigest: createHash('sha256').digest('hex'),
    };
  }

  child.stdout.on('data', (chunk: Buffer | string) => {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    stdoutHash.update(bytes);
    stdoutPreview = appendPreview(stdoutPreview, bytes);
  });
  child.stderr.on('data', (chunk: Buffer | string) => {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    stderrHash.update(bytes);
    stderrPreview = appendPreview(stderrPreview, bytes);
  });

  const completion = await new Promise<{ status: VerifierRunResult['status']; exitCode: number | null; signal: string | null }>((resolve) => {
    let settled = false;
    let timedOut = false;
    let killTimer: NodeJS.Timeout | undefined;
    const settle = (value: { status: VerifierRunResult['status']; exitCode: number | null; signal: string | null }): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (killTimer !== undefined) clearTimeout(killTimer);
      resolve(value);
    };
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGTERM');
      killTimer = setTimeout(() => child.kill('SIGKILL'), 1_000);
      killTimer.unref();
    }, normalized.timeoutMs);
    timer.unref();
    child.once('error', () => settle({ status: timedOut ? 'timeout' : 'spawn_failed', exitCode: null, signal: timedOut ? 'SIGTERM' : null }));
    child.once('close', (code, signal) => settle({
      status: timedOut ? 'timeout' : code === 0 ? 'passed' : 'failed',
      exitCode: timedOut ? null : code,
      signal: timedOut ? signal ?? 'SIGTERM' : signal,
    }));
  });
  return {
    verifier: normalized,
    ...completion,
    durationMs: Math.max(0, Math.round((dependencies.now?.() ?? performance.now()) - start)),
    stdoutPreview: stdoutPreview.toString('utf8'),
    stderrPreview: stderrPreview.toString('utf8'),
    stdoutDigest: digestHex(stdoutHash),
    stderrDigest: digestHex(stderrHash),
  };
}

export async function runVerifiers(
  verifiers: readonly VerifierSpec[],
  repositoryRoot: string,
  dependencies: VerifierDependencies = {},
): Promise<VerifierRunResult[]> {
  const results: VerifierRunResult[] = [];
  for (const verifier of verifiers) results.push(await runVerifier(verifier, repositoryRoot, dependencies));
  return results;
}
