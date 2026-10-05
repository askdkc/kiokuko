// Run in the dedicated Linux CI container: its /tmp ancestors are controlled.
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { detectRepositoryRoot } from '../../dist/repository/detect-root.js';

const root = await mkdtemp('/tmp/kiokuko-root-smoke-');
try {
  assert.throws(() => detectRepositoryRoot({ cwd: root }), { code: 'NOT_FOUND' });
  assert.deepEqual(detectRepositoryRoot({ cwd: root, allowDirectory: true }), { root, source: 'directory' });
  const child = path.join(root, 'child');
  await mkdir(child);
  await mkdir(path.join(root, '.git'));
  assert.deepEqual(detectRepositoryRoot({ cwd: child }), { root, source: 'git-marker' });
  execFileSync('git', ['init', '-q', root]);
  assert.deepEqual(detectRepositoryRoot({ cwd: child }), { root, source: 'git' });
  await writeFile(path.join(root, '.kiokuko.json'), '{}');
  assert.deepEqual(detectRepositoryRoot({ cwd: child }), { root, source: 'binding' });
  console.log('repository root: no-root, allowDirectory, marker, Git and binding passed');
} finally { await rm(root, { recursive: true, force: true }); }
