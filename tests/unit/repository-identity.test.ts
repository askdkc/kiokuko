import assert from 'node:assert/strict';
import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test, { type TestContext } from 'node:test';
import { canonicalDirectory, detectRepositoryRoot } from '../../src/repository/detect-root.js';
import { resolveRepositoryRoot } from '../../src/repository/resolve-root.js';
import { KiokukoError } from '../../src/errors.js';
import { createRepositoryIdentity } from '../../src/repository/identity.js';
import { fingerprintRemoteUrl, normalizeRemoteUrl } from '../../src/repository/remote-url.js';

async function temp(t: TestContext, prefix: string): Promise<string> {
  const directory = await realpath(await mkdtemp(path.join(tmpdir(), `kiokuko-${prefix}-`)));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return directory;
}

test('detects a realpath-normalized git marker from a subdirectory', async (t) => {
  const root = await temp(t, 'root');
  await mkdir(path.join(root, '.git'));
  const nested = path.join(root, 'src', 'deep');
  await mkdir(nested, { recursive: true });
  const link = `${root}-link`;
  t.after(() => rm(link, { force: true }));
  await symlink(root, link);
  assert.equal(detectRepositoryRoot({ cwd: nested }).root, root);
  assert.equal(detectRepositoryRoot({ cwd: path.join(link, 'src') }).root, root);
});

test('prefers an ancestor binding over a real git root', async (t) => {
  const root = await temp(t, 'binding-root');
  execFileSync('git', ['init', '-q', root]);
  await writeFile(path.join(root, '.kiokuko.json'), '{}');
  const nested = path.join(root, 'packages', 'app');
  await mkdir(nested, { recursive: true });
  assert.equal(detectRepositoryRoot({ cwd: nested }).source, 'binding');
  assert.equal(detectRepositoryRoot({ cwd: nested }).root, root);
});

test('requires allowDirectory when no binding or git root exists, independently of host ancestors', () => {
  const directory = path.resolve('/closed/fixture/child');
  const absent = { exists: () => false, gitRoot: () => undefined };
  assert.throws(() => resolveRepositoryRoot(directory, undefined, false, absent), { code: 'NOT_FOUND' });
  assert.deepEqual(resolveRepositoryRoot(directory, undefined, true, absent), { root: directory, source: 'directory' });
  const parent = path.dirname(directory);
  assert.deepEqual(resolveRepositoryRoot(directory, undefined, true, {
    ...absent, exists: (file) => file === path.join(parent, '.git'),
  }), { root: parent, source: 'git-marker' });
});

test('real Git discovery returns the canonical root', async (t) => {
  const root = await temp(t, 'real-git');
  execFileSync('git', ['init', '-q', root]);
  const child = path.join(root, 'child');
  await mkdir(child);
  assert.deepEqual(detectRepositoryRoot({ cwd: child }), { root, source: 'git' });
});

test('canonical directory rejects relative and missing paths with typed failures', async (t) => {
  const directory = await temp(t, 'canonical-directory');
  const missing = path.join(directory, 'missing');
  const file = path.join(directory, 'file');
  await writeFile(file, 'not a directory');

  assert.throws(
    () => canonicalDirectory('relative/repository'),
    (error: unknown) => error instanceof KiokukoError && error.code === 'VALIDATION_ERROR',
  );
  assert.throws(
    () => canonicalDirectory(missing),
    (error: unknown) => error instanceof KiokukoError && error.code === 'NOT_FOUND',
  );
  assert.throws(
    () => canonicalDirectory(path.join(file, 'child')),
    (error: unknown) => error instanceof KiokukoError && error.code === 'NOT_FOUND',
  );
});

test('normalizes HTTPS and SCP-like SSH remotes without credentials', () => {
  const https = normalizeRemoteUrl('https://user:secret@GitHub.COM/org/repo.git?token=hidden#frag');
  const ssh = normalizeRemoteUrl('git@github.com:org/repo.git');
  const sshUrl = normalizeRemoteUrl('ssh://git@github.com/org/repo.git');
  assert.equal(https, 'github.com/org/repo');
  assert.equal(ssh, https);
  assert.equal(sshUrl, https);
  assert.doesNotMatch(https, /secret|token|user|@/i);
  assert.equal(fingerprintRemoteUrl('https://github.com/org/repo.git'), fingerprintRemoteUrl('git@github.com:org/repo.git'));
});

test('derives stable IDs and collision-resistant workspaces', () => {
  const first = createRepositoryIdentity({
    repositoryRoot: '/tmp/sample-app',
    remoteUrl: 'https://github.com/acme/sample-app.git',
  });
  const second = createRepositoryIdentity({
    repositoryRoot: '/tmp/sample-app',
    remoteUrl: 'https://github.com/other/sample-app.git',
  });
  assert.match(first.repositoryId, /^repo_[a-f0-9]+$/);
  assert.equal(first.repositoryId, `repo_${fingerprintRemoteUrl('https://github.com/acme/sample-app.git').slice(7, 19)}`);
  assert.notEqual(first.repositoryId, second.repositoryId);
  assert.notEqual(first.workspace, second.workspace);
  assert.match(first.workspace, /^project:sample-app-[a-f0-9]+$/);
});

test('keeps an origin-less UUID identity when a binding is supplied', () => {
  const first = createRepositoryIdentity({ repositoryRoot: '/tmp/local-project' });
  const second = createRepositoryIdentity({
    repositoryRoot: '/tmp/moved-local-project',
    existingBinding: { repositoryId: first.repositoryId, workspace: first.workspace },
  });
  assert.match(first.repositoryId, /^repo_[0-9a-f-]{36}$/);
  assert.equal(second.repositoryId, first.repositoryId);
  assert.equal(second.workspace, first.workspace);
});
