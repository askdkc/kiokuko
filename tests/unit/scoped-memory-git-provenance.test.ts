import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test, { type TestContext } from 'node:test';
import { resolveCheckpointSourceCommit } from '../../src/memory/scoped-memory.js';

function processFailure(overrides: Record<string, unknown> = {}): Error {
  return Object.assign(new Error('raw process failure'), {
    status: 1,
    signal: null,
    stdout: '',
    stderr: '',
    ...overrides,
  });
}

function throwing(error: unknown) {
  return () => { throw error; };
}

async function repository(t: TestContext, bare = false): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), 'kiokuko-provenance-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  execFileSync('git', ['init', '-q', '--initial-branch=main', ...(bare ? ['--bare'] : []), root]);
  return root;
}

test('does not mistake malformed loose refs, missing objects or broken HEAD for an unborn repository', async (t) => {
  for (const bare of [false, true]) {
    for (const value of ['', 'invalid\n', `${'a'.repeat(40)}\n`]) {
      const root = await repository(t, bare);
      await writeFile(path.join(root, bare ? '' : '.git', 'refs/heads/main'), value);
      assert.throws(() => resolveCheckpointSourceCommit(root), { code: 'SERVICE_UNAVAILABLE' });
    }
    const root = await repository(t, bare);
    await writeFile(path.join(root, bare ? '' : '.git', 'HEAD'), 'invalid\n');
    assert.throws(() => resolveCheckpointSourceCommit(root), { code: 'SERVICE_UNAVAILABLE' });
  }
});

test('mount-boundary diagnostics are accepted only when the observed directory has no Git markers', async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), 'kiokuko-boundary-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const message = `fatal: not a git repository (or any parent up to mount point ${root})\nStopping at filesystem boundary (GIT_DISCOVERY_ACROSS_FILESYSTEM not set).\n`;
  for (const stderr of [message, message.replaceAll('\n', '\r\n')]) {
    assert.equal(resolveCheckpointSourceCommit(root, throwing(processFailure({ status: 128, stderr }))), null);
  }
  await mkdir(path.join(root, '.git'));
  assert.throws(() => resolveCheckpointSourceCommit(root, throwing(processFailure({ status: 128, stderr: message }))), { code: 'SERVICE_UNAVAILABLE' });
});

test('returns null only for explicit non-Git and unborn-HEAD states', async (t) => {
  const nonGit = await mkdtemp(path.join(tmpdir(), 'kiokuko-checkpoint-non-git-'));
  t.after(() => rm(nonGit, { recursive: true, force: true }));
  // These common application names alone do not establish a bare Git marker.
  await mkdir(path.join(nonGit, 'objects'));
  await mkdir(path.join(nonGit, 'refs'));
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('GIT_')));
  const source = `import { resolveCheckpointSourceCommit } from './src/memory/scoped-memory.ts'; console.log(JSON.stringify(resolveCheckpointSourceCommit(process.argv[1])));`;
  const result = execFileSync(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', source, nonGit], {
    encoding: 'utf8', env: { ...env, GIT_CEILING_DIRECTORIES: path.dirname(nonGit) },
  });
  assert.equal(result.trim(), 'null');
  const unborn = await repository(t);
  assert.equal(resolveCheckpointSourceCommit(unborn), null);
  assert.equal(resolveCheckpointSourceCommit(await repository(t, true)), null);
});

test('returns a strict immutable commit and applies bounded deterministic Git options', () => {
  let observed: { executable: string; args: string[]; timeout: number; maxBuffer: number; locale: string | undefined } | undefined;
  const commit = 'a'.repeat(40);
  const result = resolveCheckpointSourceCommit('/repository', (executable, args, options) => {
    observed = {
      executable,
      args,
      timeout: options.timeout,
      maxBuffer: options.maxBuffer,
      locale: options.env.LC_ALL,
    };
    return `${commit}\n`;
  });
  assert.equal(result, commit);
  assert.ok(observed!.timeout > 0 && observed!.timeout <= 5_000);
  assert.deepEqual({ ...observed, timeout: 5_000 }, {
    executable: 'git',
    args: ['rev-parse', '--verify', 'HEAD^{commit}'],
    timeout: 5_000,
    maxBuffer: 64 * 1024,
    locale: 'C',
  });
  assert.equal(resolveCheckpointSourceCommit('/repository', () => 'b'.repeat(64)), 'b'.repeat(64));
});

test('rejects malformed successful Git output as an integrity failure', () => {
  for (const output of ['', 'deadbee\n', `${'A'.repeat(40)}\n`, `${'a'.repeat(40)}\nsecond-line\n`, `${'a'.repeat(40)} `]) {
    assert.throws(
      () => resolveCheckpointSourceCommit('/unused', () => output),
      (error: unknown) => (error as { code?: string; message?: string }).code === 'INTEGRITY_ERROR'
        && (error as { message?: string }).message === 'Git checkpoint provenance is invalid',
    );
  }
});

