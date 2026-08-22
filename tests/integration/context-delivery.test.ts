import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { openConnection } from '../../src/db/connection.js';
import { migrateDatabase } from '../../src/db/migrate.js';
import { recordContextDelivery, recordContextDeliveryInTransaction, readContextDelivery, listContextDeliveries } from '../../src/context/delivery.js';
import { recordEntry } from '../../src/memory/entries.js';

const migrationsDirectory = path.resolve(import.meta.dirname, '../../migrations');
const now = '2026-08-20T00:00:00.000Z';
const workspace = 'workspace-delivery';

async function temporaryDatabase(prefix: string) {
  const directory = await mkdtemp(path.join(tmpdir(), `kiokuko-${prefix}-`));
  const database = openConnection(path.join(directory, 'data.sqlite3'));
  migrateDatabase(database, migrationsDirectory);
  return database;
}

function seedDeliveryTarget(database: ReturnType<typeof openConnection>): void {
  database.prepare(`
    INSERT INTO ledger_runs (
      run_id, workspace, client_kind, client_version, source_session_id, parent_run_id,
      protocol_version, capture_profile, coverage_json, status, title, task_hash,
      metadata_json, last_sequence, last_source_sequence, started_at, ended_at, created_at, updated_at
    ) VALUES (?, ?, 'generic', '1.0.0', NULL, NULL, '1', 'standard', '{}', 'active', 'Delivery task', NULL, '{}', 3, NULL, ?, NULL, ?, ?)
  `).run('run-delivery-1', workspace, now, now, now);
  recordEntry(database, {
    workspace,
    kind: 'lesson',
    status: 'verified',
    trustLevel: 'source_verified',
    confidence: 0.9,
    title: 'Private delivery title',
    body: 'Private delivery body',
    summary: 'Private delivery summary',
    createdBy: 'test',
  }, { idFactory: () => 'entry-delivery-1', now });
}

function deliveryInput(deliveryId: string, createdAt = now) {
  return {
    workspace,
    deliveryId,
    runId: 'run-delivery-1',
    throughSequence: 3,
    intakeSessionId: null,
    taskProfileHash: 'a'.repeat(64),
    queryHash: 'b'.repeat(64),
    policyVersion: 'context-policy-v1',
    externalSyncSummary: { attempted: false, imported: 0, sources: [] },
    charBudget: 8000,
    charCount: 42,
    truncated: false,
    createdAt,
    items: [{
      entryId: 'entry-delivery-1',
      entryRevision: 1,
      rank: 1,
      scoreComponents: {
        status: 100,
        trust: 25,
        confidence: 20,
        taskAffinity: 12,
        recommendedTags: 0,
        pathOverlap: 0,
        errorSignature: 0,
        feedback: 0,
        recency: 5,
        contradiction: 0,
      },
      selectionReasons: ['verified', 'source_verified_trust'],
    }],
  };
}

test('records a context delivery with metadata-only item views', async () => {
  const database = await temporaryDatabase('context-delivery-first');
  try {
    seedDeliveryTarget(database);
    const record = recordContextDelivery(database, {
      workspace,
      deliveryId: 'delivery-1',
      runId: 'run-delivery-1',
      throughSequence: 3,
      intakeSessionId: null,
      taskProfileHash: 'a'.repeat(64),
      queryHash: 'b'.repeat(64),
      policyVersion: 'context-policy-v1',
      externalSyncSummary: { attempted: false, imported: 0, sources: [] },
      charBudget: 8000,
      charCount: 42,
      truncated: false,
      createdAt: now,
      items: [{
        entryId: 'entry-delivery-1',
        entryRevision: 1,
        rank: 1,
        scoreComponents: {
          status: 100,
          trust: 25,
          confidence: 20,
          taskAffinity: 12,
          recommendedTags: 0,
          pathOverlap: 0,
          errorSignature: 0,
          feedback: 0,
          recency: 5,
          contradiction: 0,
        },
        selectionReasons: ['verified', 'source_verified_trust'],
      }],
    });

    assert.deepEqual(record, {
      workspace,
      deliveryId: 'delivery-1',
      runId: 'run-delivery-1',
      throughSequence: 3,
      intakeSessionId: null,
      taskProfileHash: 'a'.repeat(64),
      queryHash: 'b'.repeat(64),
      policyVersion: 'context-policy-v1',
      externalSyncSummary: { attempted: false, imported: 0, sources: [] },
      charBudget: 8000,
      charCount: 42,
      truncated: false,
      createdAt: now,
      items: [{
        entryId: 'entry-delivery-1',
        entryRevision: 1,
        rank: 1,
        scoreComponents: {
          status: 100,
          trust: 25,
          confidence: 20,
          taskAffinity: 12,
          recommendedTags: 0,
          pathOverlap: 0,
          errorSignature: 0,
          feedback: 0,
          recency: 5,
          contradiction: 0,
        },
        selectionReasons: ['verified', 'source_verified_trust'],
        untrusted: true,
      }],
      untrusted: true,
    });
  } finally {
    database.close();
  }
});

