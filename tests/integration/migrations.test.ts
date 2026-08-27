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
import { readContextDelivery } from '../../src/context/delivery.js';
import { inspectLegacyContextDelivery, type LegacyDeliveryRow } from '../../src/context/delivery-migration.js';
import { runDoctor } from '../../src/commands/doctor.js';
import { CheckpointService, FeedbackService } from '../../src/gateway/checkpoint-service.js';
import { promoteLedgerProposal } from '../../src/ledger/promotion.js';
import { canonicalContentHash, canonicalJson } from '../../src/serialization/validate.js';

const execFileAsync = promisify(execFile);
const repositoryRoot = path.resolve(import.meta.dirname, '../..');
const initialMigrations = path.join(repositoryRoot, 'migrations');

async function temporaryDirectory(prefix: string): Promise<string> {
  return mkdtemp(path.join(tmpdir(), `kiokuko-${prefix}-`));
}

const legacyScoreComponents = {
  status: 100,
  trust: 25,
  confidence: 18,
  retrieval: 10,
  taskAffinity: 0,
  recommendedTags: 0,
  scopeAffinity: 9,
  applicability: 0,
  pathOverlap: 0,
  errorSignature: 0,
  exactSignal: 0,
  feedback: 0,
  recency: 0,
  contradiction: 0,
} as const;

interface LegacyFixtureEntry {
  entryId: string;
  title: string;
  body: string;
  summary?: string | null;
}

interface LegacyFixtureOptions {
  prefix: string;
  entries: LegacyFixtureEntry[];
  characterBudget: number;
  characterCount: number;
  truncated?: boolean;
}

async function legacyDeliveryFixture(options: LegacyFixtureOptions) {
  const directory = await temporaryDirectory(options.prefix);
  const migrationsDirectory = path.join(directory, 'migrations');
  await mkdir(migrationsDirectory);
  const migrationFiles = await readdir(initialMigrations);
  for (let version = 1; version <= 11; version += 1) {
    const prefix = String(version).padStart(3, '0');
    const name = migrationFiles.find((candidate) => candidate.startsWith(`${prefix}_`));
    assert.ok(name);
    await copyFile(path.join(initialMigrations, name), path.join(migrationsDirectory, name));
  }

  const database = openConnection(path.join(directory, 'data.sqlite3'));
  const workspace = `workspace:${options.prefix}`;
  const runId = `run-${options.prefix}`;
  const sessionId = `session-${options.prefix}`;
  const createdAt = '2026-08-24T00:00:00.000Z';
  const profile = { taskType: 'build', target: 'migration', expected: 'legacy replay', constraints: null } as const;
  const profileHash = canonicalContentHash(profile);
  const queryHash = 'b'.repeat(64);
  const deliveryId = `context-${canonicalContentHash({ runId, queryHash })}`;

  migrateDatabase(database, migrationsDirectory);
  database.prepare(`
    INSERT INTO ledger_runs (
      run_id, workspace, client_kind, client_version, source_session_id, parent_run_id,
      protocol_version, capture_profile, coverage_json, status, title, task_hash,
      metadata_json, last_sequence, last_source_sequence, started_at, ended_at, created_at, updated_at
    ) VALUES (?, ?, 'generic', '1.0.0', NULL, NULL, '1', 'standard', ?, 'active', 'Legacy migration', NULL, '{}', 0, NULL, ?, NULL, ?, ?)
  `).run(
    runId,
    workspace,
    canonicalJson({ approval: 'unavailable', command: 'unavailable', file: 'unavailable', run: 'declared', tool: 'unavailable' }),
    createdAt,
    createdAt,
    createdAt,
  );
  database.prepare(`
    INSERT INTO akinator_sessions (id, workspace, task_text, profile_json, status, question_count, created_at, updated_at)
    VALUES (?, ?, 'Legacy migration', ?, 'ready', 0, ?, ?)
  `).run(sessionId, workspace, canonicalJson(profile), createdAt, createdAt);
  database.prepare(`
    INSERT INTO run_intakes (
      run_id, session_id, policy_version, profile_schema_version, profile_sources_json,
      initial_profile_hash, recommended_tags_json, linked_at, finalized_at
    ) VALUES (?, ?, 'v2', 1, ?, ?, ?, ?, ?)
  `).run(
    runId,
    sessionId,
    canonicalJson({ taskType: 'client_supplied', target: 'client_supplied', expected: 'client_supplied', constraints: 'client_supplied' }),
    profileHash,
    canonicalJson(['bot:builder', 'skill:tdd']),
    createdAt,
    createdAt,
  );
  for (const entry of options.entries) {
    recordEntry(database, {
      workspace,
      kind: 'lesson',
      status: 'verified',
      trustLevel: 'source_verified',
      confidence: 0.9,
      title: entry.title,
      body: entry.body,
      ...(entry.summary === undefined ? {} : { summary: entry.summary }),
      createdBy: 'migration-test',
    }, { idFactory: () => entry.entryId, now: createdAt });
  }
  database.prepare(`
    INSERT INTO context_deliveries (
      delivery_id, run_id, through_sequence, intake_session_id, task_profile_hash, query_hash,
      policy_version, external_sync_summary_json, char_budget, char_count, truncated, created_at,
      score_schema_version
    ) VALUES (?, ?, 0, ?, ?, ?, 'context-ranking-v3', '{}', ?, ?, ?, ?, 2)
  `).run(
    deliveryId,
    runId,
    sessionId,
    profileHash,
    queryHash,
    options.characterBudget,
    options.characterCount,
    options.truncated === true ? 1 : 0,
    createdAt,
  );
  const insertEntry = database.prepare(`
    INSERT INTO context_delivery_entries (
      delivery_id, entry_id, entry_revision, rank, score_components_json, selection_reason_json, origin_scope
    ) VALUES (?, ?, 1, ?, ?, ?, 'project')
  `);
  for (const [index, entry] of options.entries.entries()) {
    insertEntry.run(
      deliveryId,
      entry.entryId,
      index + 1,
      canonicalJson(legacyScoreComponents),
      canonicalJson(['project_origin', 'verified']),
    );
  }
  return { database, databasePath: path.join(directory, 'data.sqlite3'), migrationsDirectory, workspace, runId, sessionId, profileHash, deliveryId, createdAt };
}

