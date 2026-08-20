import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { access, mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { initializeDatabase } from '../../src/commands/init.js';
import { openConnection } from '../../src/db/connection.js';
import { checkpointScopedMemory, recallScopedMemory } from '../../src/memory/scoped-memory.js';
import { resolveProjectWorkspace } from '../../src/memory/workspaces.js';

async function gitRepository(prefix: string, remote?: string): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), `kiokuko-scope-${prefix}-`));
  execFileSync('git', ['init', '-q', root]);
  if (remote) execFileSync('git', ['-C', root, 'remote', 'add', 'origin', remote]);
  return root;
}

async function databasePath(prefix: string): Promise<string> {
  const directory = await mkdtemp(path.join(tmpdir(), `kiokuko-scope-db-${prefix}-`));
  const filePath = path.join(directory, 'kiokuko.sqlite3');
  await initializeDatabase({ databasePath: filePath });
  return filePath;
}

test('auto resolution is stable and does not write repository files', async () => {
  const root = await gitRepository('stable');
  const filePath = await databasePath('stable');
  const database = openConnection(filePath);
  try {
    const first = await resolveProjectWorkspace(database, root);
    const second = await resolveProjectWorkspace(database, root);
    assert.ok(first);
    assert.deepEqual(second, { ...first, source: 'location' });
    assert.match(first.repositoryId, /^repo_local_[a-f0-9]{12}$/);
    assert.equal(database.prepare('SELECT COUNT(*) AS count FROM repository_locations').get<{ count: number }>()?.count, 1);
  } finally {
    database.close();
  }
  await assert.rejects(access(path.join(root, '.kiokuko.json')));
  await assert.rejects(access(path.join(root, 'AGENTS.md')));
});

test('two working copies with the same remote share a workspace', async () => {
  const remote = 'git@github.com:example/kiokuko-scope-test.git';
  const firstRoot = await gitRepository('remote-a', remote);
  const secondRoot = await gitRepository('remote-b', remote);
  const filePath = await databasePath('remote');
  const database = openConnection(filePath);
  try {
    const first = await resolveProjectWorkspace(database, firstRoot);
    const second = await resolveProjectWorkspace(database, secondRoot);
    assert.equal(second?.repositoryId, first?.repositoryId);
    assert.equal(second?.workspace, first?.workspace);
    assert.equal(database.prepare('SELECT COUNT(*) AS count FROM repository_locations').get<{ count: number }>()?.count, 2);
  } finally {
    database.close();
  }
});

test('auto recall returns current-project and global memory but never another project', async () => {
  const firstRoot = await gitRepository('isolation-a');
  const secondRoot = await gitRepository('isolation-b');
  const filePath = await databasePath('isolation');
  const database = openConnection(filePath);
  try {
    await checkpointScopedMemory(database, {
      cwd: firstRoot,
      memories: [
        { kind: 'decision', title: 'Alpha durable beacon', body: 'durable-beacon belongs only to alpha' },
        { kind: 'preference', title: 'Global durable beacon', body: 'durable-beacon applies everywhere', scope: 'global' },
      ],
    });
    const fromFirst = await recallScopedMemory(database, { cwd: firstRoot, query: 'durable beacon' });
    assert.equal(fromFirst.project?.memory.items.length, 1);
    assert.equal(fromFirst.global?.items.length, 1);

    const fromSecond = await recallScopedMemory(database, { cwd: secondRoot, query: 'durable beacon' });
    assert.equal(fromSecond.project?.memory.items.length, 0);
    assert.equal(fromSecond.global?.items.length, 1);
    assert.doesNotMatch(JSON.stringify(fromSecond), /belongs only to alpha/);
    assert.match(fromSecond.securityNotice, /untrusted data/);
  } finally {
    database.close();
  }
});