test('replays an identical canonical delivery without inserting a duplicate', async () => {
  const database = await temporaryDatabase('context-delivery-replay');
  try {
    seedDeliveryTarget(database);
    const input = {
      workspace,
      deliveryId: 'delivery-replay-1',
      runId: 'run-delivery-1',
      throughSequence: 3,
      intakeSessionId: null,
      taskProfileHash: 'a'.repeat(64),
      queryHash: 'b'.repeat(64),
      policyVersion: 'context-policy-v1',
      externalSyncSummary: { attempted: false, imported: 0, sources: [] },
      charBudget: 8000,
      charCount: 42,
      truncated: false,
      createdAt: now,
      items: [{
        entryId: 'entry-delivery-1',
        entryRevision: 1,
        rank: 1,
        scoreComponents: {
          status: 100,
          trust: 25,
          confidence: 20,
          taskAffinity: 12,
          recommendedTags: 0,
          pathOverlap: 0,
          errorSignature: 0,
          feedback: 0,
          recency: 5,
          contradiction: 0,
        },
        selectionReasons: ['verified', 'source_verified_trust'],
      }],
    };
    const first = recordContextDelivery(database, input);
    const replay = recordContextDelivery(database, { ...input, items: [{ ...input.items[0]!, scoreComponents: { ...input.items[0]!.scoreComponents } }] });
    assert.deepEqual(replay, first);
    assert.equal(database.prepare('SELECT COUNT(*) AS count FROM context_deliveries').get<{ count: number }>()?.count, 1);
    assert.equal(database.prepare('SELECT COUNT(*) AS count FROM context_delivery_entries').get<{ count: number }>()?.count, 1);
  } finally {
    database.close();
  }
});

test('reads owned metadata snapshots and paginates newest deliveries without gaps', async () => {
  const database = await temporaryDatabase('context-delivery-list');
  try {
    seedDeliveryTarget(database);
    for (const deliveryId of ['delivery-list-b', 'delivery-list-a', 'delivery-list-c']) {
      recordContextDelivery(database, deliveryInput(deliveryId));
    }

    const read = readContextDelivery(database, { workspace, deliveryId: 'delivery-list-b' });
    assert.equal(read.items[0]?.entryId, 'entry-delivery-1');
    assert.equal('title' in read.items[0]!, false);
    read.items[0]!.scoreComponents.status = -999;
    read.items[0]!.selectionReasons.push('recent');
    const reread = readContextDelivery(database, { workspace, deliveryId: 'delivery-list-b' });
    assert.equal(reread.items[0]?.scoreComponents.status, 100);
    assert.deepEqual(reread.items[0]?.selectionReasons, ['verified', 'source_verified_trust']);

    const first = listContextDeliveries(database, { workspace, runId: 'run-delivery-1', limit: 2 });
    assert.deepEqual(first.items.map((item) => item.deliveryId), ['delivery-list-a', 'delivery-list-b']);
    assert.ok(first.nextCursor);
    const second = listContextDeliveries(database, { workspace, runId: 'run-delivery-1', limit: 2, cursor: first.nextCursor! });
    assert.deepEqual(second.items.map((item) => item.deliveryId), ['delivery-list-c']);
    assert.equal(second.nextCursor, null);
  } finally {
    database.close();
  }
});

