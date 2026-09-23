import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test, { type TestContext } from 'node:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { prepareAgentTask } from '../../src/akinator/agent-task.js';
import { initializeDatabase } from '../../src/commands/init.js';
import { exportWorkspace } from '../../src/commands/export.js';
import { importWorkspace } from '../../src/commands/import.js';
import { purgeEntry } from '../../src/commands/purge.js';
import { openConnection } from '../../src/db/connection.js';
import { createKiokukoMcpServer } from '../../src/mcp/server.js';
import { captureInteractionMemory } from '../../src/memory/interaction-capture.js';
import { recallInteractionMemory } from '../../src/memory/interaction-recall.js';
import { readEntry, recordEntry, updateCandidateEntry } from '../../src/memory/entries.js';
import { globalizeCuratorCandidate } from '../../src/memory/curator.js';
import { buildStructuredScope } from '../../src/memory/structured-memory.js';
import { promoteEntry } from '../../src/memory/lifecycle.js';
import { rebuildHybridSearch } from '../../src/memory/rebuild-search.js';
import { checkpointScopedMemory } from '../../src/memory/scoped-memory.js';

const capabilities = [{ kind: 'skill', name: 'kiokuko-soul' }, { kind: 'skill', name: 'memory-reasoning' }];
const grammar = { kind: 'preference', title: 'Japanese grammar explanations', body: 'For Japanese grammar explanations, give examples before terminology.',
  scope: 'global', portableReason: 'Applies to Japanese grammar explanations in any project.', subjects: ['Japanese Grammar'], basis: 'user_statement' };
const general = { kind: 'preference', title: 'Answer style', body: 'Use short headings in explanations.', scope: 'global',
  portableReason: 'General communication preference across subjects.', generalCommunication: true, basis: 'user_statement' };

async function fixture(t: TestContext) {
  const root = await mkdtemp(path.join(tmpdir(), 'kiokuko-interaction-'));
  const databasePath = path.join(root, 'data.sqlite3');
  await initializeDatabase({ databasePath });
  const db = openConnection(databasePath);
  t.after(async () => { db.close(); await rm(root, { recursive: true, force: true }); });
  const options = { cwd: root, clientKind: 'interaction-test' };
  const capture = (operationId: string, memories: unknown[], extra: Record<string, unknown> = {}) =>
    captureInteractionMemory(db, { operationId, memories, ...extra }, options);
  const recall = (query: string, extra: Record<string, unknown> = {}) =>
    recallInteractionMemory(db, { query, soulRead: true, capabilities, ...extra });
  return { root, databasePath, db, capture, recall, options };
}

test('standalone conversation learns subject and general preferences without a project or run', async (t) => {
  const { db, capture, recall } = await fixture(t);
  const saved = await capture('first', [grammar, general]);
  assert.equal(saved.items.length, 2);
  const memory = readEntry(db, { workspace: 'global', entryId: saved.items[0]!.entryId });
  assert.equal(memory.status, 'candidate');
  assert.equal(memory.trustLevel, 'untrusted');
  assert.deepEqual(memory.tags, ['subject:japanese-grammar']);
  assert.equal(memory.provenance.reference, 'user_statement');
  const before = db.prepare('SELECT total_changes() n').get<{ n: number }>()!.n;
  const relevant = await recall('Explain Japanese grammar particles');
  assert.ok(relevant.items.some((item) => item.content.includes('examples before terminology')));
  assert.ok(relevant.items.some((item) => item.content.includes('short headings')));
  const other = await recall('Review a SQLite transaction');
  assert.deepEqual(other.items.map((item) => item.entryId), [saved.items[1]!.entryId]);
  assert.equal(db.prepare('SELECT total_changes() n').get<{ n: number }>()!.n, before);
  for (const table of ['repository_locations', 'ledger_runs', 'akinator_sessions', 'context_deliveries']) {
    assert.equal(db.prepare(`SELECT COUNT(*) n FROM ${table}`).get<{ n: number }>()!.n, 0);
  }
});

