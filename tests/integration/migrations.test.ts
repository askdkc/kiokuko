import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import test from 'node:test';
import { openConnection } from '../../src/db/connection.js';
import { migrateDatabase } from '../../src/db/migrate.js';

const execFileAsync = promisify(execFile);
const repositoryRoot = path.resolve(import.meta.dirname, '../..');
const initialMigrations = path.join(repositoryRoot, 'migrations');

async function temporaryDirectory(prefix: string): Promise<string> {
  return mkdtemp(path.join(tmpdir(), `kiokuko-${prefix}-`));
}

test('applies the initial migration and is idempotent', async () => {
  const directory = await temporaryDirectory('first');
  const databasePath = path.join(directory, 'data.sqlite3');
  const connection = openConnection(databasePath);
  try {
    const first = migrateDatabase(connection, initialMigrations);
    assert.deepEqual(first.applied, [1, 2, 3, 4]);
    assert.equal(connection.prepare('SELECT COUNT(*) AS count FROM schema_migrations').get<{ count: number }>()?.count, 4);
    for (const table of [
      'repositories',
      'repository_locations',
      'entries',
      'tags',
      'entry_links',
      'audit_events',
      'akinator_sessions',
      'akinator_answers',
      'knowledge_sources',
      'ledger_runs',
      'run_intakes',
      'intake_feedback',
      'ledger_events',
      'ledger_evidence',
      'context_deliveries',
      'context_delivery_entries',
      'context_feedback',
      'run_feedback',
      'ledger_memory_links',
      'ledger_purge_audit',
    ]) {
      assert.equal(
        connection.prepare("SELECT 1 AS present FROM sqlite_master WHERE type = 'table' AND name = ?").get<{ present: number }>(table)?.present,
        1,
        `missing ${table}`,
      );
    }
  } finally {
    connection.close();
  }

  const reopened = openConnection(databasePath);
  try {
    assert.deepEqual(migrateDatabase(reopened, initialMigrations).applied, []);
  } finally {
    reopened.close();
  }
});

test('rejects a changed checksum for an applied migration', async () => {
  const directory = await temporaryDirectory('checksum');
  const migrationsDirectory = path.join(directory, 'migrations');
  await mkdir(migrationsDirectory);
  const migrationPath = path.join(migrationsDirectory, '001_initial.sql');
  await writeFile(migrationPath, 'CREATE TABLE checksum_fixture (id INTEGER PRIMARY KEY);\n');
  const databasePath = path.join(directory, 'data.sqlite3');
  const connection = openConnection(databasePath);
  try {
    migrateDatabase(connection, migrationsDirectory);
  } finally {
    connection.close();
  }
  await writeFile(migrationPath, 'CREATE TABLE checksum_fixture (id INTEGER PRIMARY KEY, value TEXT);\n');

  const reopened = openConnection(databasePath);
  try {
    assert.throws(() => migrateDatabase(reopened, migrationsDirectory), /checksum/i);
  } finally {
    reopened.close();
  }
});

test('rolls back the complete migration when SQL fails', async () => {
  const directory = await temporaryDirectory('rollback');
  const migrationsDirectory = path.join(directory, 'migrations');
  await mkdir(migrationsDirectory);
  await writeFile(
    path.join(migrationsDirectory, '001_broken.sql'),
    'CREATE TABLE should_rollback (id INTEGER PRIMARY KEY);\nSELECT missing_column FROM missing_table;\n',
  );
  const connection = openConnection(path.join(directory, 'data.sqlite3'));
  try {
    assert.throws(() => migrateDatabase(connection, migrationsDirectory), /missing_table|no such/i);
    assert.equal(
      connection.prepare("SELECT 1 AS present FROM sqlite_master WHERE type = 'table' AND name = 'should_rollback'").get(),
      undefined,
    );
    assert.equal(connection.prepare('SELECT COUNT(*) AS count FROM schema_migrations').get<{ count: number }>()?.count, 0);
  } finally {
    connection.close();
  }
});

test('concurrent processes initialize one migration exactly once', async () => {
  const directory = await temporaryDirectory('concurrent');
  const databasePath = path.join(directory, 'data.sqlite3');
  const script = `
    import { openConnection } from './src/db/connection.ts';
    import { migrateDatabase } from './src/db/migrate.ts';
    const connection = openConnection(process.env.KIOKUKO_DATABASE);
    try { migrateDatabase(connection, process.env.KIOKUKO_MIGRATIONS); } finally { connection.close(); }
  `;
  await Promise.all(
    Array.from({ length: 4 }, () =>
      execFileAsync(
        process.execPath,
        ['--import', 'tsx', '--input-type=module', '-e', script],
        {
          cwd: repositoryRoot,
          env: {
            ...process.env,
            KIOKUKO_DATABASE: databasePath,
            KIOKUKO_MIGRATIONS: initialMigrations,
          },
        },
      ),
    ),
  );

  const connection = openConnection(databasePath);
  try {
    assert.equal(connection.prepare('SELECT COUNT(*) AS count FROM schema_migrations').get<{ count: number }>()?.count, 4);
  } finally {
    connection.close();
  }
});

test('migration assets are package-relative and checksumable as files', async () => {
  const sql = await readFile(path.join(initialMigrations, '001_initial.sql'), 'utf8');
  assert.match(sql, /CREATE TABLE repositories/);
});