test('rejects non-canonical array own keys without persistence or echo', async () => {
  const database = await temporaryDatabase('context-delivery-non-canonical-array');
  try {
    seedDeliveryTarget(database);
    const input = deliveryInput('delivery-non-canonical-array');
    Object.defineProperty(input.items[0]!.selectionReasons, '01', {
      value: 'array-property-sentinel',
      enumerable: true,
    });

    let error: unknown;
    try {
      recordContextDelivery(database, input);
    } catch (caught) {
      error = caught;
    }
    const errorObject = typeof error === 'object' && error !== null ? error as { code?: unknown } : undefined;
    assert.deepEqual({
      code: errorObject?.code,
      message: error instanceof Error ? error.message : undefined,
      headers: database.prepare('SELECT COUNT(*) AS count FROM context_deliveries').get<{ count: number }>()?.count,
      children: database.prepare('SELECT COUNT(*) AS count FROM context_delivery_entries').get<{ count: number }>()?.count,
      echoed: error instanceof Error && error.message.includes('array-property-sentinel'),
    }, {
      code: 'VALIDATION_ERROR',
      message: 'Context delivery input is invalid',
      headers: 0,
      children: 0,
      echoed: false,
    });

    database.exec('CREATE TEMP TABLE tx_marker (value TEXT NOT NULL)');
    const transactionInput = deliveryInput('delivery-non-canonical-array-transaction');
    Object.defineProperty(transactionInput.items[0]!.selectionReasons, '01', {
      value: 'transaction-array-property-sentinel',
      enumerable: true,
    });
    database.exec('BEGIN IMMEDIATE');
    database.prepare('INSERT INTO tx_marker (value) VALUES (?)').run('before');
    assert.throws(
      () => recordContextDeliveryInTransaction(database, transactionInput),
      (error: unknown) => {
        assert.equal((error as { code?: string }).code, 'VALIDATION_ERROR');
        assert.equal((error as Error).message, 'Context delivery input is invalid');
        assert.doesNotMatch((error as Error).message, /transaction-array-property-sentinel/);
        return true;
      },
    );
    database.prepare('INSERT INTO tx_marker (value) VALUES (?)').run('after');
    assert.equal(database.prepare('SELECT COUNT(*) AS count FROM tx_marker').get<{ count: number }>()?.count, 2);
    assert.equal(database.prepare('SELECT COUNT(*) AS count FROM context_deliveries').get<{ count: number }>()?.count, 0);
    assert.equal(database.prepare('SELECT COUNT(*) AS count FROM context_delivery_entries').get<{ count: number }>()?.count, 0);
    database.exec('ROLLBACK');
    assert.equal(database.prepare('SELECT COUNT(*) AS count FROM tx_marker').get<{ count: number }>()?.count, 0);
    assert.equal(database.prepare('SELECT COUNT(*) AS count FROM context_deliveries').get<{ count: number }>()?.count, 0);
    assert.equal(database.prepare('SELECT COUNT(*) AS count FROM context_delivery_entries').get<{ count: number }>()?.count, 0);
  } finally {
    try {
      database.exec('ROLLBACK');
    } catch {
      // The assertion path may already have rolled the outer transaction back.
    }
    database.close();
  }
});

test('rejects malformed delivery input with one fixed non-echoing validation error', async () => {
  const database = await temporaryDatabase('context-delivery-validation');
  try {
    seedDeliveryTarget(database);
    const base = deliveryInput('delivery-invalid');
    const getter = deliveryInput('delivery-getter');
    Object.defineProperty(getter, 'workspace', { enumerable: true, get: () => 'getter-sentinel' });
    const symbolKey = deliveryInput('delivery-symbol');
    Object.defineProperty(symbolKey, Symbol('secret-sentinel'), { value: 'symbol-sentinel', enumerable: true });
    const sparse = deliveryInput('delivery-sparse');
    sparse.items = new Array(1);
    const cyclic = deliveryInput('delivery-cyclic');
    (cyclic.items[0] as Record<string, unknown>).cycle = cyclic;
    const proxied = new Proxy(deliveryInput('delivery-proxy'), {});
    const invalidInputs: unknown[] = [
      { ...base, unknownSentinel: 'raw-secret-sentinel' },
      getter,
      symbolKey,
      sparse,
      cyclic,
      proxied,
      { ...base, taskProfileHash: 'A'.repeat(64) },
      { ...base, charCount: Number.POSITIVE_INFINITY },
      { ...base, items: [{ ...base.items[0]!, rank: 2 }] },
      { ...base, items: [{ ...base.items[0]!, scoreComponents: { ...base.items[0]!.scoreComponents, extra: 1 } }] },
      { ...base, items: [{ ...base.items[0]!, selectionReasons: ['recent', 'verified'] }] },
      { ...base, externalSyncSummary: { attempted: false, imported: 1, sources: [] } },
      new Date(),
    ];
    for (const input of invalidInputs) {
      assert.throws(
        () => recordContextDelivery(database, input),
        (error: unknown) => {
          assert.equal((error as { code?: string }).code, 'VALIDATION_ERROR');
          assert.equal((error as Error).message, 'Context delivery input is invalid');
          assert.doesNotMatch((error as Error).message, /raw-secret-sentinel|getter-sentinel|symbol-sentinel/);
          return true;
        },
      );
    }
    assert.equal(database.prepare('SELECT COUNT(*) AS count FROM context_deliveries').get<{ count: number }>()?.count, 0);
    assert.equal(database.prepare('SELECT COUNT(*) AS count FROM context_delivery_entries').get<{ count: number }>()?.count, 0);
  } finally {
    database.close();
  }
});