test('explicit subject filters precede candidate limits and preference injection', async (t) => {
  const { capture, recall } = await fixture(t);
  for (let i = 0; i < 130; i++) await capture(`noise-${i}`, [{ ...grammar, kind: 'fact', title: `Particles ${i}`, subjects: ['physics'], body: `Particles experiment ${i}` }]);
  const saved = await capture('grammar', [grammar, general]);
  const result = await recall('particles', { subjects: ['Japanese Grammar'], limit: 1 });
  // Search remains query based; the title/body must contain the query as well as the subject.
  const second = await recall('explanations', { subjects: ['Japanese Grammar'], limit: 1 });
  assert.equal(result.items.length, 0);
  assert.deepEqual(second.items.map((item) => item.entryId), [saved.items[0]!.entryId]);
  assert.ok(!second.items.some((item) => item.entryId === saved.items[1]!.entryId));
});

test('exact captures deduplicate across operation IDs and survive restart and purge replay', async (t) => {
  const { capture, db, databasePath, options, recall } = await fixture(t);
  const first = await capture('first', [grammar]);
  assert.deepEqual(await capture('first', [grammar]), first);
  const other = openConnection(databasePath);
  try {
    const duplicate = await captureInteractionMemory(other, { operationId: 'second', memories: [grammar] }, options);
    assert.equal(duplicate.items[0]!.entryId, first.items[0]!.entryId);
    assert.equal(duplicate.items[0]!.outcome, 'duplicate');
  } finally { other.close(); }
  await assert.rejects(capture('first', [{ ...grammar, body: 'changed' }]), { code: 'CONFLICT' });
  const serialized = JSON.stringify(db.prepare('SELECT * FROM gateway_idempotency').all());
  assert.ok(!serialized.includes(grammar.body));
  purgeEntry(db, { workspace: 'global', entryId: first.items[0]!.entryId, confirm: true });
  const replay = await capture('first', [grammar]);
  assert.equal(replay.items[0]!.availability, 'unavailable');
  assert.equal(db.prepare('SELECT COUNT(*) n FROM interaction_memory_fingerprints').get<{ n: number }>()!.n, 0);
  assert.equal((await recall('Japanese grammar')).items.length, 0);
});

test('correction supersedes a verified memory atomically and stale revisions roll back the batch', async (t) => {
  const { capture, db, recall } = await fixture(t);
  const old = (await capture('first', [grammar])).items[0]!;
  promoteEntry(db, { workspace: 'global', entryId: old.entryId, expectedRevision: old.revision });
  const correction = { ...grammar, body: 'For Japanese grammar, give terminology before examples.', basis: 'user_correction',
    replaces: { entryId: old.entryId, expectedRevision: old.revision } };
  const saved = (await capture('correct', [correction])).items[0]!;
  assert.equal(saved.outcome, 'corrected');
  assert.equal(readEntry(db, { workspace: 'global', entryId: old.entryId }).supersededBy, saved.entryId);
  assert.equal(readEntry(db, { workspace: 'global', entryId: saved.entryId }).status, 'candidate');
  assert.deepEqual((await recall('Japanese grammar')).items.map((item) => item.entryId), [saved.entryId]);
  const before = db.prepare('SELECT COUNT(*) n FROM entries').get<{ n: number }>()!.n;
  await assert.rejects(capture('stale', [general, correction]), { code: 'CONFLICT' });
  assert.equal(db.prepare('SELECT COUNT(*) n FROM entries').get<{ n: number }>()!.n, before);
  assert.deepEqual((await capture('correct', [correction])).items.map((item) => item.entryId), [saved.entryId]);
});

test('a write failure after replacement insertion rolls back entry, superseding and receipt', async (t) => {
  const { capture, db } = await fixture(t);
  const old = (await capture('first', [grammar])).items[0]!;
  db.exec("CREATE TRIGGER fail_correction BEFORE UPDATE OF status ON entries WHEN NEW.status = 'superseded' BEGIN SELECT RAISE(ABORT, 'test failure'); END");
  await assert.rejects(capture('broken', [{ ...grammar, body: 'Corrected statement', basis: 'user_correction', replaces: { entryId: old.entryId, expectedRevision: 1 } }]));
  assert.equal(readEntry(db, { workspace: 'global', entryId: old.entryId }).status, 'candidate');
  assert.equal(db.prepare('SELECT COUNT(*) n FROM entries').get<{ n: number }>()!.n, 1);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM gateway_idempotency').get<{ n: number }>()!.n, 1);
});

