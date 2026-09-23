import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, rm, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test, { type TestContext } from 'node:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { initializeDatabase } from '../../src/commands/init.js';
import { openConnection } from '../../src/db/connection.js';
import { loadMigrationSnapshot, migrateDatabase } from '../../src/db/migrate.js';
import { createKiokukoMcpServer } from '../../src/mcp/server.js';
import { prepareAgentTask } from '../../src/akinator/agent-task.js';
import { captureInteractionMemory } from '../../src/memory/interaction-capture.js';
import { readEntry, recordEntry, updateCandidateEntry } from '../../src/memory/entries.js';
import { lessonReinforcement } from '../../src/memory/lesson-reinforcement.js';
import { checkpointScopedMemory } from '../../src/memory/scoped-memory.js';
import { rankedEntryHits } from '../../src/memory/retrieval.js';
import { contextRetrievalStateHash } from '../../src/context/selection-state.js';
import { purgeEntry } from '../../src/commands/purge.js';

const capabilities = [{ kind: 'skill', name: 'kiokuko-soul' }, { kind: 'skill', name: 'memory-reasoning' }];
const lesson = { kind: 'lesson', scope: 'project', title: 'Migration compatibility assets',
  body: 'When adding a migration, update the explicit module compatibility asset list and run its regression test.',
  subjects: ['migration compatibility'], basis: 'observed_result' };
const task = { soulRead: true, task: 'Implement migration compatibility assets', capabilities,
  profileHints: { taskType: 'build', target: 'migration compatibility assets', expected: 'The next migration test passes' } };

async function fixture(t: TestContext) {
  const base = await mkdtemp(path.join(tmpdir(), 'kiokuko-reinforcement-'));
  const root = path.join(base, 'repo');
  execFileSync('git', ['init', '-q', root]);
  const databasePath = path.join(base, 'memory.sqlite3');
  await initializeDatabase({ databasePath });
  const db = openConnection(databasePath);
  t.after(async () => { db.close(); await rm(base, { recursive: true, force: true }); });
  const prepare = (requestId: string, cwd = root) => prepareAgentTask(db, { ...task,
    profileHints: { taskType: 'build', target: 'migration compatibility assets', expected: 'Tests pass' },
    cwd, requestId, client: { kind: 'test' }, skillDiscoveryMode: 'off' });
  const capture = (runId: string, operationId: string, memory: unknown = lesson, cwd = root) =>
    captureInteractionMemory(db, { runId, operationId, memories: [memory] }, { cwd, clientKind: 'test' });
  return { base, root, databasePath, db, prepare, capture };
}

test('two independent runs reinforce a lesson; retries and same-run repetitions do not', async t => {
  const f = await fixture(t);
  const first = await f.prepare('first');
  const saved = (await f.capture(first.run.runId, 'one')).items[0]!;
  assert.deepEqual(saved.reinforcement, { independentRuns: 1, priority: 'normal', promoted: false });
  assert.deepEqual((await f.capture(first.run.runId, 'one')).items[0], saved);
  assert.deepEqual((await f.capture(first.run.runId, 'same-run')).items[0]!.reinforcement, saved.reinforcement);
  await assert.rejects(f.capture(first.run.runId, 'one', { ...lesson, body: 'Changed input' }), { code: 'CONFLICT' });
  const before = contextRetrievalStateHash(f.db, [saved.workspace]);
  const second = await f.prepare('second');
  const reinforced = (await f.capture(second.run.runId, 'two')).items[0]!;
  assert.equal(reinforced.entryId, saved.entryId);
  assert.deepEqual(reinforced.reinforcement, { independentRuns: 2, priority: 'reinforced', promoted: true });
  assert.notEqual(contextRetrievalStateHash(f.db, [saved.workspace]), before);
  assert.deepEqual((await f.capture(second.run.runId, 'two')).items[0], reinforced);
  const promotedState = contextRetrievalStateHash(f.db, [saved.workspace]);
  const third = await f.prepare('third');
  assert.deepEqual((await f.capture(third.run.runId, 'three')).items[0]!.reinforcement,
    { independentRuns: 3, priority: 'reinforced', promoted: false });
  assert.equal(contextRetrievalStateHash(f.db, [saved.workspace]), promotedState,
    'Another observation at the same priority must not invalidate an unchanged delivery');
  const entry = readEntry(f.db, { workspace: saved.workspace, entryId: saved.entryId });
  assert.equal(entry.status, 'candidate');
  assert.equal(entry.trustLevel, 'untrusted');
  assert.equal(entry.revision, 1);
  for (let index = 0; index < 150; index++) recordEntry(f.db, { workspace: saved.workspace, kind: 'lesson',
    title: `Migration compatibility ${index}`, body: 'Migration compatibility assets', status: 'verified', confidence: 1 });
  const ranked = rankedEntryHits(f.db, { workspace: saved.workspace, query: 'migration compatibility', limit: 1 });
  assert.equal(ranked.hits[0]!.entryId, saved.entryId);
  assert.ok(ranked.hits[0]!.reasons.includes('repeated_lesson'));
  assert.equal(rankedEntryHits(f.db, { workspace: saved.workspace, query: 'zoologyxyz', limit: 1 }).hits.length, 0);
});