test('conflicts on changed replay bodies but allows semantically identical bodies under another delivery id', async () => {
  const database = await temporaryDatabase('context-delivery-conflict');
  try {
    seedDeliveryTarget(database);
    const input = deliveryInput('delivery-conflict-1');
    const first = recordContextDelivery(database, input);
    assert.deepEqual(recordContextDelivery(database, { ...input, externalSyncSummary: { attempted: false, imported: 0, sources: [] } }), first);
    assert.throws(
      () => recordContextDelivery(database, { ...input, charCount: 43 }),
      (error: unknown) => (error as { code?: string }).code === 'CONFLICT' && (error as Error).message === 'Context delivery conflicts with existing record',
    );
    const differentId = recordContextDelivery(database, { ...input, deliveryId: 'delivery-conflict-2' });
    assert.equal(differentId.deliveryId, 'delivery-conflict-2');
    assert.equal(database.prepare('SELECT COUNT(*) AS count FROM context_deliveries').get<{ count: number }>()?.count, 2);
  } finally {
    database.close();
  }
});

test('caller-owned delivery transactions preserve outer writes and roll back together', async () => {
  const database = await temporaryDatabase('context-delivery-transaction');
  try {
    seedDeliveryTarget(database);
    database.exec('CREATE TEMP TABLE tx_marker (value TEXT NOT NULL)');
    const input = deliveryInput('delivery-transaction-1');
    database.exec('BEGIN IMMEDIATE');
    database.prepare('INSERT INTO tx_marker (value) VALUES (?)').run('before');
    recordContextDeliveryInTransaction(database, input);
    database.prepare('INSERT INTO tx_marker (value) VALUES (?)').run('after');
    assert.equal(database.prepare('SELECT COUNT(*) AS count FROM tx_marker').get<{ count: number }>()?.count, 2);
    assert.equal(database.prepare('SELECT COUNT(*) AS count FROM context_deliveries').get<{ count: number }>()?.count, 1);
    database.exec('ROLLBACK');
    assert.equal(database.prepare('SELECT COUNT(*) AS count FROM tx_marker').get<{ count: number }>()?.count, 0);
    assert.equal(database.prepare('SELECT COUNT(*) AS count FROM context_deliveries').get<{ count: number }>()?.count, 0);

    const first = recordContextDelivery(database, input);
    database.exec('BEGIN IMMEDIATE');
    database.prepare('INSERT INTO tx_marker (value) VALUES (?)').run('before-replay');
    assert.deepEqual(recordContextDeliveryInTransaction(database, input), first);
    assert.throws(
      () => recordContextDeliveryInTransaction(database, { ...input, charCount: 43 }),
      (error: unknown) => (error as { code?: string }).code === 'CONFLICT',
    );
    database.prepare('INSERT INTO tx_marker (value) VALUES (?)').run('after-conflict');
    assert.equal(database.prepare('SELECT COUNT(*) AS count FROM tx_marker').get<{ count: number }>()?.count, 2);
    database.exec('ROLLBACK');
    assert.equal(database.prepare('SELECT COUNT(*) AS count FROM context_deliveries').get<{ count: number }>()?.count, 1);
  } finally {
    try {
      database.exec('ROLLBACK');
    } catch {
      // The assertion path may already have rolled the outer transaction back.
    }
    database.close();
  }
});

