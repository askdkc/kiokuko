import assert from 'node:assert/strict';
import { chmod, mkdir, mkdtemp, readFile, readdir, rename, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { initializeDatabase } from '../../src/commands/init.js';
import { databaseFileIdentity, openConnection } from '../../src/db/connection.js';
import { migrateDatabase } from '../../src/db/migrate.js';
import { KiokukoError } from '../../src/errors.js';

async function temporaryDirectory(prefix: string): Promise<string> {
  return mkdtemp(path.join(tmpdir(), `kiokuko-init-concurrency-${prefix}-`));
}

async function migrationDirectory(root: string, includeSecond: boolean): Promise<string> {
  const directory = path.join(root, includeSecond ? 'extended-migrations' : 'baseline-migrations');
  await mkdir(directory);
  await writeFile(path.join(directory, '001_baseline.sql'), `
    CREATE TABLE preserved_data (id INTEGER PRIMARY KEY, value TEXT NOT NULL);
  `);
  if (includeSecond) {
    await writeFile(path.join(directory, '002_additional.sql'), `
      CREATE TABLE additional_data (id INTEGER PRIMARY KEY, value TEXT NOT NULL);
    `);
  }
  return directory;
}

async function createVersionOneDatabase(root: string): Promise<{ databasePath: string; baselineMigrations: string }> {
  const baselineMigrations = await migrationDirectory(root, false);
  const databasePath = path.join(root, 'data.sqlite3');
  const database = openConnection(databasePath);
  try {
    migrateDatabase(database, baselineMigrations);
    database.prepare('INSERT INTO preserved_data (id, value) VALUES (1, ?)').run('keep me');
  } finally {
    database.close();
  }
  return { databasePath, baselineMigrations };
}

test('initializeDatabase rejects a database that appears after an absent preflight without mutation', async () => {
  const root = await temporaryDirectory('database-appearance');
  const databasePath = path.join(root, 'data.sqlite3');
  const baselineMigrations = await migrationDirectory(root, false);
  const extendedMigrations = await migrationDirectory(root, true);
  let before: Buffer | undefined;

  await assert.rejects(
    initializeDatabase(
      { databasePath, migrationsDirectory: extendedMigrations },
      {
        async afterPreflight() {
          const appeared = openConnection(databasePath);
          try {
            assert.deepEqual(migrateDatabase(appeared, baselineMigrations).applied, [1]);
            appeared.prepare('INSERT INTO preserved_data (id, value) VALUES (1, ?)').run('appeared intact');
            appeared.exec('PRAGMA journal_mode = DELETE');
          } finally {
            appeared.close();
          }
          before = await readFile(databasePath);
        },
      },
    ),
    (error: unknown) => error instanceof KiokukoError
      && error.code === 'CONFLICT'
      && /appeared after preflight/u.test(error.message),
  );

  assert.ok(before !== undefined);
  assert.deepEqual(await readFile(databasePath), before);
  assert.equal((await readdir(root)).includes('backups'), false);
  const unchanged = openConnection(databasePath, { readOnly: true });
  try {
    assert.equal(unchanged.prepare('PRAGMA journal_mode').get<{ journal_mode: string }>()?.journal_mode, 'delete');
    assert.deepEqual(
      unchanged.prepare('SELECT version, name FROM schema_migrations ORDER BY version')
        .all<Record<string, unknown>>()
        .map((row) => ({ ...row })),
      [{ version: 1, name: '001_baseline.sql' }],
    );
    assert.equal(unchanged.prepare('SELECT value FROM preserved_data WHERE id = 1').get<{ value: string }>()?.value, 'appeared intact');
    assert.equal(unchanged.prepare(
      "SELECT 1 AS present FROM sqlite_master WHERE type = 'table' AND name = 'additional_data'",
    ).get(), undefined);
  } finally {
    unchanged.close();
  }
});

test('initializeDatabase rejects replacement of its reserved fresh path before SQLite opens it', async () => {
  const root = await temporaryDirectory('reserved-path-replacement');
  const databasePath = path.join(root, 'data.sqlite3');
  const reservedPath = path.join(root, 'reserved-empty.sqlite3');
  const baselineMigrations = await migrationDirectory(root, false);
  const extendedMigrations = await migrationDirectory(root, true);
  let replacementBefore: Buffer | undefined;

  await assert.rejects(
    initializeDatabase(
      { databasePath, migrationsDirectory: extendedMigrations },
      {
        async afterPathReserved() {
          await rename(databasePath, reservedPath);
          const replacement = openConnection(databasePath);
          try {
            assert.deepEqual(migrateDatabase(replacement, baselineMigrations).applied, [1]);
            replacement.prepare('INSERT INTO preserved_data (id, value) VALUES (1, ?)').run('reserved replacement intact');
            replacement.exec('PRAGMA journal_mode = DELETE');
          } finally {
            replacement.close();
          }
          replacementBefore = await readFile(databasePath);
        },
      },
    ),
    (error: unknown) => error instanceof KiokukoError
      && error.code === 'CONFLICT'
      && /file identity changed/u.test(error.message),
  );

  assert.ok(replacementBefore !== undefined);
  assert.deepEqual(await readFile(databasePath), replacementBefore);
  assert.equal((await readdir(root)).includes('backups'), false);
  const live = openConnection(databasePath, { readOnly: true });
  try {
    assert.equal(live.prepare('PRAGMA journal_mode').get<{ journal_mode: string }>()?.journal_mode, 'delete');
    assert.equal(live.prepare('SELECT value FROM preserved_data WHERE id = 1').get<{ value: string }>()?.value, 'reserved replacement intact');
    assert.equal(live.prepare(
      "SELECT 1 AS present FROM sqlite_master WHERE type = 'table' AND name = 'additional_data'",
    ).get(), undefined);
  } finally {
    live.close();
  }
});

test('initializeDatabase rejects persistent metadata written to the reserved inode before SQLite opens it', async () => {
  const root = await temporaryDirectory('reserved-inode-metadata');
  const databasePath = path.join(root, 'data.sqlite3');
  const migrations = await migrationDirectory(root, false);
  let rivalBefore: Buffer | undefined;

  await assert.rejects(
    initializeDatabase(
      { databasePath, migrationsDirectory: migrations },
      {
        async afterPathReserved() {
          const rival = openConnection(databasePath);
          try {
            rival.exec('PRAGMA user_version = 77; PRAGMA application_id = 1234; PRAGMA journal_mode = DELETE;');
          } finally {
            rival.close();
          }
          rivalBefore = await readFile(databasePath);
        },
      },
    ),
    (error: unknown) => error instanceof KiokukoError
      && error.code === 'CONFLICT'
      && /Reserved database file changed/u.test(error.message),
  );

  assert.ok(rivalBefore !== undefined);
  assert.deepEqual(await readFile(databasePath), rivalBefore);
  assert.equal((await readdir(root)).includes('backups'), false);
  const unchanged = openConnection(databasePath, { readOnly: true });
  try {
    assert.equal(unchanged.prepare('PRAGMA user_version').get<{ user_version: number }>()?.user_version, 77);
    assert.equal(unchanged.prepare('PRAGMA application_id').get<{ application_id: number }>()?.application_id, 1234);
    assert.equal(unchanged.prepare(
      "SELECT 1 AS present FROM sqlite_master WHERE type = 'table' AND name = 'schema_migrations'",
    ).get(), undefined);
  } finally {
    unchanged.close();
  }
});

test('initializeDatabase rejects a commit to the fresh inode before acquiring its write lock', async () => {
  const root = await temporaryDirectory('fresh-inode-commit');
  const databasePath = path.join(root, 'data.sqlite3');
  const migrations = await migrationDirectory(root, false);

  await assert.rejects(
    initializeDatabase(
      { databasePath, migrationsDirectory: migrations },
      {
        afterWritableOpen() {
          const rival = openConnection(databasePath);
          try {
            rival.exec('PRAGMA user_version = 77; PRAGMA application_id = 1234;');
          } finally {
            rival.close();
          }
        },
      },
    ),
    (error: unknown) => error instanceof KiokukoError
      && error.code === 'CONFLICT'
      && /changed after writable open/u.test(error.message),
  );

  assert.equal((await readdir(root)).includes('backups'), false);
  const unchanged = openConnection(databasePath, { readOnly: true });
  try {
    assert.equal(unchanged.prepare('PRAGMA user_version').get<{ user_version: number }>()?.user_version, 77);
    assert.equal(unchanged.prepare('PRAGMA application_id').get<{ application_id: number }>()?.application_id, 1234);
    assert.equal(unchanged.prepare(
      "SELECT 1 AS present FROM sqlite_master WHERE type = 'table' AND name = 'schema_migrations'",
    ).get(), undefined);
  } finally {
    unchanged.close();
  }
});

test('expected database identity fails before writable chmod or journal configuration', async () => {
  const root = await temporaryDirectory('connection-identity');
  const originalPath = path.join(root, 'data.sqlite3');
  const movedOriginalPath = path.join(root, 'moved-original.sqlite3');
  const migrations = await migrationDirectory(root, false);
  const original = openConnection(originalPath);
  try {
    assert.deepEqual(migrateDatabase(original, migrations).applied, [1]);
    original.exec('PRAGMA journal_mode = DELETE');
  } finally {
    original.close();
  }
  const expectedIdentity = databaseFileIdentity(originalPath);
  await rename(originalPath, movedOriginalPath);

  const replacement = openConnection(originalPath);
  try {
    assert.deepEqual(migrateDatabase(replacement, migrations).applied, [1]);
    replacement.exec('PRAGMA journal_mode = DELETE');
  } finally {
    replacement.close();
  }
  if (process.platform !== 'win32') await chmod(originalPath, 0o644);
  const replacementBefore = await readFile(originalPath);

  assert.throws(
    () => openConnection(originalPath, { expectedFileIdentity: expectedIdentity }),
    (error: unknown) => error instanceof KiokukoError
      && error.code === 'CONFLICT'
      && /file identity changed/u.test(error.message),
  );
  assert.deepEqual(await readFile(originalPath), replacementBefore);
  if (process.platform !== 'win32') {
    assert.equal((await stat(originalPath)).mode & 0o777, 0o644);
  }
  const unchanged = openConnection(originalPath, { readOnly: true });
  try {
    assert.equal(unchanged.prepare('PRAGMA journal_mode').get<{ journal_mode: string }>()?.journal_mode, 'delete');
  } finally {
    unchanged.close();
  }
});

test('initializeDatabase rejects a future-version database before opening it for writes', async () => {
  const root = await temporaryDirectory('future-version');
  const { databasePath, baselineMigrations } = await createVersionOneDatabase(root);
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
    initializeDatabase({ databasePath, migrationsDirectory: baselineMigrations }),
    (error: unknown) => (error as { code?: string }).code === 'INTEGRITY_ERROR' && /newer/i.test((error as Error).message),
  );
  assert.deepEqual(await readFile(databasePath), before);
});