test('propagates timeout, permission, and unexpected Git failures as typed failures', () => {
  const failures = [
    processFailure({ status: null, signal: 'SIGTERM', code: 'ETIMEDOUT', killed: true }),
    processFailure({ status: undefined, signal: undefined, code: 'EACCES' }),
    processFailure({ status: 128, stderr: 'fatal: detected dubious ownership in repository\n' }),
    processFailure({ status: 128, stderr: 'fatal: Needed a single revision\nunexpected detail\n' }),
    ...['ETIMEDOUT', 'EACCES', 'EPERM', 'ENOENT', 'ENOBUFS'].map((code) => processFailure({
      status: 128, signal: null, code, stderr: 'fatal: Needed a single revision\n',
    })),
    processFailure({ status: 128, signal: 'SIGTERM', stderr: 'fatal: Needed a single revision\n' }),
    processFailure({ status: 128, killed: true, stderr: 'fatal: Needed a single revision\n' }),
    processFailure({ status: 128, stderr: 'fatal: Needed a single revision \n' }),
    processFailure({ status: 128, stderr: 'fatal: Needed a single revision\n\n' }),
    new TypeError('programmer-bug-sentinel'),
  ];
  for (const failure of failures) {
    assert.throws(
      () => resolveCheckpointSourceCommit('/unused', throwing(failure)),
      (error: unknown) => (error as { code?: string; message?: string }).code === 'SERVICE_UNAVAILABLE'
        && (error as { message?: string }).message === 'Git checkpoint provenance could not be resolved'
        && !(error as { message?: string }).message?.includes('sentinel'),
    );
  }
});

test('shares the time budget across probes and refuses noisy missing-ref results', async (t) => {
  const root = await repository(t);
  const budgets: number[] = [];
  const run = (_command: string, args: string[], options: { timeout: number }) => {
    budgets.push(options.timeout);
    if (args.includes('HEAD^{commit}')) {
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 15);
      throw processFailure({ status: 128, stderr: 'fatal: Needed a single revision\n' });
    }
    if (args.includes('--absolute-git-dir')) return `${root}/.git\n`;
    if (args[0] === 'symbolic-ref') return 'refs/heads/main\n';
    if (args[0] === 'check-ref-format') return '';
    throw processFailure({ status: 1, stderr: 'unexpected diagnostic\n' });
  };
  assert.throws(() => resolveCheckpointSourceCommit(root, run), { code: 'SERVICE_UNAVAILABLE' });
  assert.ok(budgets.length > 1 && budgets[1]! < budgets[0]!);
  assert.ok(budgets.every((budget, index) => budget > 0 && budget <= (budgets[index - 1] ?? 5_000)));
});

test('valid real commits and linked worktree unborn refs keep Git storage semantics', async (t) => {
  const root = await repository(t);
  execFileSync('git', ['-C', root, '-c', 'core.hooksPath=/dev/null', '-c', 'commit.gpgsign=false',
    '-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-q', '--allow-empty', '-m', 'fixture']);
  assert.equal(resolveCheckpointSourceCommit(root), execFileSync('git', ['-C', root, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim());
  const linked = path.join(root, 'linked');
  execFileSync('git', ['-C', root, 'worktree', 'add', '-q', '-b', 'linked', linked]);
  execFileSync('git', ['-C', linked, 'symbolic-ref', 'HEAD', 'refs/heads/unborn']);
  assert.equal(resolveCheckpointSourceCommit(linked), null);
  await writeFile(path.join(root, '.git', 'refs/heads/unborn'), 'invalid\n');
  assert.throws(() => resolveCheckpointSourceCommit(linked), { code: 'SERVICE_UNAVAILABLE' });
});

test('an explicit unusable GIT_DIR is not interpreted as an ordinary non-repository', async (t) => {
  const root = await repository(t);
  const source = `import { resolveCheckpointSourceCommit } from './src/memory/scoped-memory.ts';
    try { console.log(JSON.stringify({ commit: resolveCheckpointSourceCommit(process.argv[1]) })); }
    catch (error) { console.log(JSON.stringify({ code: error.code })); }`;
  const output = execFileSync(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', source, root], {
    encoding: 'utf8', env: { ...process.env, GIT_DIR: path.join(root, 'missing-git-dir') },
  });
  assert.deepEqual(JSON.parse(output), { code: 'SERVICE_UNAVAILABLE' });
});

test('non-repository marker checks respect a realpath-normalized Git discovery ceiling', async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), 'kiokuko-git-ceiling-'));
  const link = root + '-link';
  t.after(() => rm(link, { force: true }));
  t.after(() => rm(root, { recursive: true, force: true }));
  await symlink(root, link);
  await mkdir(path.join(root, '.git'));
  const child = path.join(root, 'child'); await mkdir(child);
  const source = `import {resolveCheckpointSourceCommit} from './src/memory/scoped-memory.ts'; console.log(JSON.stringify(resolveCheckpointSourceCommit(process.argv[1])));`;
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('GIT_')));
  const output = execFileSync(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', source, child], {
    encoding: 'utf8', env: { ...env, GIT_CEILING_DIRECTORIES: link },
  });
  assert.equal(output.trim(), 'null');
});