test('rolls back the header, earlier children, and trigger side effects when a later child fails', async () => {
  const database = await temporaryDatabase('context-delivery-rollback');
  try {
    seedDeliveryTarget(database);
    recordEntry(database, {
      workspace,
      kind: 'lesson',
      status: 'verified',
      trustLevel: 'source_verified',
      confidence: 0.9,
      title: 'Private second title',
      body: 'Private second body',
      summary: 'Private second summary',
      createdBy: 'test',
    }, { idFactory: () => 'entry-delivery-2', now });
    database.exec('CREATE TABLE delivery_side_effects (value TEXT NOT NULL)');
    database.exec(`
      CREATE TRIGGER fail_second_delivery_child
      AFTER INSERT ON context_delivery_entries
      WHEN NEW.entry_id = 'entry-delivery-2'
      BEGIN
        INSERT INTO delivery_side_effects (value) VALUES ('should-rollback');
        SELECT RAISE(ABORT, 'intentional child failure');
      END
    `);
    const input = deliveryInput('delivery-rollback-1');
    input.items = [
      input.items[0]!,
      { ...input.items[0]!, entryId: 'entry-delivery-2', entryRevision: 1, rank: 2 },
    ];
    assert.throws(
      () => recordContextDelivery(database, input),
      (error: unknown) => (error as { code?: string }).code === 'DATABASE_ERROR' && (error as Error).message === 'Context delivery database operation failed',
    );
    assert.equal(database.prepare('SELECT COUNT(*) AS count FROM context_deliveries').get<{ count: number }>()?.count, 0);
    assert.equal(database.prepare('SELECT COUNT(*) AS count FROM context_delivery_entries').get<{ count: number }>()?.count, 0);
    assert.equal(database.prepare('SELECT COUNT(*) AS count FROM delivery_side_effects').get<{ count: number }>()?.count, 0);
  } finally {
    database.close();
  }
});

test('stores only bounded sanitized external sync metadata and rejects dynamic summary keys', async () => {
  const database = await temporaryDatabase('context-delivery-sync-summary');
  try {
    seedDeliveryTarget(database);
    const rawSecret = 'Authorization: Bearer ' + 'a'.repeat(16);
    const rawPath = path.join(process.env.HOME ?? '/home/ubuntu', 'raw-secret-path-sentinel.txt');
    const input = {
      ...deliveryInput('delivery-sync-summary-1'),
      externalSyncSummary: {
        attempted: true,
        imported: 2,
        sources: [
          { sourceId: 'source-one', commit: 'abc123', documents: 3, imported: 2, error: rawSecret },
          { sourceId: 'source-two', commit: null, documents: 0, imported: 0, error: rawPath },
        ],
      },
    };
    const record = recordContextDelivery(database, input);
    assert.equal(record.externalSyncSummary.attempted, true);
    assert.equal(record.externalSyncSummary.imported, 2);
    assert.equal(record.externalSyncSummary.sources[0]?.error, '[REDACTED:authorization_header]');
    assert.equal(record.externalSyncSummary.sources[1]?.error, '<HOME>/raw-secret-path-sentinel.txt');
    const stored = database.prepare('SELECT external_sync_summary_json FROM context_deliveries WHERE delivery_id = ?').get<{ external_sync_summary_json: string }>('delivery-sync-summary-1')?.external_sync_summary_json ?? '';
    assert.doesNotMatch(stored, new RegExp(`${(process.env.HOME ?? '/home/ubuntu').replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')}/raw-secret-path-sentinel`));
    assert.doesNotMatch(stored, /Authorization|aaaaaaaaaaaaaaaa/);
    assert.ok(Buffer.byteLength(stored, 'utf8') <= 16 * 1024);

    const invalid = deliveryInput('delivery-sync-summary-invalid');
    invalid.externalSyncSummary = {
      attempted: true,
      imported: 0,
      sources: [{ sourceId: 'source-invalid', commit: null, documents: 0, imported: 0, password: 'raw-password-sentinel' }],
    } as never;
    assert.throws(
      () => recordContextDelivery(database, invalid),
      (error: unknown) => (error as { code?: string }).code === 'VALIDATION_ERROR' && (error as Error).message === 'Context delivery input is invalid',
    );
    assert.equal(database.prepare('SELECT COUNT(*) AS count FROM context_deliveries').get<{ count: number }>()?.count, 1);
  } finally {
    database.close();
  }
});