test('current-schema initialization tolerates concurrent data writes after revalidating history under the lock', async () => {
  const root = await temporaryDirectory('no-op-concurrent-write');
  const { databasePath, baselineMigrations } = await createVersionOneDatabase(root);
  const result = await initializeDatabase({ databasePath, migrationsDirectory: baselineMigrations }, {
    afterWritableOpen() {
      const writer = openConnection(databasePath);
      try { writer.prepare('UPDATE preserved_data SET value = ? WHERE id = 1').run('concurrent update'); }
      finally { writer.close(); }
    },
  });
  assert.deepEqual(result.applied, []);
  const database = openConnection(databasePath, { readOnly: true });
  try {
    assert.equal(database.prepare('SELECT value FROM preserved_data WHERE id = 1').get()?.value, 'concurrent update');
    assert.equal(database.prepare('SELECT COUNT(*) AS count FROM schema_migrations').get()?.count, 1);
  } finally { database.close(); }
});

test('no-op initialization still rejects concurrent migration history tampering', async () => {
  const root = await temporaryDirectory('no-op-history-tampering');
  const { databasePath, baselineMigrations } = await createVersionOneDatabase(root);
  await assert.rejects(initializeDatabase({ databasePath, migrationsDirectory: baselineMigrations }, {
    afterWritableOpen() {
      const writer = openConnection(databasePath);
      try { writer.exec("UPDATE schema_migrations SET checksum = 'tampered'"); }
      finally { writer.close(); }
    },
  }), (error: unknown) => error instanceof KiokukoError && error.code === 'INTEGRITY_ERROR' && /checksum mismatch/u.test(error.message));
  const database = openConnection(databasePath, { readOnly: true });
  try {
    assert.equal(database.prepare('SELECT checksum FROM schema_migrations').get()?.checksum, 'tampered');
    assert.equal(database.prepare('SELECT value FROM preserved_data WHERE id = 1').get()?.value, 'keep me');
  } finally { database.close(); }
});
