import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test, { type TestContext } from 'node:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { initializeDatabase } from '../../src/commands/init.js';
import { purgeEntry } from '../../src/commands/purge.js';
import { openConnection } from '../../src/db/connection.js';
import { captureInteractionMemory } from '../../src/memory/interaction-capture.js';
import { readEntry, recordEntry } from '../../src/memory/entries.js';
import { globalizeCuratorCandidate } from '../../src/memory/curator.js';
import { buildStructuredScope } from '../../src/memory/structured-memory.js';
import { chatgptCaptureOutputSchema, chatgptPolicyOutputSchema, chatgptRecallOutputSchema } from '../../src/mcp/chatgpt-contract.js';
import { createChatgptMemoryServer } from '../../src/mcp/chatgpt-server.js';
import { ChatgptRuntimeOwner } from '../../src/mcp/chatgpt-runtime.js';

const memory = { kind: 'preference', title: 'Japanese grammar', body: 'Show examples before terminology.',
  subjects: ['Japanese grammar'], basis: 'user_statement', portableReason: 'Applies to language explanations across projects.' };

function errorCode(result: Record<string, unknown>) {
  return (result.structuredContent as Record<string, unknown> | undefined)?.code;
}

async function fixture(t: TestContext) {
  const root = await mkdtemp(path.join(tmpdir(), 'kiokuko-chatgpt-capture-'));
  const databasePath = path.join(root, 'kiokuko.sqlite3');
  await initializeDatabase({ databasePath });
  const db = openConnection(databasePath);
  const owners: ChatgptRuntimeOwner[] = [];
  t.after(async () => { for (const owner of owners) await owner.close(); db.close(); await rm(root, { recursive: true, force: true }); });
  const makeOwner = () => { const owner = new ChatgptRuntimeOwner(databasePath, 'read-write'); owners.push(owner); return owner; };
  return { root, databasePath, db, makeOwner };
}

async function connect(t: TestContext, owner: ChatgptRuntimeOwner) {
  const server = createChatgptMemoryServer(owner);
  const client = new Client({ name: 'untrusted-client', version: '1' });
  const [c, s] = InMemoryTransport.createLinkedPair();
  await server.connect(s); await client.connect(c);
  t.after(async () => { await client.close(); await server.close(); });
  const response = chatgptPolicyOutputSchema.parse((await client.callTool({ name: 'memory_policy', arguments: {} })).structuredContent);
  assert.equal(response.access, 'read-write');
  const policy = { version: response.policyVersion, digest: response.policyDigest, read: true };
  return { client, policy, capture: (operationId: string, memories: unknown[] = [memory]) => client.callTool({
    name: 'memory_capture', arguments: { operationId, memories, policy },
  }) };
}

test('opt-in capture publishes a strict write contract and saves global candidates visible in another session', async t => {
  const { db, makeOwner } = await fixture(t);
  const a = await connect(t, makeOwner());
  const tools = (await a.client.listTools()).tools;
  assert.deepEqual(tools.map(tool => tool.name).sort(), ['memory_capture', 'memory_policy', 'memory_recall']);
  const tool = tools.find(tool => tool.name === 'memory_capture')!;
  assert.deepEqual(tool.annotations, { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false });
  assert.equal(tool.inputSchema.additionalProperties, false);
  assert.deepEqual(Object.keys(tool.inputSchema.properties!).sort(), ['memories', 'operationId', 'policy']);
  const result = await a.capture('save-1');
  assert.notEqual(result.isError, true);
  const saved = chatgptCaptureOutputSchema.parse(result.structuredContent);
  assert.deepEqual(saved, JSON.parse((result.content as Array<{ text: string }>)[0]!.text));
  assert.equal(saved.enabled, true);
  assert.equal(saved.items[0]?.outcome, 'created');
  const entry = readEntry(db, { workspace: 'global', entryId: saved.items[0]!.entryId });
  assert.equal(entry.status, 'candidate'); assert.equal(entry.trustLevel, 'untrusted');
  assert.equal(entry.scope.retrievalScope, 'global');
  assert.equal(entry.provenance.clientKind, 'chatgpt-memory');
  const b = await connect(t, makeOwner());
  const recalled = await b.client.callTool({ name: 'memory_recall', arguments: { policy: b.policy, query: 'Japanese grammar' } });
  assert.equal(chatgptRecallOutputSchema.parse(recalled.structuredContent).items[0]?.entryId, entry.id);
  const duplicate = chatgptCaptureOutputSchema.parse((await b.capture('save-2')).structuredContent);
  assert.equal(duplicate.items[0]?.outcome, 'duplicate');
  assert.equal(duplicate.items[0]?.entryId, entry.id);
});

