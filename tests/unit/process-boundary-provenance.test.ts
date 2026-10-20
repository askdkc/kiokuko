import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { resolveCheckpointSourceCommit } from '../../src/memory/git-provenance.js';

test('checkpoint provenance ignores inherited Git selection and configuration', async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), 'kiokuko-git-boundary-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const saved = { ...process.env };
  t.after(() => { for (const key of Object.keys(process.env)) delete process.env[key]; Object.assign(process.env, saved); });
  for (const key of Object.keys(process.env)) if (key.startsWith('GIT_')) delete process.env[key];
  process.env.HOME = root;
  process.env.XDG_CONFIG_HOME = root;
  const git = (cwd: string, ...args: string[]) => execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8', env: { ...process.env, GIT_CONFIG_NOSYSTEM: '1' } }).trim();
  const makeRepo = async (name: string) => {
    const cwd = path.join(root, name); await mkdir(cwd);
    git(cwd, 'init', '-q', '--initial-branch=main');
    await writeFile(path.join(cwd, 'source'), name);
    git(cwd, 'add', 'source');
    git(cwd, '-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', '-c', 'commit.gpgsign=false', '-c', 'core.hooksPath=/dev/null', 'commit', '-qm', name);
    return { cwd, head: git(cwd, 'rev-parse', 'HEAD') };
  };
  const a = await makeRepo('requested'); const b = await makeRepo('unrelated');
  const linked = path.join(root, 'linked'); git(a.cwd, 'worktree', 'add', '-qb', 'linked', linked);
  const nested = path.join(a.cwd, 'nested'); await mkdir(nested);
  Object.assign(process.env, { GIT_DIR: path.join(b.cwd, '.git'), GIT_WORK_TREE: b.cwd, GIT_COMMON_DIR: path.join(b.cwd, '.git'), GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'core.bare', GIT_CONFIG_VALUE_0: 'true' });
  assert.equal(resolveCheckpointSourceCommit(a.cwd), a.head);
  assert.notEqual(a.head, b.head);
  assert.equal(resolveCheckpointSourceCommit(linked), a.head, 'linked .git file is supported');
  assert.equal(resolveCheckpointSourceCommit(nested), null, 'a parent checkout must not masquerade as the registered root');
  const plain = path.join(root, 'plain'); await mkdir(plain);
  assert.equal(resolveCheckpointSourceCommit(plain), null);
});
