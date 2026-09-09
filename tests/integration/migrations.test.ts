import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, readdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { initializeDatabase } from '../../src/commands/init.js';
import { openConnection } from '../../src/db/connection.js';
import { loadMigrationSnapshot, migrateDatabase } from '../../src/db/migrate.js';
import { KiokukoError } from '../../src/errors.js';

const invalid = (error: unknown): boolean => error instanceof KiokukoError && error.code === 'INTEGRITY_ERROR';

test('one baseline creates current schema and is idempotent', () => {
  const database = openConnection(':memory:');
  try {
    assert.deepEqual(loadMigrationSnapshot().migrations.map(m => m.name), ['001_baseline.sql']);
    assert.deepEqual(migrateDatabase(database), { applied: [1], currentVersion: 1 });
    assert.deepEqual(migrateDatabase(database), { applied: [], currentVersion: 1 });
    assert.deepEqual(database.prepare('PRAGMA foreign_key_check').all(), []);
    const names = database.prepare('SELECT name FROM sqlite_schema').all<{ name: string }>().map(r => r.name);
    assert.ok(names.includes('entry_search_documents'));
    assert.ok(names.includes('embedding_settings'));
    assert.deepEqual(database.prepare('PRAGMA table_info(context_deliveries)').all<{ name: string }>().map(row => row.name), [
      'delivery_id', 'run_id', 'through_sequence', 'intake_session_id', 'task_profile_hash', 'query_hash',
      'policy_version', 'char_budget', 'char_count', 'truncated', 'created_at', 'score_schema_version',
    ]);
    assert.ok(!names.some(name => /enno|oduno|zenki|goki/i.test(name)));
    assert.ok(!database.prepare('PRAGMA table_info(agent_task_skill_discovery_attempts)').all<{ name: string }>().some(r => r.name === 'phase'));
  } finally { database.close(); }
});

test('SQL and migration marker roll back together, and a corrected baseline can retry', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'kiokuko-baseline-rollback-'));
  const sql = path.join(directory, '001_baseline.sql');
  await writeFile(sql, 'CREATE TABLE retained(id INTEGER PRIMARY KEY); INSERT INTO missing VALUES (1);');
  const database = openConnection(':memory:');
  try {
    assert.throws(() => migrateDatabase(database, directory), /missing/);
    assert.deepEqual(database.prepare("SELECT name FROM sqlite_schema WHERE name NOT LIKE 'sqlite_%'").all(), []);
    await writeFile(sql, 'CREATE TABLE retained(id INTEGER PRIMARY KEY);');
    assert.deepEqual(migrateDatabase(database, directory).applied, [1]);
  } finally { database.close(); }
});

for (const mode of ['old', 'missing-history', 'empty-history', 'checksum', 'future'] as const) {
  test(`initialization refuses ${mode} without changing database or sidecar contents`, async () => {
    const directory = await mkdtemp(path.join(tmpdir(), `kiokuko-baseline-${mode}-`));
    const databasePath = path.join(directory, 'data.sqlite3');
    const database = openConnection(databasePath);
    try {
      if (mode === 'missing-history' || mode === 'empty-history') {
        database.exec('CREATE TABLE user_data(value TEXT); INSERT INTO user_data VALUES (\'preserve\');');
        if (mode === 'empty-history') database.exec('CREATE TABLE schema_migrations(version INTEGER PRIMARY KEY, name TEXT, checksum TEXT, applied_at TEXT);');
      } else if (mode === 'old') {
        database.exec(await readFile(new URL('../fixtures/unsupported-database.sql', import.meta.url), 'utf8'));
      } else {
        migrateDatabase(database);
        if (mode === 'checksum') database.exec("UPDATE schema_migrations SET checksum='modified';");
        if (mode === 'future') database.exec("INSERT INTO schema_migrations VALUES (2, '002_future.sql', 'future', '2026-01-01T00:00:00.000Z');");
      }
      const names = await readdir(directory);
      const before = await Promise.all(names.map(name => readFile(path.join(directory, name))));
      await assert.rejects(initializeDatabase({ databasePath }), (error: unknown) => invalid(error)
        && error instanceof Error && error.message.includes(databasePath) && error.message.includes('KIOKUKO_DATA_DIR'));
      assert.deepEqual(await readdir(directory), names);
      for (const [index, name] of names.entries()) assert.deepEqual(await readFile(path.join(directory, name)), before[index]);
    } finally { database.close(); }
  });
}

