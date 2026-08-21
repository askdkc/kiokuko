import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, readdir, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { initializeDatabase } from '../../src/commands/init.js';
import { openConnection } from '../../src/db/connection.js';
import { migrateDatabase } from '../../src/db/migrate.js';

async function temporaryDirectory(prefix: string): Promise<string> {
  return mkdtemp(path.join(tmpdir(), `kiokuko-init-upgrade-${prefix}-`));
}

async function migrationDirectory(root: string, includeSecond: boolean): Promise<string> {
  const directory = path.join(root, includeSecond ? 'new-migrations' : 'old-migrations');
  await mkdir(directory);
  await writeFile(path.join(directory, '001_initial.sql'), `
    CREATE TABLE preserved_data (id INTEGER PRIMARY KEY, value TEXT NOT NULL);
  `);
  if (includeSecond) {
    await writeFile(path.join(directory, '002_upgrade.sql'), `
      CREATE TABLE upgraded_data (id INTEGER PRIMARY KEY, value TEXT NOT NULL);
    `);
  }
  return directory;
}

async function createVersionOneDatabase(root: string): Promise<{ databasePath: string; oldMigrations: string }> {
  const oldMigrations = await migrationDirectory(root, false);
  const databasePath = path.join(root, 'data.sqlite3');
  const database = openConnection(databasePath);
  try {
    migrateDatabase(database, oldMigrations);
    database.prepare('INSERT INTO preserved_data (id, value) VALUES (1, ?)').run('keep me');
  } finally {
    database.close();
  }
  return { databasePath, oldMigrations };
}

test('initializeDatabase creates and verifies a pre-migration backup before upgrading an existing database', async () => {
  const root = await temporaryDirectory('backup');
  const { databasePath } = await createVersionOneDatabase(root);
  const newMigrations = await migrationDirectory(root, true);

  const result = await initializeDatabase({ databasePath, migrationsDirectory: newMigrations });
  assert.deepEqual(result.applied, [2]);
  assert.match(result.backupPath ?? '', /data\.sqlite3\.pre-upgrade-v1-to-v2-[a-zA-Z0-9_-]+\.sqlite3$/);
  assert.equal((await stat(result.backupPath!)).mode & 0o077, 0);
  assert.deepEqual(await readdir(path.dirname(result.backupPath!)), [path.basename(result.backupPath!)]);

  const backup = openConnection(result.backupPath!, { readOnly: true });
  try {
    assert.equal(backup.prepare('PRAGMA integrity_check').get<{ integrity_check: string }>()?.integrity_check, 'ok');
    assert.equal(backup.prepare('PRAGMA journal_mode').get<{ journal_mode: string }>()?.journal_mode, 'delete');
    assert.equal(backup.prepare('SELECT value FROM preserved_data WHERE id = 1').get<{ value: string }>()?.value, 'keep me');
    assert.equal(backup.prepare('SELECT COUNT(*) AS count FROM schema_migrations').get<{ count: number }>()?.count, 1);
    assert.equal(backup.prepare("SELECT 1 AS present FROM sqlite_master WHERE type = 'table' AND name = 'upgraded_data'").get(), undefined);
  } finally {
    backup.close();
  }

  const upgraded = openConnection(databasePath);
  try {
    assert.equal(upgraded.prepare('SELECT value FROM preserved_data WHERE id = 1').get<{ value: string }>()?.value, 'keep me');
    assert.equal(upgraded.prepare("SELECT 1 AS present FROM sqlite_master WHERE type = 'table' AND name = 'upgraded_data'").get<{ present: number }>()?.present, 1);
  } finally {
    upgraded.close();
  }
});

test('initializeDatabase aborts before migration when the pre-migration backup cannot be created', async () => {
  const root = await temporaryDirectory('backup-failure');
  const { databasePath } = await createVersionOneDatabase(root);
  const newMigrations = await migrationDirectory(root, true);
  await writeFile(path.join(root, 'backups'), 'blocks the backup directory');

  await assert.rejects(
    initializeDatabase({ databasePath, migrationsDirectory: newMigrations }),
    (error: unknown) => (error as { code?: string }).code === 'DATABASE_ERROR' && /pre-migration backup/i.test((error as Error).message),
  );

  const database = openConnection(databasePath);
  try {
    assert.equal(database.prepare('SELECT COUNT(*) AS count FROM schema_migrations').get<{ count: number }>()?.count, 1);
    assert.equal(database.prepare("SELECT 1 AS present FROM sqlite_master WHERE type = 'table' AND name = 'upgraded_data'").get(), undefined);
    assert.equal(database.prepare('SELECT value FROM preserved_data WHERE id = 1').get<{ value: string }>()?.value, 'keep me');
  } finally {
    database.close();
  }
});

test('initializeDatabase rejects a future-version database before opening it for writes', async () => {
  const root = await temporaryDirectory('future-version');
  const { databasePath, oldMigrations } = await createVersionOneDatabase(root);
  const database = openConnection(databasePath);
  try {
    database.prepare(`
      INSERT INTO schema_migrations (version, name, checksum, applied_at)
      VALUES (2, '002_future.sql', ?, ?)
    `).run('f'.repeat(64), '2026-08-21T00:00:00.000Z');
  } finally {
    database.close();
  }
  const before = await readFile(databasePath);

  await assert.rejects(
    initializeDatabase({ databasePath, migrationsDirectory: oldMigrations }),
    (error: unknown) => (error as { code?: string }).code === 'INTEGRITY_ERROR' && /newer/i.test((error as Error).message),
  );
  assert.deepEqual(await readFile(databasePath), before);
});
