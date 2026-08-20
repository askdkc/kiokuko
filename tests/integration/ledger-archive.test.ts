import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { openConnection } from '../../src/db/connection.js';
import { migrateDatabase } from '../../src/db/migrate.js';
import { exportWorkspace } from '../../src/commands/export.js';
import {
  exportLedgerArchive,
  importLedgerArchive,
  MAX_ARCHIVE_LINE_BYTES,
  MAX_ARCHIVE_LINE_COUNT,
  MAX_ARCHIVE_TOTAL_BYTES,
} from '../../src/ledger/archive.js';
import { LedgerStore } from '../../src/ledger/store.js';
import { finalizeRunIntakeLink, insertAkinatorAnswer, insertAkinatorSession, insertRunIntakeLink } from '../../src/akinator/store.js';
import { recordEntry } from '../../src/memory/entries.js';
import { canonicalJson } from '../../src/serialization/validate.js';

async function setup() {
  const directory = await mkdtemp(path.join(tmpdir(), 'kiokuko-ledger-archive-'));
  const database = openConnection(path.join(directory, 'data.sqlite3'));
  migrateDatabase(database, path.resolve(import.meta.dirname, '../../migrations'));
  return database;
}

const fixedNow = '2026-08-20T00:00:00.000Z';
const digest = (value: string) => createHash('sha256').update(value).digest('hex');