test('receipts survive restart, conflict on changed payload, and do not collide with local operation IDs', async t => {
  const { root, db, makeOwner } = await fixture(t);
  await captureInteractionMemory(db, { operationId: 'same-id', memories: [{ ...memory, scope: 'global', body: 'A different local preference.' }] }, { cwd: root, clientKind: 'local-test' });
  const owner = makeOwner(); const a = await connect(t, owner);
  const saved = chatgptCaptureOutputSchema.parse((await a.capture('same-id')).structuredContent);
  await owner.close();
  const b = await connect(t, makeOwner());
  assert.deepEqual((await b.capture('same-id')).structuredContent, saved);
  for (const replay of await Promise.all(Array.from({ length: 4 }, () => b.capture('same-id')))) {
    assert.deepEqual(replay.structuredContent, saved);
  }
  const changed = await b.capture('same-id', [{ ...memory, body: 'Changed request.' }]);
  assert.equal(changed.isError, true); assert.equal(errorCode(changed), 'CONFLICT');
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM gateway_idempotency').get<{n: number}>()!.n, 2);
});

test('read owners reject capture and writers recheck a changed schema before saving', async t => {
  const { databasePath, db, makeOwner } = await fixture(t);
  const read = new ChatgptRuntimeOwner(databasePath);
  try { await assert.rejects(read.capture({ operationId: 'denied', memories: [memory] }), /unavailable/); }
  finally { await read.close(); }
  const owner = makeOwner(); owner.start();
  // Even write-enabled recall has no writable connection.
  owner.withDatabase(connection => assert.throws(() => connection.exec('DELETE FROM entries'), /readonly/i));
  db.exec('DELETE FROM schema_migrations WHERE version = (SELECT MAX(version) FROM schema_migrations)');
  await assert.rejects(owner.capture({ operationId: 'outdated', memories: [memory] }), /Unsupported schema/);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM entries').get<{n:number}>()!.n, 0);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM gateway_idempotency').get<{n:number}>()!.n, 0);
});

test('corrections enforce revision and atomicity; replay never recreates purged content', async t => {
  const { db, makeOwner } = await fixture(t);
  const a = await connect(t, makeOwner());
  const saved = chatgptCaptureOutputSchema.parse((await a.capture('initial')).structuredContent).items[0]!;
  const correction = { ...memory, body: 'Explain terminology before examples.', basis: 'user_correction', replaces: { entryId: saved.entryId, expectedRevision: saved.revision } };
  const result = chatgptCaptureOutputSchema.parse((await a.capture('correction', [correction])).structuredContent);
  assert.equal(result.items[0]?.outcome, 'corrected');
  assert.equal(readEntry(db, { workspace: 'global', entryId: saved.entryId }).status, 'superseded');
  assert.equal(errorCode(await a.capture('stale', [correction])), 'CONFLICT');
  const before = db.prepare('SELECT COUNT(*) AS n FROM entries').get();
  const batch = await a.capture('atomic', [{ ...memory, title: 'Other', body: 'Must roll back.' }, correction]);
  assert.equal(batch.isError, true); assert.deepEqual(db.prepare('SELECT COUNT(*) AS n FROM entries').get(), before);
  const current = result.items[0]!;
  // The superseded entry references its replacement; purge the source first.
  purgeEntry(db, { workspace: 'global', entryId: saved.entryId, confirm: true });
  purgeEntry(db, { workspace: 'global', entryId: current.entryId, confirm: true });
  const replay = chatgptCaptureOutputSchema.parse((await a.capture('correction', [correction])).structuredContent);
  assert.equal(replay.items[0]?.availability, 'unavailable');
  assert.equal(db.prepare('SELECT 1 FROM entries WHERE id = ?').get(current.entryId), undefined);
});

test('capture cannot overwrite Curator-managed memory or a project entry', async t => {
  const { db, makeOwner } = await fixture(t);
  const a = await connect(t, makeOwner());
  const source = recordEntry(db, { workspace: 'project:curator-fixture', kind: 'lesson',
    title: 'SQLite migration recovery workflow', body: 'When a migration fails, check the applied version, restore the backup, and verify the schema before retrying.',
    summary: 'A reusable workflow for recovering from migration failures.',
    scope: buildStructuredScope({ visibility: 'project', repositoryId: 'repo_curator_fixture', memoryClass: 'troubleshooting',
      applicability: { databases: ['SQLite'] } }), tags: ['workflow', 'skill:database'] });
  const protectedEntry = globalizeCuratorCandidate(db, { workspace: source.workspace, entryId: source.id, expectedRevision: source.revision }).global;
  for (const [entry, code] of [[protectedEntry, 'CONFLICT'], [source, 'NOT_FOUND']] as const) {
    const result = await a.capture('protected-' + entry.id, [{ ...memory, basis: 'user_correction', replaces: { entryId: entry.id, expectedRevision: entry.revision } }]);
    assert.equal(errorCode(result), code);
    assert.deepEqual(readEntry(db, { workspace: entry.workspace, entryId: entry.id }), entry);
  }
});