test('explicit reinforcement handles paraphrases, checks revision/scope, and rolls back a failed batch', async t => {
  const f = await fixture(t);
  const first = await f.prepare('first');
  const second = await f.prepare('second');
  const saved = (await f.capture(first.run.runId, 'one')).items[0]!;
  const reinforces = { entryId: saved.entryId, expectedRevision: saved.revision };
  const paraphrase = { ...lesson, body: 'A new migration also needs the compatibility assets list updated.', reinforces };
  await assert.rejects(f.capture(second.run.runId, 'stale', { ...paraphrase, reinforces: { ...reinforces, expectedRevision: 2 } }), { code: 'CONFLICT' });
  const otherRoot = path.join(f.base, 'other');
  execFileSync('git', ['init', '-q', otherRoot]);
  const other = await f.prepare('other', otherRoot);
  await assert.rejects(f.capture(other.run.runId, 'cross-project', paraphrase, otherRoot), { code: 'NOT_FOUND' });
  await assert.rejects(f.capture(second.run.runId, 'invalid-basis', { ...paraphrase, basis: 'user_statement' }), { code: 'VALIDATION_ERROR' });
  f.db.exec("CREATE TRIGGER reject_lesson BEFORE INSERT ON lesson_observations BEGIN SELECT RAISE(ABORT, 'fixture failure'); END");
  await assert.rejects(captureInteractionMemory(f.db, { runId: second.run.runId, operationId: 'batch', memories: [
    { ...lesson, kind: 'fact', title: 'Must roll back' }, paraphrase,
  ] }, { cwd: f.root, clientKind: 'test' }));
  assert.equal(f.db.prepare('SELECT COUNT(*) n FROM entries').get<{ n: number }>()!.n, 1);
  f.db.exec('DROP TRIGGER reject_lesson');
  await assert.rejects(captureInteractionMemory(f.db, { runId: second.run.runId, operationId: 'correct-and-reinforce', memories: [
    { ...lesson, body: 'A correction', basis: 'user_correction', replaces: reinforces }, paraphrase,
  ] }, { cwd: f.root, clientKind: 'test' }), { code: 'CONFLICT' });
  assert.equal(readEntry(f.db, { workspace: saved.workspace, entryId: saved.entryId }).status, 'candidate');
  assert.equal(f.db.prepare('SELECT COUNT(*) n FROM entries').get<{ n: number }>()!.n, 1);
  const receipt = (await f.capture(second.run.runId, 'paraphrase', paraphrase)).items[0]!;
  assert.equal(receipt.outcome, 'reinforced');
  assert.equal(receipt.reinforcement!.priority, 'reinforced');
  assert.equal(readEntry(f.db, { workspace: saved.workspace, entryId: saved.entryId }).body, lesson.body);
  const current = readEntry(f.db, { workspace: saved.workspace, entryId: saved.entryId });
  updateCandidateEntry(f.db, { ...current, entryId: current.id, expectedRevision: 1, body: 'Corrected lesson: derive the asset list automatically.' });
  assert.deepEqual(lessonReinforcement(f.db, readEntry(f.db, { workspace: saved.workspace, entryId: saved.entryId })),
    { independentRuns: 0, priority: 'normal' });
  await assert.rejects(f.capture(second.run.runId, 'old-revision', paraphrase), { code: 'CONFLICT' });
  purgeEntry(f.db, { workspace: saved.workspace, entryId: saved.entryId, confirm: true });
  assert.equal((await f.capture(first.run.runId, 'one')).items[0]!.availability, 'unavailable');
  assert.equal(f.db.prepare('SELECT COUNT(*) n FROM lesson_observations').get<{ n: number }>()!.n, 0);
});