async function applyContextDeliveryMigration(fixture: { database: ReturnType<typeof openConnection>; migrationsDirectory: string }) {
  await copyFile(path.join(initialMigrations, '012_context_delivery_v4.sql'), path.join(fixture.migrationsDirectory, '012_context_delivery_v4.sql'));
  return migrateDatabase(fixture.database, fixture.migrationsDirectory);
}

test('applies the initial migration and is idempotent', async () => {
  const directory = await temporaryDirectory('first');
  const databasePath = path.join(directory, 'data.sqlite3');
  const connection = openConnection(databasePath);
  try {
    const first = migrateDatabase(connection, initialMigrations);
    assert.deepEqual(first.applied, [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]);
    assert.equal(connection.prepare('SELECT COUNT(*) AS count FROM schema_migrations').get<{ count: number }>()?.count, 12);
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

test('migration 012 preserves historical character metadata when a legacy delivery has no items', async () => {
  const fixture = await legacyDeliveryFixture({
    prefix: 'migration-012-empty-items',
    entries: [],
    characterBudget: 12_000,
    characterCount: 1_803,
  });
  try {
    assert.deepEqual((await applyContextDeliveryMigration(fixture)).applied, [12]);
    const delivery = readContextDelivery(fixture.database, { workspace: fixture.workspace, deliveryId: fixture.deliveryId });
    assert.equal(delivery.items.length, 0);
    assert.equal(delivery.charCount, 1_803);
  } finally {
    fixture.database.close();
  }
});

test('migration 012 preserves a historical count that differs from current entry content', async () => {
  const fixture = await legacyDeliveryFixture({
    prefix: 'migration-012-opaque-count',
    entries: [{ entryId: 'entry-legacy-opaque-count', title: 'Legacy title', body: 'current body' }],
    characterBudget: 12_000,
    characterCount: 2_027,
  });
  try {
    assert.deepEqual((await applyContextDeliveryMigration(fixture)).applied, [12]);
    const delivery = readContextDelivery(fixture.database, { workspace: fixture.workspace, deliveryId: fixture.deliveryId });
    assert.equal(delivery.charCount, 2_027);
    assert.equal(delivery.items.length, 1);
    assert.equal(delivery.items[0]?.entryId, 'entry-legacy-opaque-count');
  } finally {
    fixture.database.close();
  }
});

test('legacy migration does not expand a bounded preview for an oversized source body', async () => {
  const fixture = await legacyDeliveryFixture({
    prefix: 'migration-012-oversized-source',
    entries: [{ entryId: 'entry-legacy-oversized', title: 'Legacy title', body: 'x'.repeat(100_001) }],
    characterBudget: 7,
    characterCount: 7,
  });
  try {
    assert.deepEqual((await applyContextDeliveryMigration(fixture)).applied, [12]);
    const stored = fixture.database.prepare('SELECT char_budget, char_count FROM context_deliveries WHERE delivery_id = ?')
      .get<{ char_budget: number; char_count: number }>(fixture.deliveryId);
    assert.deepEqual({ ...stored }, { char_budget: 7, char_count: 7 });
  } finally {
    fixture.database.close();
  }
});

test('migration 012 rejects persisted legacy character counts outside their budget', async () => {
  for (const [suffix, characterCount] of [['negative', -1], ['over-budget', 101] as const]) {
    const fixture = await legacyDeliveryFixture({
      prefix: `migration-012-invalid-count-${suffix}`,
      entries: [],
      characterBudget: 100,
      characterCount: 0,
    });
    try {
      fixture.database.prepare('PRAGMA ignore_check_constraints = ON').run();
      fixture.database.prepare('UPDATE context_deliveries SET char_count = ? WHERE delivery_id = ?')
        .run(characterCount, fixture.deliveryId);
      await copyFile(path.join(initialMigrations, '012_context_delivery_v4.sql'), path.join(fixture.migrationsDirectory, '012_context_delivery_v4.sql'));
      assert.throws(
        () => migrateDatabase(fixture.database, fixture.migrationsDirectory),
        (error: unknown) => (error as { code?: string; details?: { stage?: string } }).code === 'INTEGRITY_ERROR'
          && (error as { details?: { stage?: string } }).details?.stage === 'legacy-delivery-character-range',
      );
      assert.equal(fixture.database.prepare('SELECT COUNT(*) AS count FROM schema_migrations').get<{ count: number }>()?.count, 11);
      assert.equal(fixture.database.prepare('SELECT char_count FROM context_deliveries WHERE delivery_id = ?').get<{ char_count: number }>(fixture.deliveryId)?.char_count, characterCount);
    } finally {
      fixture.database.close();
    }
  }
});

test('migration 012 rejects a legacy delivery whose identity does not match its policy', async () => {
  const fixture = await legacyDeliveryFixture({
    prefix: 'migration-012-invalid-identity',
    entries: [],
    characterBudget: 100,
    characterCount: 0,
  });
  try {
    fixture.database.prepare('UPDATE context_deliveries SET delivery_id = ? WHERE delivery_id = ?')
      .run('context-forged-legacy-identity', fixture.deliveryId);
    await copyFile(path.join(initialMigrations, '012_context_delivery_v4.sql'), path.join(fixture.migrationsDirectory, '012_context_delivery_v4.sql'));
    assert.throws(
      () => migrateDatabase(fixture.database, fixture.migrationsDirectory),
      (error: unknown) => (error as { code?: string; details?: { stage?: string } }).code === 'INTEGRITY_ERROR'
        && (error as { details?: { stage?: string } }).details?.stage === 'legacy-delivery-identity',
    );
    assert.equal(fixture.database.prepare('SELECT COUNT(*) AS count FROM schema_migrations').get<{ count: number }>()?.count, 11);
    assert.equal(fixture.database.prepare('SELECT COUNT(*) AS count FROM context_deliveries WHERE delivery_id = ?').get<{ count: number }>('context-forged-legacy-identity')?.count, 1);
  } finally {
    fixture.database.close();
  }
});

test('migration inspector rejects a missing exact legacy entry revision', async () => {
  const fixture = await legacyDeliveryFixture({
    prefix: 'migration-012-missing-revision',
    entries: [{ entryId: 'entry-legacy-missing-revision', title: 'Legacy title', body: 'current body' }],
    characterBudget: 100,
    characterCount: 2,
  });
  try {
    fixture.database.prepare('PRAGMA foreign_keys = OFF').run();
    fixture.database.prepare('DELETE FROM entry_revisions WHERE entry_id = ? AND revision = 1')
      .run('entry-legacy-missing-revision');
    fixture.database.prepare('PRAGMA foreign_keys = ON').run();
    const row = fixture.database.prepare(`
      SELECT cd.delivery_id, cd.run_id, cd.policy_version, cd.score_schema_version,
             lr.workspace AS run_workspace
        FROM context_deliveries AS cd
        LEFT JOIN ledger_runs AS lr ON lr.run_id = cd.run_id
       WHERE cd.delivery_id = ?
    `).get<LegacyDeliveryRow>(fixture.deliveryId);
    assert.ok(row);
    assert.throws(
      () => inspectLegacyContextDelivery(fixture.database, row),
      (error: unknown) => (error as { code?: string; details?: { stage?: string } }).code === 'INTEGRITY_ERROR'
        && (error as { details?: { stage?: string } }).details?.stage === 'legacy-delivery-entry-revision',
    );
  } finally {
    fixture.database.close();
  }
});

test('doctor reports all invalid legacy deliveries without applying migration 012', async () => {
  const fixture = await legacyDeliveryFixture({
    prefix: 'migration-012-doctor-invalid',
    entries: [],
    characterBudget: 100,
    characterCount: 0,
  });
  try {
    fixture.database.prepare('UPDATE context_deliveries SET delivery_id = ? WHERE delivery_id = ?')
      .run('context-forged-doctor-identity', fixture.deliveryId);
    fixture.database.prepare(`
      INSERT INTO context_deliveries (
        delivery_id, run_id, through_sequence, intake_session_id, task_profile_hash,
        query_hash, policy_version, external_sync_summary_json, char_budget, char_count,
        truncated, created_at, score_schema_version
      ) VALUES (?, ?, 0, ?, ?, ?, 'context-ranking-v3', '{}', 100, 0, 0, ?, 2)
    `).run(
      'context-forged-doctor-identity-2',
      fixture.runId,
      fixture.sessionId,
      fixture.profileHash,
      'c'.repeat(64),
      fixture.createdAt,
    );
    await copyFile(path.join(initialMigrations, '012_context_delivery_v4.sql'), path.join(fixture.migrationsDirectory, '012_context_delivery_v4.sql'));
    const report = await runDoctor({
      databasePath: fixture.databasePath,
      migrationsDirectory: fixture.migrationsDirectory,
      runtimeDescriptorPath: path.join(path.dirname(fixture.migrationsDirectory), 'runtime.json'),
    });
    assert.equal(report.ok, false);
    assert.equal(report.currentVersion, 12);
    assert.equal(report.legacyDeliveries.scanned, 2);
    assert.equal(report.legacyDeliveries.valid, 0);
    assert.equal(report.legacyDeliveries.invalid, 2);
    assert.deepEqual(report.legacyDeliveries.findings, [
      {
        deliveryId: 'context-forged-doctor-identity',
        runId: fixture.runId,
        policyVersion: 'context-ranking-v3',
        stage: 'legacy-delivery-identity',
        code: 'INTEGRITY_ERROR',
      },
      {
        deliveryId: 'context-forged-doctor-identity-2',
        runId: fixture.runId,
        policyVersion: 'context-ranking-v3',
        stage: 'legacy-delivery-identity',
        code: 'INTEGRITY_ERROR',
      },
    ]);
    assert.equal(report.checks.legacyDeliveries.ok, false);
    assert.equal(report.checks.migrations.ok, false);
    assert.equal(fixture.database.prepare('SELECT COUNT(*) AS count FROM schema_migrations').get<{ count: number }>()?.count, 11);
    assert.equal(fixture.database.prepare('SELECT COUNT(*) AS count FROM context_deliveries WHERE run_id = ?').get<{ count: number }>(fixture.runId)?.count, 2);
  } finally {
    fixture.database.close();
  }
});

test('migration 012 validates legacy scoped delivery accounting without changing identity or references', async () => {
  const directory = await temporaryDirectory('migration-012-context-delivery');
  const migrationsDirectory = path.join(directory, 'migrations');
  await mkdir(migrationsDirectory);
  const migrationFiles = await readdir(initialMigrations);
  for (let version = 1; version <= 11; version += 1) {
    const prefix = String(version).padStart(3, '0');
    const name = migrationFiles.find((candidate) => candidate.startsWith(`${prefix}_`));
    assert.ok(name);
    await copyFile(path.join(initialMigrations, name), path.join(migrationsDirectory, name));
  }
  const database = openConnection(path.join(directory, 'data.sqlite3'));
  const workspace = 'workspace:migration-012';
  const runId = 'run-migration-012';
  const sessionId = 'session-migration-012';
  const entryId = 'entry-migration-012';
  const createdAt = '2026-08-24T00:00:00.000Z';
  const profile = { taskType: 'build', target: 'migration', expected: 'current format', constraints: null } as const;
  const profileHash = canonicalContentHash(profile);
  const queryHash = 'b'.repeat(64);
  const legacyDeliveryId = `context-${canonicalContentHash({ runId, queryHash })}`;
  try {
    assert.deepEqual(migrateDatabase(database, migrationsDirectory).applied, [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11]);
    database.prepare(`
      INSERT INTO ledger_runs (
        run_id, workspace, client_kind, client_version, source_session_id, parent_run_id,
        protocol_version, capture_profile, coverage_json, status, title, task_hash,
        metadata_json, last_sequence, last_source_sequence, started_at, ended_at, created_at, updated_at
      ) VALUES (?, ?, 'generic', '1.0.0', NULL, NULL, '1', 'standard', ?, 'active', 'Migration 012', NULL, '{}', 0, NULL, ?, NULL, ?, ?)
    `).run(
      runId,
      workspace,
      canonicalJson({ approval: 'unavailable', command: 'unavailable', file: 'unavailable', run: 'declared', tool: 'unavailable' }),
      createdAt,
      createdAt,
      createdAt,
    );
    database.prepare(`
      INSERT INTO akinator_sessions (id, workspace, task_text, profile_json, status, question_count, created_at, updated_at)
      VALUES (?, ?, 'Migration 012', ?, 'ready', 0, ?, ?)
    `).run(sessionId, workspace, canonicalJson(profile), createdAt, createdAt);
    database.prepare(`
      INSERT INTO run_intakes (
        run_id, session_id, policy_version, profile_schema_version, profile_sources_json,
        initial_profile_hash, recommended_tags_json, linked_at, finalized_at
      ) VALUES (?, ?, 'v2', 1, ?, ?, ?, ?, ?)
    `).run(
      runId,
      sessionId,
      canonicalJson({ taskType: 'client_supplied', target: 'client_supplied', expected: 'client_supplied', constraints: 'client_supplied' }),
      profileHash,
      canonicalJson(['bot:builder', 'skill:tdd']),
      createdAt,
      createdAt,
    );
    const proposalEventId = 'proposal-migration-012';
    const proposal = {
      kind: 'lesson',
      title: 'Promoted migration proposal',
      body: 'A historical promotion reference must remain resolvable.',
      summary: null,
      scope: {},
      tags: [],
    } as const;
    new LedgerStore(database, { now: () => createdAt }).appendBatch(runId, {
      events: [{ eventId: proposalEventId, eventType: 'memory.proposed', actor: 'agent', occurredAt: createdAt, payload: proposal }],
    });
    recordEntry(database, {
      workspace,
      kind: 'lesson',
      status: 'verified',
      trustLevel: 'source_verified',
      confidence: 0.9,
      title: 'Migration delivery entry',
      body: 'Preserve this delivery while upgrading its identity.',
      createdBy: 'migration-test',
    }, { idFactory: () => entryId, now: createdAt });
    database.prepare(`
      INSERT INTO context_deliveries (
        delivery_id, run_id, through_sequence, intake_session_id, task_profile_hash, query_hash,
        policy_version, external_sync_summary_json, char_budget, char_count, truncated, created_at,
        score_schema_version
      ) VALUES (?, ?, 1, ?, ?, ?, 'context-ranking-v3', '{}', 1000, 52, 0, ?, 2)
    `).run(legacyDeliveryId, runId, sessionId, profileHash, queryHash, createdAt);
    database.prepare(`
      INSERT INTO context_delivery_entries (
        delivery_id, entry_id, entry_revision, rank, score_components_json, selection_reason_json, origin_scope
      ) VALUES (?, ?, 1, 1, ?, ?, 'project')
    `).run(
      legacyDeliveryId,
      entryId,
      canonicalJson({
        status: 100,
        trust: 25,
        confidence: 18,
        retrieval: 10,
        taskAffinity: 0,
        recommendedTags: 0,
        scopeAffinity: 9,
        applicability: 0,
        pathOverlap: 0,
        errorSignature: 0,
        exactSignal: 0,
        feedback: 0,
        recency: 0,
        contradiction: 0,
      }),
      canonicalJson(['project_origin', 'verified']),
    );
    database.prepare(`
      INSERT INTO context_feedback (
        feedback_id, delivery_id, entry_id, run_id, verdict, comment, actor, idempotency_key, created_at
      ) VALUES (?, ?, ?, ?, 'helpful', NULL, 'operator', ?, ?)
    `).run('feedback-migration-012', legacyDeliveryId, entryId, runId, 'c'.repeat(64), createdAt);
    database.prepare(`
      INSERT INTO ledger_memory_links (link_id, run_id, event_id, delivery_id, entry_id, created_at)
      VALUES (?, ?, NULL, ?, ?, ?)
    `).run('link-migration-012', runId, legacyDeliveryId, entryId, createdAt);
    database.prepare(`
      INSERT INTO ledger_purge_audit (
        purge_id, run_id, event_id, delivery_id, entry_id, target_type, target_id, actor, reason, created_at
      ) VALUES (?, ?, NULL, ?, NULL, 'delivery', ?, 'operator', 'migration test', ?)
    `).run('purge-migration-012', runId, legacyDeliveryId, legacyDeliveryId, createdAt);

    const promoted = promoteLedgerProposal(database, {
      workspace,
      runId,
      proposalEventId,
      deliveryId: legacyDeliveryId,
      actor: 'operator',
      createdAt,
      confirmed: true,
    });
    const promotionReference = promoted.entry.provenance.reference;
    assert.equal(typeof promotionReference, 'string');
    assert.equal(JSON.parse(promotionReference as string).deliveryId, legacyDeliveryId);

    const checkpoint = new CheckpointService(database, () => createdAt).checkpoint({
      runId,
      idempotencyKey: 'checkpoint-migration-012',
      request: {
        apiVersion: '1',
        contextFeedback: [{
          feedbackId: 'feedback-migration-012-checkpoint',
          deliveryId: legacyDeliveryId,
          entryId,
          verdict: 'helpful',
        }],
      },
    });
    assert.equal(checkpoint.acceptedThrough, 2);

    const standaloneFeedback = new FeedbackService(database, () => createdAt).feedback({
      runId,
      idempotencyKey: 'feedback-migration-012-standalone-key',
      request: {
        apiVersion: '1',
        category: 'context',
        feedbackId: 'feedback-migration-012-standalone',
        deliveryId: legacyDeliveryId,
        entryId,
        verdict: 'helpful',
      },
    });
    assert.equal((standaloneFeedback.record as { deliveryId: string }).deliveryId, legacyDeliveryId);
    assert.equal(new LedgerStore(database).verifyChain(runId), true);

    await copyFile(path.join(initialMigrations, '012_context_delivery_v4.sql'), path.join(migrationsDirectory, '012_context_delivery_v4.sql'));
    assert.deepEqual(migrateDatabase(database, migrationsDirectory).applied, [12]);
    const migrated = database.prepare(`
      SELECT delivery_id, policy_version, score_schema_version, char_budget, char_count, truncated
        FROM context_deliveries WHERE run_id = ?
    `).get<Record<string, unknown>>(runId);
    assert.ok(migrated);
    assert.equal(migrated.delivery_id, legacyDeliveryId);
    assert.equal(migrated.policy_version, 'context-ranking-v3');
    assert.equal(migrated.score_schema_version, 2);
    assert.equal(migrated.char_count, 52);
    assert.equal(migrated.truncated, 0);
    assert.equal(database.prepare('SELECT COUNT(*) AS count FROM context_deliveries WHERE delivery_id = ?').get<{ count: number }>(legacyDeliveryId)?.count, 1);
    assert.equal(database.prepare('SELECT delivery_id FROM context_feedback WHERE feedback_id = ?').get<{ delivery_id: string }>('feedback-migration-012')?.delivery_id, legacyDeliveryId);
    assert.equal(database.prepare('SELECT delivery_id FROM ledger_memory_links WHERE link_id = ?').get<{ delivery_id: string }>('link-migration-012')?.delivery_id, legacyDeliveryId);
    assert.deepEqual(
      { ...database.prepare('SELECT delivery_id, target_id FROM ledger_purge_audit WHERE purge_id = ?').get('purge-migration-012') },
      { delivery_id: legacyDeliveryId, target_id: legacyDeliveryId },
    );
    assert.equal(database.prepare('SELECT COUNT(*) AS count FROM context_feedback WHERE delivery_id = ?').get<{ count: number }>(legacyDeliveryId)?.count, 3);
    assert.equal(database.prepare('SELECT COUNT(*) AS count FROM ledger_memory_links WHERE delivery_id = ?').get<{ count: number }>(legacyDeliveryId)?.count, 2);
    assert.equal(database.prepare('SELECT COUNT(*) AS count FROM gateway_idempotency WHERE response_json LIKE ?').get<{ count: number }>(`%${legacyDeliveryId}%`)?.count, 1);
    const feedbackEvent = database.prepare(`
      SELECT payload_json FROM ledger_events WHERE run_id = ? AND event_type = 'context.feedback'
    `).get<{ payload_json: string }>(runId);
    assert.ok(feedbackEvent);
    assert.match(feedbackEvent.payload_json, new RegExp(legacyDeliveryId));
    const promotedReference = database.prepare(`
      SELECT r.provenance_json FROM entries AS e
      JOIN entry_revisions AS r ON r.entry_id = e.id AND r.revision = e.current_revision
      WHERE e.id = ?
    `).get<{ provenance_json: string }>(promoted.entry.id);
    assert.ok(promotedReference);
    assert.equal(JSON.parse(promotedReference.provenance_json).reference.includes(legacyDeliveryId), true);
    assert.equal(new LedgerStore(database).verifyChain(runId), true);
    assert.doesNotThrow(() => readContextDelivery(database, { workspace, deliveryId: legacyDeliveryId }));
  } finally {
    database.close();
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
    assert.equal(connection.prepare('SELECT COUNT(*) AS count FROM schema_migrations').get<{ count: number }>()?.count, 12);
  } finally {
    connection.close();
  }
});

test('migration assets are package-relative and checksumable as files', async () => {
  const sql = await readFile(path.join(initialMigrations, '001_initial.sql'), 'utf8');
  assert.match(sql, /CREATE TABLE repositories/);
});
