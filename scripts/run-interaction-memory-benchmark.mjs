import assert from 'node:assert/strict';
import { performance } from 'node:perf_hooks';
import { openConnection } from '../dist/db/connection.js';
import { migrateDatabase } from '../dist/db/migrate.js';
import { withImmediateTransaction } from '../dist/db/transaction.js';
import { ordinaryContextSelectionStateHash } from '../dist/context/selection-state.js';
import { recordEntryInTransaction } from '../dist/memory/entries.js';
import { buildStructuredScope } from '../dist/memory/structured-memory.js';
import { ensureGlobalWorkspace } from '../dist/memory/workspaces.js';
import { recallInteractionMemory } from '../dist/memory/interaction-recall.js';
import { captureInteractionMemory } from '../dist/memory/interaction-capture.js';

const database = openConnection(':memory:');
const capabilities = [{ kind: 'skill', name: 'kiokuko-soul' }, { kind: 'skill', name: 'memory-reasoning' }];
const now = '2026-09-19T00:00:00.000Z';
const scope = buildStructuredScope({ visibility: 'global', retrievalScope: 'global', portableReason: 'General synthetic knowledge.' });
const input = (i) => ({ workspace: 'global', kind: 'fact', title: `Synthetic topic ${i}`,
  body: `Synthetic topic ${i} has reference marker reference${i}.`, tags: [`subject:topic-${i % 100}`], scope,
  provenance: { type: 'interaction_capture', reference: 'observed_result', clientKind: 'benchmark', timestamp: now } });
async function measure(operation, count = 10) {
  const samples = [];
  for (let i = 0; i < count; i++) { const start = performance.now(); await operation(i); samples.push(performance.now() - start); }
  samples.sort((a, b) => a - b);
  return { p50ms: Number(samples[Math.floor(samples.length * .5)].toFixed(2)), p95ms: Number(samples[Math.ceil(samples.length * .95) - 1].toFixed(2)) };
}
try {
  migrateDatabase(database); ensureGlobalWorkspace(database);
  const start = performance.now();
  withImmediateTransaction(database, () => {
    for (let i = 0; i < 10_000; i++) recordEntryInTransaction(database, input(i), { now });
  });
  const seedMs = performance.now() - start;
  const recall = await measure(async () => {
    const result = await recallInteractionMemory(database, { soulRead: true, capabilities, query: 'reference9999', subjects: ['topic-99'] });
    assert.equal(result.items[0]?.title, 'Synthetic topic 9999');
  });
  const snapshot = await measure(() => ordinaryContextSelectionStateHash(database, ['global']), 3);
  const capture = await measure(async (i) => { const result = await captureInteractionMemory(database, { operationId: `benchmark-${i}`, memories: [{ kind: 'fact',
    title: 'Synthetic topic 9999', body: input(9999).body, scope: 'global', portableReason: 'General synthetic knowledge.',
    subjects: ['topic-99'], basis: 'observed_result' }] }, { cwd: process.cwd(), clientKind: 'benchmark' }); assert.equal(result.items[0]?.outcome, 'duplicate'); });
  assert.equal(database.prepare('SELECT COUNT(*) n FROM entries').get().n, 10_000);
  withImmediateTransaction(database, () => recordEntryInTransaction(database, input(10_000), { now }));
  assert.throws(() => ordinaryContextSelectionStateHash(database, ['global']), { code: 'INTEGRITY_ERROR' });
  console.log(JSON.stringify({ corpusSize: 10_000, storage: 'in-memory SQLite', semantics: 'off', node: process.version,
    platform: process.platform, arch: process.arch, seedMs: Number(seedMs.toFixed(2)), subjectRecall: recall,
    exactDuplicateCapture: capture, projectSnapshotHash: snapshot, refuses10001EntrySnapshot: true }, null, 2));
} finally { database.close(); }
