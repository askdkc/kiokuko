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
    assert.deepEqual(first.applied, [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
    assert.equal(connection.prepare('SELECT COUNT(*) AS count FROM schema_migrations').get<{ count: number }>()?.count, 10);
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
      'external_skills',
      'external_skill_entries',
      'skill_discovery_cache',
      'skill_source_failure_cache',
      'skill_audit_failure_cache',
      'agent_task_skill_discovery_attempts',
      'entry_revision_hash_format',
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

test('migration 009 constrains each run to one terminally consistent Skill discovery attempt', async () => {
  const directory = await temporaryDirectory('skill-discovery-attempt-schema');
  const connection = openConnection(path.join(directory, 'data.sqlite3'));
  try {
    migrateDatabase(connection, initialMigrations);
    const timestamp = '2026-08-26T00:00:00.000Z';
    new LedgerStore(connection, { now: () => timestamp }).createRun({
      runId: 'run-skill-discovery-attempt',
      workspace: 'workspace:skill-discovery-attempt',
      protocolVersion: '1',
      client: { kind: 'test' },
      captureProfile: 'minimal',
      coverage: { run: 'unavailable', tool: 'unavailable', command: 'unavailable', file: 'unavailable', approval: 'unavailable' },
      task: {
        title: 'Validate discovery attempt schema',
        query: 'Validate discovery attempt schema',
        profileHints: { taskType: 'build', target: null, expected: null, constraints: null },
      },
      startedAt: timestamp,
    });
    const insert = connection.prepare(`
      INSERT INTO agent_task_skill_discovery_attempts (
        run_id, request_digest, state, summary_json, failure_json, started_at, finished_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?)
    `);
    const digest = 'a'.repeat(64);
    assert.throws(() => insert.run('missing-run', digest, 'started', null, null, timestamp, null), /foreign key/iu);
    for (const invalidDigest of ['a'.repeat(63), 'A'.repeat(64), `${'a'.repeat(63)}g`]) {
      assert.throws(() => insert.run('run-skill-discovery-attempt', invalidDigest, 'started', null, null, timestamp, null), /check constraint/iu);
    }
    assert.throws(() => insert.run('run-skill-discovery-attempt', digest, 'waiting', null, null, timestamp, null), /check constraint/iu);
    assert.throws(() => insert.run('run-skill-discovery-attempt', digest, 'started', '{}', null, timestamp, null), /check constraint/iu);
    assert.throws(() => insert.run('run-skill-discovery-attempt', digest, 'completed', null, null, timestamp, timestamp), /check constraint/iu);
    assert.throws(() => insert.run('run-skill-discovery-attempt', digest, 'completed', '{}', '{}', timestamp, timestamp), /check constraint/iu);
    assert.throws(() => insert.run('run-skill-discovery-attempt', digest, 'failed', null, null, timestamp, timestamp), /check constraint/iu);
    assert.throws(() => insert.run('run-skill-discovery-attempt', digest, 'failed', '{}', '{}', timestamp, timestamp), /check constraint/iu);
    assert.throws(() => insert.run('run-skill-discovery-attempt', digest, 'failed', null, '{}', timestamp, '2026-08-25T23:59:59.999Z'), /check constraint/iu);

    insert.run('run-skill-discovery-attempt', digest, 'started', null, null, timestamp, null);
    assert.throws(() => insert.run('run-skill-discovery-attempt', digest, 'started', null, null, timestamp, null), /unique constraint/iu);
    assert.throws(() => connection.prepare(`
      UPDATE agent_task_skill_discovery_attempts
      SET state = 'completed', finished_at = ?
      WHERE run_id = 'run-skill-discovery-attempt'
    `).run(timestamp), /check constraint/iu);
    connection.prepare(`
      UPDATE agent_task_skill_discovery_attempts
      SET state = 'completed', summary_json = '{}', finished_at = ?
      WHERE run_id = 'run-skill-discovery-attempt'
    `).run(timestamp);
    connection.prepare("DELETE FROM ledger_runs WHERE run_id = 'run-skill-discovery-attempt'").run();
    assert.equal(connection.prepare('SELECT COUNT(*) AS count FROM agent_task_skill_discovery_attempts')
      .get<{ count: number }>()?.count, 0);
  } finally {
    connection.close();
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

test('migration 009 preserves v8 knowledge sources and rolls back a failed upgrade atomically', async () => {
  const directory = await temporaryDirectory('migration-009-upgrade');
  const migrationsDirectory = path.join(directory, 'migrations');
  await mkdir(migrationsDirectory);
  const migrationFiles = await readdir(initialMigrations);
  for (let version = 1; version <= 8; version += 1) {
    const prefix = String(version).padStart(3, '0');
    const name = migrationFiles.find((candidate) => candidate.startsWith(`${prefix}_`));
    assert.ok(name);
    await copyFile(path.join(initialMigrations, name), path.join(migrationsDirectory, name));
  }
  const migration009 = await readFile(path.join(initialMigrations, '009_external_skill_discovery.sql'), 'utf8');
  const migration009Path = path.join(migrationsDirectory, '009_external_skill_discovery.sql');
  const connection = openConnection(path.join(directory, 'data.sqlite3'));
  const expectedKnowledgeSource = {
    source_id: 'legacy-knowledge-source',
    repository_url: 'https://github.com/example/legacy-knowledge.git',
    ref_name: 'release/v8',
    commit_sha: '0123456789abcdef0123456789abcdef01234567',
    document_count: 7,
    last_synced_at: '2026-08-23T01:02:03.000Z',
  };
  const expectedKnowledgeSources = [expectedKnowledgeSource];
  const knowledgeSources = () => connection.prepare(`
    SELECT source_id, repository_url, ref_name, commit_sha, document_count, last_synced_at
    FROM knowledge_sources
    ORDER BY source_id
  `).all<Record<string, unknown>>().map((row) => ({ ...row }));

  try {
    assert.deepEqual(migrateDatabase(connection, migrationsDirectory).applied, [1, 2, 3, 4, 5, 6, 7, 8]);
    connection.prepare(`
      INSERT INTO knowledge_sources (
        source_id, repository_url, ref_name, commit_sha, document_count, last_synced_at
      ) VALUES (?, ?, ?, ?, ?, ?)
    `).run(
      expectedKnowledgeSource.source_id,
      expectedKnowledgeSource.repository_url,
      expectedKnowledgeSource.ref_name,
      expectedKnowledgeSource.commit_sha,
      expectedKnowledgeSource.document_count,
      expectedKnowledgeSource.last_synced_at,
    );
    assert.deepEqual(knowledgeSources(), expectedKnowledgeSources);

    await writeFile(
      migration009Path,
      `${migration009}\nSELECT missing_column FROM migration_009_forced_failure;\n`,
    );
    assert.throws(() => migrateDatabase(connection, migrationsDirectory), /migration_009_forced_failure|no such table/i);
    assert.equal(connection.prepare('SELECT COUNT(*) AS count FROM schema_migrations').get<{ count: number }>()?.count, 8);
    for (const table of ['external_skill_generation_clock', 'external_skill_generation_tokens', 'external_skills', 'external_skill_entries', 'skill_discovery_cache', 'skill_source_failure_cache', 'skill_audit_failure_cache', 'agent_task_skill_discovery_attempts', 'entry_revision_hash_format']) {
      assert.equal(
        connection.prepare("SELECT 1 AS present FROM sqlite_master WHERE type = 'table' AND name = ?").get(table),
        undefined,
        `${table} survived the failed migration`,
      );
    }
    assert.deepEqual(knowledgeSources(), expectedKnowledgeSources);
    assert.deepEqual(connection.prepare('PRAGMA foreign_key_check').all(), []);

    await writeFile(migration009Path, migration009);
    assert.deepEqual(migrateDatabase(connection, migrationsDirectory).applied, [9]);
    assert.deepEqual(knowledgeSources(), expectedKnowledgeSources);
    assert.deepEqual(connection.prepare('PRAGMA foreign_key_check').all(), []);
    assert.equal(connection.prepare('SELECT COUNT(*) AS count FROM schema_migrations').get<{ count: number }>()?.count, 9);
    for (const table of ['external_skill_generation_clock', 'external_skill_generation_tokens', 'external_skills', 'external_skill_entries', 'skill_discovery_cache', 'skill_source_failure_cache', 'skill_audit_failure_cache', 'agent_task_skill_discovery_attempts', 'entry_revision_hash_format']) {
      assert.equal(
        connection.prepare("SELECT 1 AS present FROM sqlite_master WHERE type = 'table' AND name = ?").get<{ present: number }>(table)?.present,
        1,
        `missing ${table}`,
      );
    }

    const token = connection.prepare('INSERT INTO external_skill_generation_tokens DEFAULT VALUES RETURNING generation').get<{ generation: number }>();
    assert.equal(token?.generation, 1);
    connection.prepare('UPDATE external_skill_generation_clock SET value = ? WHERE singleton = 1').run(token!.generation);
    connection.prepare(`
      INSERT INTO external_skills (
        skill_id, provider, source_type, source_locator, slug, name, install_url,
        official_status, duplicate, installs, state, source_workspace,
        first_seen_at, last_seen_at, last_checked_at, generation
      ) VALUES (?, ?, ?, ?, ?, ?, NULL, ?, 0, 0, ?, ?, ?, ?, ?, ?)
    `).run(
      'github:example/skills:test',
      'fixture',
      'github',
      'example/skills',
      'test',
      'Test Skill',
      'unknown',
      'discovered',
      'external-skills:example/skills',
      '2026-08-23T01:02:03.000Z',
      '2026-08-23T01:02:03.000Z',
      '2026-08-23T01:02:03.000Z',
      1,
    );
    assert.throws(() => connection.prepare(`
      INSERT INTO external_skill_entries (
        skill_id, source_path, chunk_index, entry_id, entry_revision,
        content_hash, primary_document, active, imported_at
      ) VALUES (?, ?, 0, ?, 1, ?, 1, 1, ?)
    `).run(
      'github:example/skills:test',
      'skills/test/SKILL.md',
      'missing-entry',
      'a'.repeat(64),
      '2026-08-23T01:02:03.000Z',
    ), /foreign key/i);
    assert.deepEqual(connection.prepare('PRAGMA foreign_key_check').all(), []);
    assert.deepEqual(knowledgeSources(), expectedKnowledgeSources);
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
    assert.equal(
      connection.prepare("SELECT 1 AS present FROM sqlite_master WHERE type = 'table' AND name = 'schema_migrations'").get(),
      undefined,
    );
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
    assert.equal(connection.prepare('SELECT COUNT(*) AS count FROM schema_migrations').get<{ count: number }>()?.count, 10);
  } finally {
    connection.close();
  }
});

test('migration assets are package-relative and checksumable as files', async () => {
  const sql = await readFile(path.join(initialMigrations, '001_initial.sql'), 'utf8');
  assert.match(sql, /CREATE TABLE repositories/);
});
