import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { initializeDatabase } from '../../src/commands/init.js';
import { openConnection } from '../../src/db/connection.js';
import { migrateDatabase } from '../../src/db/migrate.js';

test('initializeDatabase keeps the verified backup and rolls back a failing migration', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'kiokuko-init-migration-failure-'));
  const oldMigrations = path.join(root, 'old-migrations');
  const brokenMigrations = path.join(root, 'broken-migrations');
  await Promise.all([oldMigrations, brokenMigrations].map((directory) => mkdir(directory)));
  const initialSql = 'CREATE TABLE preserved_data (id INTEGER PRIMARY KEY, value TEXT NOT NULL);\n';
  await writeFile(path.join(oldMigrations, '001_initial.sql'), initialSql);
  await writeFile(path.join(brokenMigrations, '001_initial.sql'), initialSql);
  await writeFile(path.join(brokenMigrations, '002_broken.sql'), `
    CREATE TABLE should_rollback (id INTEGER PRIMARY KEY);
    SELECT missing_column FROM missing_table;
  `);
  const databasePath = path.join(root, 'data.sqlite3');
  const initial = openConnection(databasePath);
  try {
    migrateDatabase(initial, oldMigrations);
    initial.prepare('INSERT INTO preserved_data (id, value) VALUES (1, ?)').run('keep me');
  } finally {
    initial.close();
  }

  await assert.rejects(initializeDatabase({ databasePath, migrationsDirectory: brokenMigrations }), /missing_table|no such/i);
  const backups = (await readdir(path.join(root, 'backups'))).filter((name) => name.endsWith('.sqlite3'));
  assert.equal(backups.length, 1);

  for (const candidate of [databasePath, path.join(root, 'backups', backups[0]!)]) {
    const database = openConnection(candidate, { readOnly: true });
    try {
      assert.equal(database.prepare('SELECT value FROM preserved_data WHERE id = 1').get<{ value: string }>()?.value, 'keep me');
      assert.equal(database.prepare('SELECT COUNT(*) AS count FROM schema_migrations').get<{ count: number }>()?.count, 1);
      assert.equal(database.prepare("SELECT 1 AS present FROM sqlite_master WHERE type = 'table' AND name = 'should_rollback'").get(), undefined);
    } finally {
      database.close();
    }
  }
});
