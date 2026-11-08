import assert from 'node:assert/strict';
import test from 'node:test';
import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { codexProjectWorktrees } from '../../src/setup/codex-projects.js';

test('Codex project discovery accepts only bounded profile roots and canonicalizes live Git worktrees', async () => {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), 'kiokuko-codex-projects-')));
  const config = path.join(root, 'config.toml');
  const state = path.join(root, '.codex-global-state.json');
  const project = path.join(root, 'repo');
  const child = path.join(project, 'child');
  try {
    assert.deepEqual(await codexProjectWorktrees(config), []);
    execFileSync('git', ['init', '-q', project]);
    await mkdir(child);
    const value = { 'electron-saved-workspace-roots': [project, child, path.join(root, 'gone'), root],
      'active-workspace-roots': ['/unrelated/active'], 'thread-workspace-root-hints': { old: '/unrelated/history' } };
    await writeFile(state, JSON.stringify(value));
    assert.deepEqual(await codexProjectWorktrees(config), [project]);
    assert.deepEqual(JSON.parse(await readFile(state, 'utf8')), value);
    const modern = path.join(root, 'modern');
    execFileSync('git', ['init', '-q', modern]);
    await writeFile(state, JSON.stringify({ ...value, 'local-projects': {
      modern: { id: 'modern', name: 'Modern', rootPaths: [modern, project] },
    } }));
    assert.deepEqual(await codexProjectWorktrees(config), [project, modern]);
    for (const roots of [['relative'], [project, null], Array(257).fill(project)]) {
      await writeFile(state, JSON.stringify({ 'electron-saved-workspace-roots': roots }));
      await assert.rejects(codexProjectWorktrees(config), /bounded list/u);
    }
    await writeFile(state, '{bad');
    await assert.rejects(codexProjectWorktrees(config), SyntaxError);
    await writeFile(state, ' '.repeat(8 * 1024 * 1024 + 1));
    await assert.rejects(codexProjectWorktrees(config), /bounded regular file/u);
    await rm(state);
    await writeFile(path.join(root, 'foreign.json'), '{}');
    await symlink(path.join(root, 'foreign.json'), state);
    await assert.rejects(codexProjectWorktrees(config));
  } finally { await rm(root, { recursive: true, force: true }); }
});