test('enforces run, intake, workspace, sequence, and historical entry revision relations', async () => {
  const database = await temporaryDatabase('context-delivery-relations');
  try {
    seedDeliveryTarget(database);
    database.prepare(`
      INSERT INTO akinator_sessions (id, workspace, task_text, profile_json, status, question_count, created_at, updated_at)
      VALUES (?, ?, 'Delivery task', '{}', 'ready', 1, ?, ?)
    `).run('session-delivery-1', workspace, now, now);
    database.prepare(`
      INSERT INTO run_intakes (
        run_id, session_id, policy_version, profile_schema_version, profile_sources_json,
        recommended_tags_json, linked_at
      ) VALUES (?, ?, 'context-policy-v1', 1, '{}', '[]', ?)
    `).run('run-delivery-1', 'session-delivery-1', now);

    const linked = recordContextDelivery(database, { ...deliveryInput('delivery-linked-1'), intakeSessionId: 'session-delivery-1' });
    assert.equal(linked.intakeSessionId, 'session-delivery-1');
    assert.equal(linked.items[0]?.entryRevision, 1);

    assert.throws(
      () => recordContextDelivery(database, { ...deliveryInput('delivery-sequence-1'), throughSequence: 4 }),
      (error: unknown) => (error as { code?: string }).code === 'CONFLICT' && (error as Error).message === 'Context delivery conflicts with existing record',
    );
    for (const input of [
      { ...deliveryInput('delivery-missing-run-1'), runId: 'missing-run' },
      { ...deliveryInput('delivery-missing-intake-1'), intakeSessionId: 'missing-session' },
      { ...deliveryInput('delivery-wrong-intake-1'), intakeSessionId: 'another-session' },
    ]) {
      assert.throws(
        () => recordContextDelivery(database, input),
        (error: unknown) => (error as { code?: string }).code === 'NOT_FOUND' && (error as Error).message === 'Context delivery target was not found',
      );
    }

    database.prepare(`
      INSERT INTO ledger_runs (
        run_id, workspace, client_kind, protocol_version, capture_profile, coverage_json,
        status, metadata_json, last_sequence, started_at, created_at, updated_at
      ) VALUES (?, 'other-workspace', 'generic', '1', 'standard', '{}', 'active', '{}', 3, ?, ?, ?)
    `).run('run-other-workspace', now, now, now);
    assert.throws(
      () => recordContextDelivery(database, { ...deliveryInput('delivery-cross-run-1'), runId: 'run-other-workspace' }),
      (error: unknown) => (error as { code?: string }).code === 'NOT_FOUND' && (error as Error).message === 'Context delivery target was not found',
    );

    recordEntry(database, {
      workspace: 'other-workspace',
      kind: 'lesson',
      status: 'verified',
      trustLevel: 'source_verified',
      confidence: 0.9,
      title: 'Other title',
      body: 'Other body',
      createdBy: 'test',
    }, { idFactory: () => 'entry-other-workspace', now });
    assert.throws(
      () => recordContextDelivery(database, { ...deliveryInput('delivery-cross-entry-1'), items: [{ ...deliveryInput('x').items[0]!, entryId: 'entry-other-workspace' }] }),
      (error: unknown) => (error as { code?: string }).code === 'NOT_FOUND' && (error as Error).message === 'Context delivery target was not found',
    );
  } finally {
    database.close();
  }
});