test('secret input, trust escalation, ambiguous correction and oversized batches have no effects', async (t) => {
  const { capture, db } = await fixture(t);
  await assert.rejects(capture('secret', [general, { ...grammar, body: `api_key = sk-${'x'.repeat(30)}` }]), { code: 'SECURITY_REJECTION' });
  await assert.rejects(capture('trust', [{ ...grammar, trustLevel: 'system_verified' }]), { code: 'VALIDATION_ERROR' });
  await assert.rejects(capture('expanded', [{ ...grammar, body: 'ﬃ'.repeat(1000) }]), { code: 'VALIDATION_ERROR' });
  await assert.rejects(capture('large', Array.from({ length: 6 }, () => grammar)), { code: 'VALIDATION_ERROR' });
  await assert.rejects(capture('inferred', [{ ...grammar, replaces: { entryId: 'unknown', expectedRevision: 1 } }]), { code: 'VALIDATION_ERROR' });
  assert.equal(db.prepare('SELECT COUNT(*) n FROM entries').get<{ n: number }>()!.n, 0);
});

test('recall preserves soul and memory gates, limits general preferences and counts serialized context', async (t) => {
  const { capture, recall } = await fixture(t);
  await capture('styles', [general, { ...general, title: 'Style 2', body: 'Use plain language.' }, { ...general, title: 'Style 3', body: 'Use concrete examples.' }]);
  assert.equal((await recall('SQLite')).items.length, 2);
  const blocked = await recall('SQLite', { capabilities: [] });
  assert.equal(blocked.nextAction, 'required_capability_unavailable');
  assert.equal(blocked.items.length, 0);
  const missing = await recall('SQLite', { capabilities: [capabilities[0]] });
  assert.equal(missing.memoryPolicy.withheldReason, 'memory_reasoning_missing');
  assert.equal(missing.items.length, 0);
  const malformed = await recall('SQLite', { capabilities: [...capabilities, 42] });
  assert.equal(malformed.items.length, 0);
  assert.equal(malformed.memoryPolicy.withheldReason, 'memory_reasoning_unknown');
  const bounded = await recall('SQLite', { maxContextChars: 400 });
  assert.ok(Array.from(JSON.stringify(bounded.items)).length <= 400);
  await assert.rejects(recall(' '), { code: 'VALIDATION_ERROR' });
});

test('fingerprints follow candidate edits and rebuild from authoritative revisions', async (t) => {
  const { capture, db } = await fixture(t);
  const saved = (await capture('first', [grammar])).items[0]!;
  const current = readEntry(db, { workspace: 'global', entryId: saved.entryId });
  updateCandidateEntry(db, { ...current, entryId: current.id, expectedRevision: current.revision, body: 'A new grammar preference.' });
  db.exec('DELETE FROM interaction_memory_fingerprints');
  rebuildHybridSearch(db);
  const duplicate = await capture('second', [{ ...grammar, body: 'A new grammar preference.' }]);
  assert.equal(duplicate.items[0]!.entryId, saved.entryId);
  assert.equal(duplicate.items[0]!.revision, 2);
  assert.equal(duplicate.items[0]!.outcome, 'duplicate');
});

test('project capture requires its ready active run and preserves terminal checkpoint semantics', async (t) => {
  const { root, capture, db, options } = await fixture(t);
  execFileSync('git', ['init', '-q', root]);
  const open = (requestId: string, ready: boolean, caps = capabilities) => prepareAgentTask(db, { requestId, cwd: root, task: 'Implement transaction validation',
    profileHints: { taskType: 'build', ...(ready ? { target: 'transaction validation', expected: 'tests pass' } : {}) },
    capabilities: caps, client: { kind: options.clientKind }, skillDiscoveryMode: 'off' });
  const pending = await open('pending', false);
  const projectMemory = { ...grammar, scope: 'project', portableReason: undefined };
  await assert.rejects(capture('no-run', [projectMemory]), { code: 'VALIDATION_ERROR' });
  await assert.rejects(capture('pending', [projectMemory], { runId: pending.run.runId }), { code: 'CONFLICT' });
  const ready = await open('ready', true);
  const saved = await capture('active', [projectMemory], { runId: ready.run.runId });
  assert.equal(db.prepare('SELECT status FROM ledger_runs WHERE run_id = ?').get<{ status: string }>(ready.run.runId)!.status, 'active');
  await assert.rejects(captureInteractionMemory(db, { operationId: 'wrong-client', memories: [projectMemory], runId: ready.run.runId }, { ...options, clientKind: 'other' }), { code: 'CONFLICT' });
  await checkpointScopedMemory(db, { cwd: root, runId: ready.run.runId, outcome: 'completed', memories: [], evidence: { tests: [{ runner: 'node:test', outcome: 'passed' }] } });
  await assert.rejects(capture('terminal', [projectMemory], { runId: ready.run.runId }), { code: 'CONFLICT' });
  assert.equal(saved.items[0]!.workspace, ready.project.workspace);
});

