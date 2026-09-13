import assert from 'node:assert/strict';
import { performance, monitorEventLoopDelay } from 'node:perf_hooks';
import { fixture, capabilities, base, printReport } from './akinator-memory-fixture.mjs';
import { probeProfileMemory } from '../dist/akinator/memory-probe.js';
import { getAkinatorStateService, getAkinatorContextService } from '../dist/akinator/service.js';
import { recordEntryInTransaction, readEntry } from '../dist/memory/entries.js';
import { isRetrievableEntry } from '../dist/memory/hybrid-retrieval.js';
import { withImmediateTransaction } from '../dist/db/transaction.js';
import { prepareAgentTask } from '../dist/akinator/agent-task.js';

const large = process.argv.includes('--large');
const limitCheck = process.argv.includes('--limit-check');
const sizes = limitCheck ? [[10_001, 1]] : large ? [[10_000, 1_000], [100_000, 10_000]] : [[1_000, 100]];
const results = [];
let prepareFailures = 0;
for (const [entries, profiles] of sizes) {
  const f = await fixture({ reuseSeedStatements: true });
  const delay = monitorEventLoopDelay({ resolution: 10 }); delay.enable();
  try {
    process.stderr.write(`Preparing ${entries} entries / ${profiles} profiles...\n`);
    const source = f.addProfile();
    for (let i = 1; i < profiles; i++) {
      f.addProfile(`other/location-${i}.txt`);
      if (i % 1000 === 0) { process.stderr.write(`Profiles: ${i}/${profiles}\n`); await new Promise(resolve => setImmediate(resolve)); }
    }
    for (let offset = 0; offset < entries; offset += 1000) {
      withImmediateTransaction(f.database, () => {
        for (let i = offset; i < Math.min(offset + 1000, entries); i++) recordEntryInTransaction(f.seedDatabase, {
          workspace: f.scope.workspace, kind: 'lesson', title: `Unrelated ${i}`, body: `Synthetic unrelated datum ${i}`,
          tags: i < 12 ? ['bot:builder', 'skill:tdd'] : ['unrelated'],
        }, { now: '2026-09-01T00:00:00.000Z' });
      });
      if ((offset + 1000) % 10_000 === 0) process.stderr.write(`Entries: ${offset + 1000}/${entries}\n`);
      await new Promise(resolve => setImmediate(resolve));
    }
    f.finishSeeding();
    process.stderr.write('Corpus ready; measuring retrieval and prepare.\n');
    let sqlCalls = 0, entryReads = 0, transactionStarted, transactionMs = 0;
    const measured = { filePath: f.database.filePath, exec(sql) {
      const result = f.database.exec(sql);
      if (/^BEGIN /u.test(sql)) transactionStarted = performance.now();
      if (/^(COMMIT|ROLLBACK)$/u.test(sql) && transactionStarted !== undefined) {
        transactionMs += performance.now() - transactionStarted;
        transactionStarted = undefined;
      }
      return result;
    }, close() {}, prepare(sql) {
      sqlCalls++;
      if (sql.includes('revision_entry_id')) entryReads++;
      return f.database.prepare(sql);
    } };
    async function measure(label, action) {
      sqlCalls = 0; entryReads = 0; transactionMs = 0;
      const cpu = process.cpuUsage(), started = performance.now();
      const value = await action();
      const elapsedMs = performance.now() - started;
      const used = process.cpuUsage(cpu);
      results.push({ label, entries, profiles, elapsedMs, sqlCalls, entryReads, transactionMs, cpuMicros: used.user + used.system, rss: process.memoryUsage().rss });
      return value;
    }
    // Reproduce the former taggedEntries algorithm; same canonical decoder and eligibility policy.
    const legacy = await measure('legacy tagged scan', () => measured.prepare('SELECT id FROM entries WHERE workspace = ? ORDER BY updated_at DESC, id ASC').all(f.scope.workspace)
      .map(row => readEntry(measured, { workspace: f.scope.workspace, entryId: row.id }))
      .filter(entry => isRetrievableEntry(measured, entry) && entry.status !== 'superseded' && entry.tags.some(tag => ['bot:builder', 'skill:tdd'].includes(tag))).slice(0, 12));
    const context = await measure('indexed context (includes ordinary search)', () => getAkinatorContextService(measured, { workspace: f.scope.workspace, sessionId: source.intakeSessionId }));
    assert.deepEqual(context.entries.map(entry => entry.id), legacy.map(entry => entry.id));
    await measure('state only', () => getAkinatorStateService(measured, { workspace: f.scope.workspace, sessionId: source.intakeSessionId }));
    assert.equal(entryReads, 0);
    for (const mode of ['off', 'shadow', 'suggest', 'resolve']) {
      for (let sample = 0; sample < 5; sample++) {
        const probe = await measure(`probe ${mode} ${sample === 0 ? 'first' : 'warm'}`, () => probeProfileMemory(measured, 'src/feature.ts', base, { scope: f.scope, mode, capabilities }));
        assert.ok(probe.resolution.metrics.expandedProfiles <= 64);
        results.at(-1).probe = probe.resolution.metrics;
      }
      await measure(`prepare ${mode} (no embedding runtime, discovery off)`, async () => {
        try {
          const prepared = await prepareAgentTask(measured, {
            requestId: `benchmark-${mode}`, task: 'src/feature.ts', cwd: f.root, profileHints: base, capabilities,
            profileMemoryMode: mode, skillDiscoveryMode: 'off',
          });
          return { outcome: 'passed', nextAction: prepared.nextAction };
        } catch (error) {
          prepareFailures++;
          return { outcome: 'failed', code: error.code ?? null, message: error.message };
        }
      }).then(outcome => { results.at(-1).prepare = outcome; });
    }
    await new Promise(resolve => setTimeout(resolve, 20));
    results.push({ entries, profiles, eventLoopDelayMaxMs: delay.max / 1e6 });
  } finally { delay.disable(); await f.close(); }
}
printReport({ node: process.version, sqlite: process.versions.sqlite,
  platform: process.platform, architecture: process.arch, large, limitCheck, prepareFailures, seed: 'fixed synthetic corpus v1',
  note: 'In-memory SQLite, sequential requests. Corpus creation alone reuses prepared statements; measurements use the normal uncached adapter. Legacy tag scan and indexed context have different measured boundaries. Embedding/network/provider time and concurrent request latency are not measured.', results });
if (prepareFailures > 0) process.exitCode = 1;