test('owns input and output snapshots and does not mutate memory, run, intake, or feedback state', async () => {
  const database = await temporaryDatabase('context-delivery-nonmutation');
  try {
    seedDeliveryTarget(database);
    database.prepare('INSERT INTO entry_revision_tags (entry_id, revision, tag) VALUES (?, ?, ?)').run('entry-delivery-1', 1, 'delivery-tag-sentinel');
    const before = {
      entries: database.prepare('SELECT e.id, e.status, e.trust_level, e.current_revision, r.body, r.summary FROM entries e JOIN entry_revisions r ON r.entry_id = e.id AND r.revision = e.current_revision ORDER BY e.id').all(),
      tags: database.prepare('SELECT entry_id, revision, tag FROM entry_revision_tags ORDER BY entry_id, revision, tag').all(),
      runs: database.prepare('SELECT run_id, workspace, status, last_sequence, metadata_json FROM ledger_runs ORDER BY run_id').all(),
      sessions: database.prepare('SELECT * FROM akinator_sessions ORDER BY id').all(),
      intakes: database.prepare('SELECT * FROM run_intakes ORDER BY run_id').all(),
      contextFeedback: database.prepare('SELECT * FROM context_feedback ORDER BY feedback_id').all(),
      runFeedback: database.prepare('SELECT * FROM run_feedback ORDER BY feedback_id').all(),
    };
    const input = deliveryInput('delivery-nonmutation-1');
    const record = recordContextDelivery(database, input);
    input.items[0]!.scoreComponents.status = -999;
    input.items[0]!.selectionReasons.push('recent');
    record.items[0]!.scoreComponents.status = -999;
    record.externalSyncSummary.sources.push({ sourceId: 'caller-mutation', commit: null, documents: 0, imported: 0 });
    const reread = readContextDelivery(database, { workspace, deliveryId: 'delivery-nonmutation-1' });
    assert.equal(reread.items[0]?.scoreComponents.status, 100);
    assert.deepEqual(reread.items[0]?.selectionReasons, ['verified', 'source_verified_trust']);
    assert.deepEqual(reread.externalSyncSummary.sources, []);

    assert.deepEqual(database.prepare('SELECT e.id, e.status, e.trust_level, e.current_revision, r.body, r.summary FROM entries e JOIN entry_revisions r ON r.entry_id = e.id AND r.revision = e.current_revision ORDER BY e.id').all(), before.entries);
    assert.deepEqual(database.prepare('SELECT entry_id, revision, tag FROM entry_revision_tags ORDER BY entry_id, revision, tag').all(), before.tags);
    assert.deepEqual(database.prepare('SELECT run_id, workspace, status, last_sequence, metadata_json FROM ledger_runs ORDER BY run_id').all(), before.runs);
    assert.deepEqual(database.prepare('SELECT * FROM akinator_sessions ORDER BY id').all(), before.sessions);
    assert.deepEqual(database.prepare('SELECT * FROM run_intakes ORDER BY run_id').all(), before.intakes);
    assert.deepEqual(database.prepare('SELECT * FROM context_feedback ORDER BY feedback_id').all(), before.contextFeedback);
    assert.deepEqual(database.prepare('SELECT * FROM run_feedback ORDER BY feedback_id').all(), before.runFeedback);
    const deliveryStorage = JSON.stringify({
      headers: database.prepare('SELECT * FROM context_deliveries').all(),
      entries: database.prepare('SELECT * FROM context_delivery_entries').all(),
    });
    assert.doesNotMatch(deliveryStorage, /Private delivery title|Private delivery body|Private delivery summary|delivery-tag-sentinel/);
  } finally {
    database.close();
  }
});

test('maps corrupt stored scalars, canonical metadata, revisions, and joins to fixed integrity errors', async () => {
  const database = await temporaryDatabase('context-delivery-integrity');
  try {
    seedDeliveryTarget(database);
    const input = deliveryInput('delivery-integrity-1');
    recordContextDelivery(database, input);
    const originalScore = database.prepare('SELECT score_components_json FROM context_delivery_entries WHERE delivery_id = ?').get<{ score_components_json: string }>(input.deliveryId)?.score_components_json ?? '';
    const originalReasons = database.prepare('SELECT selection_reason_json FROM context_delivery_entries WHERE delivery_id = ?').get<{ selection_reason_json: string }>(input.deliveryId)?.selection_reason_json ?? '';
    database.exec('PRAGMA foreign_keys = OFF; PRAGMA ignore_check_constraints = ON;');
    const corruptions = [
      () => database.prepare('UPDATE context_deliveries SET task_profile_hash = ? WHERE delivery_id = ?').run('BAD-HASH', input.deliveryId),
      () => database.prepare('UPDATE context_deliveries SET created_at = ? WHERE delivery_id = ?').run('not-a-timestamp', input.deliveryId),
      () => database.prepare('UPDATE context_deliveries SET truncated = ? WHERE delivery_id = ?').run(2, input.deliveryId),
      () => database.prepare('UPDATE context_delivery_entries SET score_components_json = ? WHERE delivery_id = ?').run('{}', input.deliveryId),
      () => database.prepare('UPDATE context_delivery_entries SET selection_reason_json = ? WHERE delivery_id = ?').run('["recent","verified"]', input.deliveryId),
      () => database.prepare('UPDATE context_delivery_entries SET entry_revision = ? WHERE delivery_id = ?').run(3, input.deliveryId),
      () => database.prepare('UPDATE context_delivery_entries SET rank = ? WHERE delivery_id = ?').run(2, input.deliveryId),
      () => database.prepare('UPDATE entries SET workspace = ? WHERE id = ?').run('other-workspace', 'entry-delivery-1'),
    ];
    for (const corrupt of corruptions) {
      corrupt();
      assert.throws(
        () => readContextDelivery(database, { workspace, deliveryId: input.deliveryId }),
        (error: unknown) => {
          assert.equal((error as { code?: string }).code, 'INTEGRITY_ERROR');
          assert.equal((error as Error).message, 'Stored context delivery is invalid');
          assert.doesNotMatch((error as Error).message, /BAD-HASH|not-a-timestamp|other-workspace|recent/);
          return true;
        },
      );
      database.prepare('UPDATE context_deliveries SET task_profile_hash = ?, created_at = ?, truncated = ? WHERE delivery_id = ?').run('a'.repeat(64), now, 0, input.deliveryId);
      database.prepare('UPDATE context_delivery_entries SET score_components_json = ?, selection_reason_json = ?, entry_revision = ?, rank = ? WHERE delivery_id = ?').run(originalScore, originalReasons, 1, 1, input.deliveryId);
      database.prepare('UPDATE entries SET workspace = ? WHERE id = ?').run(workspace, 'entry-delivery-1');
    }
    database.exec('PRAGMA ignore_check_constraints = OFF; PRAGMA foreign_keys = ON;');

    database.prepare('UPDATE entries SET current_revision = ? WHERE id = ?').run(3, 'entry-delivery-1');
    assert.equal(readContextDelivery(database, { workspace, deliveryId: input.deliveryId }).items[0]?.entryRevision, 1);
    database.exec('PRAGMA ignore_check_constraints = ON;');
    database.prepare('UPDATE entries SET current_revision = ? WHERE id = ?').run(0, 'entry-delivery-1');
    assert.doesNotThrow(() => listContextDeliveries(database, { workspace, runId: 'run-delivery-1' }));
  } finally {
    database.close();
  }
});