function seedCompleteGraph(database: ReturnType<typeof openConnection>, workspace: string, entryId: string) {
  const sessionId = `${workspace}-session`;
  const runId = `${workspace}-run`;
  const eventId = `${workspace}-event`;
  const deliveryId = `${workspace}-delivery`;
  insertAkinatorSession(database, {
    id: sessionId,
    workspace,
    task: 'Archive linked intake',
    profile: { taskType: 'build', target: 'src', expected: 'pass', constraints: null },
    status: 'ready',
    questionCount: 1,
    createdAt: fixedNow,
    updatedAt: fixedNow,
  });
  insertAkinatorAnswer(database, { workspace, sessionId, questionId: 'target', answer: 'src', createdAt: fixedNow });
  const store = new LedgerStore(database, { now: () => fixedNow });
  store.createRun({
    runId,
    workspace,
    protocolVersion: '1',
    client: { kind: 'generic', version: '1.0.0', sessionId },
    captureProfile: 'standard',
    coverage: { run: 'complete', tool: 'best_effort', command: 'declared', file: 'unavailable', approval: 'unavailable' },
    task: { title: 'Archive run', query: 'Archive graph', profileHints: { taskType: 'build', target: 'src', expected: 'pass', constraints: null } },
    metadata: { z: true, a: 'metadata' },
    startedAt: fixedNow,
  });
  store.appendBatch(runId, { events: [{ eventId, eventType: 'run.started', actor: 'agent', payload: { z: 1, a: 'payload' } }] });
  insertRunIntakeLink(database, {
    runId,
    sessionId,
    workspace,
    policyVersion: 'policy-v1',
    profileSchemaVersion: 1,
    profileSources: { taskType: 'inferred', target: 'user_answer' },
    initialProfileHash: null,
    recommendedTags: ['archive', 'ledger'],
    linkedAt: fixedNow,
    finalizedAt: null,
  });
  finalizeRunIntakeLink(database, { workspace, runId, profileHash: 'a'.repeat(64), recommendedTags: ['archive', 'ledger'], finalizedAt: fixedNow });
  store.updateRunStatus(runId, 'active', fixedNow);
  database.prepare(`INSERT INTO intake_feedback (feedback_id, run_id, session_id, question_id, profile_field, verdict, comment, actor, idempotency_key, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(`${workspace}-intake-feedback`, runId, sessionId, 'target', null, 'helpful', 'clear question', 'user', digest('intake-key'), fixedNow);
  database.prepare(`INSERT INTO ledger_evidence (evidence_id, run_id, event_id, kind, locator, digest_algorithm, digest, byte_size, summary, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(`${workspace}-evidence`, runId, eventId, 'test', 'tests/archive.test.ts', 'sha256', 'b'.repeat(64), 10, 'passed', fixedNow);
  database.prepare(`INSERT INTO context_deliveries (delivery_id, run_id, through_sequence, intake_session_id, task_profile_hash, query_hash, policy_version, external_sync_summary_json, char_budget, char_count, truncated, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(deliveryId, runId, 1, sessionId, 'c'.repeat(64), 'd'.repeat(64), 'policy-v1', '{"result":"none","source":"local"}', 1000, 100, 0, fixedNow);
  database.prepare(`INSERT INTO context_delivery_entries (delivery_id, entry_id, entry_revision, rank, score_components_json, selection_reason_json) VALUES (?, ?, ?, ?, ?, ?)`)
    .run(deliveryId, entryId, 1, 1, '{"semantic":0.9,"trust":0.8}', '{"reason":"matching task"}');
  database.prepare(`INSERT INTO context_feedback (feedback_id, delivery_id, entry_id, run_id, verdict, comment, actor, idempotency_key, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(`${workspace}-context-feedback`, deliveryId, entryId, runId, 'helpful', 'useful', 'user', digest('context-key'), fixedNow);
  database.prepare(`INSERT INTO run_feedback (feedback_id, run_id, outcome, recommendation_code, recommendation_verdict, rating, comment, actor, idempotency_key, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(`${workspace}-run-feedback`, runId, 'completed', 'VERIFY_AFTER_MUTATION', 'accepted', 5, 'good run', 'user', digest('run-key'), fixedNow);
  database.prepare(`INSERT INTO ledger_memory_links (link_id, run_id, event_id, delivery_id, entry_id, created_at) VALUES (?, ?, ?, ?, ?, ?)`)
    .run(`${workspace}-memory-link`, runId, eventId, deliveryId, entryId, fixedNow);
  database.prepare(`INSERT INTO ledger_purge_audit (purge_id, run_id, event_id, delivery_id, entry_id, target_type, target_id, actor, reason, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(`${workspace}-purge`, runId, eventId, deliveryId, entryId, 'run', runId, 'operator', 'privacy request', fixedNow);
  return { sessionId, runId, eventId, deliveryId };
}

function rebuildArchive(content: string, mutate: (lines: Array<Record<string, unknown>>) => void): string {
  const lines = content.trimEnd().split('\n').slice(1).map((line: string) => JSON.parse(line) as Record<string, unknown>);
  mutate(lines);
  const payload = `${lines.map((line) => canonicalJson(line)).join('\n')}\n`;
  return `${canonicalJson({ type: 'checksum', sha256: createHash('sha256').update(payload).digest('hex') })}\n${payload}`;
}

function seedSingleRun(database: ReturnType<typeof openConnection>, workspace = 'workspace:validation') {
  const store = new LedgerStore(database, { now: () => fixedNow });
  store.createRun({
    runId: `${workspace}-run`, workspace, protocolVersion: '1', client: { kind: 'generic' }, captureProfile: 'minimal',
    coverage: { run: 'declared', tool: 'unavailable', command: 'unavailable', file: 'unavailable', approval: 'unavailable' },
    task: { title: 'Validation', query: 'Validate archive', profileHints: { taskType: 'build', target: null, expected: null, constraints: null } }, startedAt: fixedNow,
  });
  store.appendBatch(`${workspace}-run`, { events: [{ eventId: `${workspace}-event`, eventType: 'run.started', actor: 'agent', payload: { ok: true } }] });
  return exportLedgerArchive(database, { workspace }).content;
}

test('exports an empty workspace as a deterministic ledger manifest without memory ledger leakage', async () => {
  const database = await setup();
  try {
    const before = exportWorkspace(database, { workspace: 'workspace:empty' }).content;
    const first = exportLedgerArchive(database, { workspace: 'workspace:empty' });
    const second = exportLedgerArchive(database, { workspace: 'workspace:empty' });
    const after = exportWorkspace(database, { workspace: 'workspace:empty' }).content;

    assert.equal(first.content, second.content);
    assert.equal(first.content, `${first.content}`);
    assert.equal(first.workspace, 'workspace:empty');
    assert.deepEqual(first.counts, {
      runs: 0,
      sessions: 0,
      answers: 0,
      runIntakes: 0,
      intakeFeedback: 0,
      events: 0,
      evidence: 0,
      deliveries: 0,
      deliveryEntries: 0,
      contextFeedback: 0,
      runFeedback: 0,
      memoryLinks: 0,
      purgeAudit: 0,
    });
    assert.equal(before, after);
    assert.equal(before.includes('ledger_runs'), false);
    assert.equal(before.includes('ledger_events'), false);
    assert.equal(first.content.split('\n').length, 3);
    assert.match(first.content, /"type":"checksum"/);
    assert.match(first.content, /"archiveVersion":1/);
    assert.match(first.content, /"format":"kiokuko-ledger-jsonl"/);
  } finally {
    database.close();
  }
});


test('exports runs and events with stable allowlisted records and canonical stored JSON', async () => {
  const database = await setup();
  try {
    const store = new LedgerStore(database, { now: () => '2026-08-20T00:00:00.000Z' });
    store.createRun({
      runId: 'run-archive-1',
      workspace: 'workspace:archive',
      protocolVersion: '1',
      client: { kind: 'generic', version: '1.0.0' },
      captureProfile: 'standard',
      coverage: { run: 'complete', tool: 'best_effort', command: 'declared', file: 'unavailable', approval: 'unavailable' },
      task: { title: 'Archive', query: 'Export', profileHints: { taskType: 'build', target: null, expected: 'pass', constraints: null } },
      metadata: { z: true, a: 'stable' },
      startedAt: '2026-08-20T00:00:00.000Z',
    });
    store.appendBatch('run-archive-1', {
      events: [{ eventId: 'event-archive-1', eventType: 'run.started', actor: 'agent', payload: { z: 1, a: 'two' } }],
    });

    const archive = exportLedgerArchive(database, { workspace: 'workspace:archive' });
    const lines = archive.content.trimEnd().split('\n').map((line: string) => JSON.parse(line) as Record<string, unknown>);
    assert.deepEqual(lines.slice(1).map((line: Record<string, unknown>) => line.type), ['manifest', 'run', 'event']);
    assert.deepEqual(archive.counts, { runs: 1, sessions: 0, answers: 0, runIntakes: 0, intakeFeedback: 0, events: 1, evidence: 0, deliveries: 0, deliveryEntries: 0, contextFeedback: 0, runFeedback: 0, memoryLinks: 0, purgeAudit: 0 });
    assert.equal((lines[2]?.coverage_json as string), '{"approval":"unavailable","command":"declared","file":"unavailable","run":"complete","tool":"best_effort"}');
    assert.equal((lines[2]?.metadata_json as string), '{"a":"stable","z":true}');
    assert.equal((lines[3]?.payload_json as string), '{"a":"two","z":1}');
  } finally {
    database.close();
  }
});

test('rejects an empty workspace value before querying the database', async () => {
  const database = await setup();
  try {
    assert.throws(
      () => exportLedgerArchive(database, { workspace: '' }),
      (error: unknown) => (error as { code?: string }).code === 'VALIDATION_ERROR',
    );
  } finally {
    database.close();
  }
});

test('imports a ledger graph transactionally and re-imports identical rows as no-ops', async () => {
  const source = await setup();
  const target = await setup();
  try {
    const store = new LedgerStore(source, { now: () => '2026-08-20T00:00:00.000Z' });
    store.createRun({
      runId: 'run-import-1', workspace: 'workspace:import', protocolVersion: '1',
      client: { kind: 'generic' }, captureProfile: 'minimal',
      coverage: { run: 'declared', tool: 'unavailable', command: 'unavailable', file: 'unavailable', approval: 'unavailable' },
      task: { title: 'Import', query: 'Round trip', profileHints: { taskType: 'build', target: null, expected: null, constraints: null } },
      startedAt: '2026-08-20T00:00:00.000Z',
    });
    store.appendBatch('run-import-1', { events: [{ eventId: 'event-import-1', eventType: 'run.started', actor: 'agent', payload: { ok: true } }] });
    const archive = exportLedgerArchive(source, { workspace: 'workspace:import' });

    const imported = importLedgerArchive(target, { content: archive.content });
    assert.equal(imported.dryRun, false);
    assert.equal(imported.imported.runs, 1);
    assert.equal(imported.imported.events, 1);
    assert.equal(exportLedgerArchive(target, { workspace: 'workspace:import' }).content, archive.content);

    const duplicate = importLedgerArchive(target, { content: archive.content });
    assert.equal(duplicate.imported.runs, 0);
    assert.equal(duplicate.imported.events, 0);
    assert.equal(duplicate.duplicates.runs, 1);
    assert.equal(duplicate.duplicates.events, 1);
  } finally {
    source.close();
    target.close();
  }
});

test('archives the complete linked ledger graph without curated memory bodies or unrelated workspaces', async () => {
  const source = await setup();
  const target = await setup();
  const workspace = 'workspace:complete';
  const memoryBody = 'curated-body-must-not-be-archived';
  try {
    const sourceEntry = recordEntry(source, {
      workspace,
      kind: 'reference',
      title: 'curated-title-must-not-be-archived',
      body: memoryBody,
      summary: 'curated-summary-must-not-be-archived',
      tags: ['curated'],
    }, { idFactory: () => 'entry-complete-1', now: fixedNow });
    const memoryBefore = exportWorkspace(source, { workspace }).content;
    const graph = seedCompleteGraph(source, workspace, sourceEntry.id);
    const unrelated = new LedgerStore(source, { now: () => fixedNow });
    unrelated.createRun({
      runId: 'unrelated-run', workspace: 'workspace:other', protocolVersion: '1', client: { kind: 'generic' }, captureProfile: 'minimal',
      coverage: { run: 'declared', tool: 'unavailable', command: 'unavailable', file: 'unavailable', approval: 'unavailable' },
      task: { title: 'Other', query: 'Other', profileHints: { taskType: 'build', target: null, expected: null, constraints: null } }, startedAt: fixedNow,
    });
    const archive = exportLedgerArchive(source, { workspace });
    const memoryAfter = exportWorkspace(source, { workspace }).content;

    assert.equal(memoryBefore, memoryAfter);
    assert.equal(memoryAfter.includes('ledger_runs'), false);
    assert.equal(archive.content.includes(memoryBody), false);
    assert.equal(archive.content.includes('curated-title-must-not-be-archived'), false);
    assert.equal(archive.content.includes('unrelated-run'), false);
    assert.deepEqual(archive.counts, {
      runs: 1, sessions: 1, answers: 1, runIntakes: 1, intakeFeedback: 1, events: 1, evidence: 1,
      deliveries: 1, deliveryEntries: 1, contextFeedback: 1, runFeedback: 1, memoryLinks: 1, purgeAudit: 1,
    });
    const lines = archive.content.trimEnd().split('\n').map((line: string) => JSON.parse(line) as Record<string, unknown>);
    const deliveryEntry = lines.find((line: Record<string, unknown>) => line.type === 'delivery_entry');
    assert.ok(deliveryEntry);
    assert.deepEqual(Object.keys(deliveryEntry).sort(), ['delivery_id', 'entry_id', 'entry_revision', 'rank', 'score_components_json', 'selection_reason_json', 'type'].sort());
    assert.equal((deliveryEntry.score_components_json as string), '{"semantic":0.9,"trust":0.8}');
    assert.equal((deliveryEntry.selection_reason_json as string), '{"reason":"matching task"}');

    recordEntry(target, {
      workspace,
      kind: 'reference',
      title: 'curated-title-must-not-be-archived',
      body: memoryBody,
      summary: 'curated-summary-must-not-be-archived',
      tags: ['curated'],
    }, { idFactory: () => sourceEntry.id, now: fixedNow });
    importLedgerArchive(target, { content: archive.content });
    assert.equal(exportLedgerArchive(target, { workspace }).content, archive.content);
    assert.equal(target.prepare('SELECT COUNT(*) AS count FROM ledger_runs WHERE workspace = ?').get<{ count: number }>(workspace)?.count, 1);
    assert.equal(target.prepare('SELECT COUNT(*) AS count FROM akinator_answers').get<{ count: number }>()?.count, 1);
    assert.equal(graph.runId, `${workspace}-run`);
  } finally {
    source.close();
    target.close();
  }
});

test('rejects checksum/count/schema/version corruption with fixed typed errors and no mutation', async () => {
  const source = await setup();
  const target = await setup();
  try {
    const archive = seedSingleRun(source);
    const corrupted = archive.replace('true', 'false');
    assert.throws(() => importLedgerArchive(target, { content: corrupted }), (error: unknown) => (error as { code?: string }).code === 'INTEGRITY_ERROR');
    assert.equal(target.prepare('SELECT COUNT(*) AS count FROM ledger_runs').get<{ count: number }>()?.count, 0);

    const countMismatch = rebuildArchive(archive, (lines) => { const manifest = lines[0]!; const counts = manifest.counts as Record<string, number>; manifest.counts = { ...counts, events: Number(counts.events) + 1 }; });
    assert.throws(() => importLedgerArchive(target, { content: countMismatch }), (error: unknown) => (error as { code?: string }).code === 'INTEGRITY_ERROR');
    const unknownField = rebuildArchive(archive, (lines) => { lines.find((line) => line.type === 'run')!.unknown = 'sentinel'; });
    assert.throws(() => importLedgerArchive(target, { content: unknownField }), (error: unknown) => (error as { code?: string }).code === 'VALIDATION_ERROR');
    const unknownType = rebuildArchive(archive, (lines) => { lines.find((line) => line.type === 'event')!.type = 'unknown_record'; });
    assert.throws(() => importLedgerArchive(target, { content: unknownType }), (error: unknown) => (error as { code?: string }).code === 'VALIDATION_ERROR');
    const duplicateManifest = rebuildArchive(archive, (lines) => { lines.push({ ...lines[0]! }); });
    assert.throws(() => importLedgerArchive(target, { content: duplicateManifest }), (error: unknown) => (error as { code?: string }).code === 'INTEGRITY_ERROR');
    const unsupported = rebuildArchive(archive, (lines) => { lines[0]!.archiveVersion = 2; });
    assert.throws(() => importLedgerArchive(target, { content: unsupported }), (error: unknown) => (error as { code?: string }).code === 'VALIDATION_ERROR');
  } finally {
    source.close();
    target.close();
  }
});

test('validates hash chain, run cursor, delivery cursor, dry-run, missing memory, and override before writing', async () => {
  const source = await setup();
  const target = await setup();
  try {
    const archive = seedSingleRun(source);
    const badHash = rebuildArchive(archive, (lines) => { lines.find((line) => line.type === 'event')!.event_hash = 'f'.repeat(64); });
    assert.throws(() => importLedgerArchive(target, { content: badHash }), (error: unknown) => (error as { code?: string }).code === 'INTEGRITY_ERROR');
    const badSequence = rebuildArchive(archive, (lines) => { lines.find((line) => line.type === 'event')!.sequence = 2; });
    assert.throws(() => importLedgerArchive(target, { content: badSequence }), (error: unknown) => (error as { code?: string }).code === 'INTEGRITY_ERROR');
    const badCursor = rebuildArchive(archive, (lines) => { lines.find((line) => line.type === 'run')!.last_sequence = 2; });
    assert.throws(() => importLedgerArchive(target, { content: badCursor }), (error: unknown) => (error as { code?: string }).code === 'INTEGRITY_ERROR');
    assert.equal(target.prepare('SELECT COUNT(*) AS count FROM ledger_runs').get<{ count: number }>()?.count, 0);

    const dryRun = importLedgerArchive(target, { content: archive, dryRun: true });
    assert.equal(dryRun.dryRun, true);
    assert.equal(dryRun.imported.runs, 1);
    assert.equal(target.prepare('SELECT COUNT(*) AS count FROM ledger_runs').get<{ count: number }>()?.count, 0);
    assert.throws(() => importLedgerArchive(target, { content: archive, workspace: 'workspace:other' }), (error: unknown) => (error as { code?: string }).code === 'VALIDATION_ERROR');

    const completeSource = await setup();
    try {
      const entry = recordEntry(completeSource, { workspace: 'workspace:missing', kind: 'fact', title: 'ref', body: 'ref' }, { idFactory: () => 'missing-entry', now: fixedNow });
      seedCompleteGraph(completeSource, 'workspace:missing', entry.id);
      const completeArchive = exportLedgerArchive(completeSource, { workspace: 'workspace:missing' });
      const badDeliveryCursor = rebuildArchive(completeArchive.content, (lines) => { lines.find((line) => line.type === 'delivery')!.through_sequence = 2; });
      assert.throws(() => importLedgerArchive(target, { content: badDeliveryCursor }), (error: unknown) => (error as { code?: string }).code === 'INTEGRITY_ERROR');
      assert.throws(() => importLedgerArchive(target, { content: completeArchive.content }), (error: unknown) => (error as { code?: string }).code === 'NOT_FOUND');
      assert.equal(target.prepare('SELECT COUNT(*) AS count FROM ledger_runs').get<{ count: number }>()?.count, 0);
    } finally {
      completeSource.close();
    }
  } finally {
    source.close();
    target.close();
  }
});

test('rejects persisted hash-chain and secret residue on export without echoing sentinel values', async () => {
  const corrupted = await setup();
  const secretDatabase = await setup();
  try {
    seedSingleRun(corrupted);
    corrupted.prepare('UPDATE ledger_events SET event_hash = ?').run('f'.repeat(64));
    assert.throws(() => exportLedgerArchive(corrupted, { workspace: 'workspace:validation' }), (error: unknown) => (error as { code?: string }).code === 'INTEGRITY_ERROR');

    seedSingleRun(secretDatabase);
    const sentinel = 'password=secret-sentinel-value-12345';
    secretDatabase.prepare('UPDATE ledger_runs SET metadata_json = ?').run(JSON.stringify({ note: sentinel }));
    assert.throws(() => exportLedgerArchive(secretDatabase, { workspace: 'workspace:validation' }), (error: unknown) => {
      const typed = error as { code?: string; message?: string; details?: unknown };
      assert.equal(typed.code, 'SECURITY_REJECTION');
      assert.equal(String(typed.message).includes(sentinel), false);
      assert.equal(JSON.stringify(typed.details).includes(sentinel), false);
      return true;
    });

    const malformed = await setup();
    try {
      seedSingleRun(malformed);
      const rawJson = 'not-json-sentinel';
      malformed.prepare('UPDATE ledger_runs SET metadata_json = ?').run(rawJson);
      assert.throws(() => exportLedgerArchive(malformed, { workspace: 'workspace:validation' }), (error: unknown) => {
        const typed = error as { code?: string; message?: string };
        assert.equal(typed.code, 'INTEGRITY_ERROR');
        assert.equal(String(typed.message).includes(rawJson), false);
        return true;
      });
    } finally {
      malformed.close();
    }
  } finally {
    corrupted.close();
    secretDatabase.close();
  }
});

test('rejects same-identity different content atomically and enforces archive bounds', async () => {
  const source = await setup();
  const target = await setup();
  try {
    const archive = seedSingleRun(source);
    importLedgerArchive(target, { content: archive });
    const changed = rebuildArchive(archive, (lines) => { lines.find((line) => line.type === 'run')!.title = 'different-content'; });
    assert.throws(() => importLedgerArchive(target, { content: changed }), (error: unknown) => (error as { code?: string }).code === 'CONFLICT');
    const dryConflict = importLedgerArchive(target, { content: changed, dryRun: true });
    assert.equal(dryConflict.dryRun, true);
    assert.equal(dryConflict.conflicts, 1);
    assert.equal(dryConflict.imported.runs, 0);
    assert.equal(target.prepare('SELECT COUNT(*) AS count FROM ledger_runs').get<{ count: number }>()?.count, 1);
    assert.equal(target.prepare('PRAGMA foreign_keys').get<{ foreign_keys: number }>()?.foreign_keys, 1);

    const tooManyLines = `${Array.from({ length: MAX_ARCHIVE_LINE_COUNT + 1 }, () => '{}').join('\\n')}\\n`;
    assert.throws(() => importLedgerArchive(target, { content: tooManyLines }), (error: unknown) => (error as { code?: string }).code === 'VALIDATION_ERROR');
    const tooLongLine = `${'x'.repeat(MAX_ARCHIVE_LINE_BYTES)}\\n`;
    assert.throws(() => importLedgerArchive(target, { content: tooLongLine }), (error: unknown) => (error as { code?: string }).code === 'VALIDATION_ERROR');
    const tooManyBytes = `${'x'.repeat(MAX_ARCHIVE_TOTAL_BYTES)}\\n`;
    assert.throws(() => importLedgerArchive(target, { content: tooManyBytes }), (error: unknown) => (error as { code?: string }).code === 'VALIDATION_ERROR');
  } finally {
    source.close();
    target.close();
  }
});
