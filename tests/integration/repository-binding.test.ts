import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { openConnection } from '../../src/db/connection.js';
import { migrateDatabase } from '../../src/db/migrate.js';
import { registerRepositoryAndLocation } from '../../src/repository/binding.js';
import { parseProjectConfig } from '../../src/config/project-config.js';

async function temp(prefix: string): Promise<string> {
  return mkdtemp(path.join(tmpdir(), `kiokuko-${prefix}-`));
}

const config = {
  schemaVersion: 1,
  repositoryId: 'repo_aaaaaaaaaaaaaaaa',
  workspace: 'project:sample-aaaaaaaa',
  agentFile: 'AGENT.md',
  templateVersion: 1,
};

test('rejects unknown binding schema versions and fields', () => {
  assert.throws(() => parseProjectConfig({ ...config, schemaVersion: 99 }), /schemaVersion/i);
  assert.throws(() => parseProjectConfig({ ...config, extra: true }), /unknown|field/i);
  assert.throws(() => parseProjectConfig({ ...config, agentFile: '../outside.md' }), /agentFile/i);
});

test('registers one repository at multiple canonical locations transactionally', async () => {
  const directory = await temp('binding');
  const connection = openConnection(path.join(directory, 'kiokuko.sqlite3'));
  try {
    migrateDatabase(connection);
    const first = registerRepositoryAndLocation(connection, {
      repositoryId: config.repositoryId,
      workspace: config.workspace,
      displayName: 'sample',
      canonicalRoot: path.join(directory, 'clone-a'),
      remoteFingerprint: 'sha256:' + '1'.repeat(64),
      bindingSchemaVersion: 1,
      agentTemplateVersion: 1,
    });
    const second = registerRepositoryAndLocation(connection, {
      repositoryId: config.repositoryId,
      workspace: config.workspace,
      displayName: 'sample',
      canonicalRoot: path.join(directory, 'clone-b'),
      remoteFingerprint: 'sha256:' + '1'.repeat(64),
      bindingSchemaVersion: 1,
      agentTemplateVersion: 1,
    });
    assert.equal(first.created, true);
    assert.equal(second.created, false);
    assert.equal(
      connection.prepare('SELECT COUNT(*) AS count FROM repository_locations WHERE repository_id = ?').get<{ count: number }>(config.repositoryId)?.count,
      2,
    );
  } finally {
    connection.close();
  }
});

test('rejects a root or workspace conflict with a different repository identity', async () => {
  const directory = await temp('binding-conflict');
  const connection = openConnection(path.join(directory, 'kiokuko.sqlite3'));
  try {
    migrateDatabase(connection);
    const root = path.join(directory, 'clone');
    registerRepositoryAndLocation(connection, {
      repositoryId: 'repo_first',
      workspace: 'project:first-111111',
      displayName: 'first',
      canonicalRoot: root,
      remoteFingerprint: null,
      bindingSchemaVersion: 1,
      agentTemplateVersion: 1,
    });
    assert.throws(
      () => registerRepositoryAndLocation(connection, {
        repositoryId: 'repo_second',
        workspace: 'project:second-222222',
        displayName: 'second',
        canonicalRoot: root,
        remoteFingerprint: null,
        bindingSchemaVersion: 1,
        agentTemplateVersion: 1,
      }),
      /conflict|rebind/i,
    );
    assert.throws(
      () => registerRepositoryAndLocation(connection, {
        repositoryId: 'repo_third',
        workspace: 'project:first-111111',
        displayName: 'third',
        canonicalRoot: path.join(directory, 'other-clone'),
        remoteFingerprint: null,
        bindingSchemaVersion: 1,
        agentTemplateVersion: 1,
      }),
      /workspace|conflict/i,
    );
    assert.throws(
      () => registerRepositoryAndLocation(connection, {
        repositoryId: 'repo_raw_remote',
        workspace: 'project:raw-333333',
        displayName: 'raw',
        canonicalRoot: path.join(directory, 'raw-clone'),
        remoteFingerprint: 'https://user:secret@example.com/org/repo.git',
        bindingSchemaVersion: 1,
        agentTemplateVersion: 1,
      }),
      /fingerprint|remote/i,
    );
  } finally {
    connection.close();
  }
});