test('rejects malformed or noncanonical cursors, limits, unknown query fields, and hidden targets', async () => {
  const database = await temporaryDatabase('context-delivery-query-validation');
  try {
    seedDeliveryTarget(database);
    recordContextDelivery(database, deliveryInput('delivery-query-a'));
    recordContextDelivery(database, deliveryInput('delivery-query-b'));
    const first = listContextDeliveries(database, { workspace, runId: 'run-delivery-1', limit: 1 });
    assert.ok(first.nextCursor);
    const validCursor = first.nextCursor!;
    const wrongVersion = Buffer.from(JSON.stringify({ version: 2, createdAt: now, deliveryId: 'delivery-query-a' }), 'utf8').toString('base64url');
    const reordered = Buffer.from(JSON.stringify({ deliveryId: 'delivery-query-a', createdAt: now, version: 1 }), 'utf8').toString('base64url');
    for (const cursor of ['', 'not base64', `${validCursor}=`, wrongVersion, reordered, 'e30']) {
      assert.throws(
        () => listContextDeliveries(database, { workspace, runId: 'run-delivery-1', cursor }),
        (error: unknown) => (error as { code?: string }).code === 'VALIDATION_ERROR' && (error as Error).message === 'Context delivery input is invalid',
      );
    }
    for (const limit of [0, 101, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
      assert.throws(
        () => listContextDeliveries(database, { workspace, runId: 'run-delivery-1', limit }),
        (error: unknown) => (error as { code?: string }).code === 'VALIDATION_ERROR' && (error as Error).message === 'Context delivery input is invalid',
      );
    }
    assert.throws(
      () => listContextDeliveries(database, { workspace, runId: 'run-delivery-1', unknownSentinel: 'not-exposed' } as never),
      (error: unknown) => (error as { code?: string }).code === 'VALIDATION_ERROR' && !(error as Error).message.includes('not-exposed'),
    );
    for (const input of [
      { workspace: 'other-workspace', deliveryId: 'delivery-query-a' },
      { workspace, deliveryId: 'missing-delivery' },
    ]) {
      assert.throws(
        () => readContextDelivery(database, input),
        (error: unknown) => (error as { code?: string }).code === 'NOT_FOUND' && (error as Error).message === 'Context delivery target was not found',
      );
    }
    for (const input of [
      { workspace, runId: 'missing-run' },
      { workspace: 'other-workspace', runId: 'run-delivery-1' },
    ]) {
      assert.throws(
        () => listContextDeliveries(database, input),
        (error: unknown) => (error as { code?: string }).code === 'NOT_FOUND' && (error as Error).message === 'Context delivery target was not found',
      );
    }
  } finally {
    database.close();
  }
});