test('project memory_capture survives a server restart and is delivered from its original workspace', async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), 'kiokuko-capture-restart-'));
  const databasePath = path.join(root, 'data.sqlite3');
  execFileSync('git', ['init', '-q', root]);
  t.after(async () => { await rm(root, { recursive: true, force: true }); });
  const connect = async () => {
    const server = createKiokukoMcpServer({ databasePath, cwd: () => root });
    const client = new Client({ name: 'capture-restart-test', version: '1' });
    const [a, b] = InMemoryTransport.createLinkedPair();
    await server.connect(b);
    await client.connect(a);
    return { client, server };
  };
  const first = await connect();
  let entryId: string;
  let workspace: string;
  try {
    const prepared = await first.client.callTool({ name: 'task_prepare', arguments: {
      soulRead: true, requestId: 'capture-restart-first', task: 'Check migration compatibility assets',
      profileHints: { taskType: 'debug', target: 'migration compatibility assets', expected: 'The asset list is checked' },
      capabilities,
    } });
    assert.notEqual(prepared.isError, true);
    const initial = prepared.structuredContent as { run: { runId: string }; project: { workspace: string } };
    workspace = initial.project.workspace;
    const captured = await first.client.callTool({ name: 'memory_capture', arguments: {
      operationId: 'capture-restart-memory', runId: initial.run.runId,
      memories: [{ kind: 'lesson', title: 'Migration compatibility asset list',
        body: 'When adding a migration, update the explicit module compatibility asset list and run its test.',
        scope: 'project', subjects: ['migration compatibility'], basis: 'observed_result' }],
    } });
    assert.notEqual(captured.isError, true);
    const receipt = captured.structuredContent as { items: Array<{ entryId: string; workspace: string; outcome: string; availability: string }> };
    assert.equal(receipt.items[0]?.outcome, 'created');
    assert.equal(receipt.items[0]?.availability, 'current');
    assert.equal(receipt.items[0]?.workspace, workspace);
    entryId = receipt.items[0]!.entryId;
  } finally { await first.client.close(); await first.server.close(); }

  const second = await connect();
  try {
    const prepared = await second.client.callTool({ name: 'task_prepare', arguments: {
      soulRead: true, requestId: 'capture-restart-second', task: 'Check migration compatibility asset list',
      profileHints: { taskType: 'debug', target: 'migration compatibility asset list', expected: 'The asset list is checked' },
      capabilities,
    } });
    assert.notEqual(prepared.isError, true);
    const recalled = prepared.structuredContent as { project: { workspace: string }; context: { items: Array<{ entryId: string }> } };
    assert.equal(recalled.project.workspace, workspace);
    assert.ok(recalled.context.items.some((item) => item.entryId === entryId));
  } finally { await second.client.close(); await second.server.close(); }
});

test('project preparation includes general preferences but withholds them without memory-reasoning', async (t) => {
  const { root, db, capture } = await fixture(t);
  await capture('general', [general]);
  execFileSync('git', ['init', '-q', root]);
  const prepare = (requestId: string, caps: unknown[]) => prepareAgentTask(db, { requestId, cwd: root,
    task: 'Implement SQLite transactions', profileHints: { taskType: 'build', target: 'transactions', expected: 'tests pass' },
    capabilities: caps, skillDiscoveryMode: 'off' });
  const ready = await prepare('with-memory', capabilities);
  assert.ok(ready.context?.items.some((item) => item.bodyPreview.includes('short headings')));
  const withheld = await prepare('without-memory', [capabilities[0]]);
  assert.equal(withheld.memoryPolicy.contextWithheld, true);
  assert.equal(withheld.context, null);
});