test('foreign-key failure rolls back initialization of a new file', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'kiokuko-baseline-fk-'));
  const migrationsDirectory = path.join(directory, 'migrations');
  await mkdir(migrationsDirectory);
  await writeFile(path.join(migrationsDirectory, '001_baseline.sql'), `
    CREATE TABLE parent(id INTEGER PRIMARY KEY);
    CREATE TABLE child(id INTEGER REFERENCES parent(id) DEFERRABLE INITIALLY DEFERRED);
    INSERT INTO child VALUES (1);
  `);
  const databasePath = path.join(directory, 'data.sqlite3');
  await assert.rejects(initializeDatabase({ databasePath, migrationsDirectory }), invalid);
  const database = openConnection(databasePath, { readOnly: true });
  try { assert.deepEqual(database.prepare("SELECT name FROM sqlite_schema WHERE name NOT LIKE 'sqlite_%'").all(), []); }
  finally { database.close(); }
});

test('reinitialization leaves the supported database file unchanged', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'kiokuko-baseline-repeat-'));
  const databasePath = path.join(directory, 'data.sqlite3');
  const first = await initializeDatabase({ databasePath });
  const before = await readFile(databasePath);
  const second = await initializeDatabase({ databasePath });
  assert.deepEqual(first.applied, [1]);
  assert.deepEqual(second.applied, []);
  assert.deepEqual(await readFile(databasePath), before);
});

test('refuses a non-SQLite file with path and new-directory guidance without modifying it', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'kiokuko-baseline-non-sqlite-'));
  const databasePath = path.join(directory, 'data.sqlite3');
  const contents = Buffer.from('This existing file is not a database.');
  await writeFile(databasePath, contents);
  await assert.rejects(initializeDatabase({ databasePath }), (error: unknown) => invalid(error)
    && error instanceof Error && error.message.includes(databasePath) && error.message.includes('KIOKUKO_DATA_DIR'));
  assert.deepEqual(await readFile(databasePath), contents);
  assert.deepEqual(await readdir(directory), ['data.sqlite3']);
});

test('refuses orphan sidecars before reserving a new database and preserves their contents', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'kiokuko-orphan-sidecars-'));
  const databasePath = path.join(directory, 'data.sqlite3');
  for (const suffix of ['-wal', '-shm', '-journal']) await writeFile(`${databasePath}${suffix}`, `preserve${suffix}`);
  const names = await readdir(directory);
  await assert.rejects(initializeDatabase({ databasePath }), invalid);
  assert.deepEqual(await readdir(directory), names);
  for (const suffix of ['-wal', '-shm', '-journal']) assert.equal(await readFile(`${databasePath}${suffix}`, 'utf8'), `preserve${suffix}`);
});

test('refuses sidecars that appear after fresh path reservation without opening SQLite', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'kiokuko-sidecar-race-'));
  const databasePath = path.join(directory, 'data.sqlite3');
  await assert.rejects(initializeDatabase({ databasePath }, {
    afterPathReserved: async () => { await writeFile(`${databasePath}-wal`, 'preserve racing WAL'); },
  }), invalid);
  assert.equal((await readFile(databasePath)).length, 0);
  assert.equal(await readFile(`${databasePath}-wal`, 'utf8'), 'preserve racing WAL');
});

test('refuses a rollback journal without invoking SQLite recovery', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'kiokuko-journal-refusal-'));
  const databasePath = path.join(directory, 'data.sqlite3');
  await initializeDatabase({ databasePath });
  await writeFile(`${databasePath}-journal`, 'preserve journal');
  const before = await readFile(databasePath);
  await assert.rejects(initializeDatabase({ databasePath }), invalid);
  assert.deepEqual(await readFile(databasePath), before);
  assert.equal(await readFile(`${databasePath}-journal`, 'utf8'), 'preserve journal');
});

const embeddingTables = [
  'embedding_profiles',
  'embedding_runtime',
  'entry_embeddings',
  'embedding_jobs',
  'query_embeddings',
] as const;

test('baseline installs the derived embedding schema without provider I/O', () => {
  const database = openConnection(':memory:');
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (() => {
    throw new Error('provider I/O is forbidden during migration');
  }) as typeof fetch;
  try {
    const result = migrateDatabase(database);
    assert.equal(result.currentVersion, 1);
    assert.deepEqual(result.applied, [1]);
    for (const table of embeddingTables) {
      assert.equal(
        database.prepare("SELECT 1 AS present FROM sqlite_master WHERE type = 'table' AND name = ?").get(table)?.present,
        1,
        `missing ${table}`,
      );
    }
    const runtime = database.prepare('SELECT singleton, active_profile_id, generation, activated_at FROM embedding_runtime').get();
    assert.deepEqual(runtime === undefined ? undefined : { ...runtime }, {
      singleton: 1,
      active_profile_id: null,
      generation: 1,
      activated_at: null,
    });
    assert.deepEqual(database.prepare('PRAGMA foreign_key_check').all(), []);
    assert.deepEqual({ ...(database.prepare('SELECT mode, provider_kind, setup_state FROM embedding_settings').get() as object) }, {
      mode: 'off',
      provider_kind: null,
      setup_state: 'disabled',
    });
    assert.deepEqual(migrateDatabase(database).applied, []);
  } finally {
    globalThis.fetch = originalFetch;
    database.close();
  }
});
