import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { copyFile, mkdir, mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { initializeDatabase } from '../../src/commands/init.js';
import { openConnection } from '../../src/db/connection.js';
import { migrateDatabase } from '../../src/db/migrate.js';

const repositoryRoot = path.resolve(import.meta.dirname, '../..');
const currentMigrations = path.join(repositoryRoot, 'migrations');
const releasedVersions = ['v0.1.1', 'v0.1.2', 'v0.1.3'] as const;
// Every published tag above shipped these exact immutable assets. Fixed hashes
// keep the fixtures tied to the releases even after later migrations are added.
const releasedMigrationHashes = {
  '001_initial.sql': 'bb4c8d69a418ee809fa057e4c656a65b896357ac222d86cfaf711cecddc41496',
  '002_fts.sql': 'bf01abce9c9f9f16d2c03c12cd7dd0b594189fc8f06946742f57b4fc958e5c18',
  '003_akinator.sql': 'fbb08def145ca5d16d71032035b7ddd307cc405298929efd3984a921d7e30baf',
  '004_agent_gateway.sql': 'e486560777bf37f63a8a51cbcdff0d803316e857c626e3b43bffb3865181a6aa',
} as const;

async function releasedMigrations(root: string): Promise<string> {
  const directory = path.join(root, 'released-migrations');
  await mkdir(directory);
  for (const [name, expectedHash] of Object.entries(releasedMigrationHashes)) {
    const source = path.join(currentMigrations, name);
    const content = await readFile(source);
    assert.equal(createHash('sha256').update(content).digest('hex'), expectedHash, `${name} no longer matches the released asset`);
    await copyFile(source, path.join(directory, name));
  }
  return directory;
}

for (const release of releasedVersions) {
  test(`upgrades a ${release} database without losing released-schema data`, async () => {
    const root = await mkdtemp(path.join(tmpdir(), `kiokuko-release-${release}-`));
    const migrations = await releasedMigrations(root);
    const databasePath = path.join(root, `${release}.sqlite3`);
    const released = openConnection(databasePath);
    try {
      assert.deepEqual(migrateDatabase(released, migrations).applied, [1, 2, 3, 4]);
      const now = '2026-08-21T00:00:00.000Z';
      released.prepare(`
        INSERT INTO repositories (
          repository_id, workspace, display_name, remote_fingerprint,
          binding_schema_version, agent_template_version, created_at, last_used_at
        ) VALUES (?, ?, ?, NULL, 1, 1, ?, ?)
      `).run(`repo-${release}`, `workspace-${release}`, release, now, now);
      released.prepare(`
        INSERT INTO entries (
          id, workspace, kind, status, title, body, summary, scope_json, provenance_json,
          trust_level, confidence, content_hash, revision, created_by, created_at, updated_at
        ) VALUES (?, ?, 'lesson', 'candidate', ?, ?, NULL, '{}', '{}', 'user_asserted', 0.8, ?, 1, 'release-fixture', ?, ?)
      `).run(`entry-${release}`, `workspace-${release}`, release, `preserve ${release}`, `hash-${release}`, now, now);
      released.prepare(`
        INSERT INTO akinator_sessions (id, workspace, task_text, profile_json, status, question_count, created_at, updated_at)
        VALUES (?, ?, 'Upgrade fixture', '{}', 'active', 0, ?, ?)
      `).run(`session-${release}`, `workspace-${release}`, now, now);
    } finally {
      released.close();
    }

    const result = await initializeDatabase({ databasePath, migrationsDirectory: currentMigrations });
    assert.equal(result.currentVersion >= 4, true);
    assert.equal(result.backupPath === null, result.applied.length === 0);

    const upgraded = openConnection(databasePath);
    try {
      assert.equal(upgraded.prepare('SELECT body FROM entries WHERE id = ?').get<{ body: string }>(`entry-${release}`)?.body, `preserve ${release}`);
      assert.equal(upgraded.prepare('SELECT task_text FROM akinator_sessions WHERE id = ?').get<{ task_text: string }>(`session-${release}`)?.task_text, 'Upgrade fixture');
      assert.equal(upgraded.prepare('PRAGMA integrity_check').get<{ integrity_check: string }>()?.integrity_check, 'ok');
    } finally {
      upgraded.close();
    }
  });
}