test('invalid authority, limits, policy and secrets cannot write or leak input values', async t => {
  const { db, makeOwner } = await fixture(t);
  const a = await connect(t, makeOwner());
  const inputs: Array<[Record<string, unknown>, string]> = [
    [{ policy: undefined }, 'POLICY_REQUIRED'], [{ policy: { ...a.policy, digest: 'old' } }, 'POLICY_VERSION_MISMATCH'],
    ...['cwd', 'runId', 'workspace', 'databasePath', 'access', 'confirmed'].map(key => [{ [key]: '/private/sentinel' }, 'VALIDATION_ERROR'] as [Record<string, unknown>, string]),
    ...['scope', 'retrievalScope', 'reinforces', 'trustLevel', 'status', 'createdBy', 'confidence'].map(key => [{ memories: [{ ...memory, [key]: 'sentinel' }] }, 'VALIDATION_ERROR'] as [Record<string, unknown>, string]),
    [{ memories: [] }, 'VALIDATION_ERROR'], [{ memories: Array(6).fill(memory) }, 'VALIDATION_ERROR'],
    ...[{ basis: 'observed_result' }, { kind: 'invalid' }, { body: 'x'.repeat(2001) }, { summary: 'x'.repeat(501) }, { subjects: [] }, { generalCommunication: true }, { replaces: { entryId: 'made-up', expectedRevision: 1 } }].map(extra => [{ memories: [{ ...memory, ...extra }] }, 'VALIDATION_ERROR'] as [Record<string, unknown>, string]),
    [{ memories: [{ ...memory, body: 'sk-' + 'a'.repeat(48) }] }, 'SECURITY_REJECTION'],
    [{ operationId: 'sk-' + 'a'.repeat(48) }, 'SECURITY_REJECTION'],
  ];
  for (const [extra, code] of inputs) {
    const result = await a.client.callTool({ name: 'memory_capture', arguments: { operationId: 'invalid', memories: [memory], policy: a.policy, ...extra } });
    assert.equal(result.isError, true); assert.equal(errorCode(result), code, JSON.stringify(extra));
    assert.ok(!JSON.stringify(result).includes('sentinel'));
  }
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM entries').get<{n:number}>()!.n, 0);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM gateway_idempotency').get<{n:number}>()!.n, 0);
});

test('disabled capture reports no save and runtime shutdown drains accepted writes', async t => {
  const { db, makeOwner } = await fixture(t);
  const owner = makeOwner(); const a = await connect(t, owner);
  const previous = process.env.KIOKUKO_INTERACTION_MEMORY;
  process.env.KIOKUKO_INTERACTION_MEMORY = 'off';
  try {
    assert.deepEqual(chatgptCaptureOutputSchema.parse((await a.capture('disabled')).structuredContent).items, []);
    assert.equal(chatgptCaptureOutputSchema.parse((await a.capture('disabled')).structuredContent).enabled, false);
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM gateway_idempotency').get<{n:number}>()!.n, 0);
  } finally {
    if (previous === undefined) delete process.env.KIOKUKO_INTERACTION_MEMORY; else process.env.KIOKUKO_INTERACTION_MEMORY = previous;
  }
  const write = owner.capture({ policy: a.policy, operationId: 'drained', memories: [memory] });
  await owner.close();
  assert.equal((await write).items[0]?.outcome, 'created');
  await assert.rejects(owner.capture({ policy: a.policy, operationId: 'late', memories: [memory] }), /closed/);
});

test('real CLI read-write saves and a fresh read-only CLI recalls the same memory', async t => {
  const { root } = await fixture(t);
  let entryId: string | undefined;
  for (const access of ['read-write', 'read']) {
    const client = new Client({ name: 'chatgpt-fixture', version: '1' });
    const transport = new StdioClientTransport({ command: process.execPath,
      args: ['--import', 'tsx', 'src/bin/kiokuko.ts', 'mcp', '--profile', 'chatgpt-memory', '--access', access],
      env: { PATH: process.env.PATH ?? '', KIOKUKO_DATA_DIR: root }, stderr: 'pipe' });
    try {
      await client.connect(transport);
      const p = chatgptPolicyOutputSchema.parse((await client.callTool({ name: 'memory_policy', arguments: {} })).structuredContent);
      const policy = { version: p.policyVersion, digest: p.policyDigest, read: true };
      if (access === 'read-write') {
        const saved = await client.callTool({ name: 'memory_capture', arguments: { policy, operationId: 'cli-save', memories: [memory] } });
        entryId = chatgptCaptureOutputSchema.parse(saved.structuredContent).items[0]!.entryId;
      } else {
        assert.equal((await client.callTool({ name: 'memory_capture', arguments: { policy, operationId: 'denied', memories: [memory] } })).isError, true);
        const found = await client.callTool({ name: 'memory_recall', arguments: { policy, query: 'Japanese grammar' } });
        assert.equal(chatgptRecallOutputSchema.parse(found.structuredContent).items[0]?.entryId, entryId);
      }
    } finally { await client.close(); }
  }
});

test('capture bounds waiting writes and drains accepted retries without duplicate memory', async t => {
  const { db, makeOwner } = await fixture(t);
  const owner = makeOwner();
  const input = { operationId: 'queued', memories: [memory] };
  const accepted = Array.from({ length: 65 }, () => owner.capture(input));
  await assert.rejects(owner.capture(input), { code: 'BACKPRESSURE' });
  await owner.close();
  const results = await Promise.all(accepted);
  for (const result of results) assert.deepEqual(result, results[0]);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM entries').get<{n:number}>()!.n, 1);
});
