import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { copyFile, mkdtemp, mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import test from 'node:test';
import { openConnection } from '../../src/db/connection.js';
import { migrateDatabase } from '../../src/db/migrate.js';
import { LedgerStore } from '../../src/ledger/store.js';
import { recordEntry } from '../../src/memory/entries.js';

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
    assert.deepEqual(first.applied, [1, 2, 3, 4, 5, 6, 7, 8]);
    assert.equal(connection.prepare('SELECT COUNT(*) AS count FROM schema_migrations').get<{ count: number }>()?.count, 8);
    for (const table of [
      'repositories',
      'repository_locations',
      'entries',
      'entry_revisions',
      'entry_revision_tags',
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
      'akinator_reasoning_paths',
      'repository_fingerprints',
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

test('migration 008 preserves project and global delivery rows while enabling ecosystem origin', async () => {
  const directory = await temporaryDirectory('migration-008-upgrade');
  const migrationsDirectory = path.join(directory, 'migrations');
  await mkdir(migrationsDirectory);
  const migrationFiles = await readdir(initialMigrations);
  for (let version = 1; version <= 7; version += 1) {
    const prefix = String(version).padStart(3, '0');
    const name = migrationFiles.find((candidate) => candidate.startsWith(`${prefix}_`));
    assert.ok(name);
    await copyFile(path.join(initialMigrations, name), path.join(migrationsDirectory, name));
  }
  const connection = openConnection(path.join(directory, 'data.sqlite3'));
  try {
    assert.deepEqual(migrateDatabase(connection, migrationsDirectory).applied, [1, 2, 3, 4, 5, 6, 7]);
    const projectEntry = recordEntry(connection, {
      workspace: 'workspace:migration-project', kind: 'lesson', title: 'Project row', body: 'Keep the project row.',
    }, { idFactory: () => 'entry-migration-project', now: '2026-08-23T00:00:00.000Z' });
    const globalEntry = recordEntry(connection, {
      workspace: 'global', kind: 'lesson', title: 'Global row', body: 'Keep the global row.',
      scope: { visibility: 'global' },
    }, { idFactory: () => 'entry-migration-global', now: '2026-08-23T00:00:00.000Z' });
    const store = new LedgerStore(connection, { now: () => '2026-08-23T00:00:00.000Z' });
    store.createRun({
      runId: 'run-migration-008', workspace: 'workspace:migration-project', protocolVersion: '1', client: { kind: 'generic' }, captureProfile: 'minimal',
      coverage: { run: 'declared', tool: 'unavailable', command: 'unavailable', file: 'unavailable', approval: 'unavailable' },
      task: { title: 'Upgrade', query: 'Upgrade delivery origins', profileHints: { taskType: 'build', target: null, expected: null, constraints: null } },
      startedAt: '2026-08-23T00:00:00.000Z',
    });
    connection.prepare(`
      INSERT INTO context_deliveries (
        delivery_id, run_id, through_sequence, intake_session_id, task_profile_hash,
        query_hash, policy_version, external_sync_summary_json, char_budget,
        char_count, truncated, created_at
      ) VALUES ('delivery-migration-008', 'run-migration-008', 0, NULL, ?, ?, 'v2', '{}', 100, 0, 0, ?)
    `).run('a'.repeat(64), 'b'.repeat(64), '2026-08-23T00:00:00.000Z');
    const insert = connection.prepare(`
      INSERT INTO context_delivery_entries (
        delivery_id, entry_id, entry_revision, rank, score_components_json,
        selection_reason_json, origin_scope
      ) VALUES ('delivery-migration-008', ?, 1, ?, '{}', '[]', ?)
    `);
    insert.run(projectEntry.id, 1, 'project');
    insert.run(globalEntry.id, 2, 'global');
    connection.prepare(`
      INSERT INTO context_feedback (
        feedback_id, delivery_id, entry_id, run_id, verdict, comment,
        actor, idempotency_key, created_at
      ) VALUES (?, 'delivery-migration-008', ?, 'run-migration-008', 'helpful', NULL, ?, ?, ?)
    `).run('feedback-migration-project', projectEntry.id, 'project-user', 'c'.repeat(64), '2026-08-23T00:00:00.000Z');
    connection.prepare(`
      INSERT INTO context_feedback (
        feedback_id, delivery_id, entry_id, run_id, verdict, comment,
        actor, idempotency_key, created_at
      ) VALUES (?, 'delivery-migration-008', ?, 'run-migration-008', 'helpful', NULL, ?, ?, ?)
    `).run('feedback-migration-global', globalEntry.id, 'global-user', 'd'.repeat(64), '2026-08-23T00:00:00.000Z');

    await copyFile(path.join(initialMigrations, '008_federated_memory.sql'), path.join(migrationsDirectory, '008_federated_memory.sql'));
    assert.deepEqual(migrateDatabase(connection, migrationsDirectory).applied, [8]);
    assert.deepEqual(
      connection.prepare('SELECT entry_id, origin_scope FROM context_delivery_entries ORDER BY rank').all<Record<string, unknown>>().map((row) => ({ ...row })),
      [
        { entry_id: projectEntry.id, origin_scope: 'project' },
        { entry_id: globalEntry.id, origin_scope: 'global' },
      ],
    );
    assert.deepEqual(
      connection.prepare('SELECT feedback_id, entry_id FROM context_feedback ORDER BY feedback_id').all<Record<string, unknown>>().map((row) => ({ ...row })),
      [
        { feedback_id: 'feedback-migration-global', entry_id: globalEntry.id },
        { feedback_id: 'feedback-migration-project', entry_id: projectEntry.id },
      ],
    );
    assert.doesNotThrow(() => connection.prepare(`
      INSERT INTO context_delivery_entries (
        delivery_id, entry_id, entry_revision, rank, score_components_json,
        selection_reason_json, origin_scope
      ) VALUES ('delivery-migration-008', ?, 1, 3, '{}', '[]', 'ecosystem')
    `).run(recordEntry(connection, {
      workspace: 'workspace:migration-foreign', kind: 'lesson', title: 'Ecosystem row', body: 'Allow the ecosystem row.',
    }, { idFactory: () => 'entry-migration-ecosystem', now: '2026-08-23T00:00:00.000Z' }).id));
    assert.deepEqual(connection.prepare('PRAGMA foreign_key_check').all(), []);
  } finally {
    connection.close();
  }
});

test('rejects a database created by a newer migration set without changing it', async () => {
  const directory = await temporaryDirectory('future-version');
  const migrationsDirectory = path.join(directory, 'migrations');
  await mkdir(migrationsDirectory);
  await writeFile(path.join(migrationsDirectory, '001_initial.sql'), 'CREATE TABLE future_fixture (id INTEGER PRIMARY KEY);\n');
  const databasePath = path.join(directory, 'data.sqlite3');
  const connection = openConnection(databasePath);
  try {
    migrateDatabase(connection, migrationsDirectory);
    connection.prepare(`
      INSERT INTO schema_migrations (version, name, checksum, applied_at)
      VALUES (2, '002_from_the_future.sql', ?, ?)
    `).run('f'.repeat(64), '2026-08-21T00:00:00.000Z');
    const before = connection.prepare('SELECT COUNT(*) AS count FROM schema_migrations').get<{ count: number }>()?.count;
    assert.throws(
      () => migrateDatabase(connection, migrationsDirectory),
      (error: unknown) => (error as { code?: string }).code === 'INTEGRITY_ERROR' && /newer/i.test((error as Error).message),
    );
    assert.equal(connection.prepare('SELECT COUNT(*) AS count FROM schema_migrations').get<{ count: number }>()?.count, before);
  } finally {
    connection.close();
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
    assert.equal(connection.prepare('SELECT COUNT(*) AS count FROM schema_migrations').get<{ count: number }>()?.count, 8);
  } finally {
    connection.close();
  }
});

test('migration assets are package-relative and checksumable as files', async () => {
  const sql = await readFile(path.join(initialMigrations, '001_initial.sql'), 'utf8');
  assert.match(sql, /CREATE TABLE repositories/);
});