test('MCP publishes usable schemas, transport provenance, disable switch, and two-session recall', async (t) => {
  const { root, databasePath, db } = await fixture(t);
  const connect = async (enabled: boolean) => {
    const server = createKiokukoMcpServer({ databasePath, cwd: () => root, interactionMemoryEnabled: enabled });
    const client = new Client({ name: 'interaction-test', version: '1' });
    const [a, b] = InMemoryTransport.createLinkedPair();
    await server.connect(b); await client.connect(a);
    t.after(async () => { await client.close(); await server.close(); });
    return client;
  };
  const first = await connect(true);
  const tools = (await first.listTools()).tools;
  assert.ok(tools.find((tool) => tool.name === 'memory_capture')!.inputSchema.properties?.memories);
  const saved = await first.callTool({ name: 'memory_capture', arguments: { operationId: 'mcp-first', memories: [grammar] } });
  assert.notEqual(saved.isError, true);
  const second = await connect(false);
  const recalled = await second.callTool({ name: 'memory_recall', arguments: { query: 'Japanese grammar', soulRead: true, capabilities } });
  assert.notEqual(recalled.isError, true);
  assert.match(JSON.stringify(recalled.structuredContent), /examples before terminology/u);
  const disabled = await second.callTool({ name: 'memory_capture', arguments: { operationId: 'disabled', memories: [general] } });
  assert.deepEqual(disabled.structuredContent, { enabled: false, items: [] });
  assert.equal(db.prepare('SELECT COUNT(*) n FROM entries').get<{ n: number }>()!.n, 1);
  // This verifies protocol sessions, not natural model tool selection.
});


test('workspace import recreates fingerprints and keeps superseded memories excluded', async (t) => {
  const source = await fixture(t);
  const old = (await source.capture('old', [grammar])).items[0]!;
  await source.capture('correction', [{ ...grammar, body: 'Use terminology first for Japanese grammar.', basis: 'user_correction',
    replaces: { entryId: old.entryId, expectedRevision: 1 } }]);
  const archive = exportWorkspace(source.db, { workspace: 'global' });
  const file = path.join(source.root, 'export.jsonl');
  await writeFile(file, archive.content);
  const target = await fixture(t);
  await importWorkspace(target.db, { input: file });
  const duplicate = (await target.capture('new', [{ ...grammar, body: 'Use terminology first for Japanese grammar.' }])).items[0]!;
  assert.equal(duplicate.outcome, 'duplicate');
  assert.equal(target.db.prepare('SELECT COUNT(*) n FROM interaction_memory_fingerprints').get<{ n: number }>()!.n, 1);
  assert.deepEqual((await target.recall('Japanese grammar')).items.map((item) => item.entryId), [duplicate.entryId]);
});