test('capture and evidence-backed checkpoint observations share lesson identity; evidence alone creates none', async t => {
  const f = await fixture(t);
  const first = await f.prepare('first');
  const second = await f.prepare('second');
  const third = await f.prepare('third');
  const saved = (await f.capture(first.run.runId, 'one')).items[0]!;
  const checkpoint = await checkpointScopedMemory(f.db, { cwd: f.root, runId: second.run.runId, outcome: 'failed',
    memories: [{ kind: 'lesson', scope: 'project', title: 'Migration asset regression', body: lesson.body }],
    evidence: { tests: [{ runner: 'node:test', outcome: 'failed' }] } });
  assert.equal(checkpoint.entries[0]!.reinforcement!.priority, 'reinforced');
  assert.equal(lessonReinforcement(f.db, readEntry(f.db, { workspace: saved.workspace, entryId: saved.entryId })).independentRuns, 2);
  const evidenceOnly = await checkpointScopedMemory(f.db, { cwd: f.root, runId: third.run.runId, outcome: 'failed',
    memories: [],
    evidence: { tests: [{ runner: 'node:test', outcome: 'failed' }] } });
  assert.equal(evidenceOnly.storedMemoryCount, 0);
  assert.equal(f.db.prepare('SELECT COUNT(*) n FROM lesson_observations').get<{ n: number }>()!.n, 2);
});

test('child runs, declarations, global captures and unevidenced checkpoints cannot manufacture promotion', async t => {
  const f = await fixture(t);
  const parent = await f.prepare('parent');
  const child = await f.prepare('child');
  f.db.prepare('UPDATE ledger_runs SET parent_run_id = ? WHERE run_id = ?').run(parent.run.runId, child.run.runId);
  const saved = (await f.capture(parent.run.runId, 'parent')).items[0]!;
  assert.equal((await f.capture(child.run.runId, 'child')).items[0]!.reinforcement!.independentRuns, 1);
  const independent = await f.prepare('independent');
  const declared = await f.capture(independent.run.runId, 'declaration', { ...lesson, basis: 'user_statement' });
  assert.equal(declared.items[0]!.reinforcement, undefined);
  assert.equal(lessonReinforcement(f.db, readEntry(f.db, { workspace: saved.workspace, entryId: saved.entryId })).independentRuns, 1);
  const globalMemory = { ...lesson, scope: 'global', portableReason: 'A reusable lesson about migration tests' };
  for (const operationId of ['global-one', 'global-two']) {
    const result = await captureInteractionMemory(f.db, { operationId, memories: [globalMemory] }, { cwd: f.root, clientKind: 'test' });
    assert.equal(result.items[0]!.reinforcement, undefined);
  }
  const unevidenced = await checkpointScopedMemory(f.db, { cwd: f.root, runId: independent.run.runId, outcome: 'failed',
    memories: [{ kind: 'lesson', title: 'Declaration only', body: lesson.body, scope: 'project' }] });
  assert.equal(unevidenced.entries[0]!.reinforcement!.independentRuns, 1);
  const correction = (await f.capture(parent.run.runId, 'correction', { ...lesson, body: 'Derive the asset list from migration files.',
    basis: 'user_correction', replaces: { entryId: saved.entryId, expectedRevision: 1 } })).items[0]!;
  assert.equal(lessonReinforcement(f.db, readEntry(f.db, { workspace: saved.workspace, entryId: correction.entryId })).independentRuns, 0);
  assert.equal(f.db.prepare('SELECT COUNT(*) n FROM lesson_observations').get<{ n: number }>()!.n, 0);
});

