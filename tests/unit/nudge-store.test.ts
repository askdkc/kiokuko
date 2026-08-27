import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { openConnection } from '../../src/db/connection.js';
import { migrateDatabase } from '../../src/db/migrate.js';
import { NUDGE_POLICY_VERSION, readNudgeHistory, recordNudgeDeliveryInTransaction } from '../../src/context/nudge-store.js';

const migrations = path.resolve(import.meta.dirname, '../../migrations');
const now = '2026-08-27T00:00:00.000Z';

async function createDatabase() {
  const directory = await mkdtemp(path.join(tmpdir(), 'kiokuko-nudge-store-'));
  const database = openConnection(path.join(directory, 'data.sqlite3'));
  migrateDatabase(database, migrations);
  return database;
}

function insertRun(database: ReturnType<typeof openConnection>, runId: string): void {
  database.prepare(`
    INSERT INTO ledger_runs (
      run_id, workspace, client_kind, client_version, source_session_id, parent_run_id,
      protocol_version, capture_profile, coverage_json, status, title, task_hash,
      metadata_json, last_sequence, last_source_sequence, started_at, ended_at, created_at, updated_at
    ) VALUES (?, ?, 'test', '1', NULL, NULL, '1', 'minimal', '{}', 'active', 'Task', NULL, '{}', 0, NULL, ?, NULL, ?, ?)
  `).run(runId, `workspace:${runId}`, now, now, now);
}

function deliver(
  database: ReturnType<typeof openConnection>,
  runId: string,
  occurrenceId: string,
  code: 'UNRESOLVED_FAILURE' | 'VERIFY_AFTER_MUTATION' = 'UNRESOLVED_FAILURE',
  throughSequence = 3,
  policyVersion: string = NUDGE_POLICY_VERSION,
): void {
  recordNudgeDeliveryInTransaction(database, {
    runId,
    policyVersion,
    code,
    occurrenceId,
    throughSequence,
    priority: code === 'UNRESOLVED_FAILURE' ? 3 : 4,
    deliveredAt: now,
  });
}

test('reads empty history and aggregates delivered occurrences, run count, and latest code sequence', async () => {
  const database = await createDatabase();
  try {
    insertRun(database, 'run-store');
    assert.deepEqual(readNudgeHistory(database, 'run-store', NUDGE_POLICY_VERSION), {
      deliveredOccurrenceIds: new Set(),
      runDeliveryCount: 0,
      lastSequenceByCode: new Map(),
    });
    deliver(database, 'run-store', 'occurrence-a', 'UNRESOLVED_FAILURE', 3);
    deliver(database, 'run-store', 'occurrence-b', 'UNRESOLVED_FAILURE', 7);
    deliver(database, 'run-store', 'occurrence-c', 'VERIFY_AFTER_MUTATION', 4);
    const history = readNudgeHistory(database, 'run-store', NUDGE_POLICY_VERSION);
    assert.deepEqual([...history.deliveredOccurrenceIds].sort(), ['occurrence-a', 'occurrence-b', 'occurrence-c']);
    assert.equal(history.runDeliveryCount, 3);
    assert.equal(history.lastSequenceByCode.get('UNRESOLVED_FAILURE'), 7);
    assert.equal(history.lastSequenceByCode.get('VERIFY_AFTER_MUTATION'), 4);
  } finally {
    database.close();
  }
});

test('rejects unsupported policy versions and duplicate logical identities', async () => {
  const database = await createDatabase();
  try {
    insertRun(database, 'run-store-a');
    insertRun(database, 'run-store-b');
    deliver(database, 'run-store-a', 'occurrence-a');
    deliver(database, 'run-store-b', 'occurrence-a');
    assert.equal(readNudgeHistory(database, 'run-store-a', NUDGE_POLICY_VERSION).runDeliveryCount, 1);
    assert.equal(readNudgeHistory(database, 'run-store-b', NUDGE_POLICY_VERSION).runDeliveryCount, 1);
    assert.throws(
      () => deliver(database, 'run-store-a', 'occurrence-a', 'UNRESOLVED_FAILURE', 3, 'nudges.v2'),
      (error: unknown) => (error as { code?: string }).code === 'VALIDATION_ERROR',
    );
    assert.throws(
      () => readNudgeHistory(database, 'run-store-a', 'nudges.v2'),
      (error: unknown) => (error as { code?: string }).code === 'VALIDATION_ERROR',
    );
    assert.throws(() => deliver(database, 'run-store-a', 'occurrence-a'), (error: unknown) => (
      error as { code?: string }
    ).code === 'CONFLICT');
  } finally {
    database.close();
  }
});

test('rejects priority mismatches at the application and database boundaries', async () => {
  const database = await createDatabase();
  try {
    insertRun(database, 'run-priority');
    assert.throws(
      () => recordNudgeDeliveryInTransaction(database, {
        runId: 'run-priority',
        policyVersion: NUDGE_POLICY_VERSION,
        code: 'UNRESOLVED_FAILURE',
        occurrenceId: 'occurrence-priority',
        throughSequence: 1,
        priority: 999,
        deliveredAt: now,
      }),
      (error: unknown) => (error as { code?: string }).code === 'VALIDATION_ERROR',
    );
    deliver(database, 'run-priority', 'stored-priority');
    assert.throws(
      () => database.prepare('UPDATE nudge_deliveries SET priority = 999 WHERE run_id = ?').run('run-priority'),
      /invalid nudge delivery/u,
    );
  } finally {
    database.close();
  }
});