test('concurrent independent capture processes serialize deduplication and conflicting operation reuse', async (t) => {
  const { root, databasePath, db } = await fixture(t);
  const source = `import { openConnection } from ${JSON.stringify(new URL('../../src/db/connection.ts', import.meta.url).href)};
    import { captureInteractionMemory } from ${JSON.stringify(new URL('../../src/memory/interaction-capture.ts', import.meta.url).href)};
    const db = openConnection(process.argv[1]);
    process.stdout.write('ready\\n');
    process.stdin.once('data', async () => {
      try { process.stdout.write(JSON.stringify(await captureInteractionMemory(db, JSON.parse(process.argv[2]), { cwd: process.argv[3], clientKind: 'concurrent-test' })) + '\\n'); }
      catch (error) { process.stdout.write(JSON.stringify({ error: error.code }) + '\\n'); }
      finally { db.close(); process.stdin.destroy(); }
    });`;
  async function race(payloads: object[]) {
    const children = payloads.map((payload) => {
      const child = spawn(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', source, databasePath, JSON.stringify(payload), root], { stdio: ['pipe', 'pipe', 'pipe'] });
      t.after(() => { if (child.exitCode === null) child.kill(); });
      let output = '', errors = '';
      let ready!: () => void;
      const started = new Promise<void>((resolve) => { ready = resolve; });
      child.stdout.on('data', (chunk: Buffer) => { output += chunk.toString(); if (output.includes('ready\n')) ready(); });
      child.stderr.on('data', (chunk: Buffer) => { errors += chunk.toString(); });
      const completed = new Promise<Record<string, any>>((resolve, reject) => {
        child.on('error', reject);
        child.on('close', (code) => { ready(); if (code !== 0) reject(new Error(errors)); else resolve(JSON.parse(output.trim().split('\n').at(-1)!)); });
      });
      return { child, started, completed };
    });
    await Promise.all(children.map((child) => child.started));
    for (const { child } of children) child.stdin.end('go');
    return Promise.all(children.map((child) => child.completed));
  }
  const same = await race([{ operationId: 'one', memories: [grammar] }, { operationId: 'two', memories: [grammar] }]);
  assert.equal(same[0]!.items[0].entryId, same[1]!.items[0].entryId);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM entries').get<{ n: number }>()!.n, 1);
  const conflict = await race([{ operationId: 'conflict', memories: [general] }, { operationId: 'conflict', memories: [{ ...general, body: 'Use long headings.' }] }]);
  assert.equal(conflict.filter((result) => result.error === 'CONFLICT').length, 1);
});

test('capture rejects another project and duplicate correction targets without partial writes', async (t) => {
  const { root, db, capture, options } = await fixture(t);
  const a = path.join(root, 'a'), b = path.join(root, 'b');
  await mkdir(a); await mkdir(b);
  execFileSync('git', ['init', '-q', a]); execFileSync('git', ['init', '-q', b]);
  const prepare = (cwd: string, requestId: string) => prepareAgentTask(db, { cwd, requestId, task: 'Implement validation',
    profileHints: { taskType: 'build', target: 'validation', expected: 'tests pass' }, capabilities,
    client: { kind: options.clientKind }, skillDiscoveryMode: 'off' });
  const runA = await prepare(a, 'a'); await prepare(b, 'b');
  await assert.rejects(capture('wrong-project', [{ ...grammar, scope: 'project' }], { cwd: b, runId: runA.run.runId }), { code: 'CONFLICT' });
  assert.equal(db.prepare('SELECT COUNT(*) n FROM entries').get<{ n: number }>()!.n, 0);
  const old = (await capture('old', [grammar])).items[0]!;
  const correct = { ...grammar, body: 'New grammar preference', basis: 'user_correction', replaces: { entryId: old.entryId, expectedRevision: 1 } };
  await assert.rejects(capture('ambiguous', [correct, { ...correct, body: 'Different preference' }]), { code: 'VALIDATION_ERROR' });
  assert.equal(readEntry(db, { workspace: 'global', entryId: old.entryId }).status, 'candidate');
  await assert.rejects(capture('old', [grammar], { cwd: a, runId: runA.run.runId }), { code: 'CONFLICT' });
});


test('automatic corrections cannot replace protected Curator projections', async (t) => {
  const { db, capture, recall } = await fixture(t);
  const source = recordEntry(db, { workspace: 'project:curator-fixture', kind: 'lesson',
    title: 'SQLite migration recovery workflow', body: 'A reusable troubleshooting workflow: when a migration fails, check the applied version, restore the backup, and verify the schema before retrying.',
    summary: 'A reusable workflow for recovering from migration failures.',
    scope: buildStructuredScope({ visibility: 'project', repositoryId: 'repo_curator_fixture', memoryClass: 'troubleshooting',
      applicability: { databases: ['SQLite'], tools: ['migration'] }, signals: { commands: ['check schema'] } }),
    tags: ['workflow', 'skill:database'] });
  const protectedEntry = globalizeCuratorCandidate(db, { workspace: source.workspace, entryId: source.id, expectedRevision: source.revision }).global;
  await assert.rejects(capture('protected', [{ ...grammar, basis: 'user_correction',
    replaces: { entryId: protectedEntry.id, expectedRevision: protectedEntry.revision } }]), { code: 'CONFLICT' });
  assert.equal(readEntry(db, { workspace: 'global', entryId: protectedEntry.id }).status, 'verified');
  const result = await recall('SQLite migration recovery', { capabilities: [capabilities[0]] });
  assert.ok(result.items.some((item) => item.entryId === protectedEntry.id), 'Curator exception remains available without ordinary-memory capability');
});