test('MCP restart delivers repeated lesson first and requires review plus regression evidence', async t => {
  const f = await fixture(t);
  const connect = async () => {
    const server = createKiokukoMcpServer({ databasePath: f.databasePath, cwd: () => f.root });
    const client = new Client({ name: 'reinforcement-test', version: '1' });
    const [a, b] = InMemoryTransport.createLinkedPair();
    await server.connect(b); await client.connect(a);
    return { client, close: async () => { await client.close(); await server.close(); } };
  };
  type Prepared = { run: { runId: string }; context: { deliveryId: string; items: Array<{ entryId: string; revision: number; selectionReasons: string[] }> } };
  const first = await connect();
  let entryId: string;
  try {
    for (const id of ['one', 'two']) {
      const result = await first.client.callTool({ name: 'task_prepare', arguments: { ...task, requestId: id } });
      assert.notEqual(result.isError, true);
      const prepared = result.structuredContent as unknown as Prepared;
      if (id === 'two') {
        const rejected = await first.client.callTool({ name: 'memory_capture', arguments: {
          runId: prepared.run.runId, operationId: 'stale-target',
          memories: [{ ...lesson, reinforces: { entryId: entryId!, expectedRevision: 2 } }],
        } });
        assert.equal(rejected.isError, true);
        const failure = rejected.structuredContent as { reason: string; storedObservationCount: number };
        assert.equal(failure.reason, 'reinforcement_revision_changed');
        assert.equal(failure.storedObservationCount, 0);
      }
      const capture = await first.client.callTool({ name: 'memory_capture', arguments: {
        runId: prepared.run.runId, operationId: id, memories: [lesson],
      } });
      assert.notEqual(capture.isError, true);
      entryId = (capture.structuredContent as { items: Array<{ entryId: string }> }).items[0]!.entryId;
    }
  } finally { await first.close(); }
  const second = await connect();
  try {
    const call = (name: string, args: Record<string, unknown>) => second.client.callTool({ name, arguments: args });
    const prepared = (await call('task_prepare', { ...task, requestId: 'three' })).structuredContent as unknown as Prepared;
    assert.equal(prepared.context.items[0]!.entryId, entryId!);
    assert.ok(prepared.context.items[0]!.selectionReasons.includes('repeated_lesson'));
    const runId = prepared.run.runId, deliveryId = prepared.context.deliveryId;
    const checkpoint = { runId, outcome: 'completed', evidence: { tests: [{ runner: 'node:test', outcome: 'passed' }] } };
    assert.equal((await call('memory_checkpoint', checkpoint)).isError, true);
    const status = (await call('task_memory_status', { cwd: f.root, runId, snapshot: true })).structuredContent as
      { revision: number; pending: string[]; stateDigest: string };
    assert.ok(status.pending.includes(entryId!));
    const review = { cwd: f.root, runId, deliveryId, entryId: entryId!, entryRevision: 1, decision: 'adopted',
      basis: 'This task adds a migration', invariant: 'The new migration appears in compatibility assets',
      counterexample: 'Add a migration without adding its asset', verification: 'Run the asset coverage test' };
    const reviewed = await call('task_memory_review', { ...review, requestId: 'review', expectedRevision: status.revision });
    assert.notEqual(reviewed.isError, true);
    assert.equal((await call('memory_checkpoint', checkpoint)).isError, true);
    const executed = await call('task_execution_evidence', { cwd: f.root, runId, deliveryId, requestId: 'evidence',
      expectedRevision: (reviewed.structuredContent as { revision: number }).revision,
      stateDigest: status.stateDigest, execution: 'asset coverage fixture', outcome: 'passed', exitCode: 0 });
    assert.notEqual(executed.isError, true);
    const evidence = executed.structuredContent as { evidenceId: string; revision: number };
    assert.notEqual((await call('task_memory_review', { ...review, requestId: 'review-passed',
      expectedRevision: evidence.revision, evidenceIds: [evidence.evidenceId] })).isError, true);
    assert.notEqual((await call('memory_checkpoint', checkpoint)).isError, true);
    const withheld = await call('task_prepare', { ...task, requestId: 'withheld', capabilities: [capabilities[0]] });
    assert.equal((withheld.structuredContent as { memoryPolicy: { contextWithheld: boolean } }).memoryPolicy.contextWithheld, true);
  } finally { await second.close(); }
});

test('migration preserves existing entries and does not infer historical observations', async t => {
  const base = await mkdtemp(path.join(tmpdir(), 'kiokuko-reinforcement-migration-'));
  t.after(() => rm(base, { recursive: true, force: true }));
  const dir = path.join(base, 'migrations');
  await mkdir(dir);
  for (const migration of loadMigrationSnapshot().migrations.filter(m => m.version < 5)) await writeFile(path.join(dir, migration.name), migration.sql);
  const databasePath = path.join(base, 'memory.sqlite3');
  await initializeDatabase({ databasePath, migrationsDirectory: dir });
  const db = openConnection(databasePath);
  try {
    const entry = recordEntry(db, { workspace: 'legacy', kind: 'lesson', title: 'Existing lesson', body: lesson.body });
    assert.deepEqual(migrateDatabase(db).applied, [5]);
    assert.deepEqual(readEntry(db, { workspace: entry.workspace, entryId: entry.id }), entry);
    assert.deepEqual(migrateDatabase(db).applied, []);
    assert.equal(db.prepare('SELECT COUNT(*) n FROM lesson_observations').get<{ n: number }>()!.n, 0);
  } finally { db.close(); }
});
