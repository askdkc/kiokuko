import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { existsSync } from 'node:fs';
import { mkdtemp, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test, { type TestContext } from 'node:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { CHATGPT_MEMORY_POLICY } from '../../src/chatgpt/memory-policy.js';
import { initializeDatabase } from '../../src/commands/init.js';
import type { SqliteDatabase } from '../../src/db/adapter.js';
import { openConnection } from '../../src/db/connection.js';
import { createChatgptMemoryServer } from '../../src/mcp/chatgpt-server.js';
import { ChatgptRuntimeOwner } from '../../src/mcp/chatgpt-runtime.js';
import { chatgptPolicyOutputSchema, chatgptRecallOutputSchema } from '../../src/mcp/chatgpt-contract.js';
import { recordEntry } from '../../src/memory/entries.js';
import { recallInteractionMemory } from '../../src/memory/interaction-recall.js';
import { buildStructuredScope } from '../../src/memory/structured-memory.js';

const policy = { version: CHATGPT_MEMORY_POLICY.policyVersion, digest: CHATGPT_MEMORY_POLICY.policyDigest, read: true };

// Includes logical rows in every table (also revisions, tasks, handoffs and embedding queues).
function snapshot(db: SqliteDatabase) {
  return db.prepare("SELECT name FROM sqlite_schema WHERE type='table' ORDER BY name").all<{ name: string }>()
    .map(({ name }) => [name, db.prepare(`SELECT * FROM "${name.replaceAll('"', '""')}"`).all()]);
}

async function fixture(t: TestContext) {
  const root = await mkdtemp(path.join(tmpdir(), 'kiokuko-chatgpt-'));
  const databasePath = path.join(root, 'kiokuko.sqlite3');
  await initializeDatabase({ databasePath });
  const db = openConnection(databasePath);
  const global = recordEntry(db, { workspace: 'global', kind: 'fact', title: '日本語 memory',
    body: '日本語 memory: "escaped"\n😀 '.repeat(150), tags: ['subject:japanese'],
    scope: buildStructuredScope({ visibility: 'global', retrievalScope: 'global', portableReason: 'General language knowledge across projects.' }),
    provenance: { type: 'manual', reference: 'chatgpt-test' }, createdBy: 'test' });
  for (const retrievalScope of ['project-only', 'ecosystem'] as const) {
    recordEntry(db, { workspace: 'private-project', kind: 'fact', title: '日本語 memory', body: 'private-sentinel',
      scope: buildStructuredScope({ visibility: 'project', retrievalScope, applicability: { languages: ['typescript'] } }), provenance: { type: 'manual', reference: 'chatgpt-test' }, createdBy: 'test' });
  }
  const owner = new ChatgptRuntimeOwner(databasePath);
  t.after(async () => { owner.close(); db.close(); await rm(root, { recursive: true, force: true }); });
  return { root, databasePath, db, owner, global };
}

async function connect(t: TestContext, owner: ChatgptRuntimeOwner) {
  const server = createChatgptMemoryServer(owner);
  const client = new Client({ name: 'codex-admin', version: '999.0.0' });
  const [c, s] = InMemoryTransport.createLinkedPair();
  await server.connect(s);
  await client.connect(c);
  t.after(async () => { await client.close(); await server.close(); });
  return client;
}

test('remote tools are an explicit read-only allowlist with strict published schemas', async t => {
  const { owner } = await fixture(t);
  const client = await connect(t, owner);
  const list = (await client.listTools()).tools;
  assert.deepEqual(list.map(tool => tool.name).sort(), ['memory_policy', 'memory_recall']);
  for (const tool of list) {
    assert.deepEqual(tool.annotations, { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false });
    assert.equal(tool.inputSchema.additionalProperties, false);
    assert.equal(tool.outputSchema?.type, 'object');
  }
  const recall = list.find(tool => tool.name === 'memory_recall')!;
  assert.deepEqual(Object.keys(recall.inputSchema.properties!).sort(), ['limit', 'maxContextChars', 'policy', 'query', 'subjects']);
  for (const name of ['memory_capture', 'task_prepare', 'task_answer', 'task_inspect', 'memory_checkpoint',
    'task_memory_review', 'task_memory_refresh', 'task_memory_status', 'task_execution_evidence',
    'curator_check', 'curator_globalize', 'handoff_save', 'handoff_load', 'handoff_discard', '/private/sentinel']) {
    const result = await client.callTool({ name, arguments: {} });
    assert.equal(result.isError, true);
    assert.ok(!JSON.stringify(result).includes('sentinel'));
  }
});

test('policy works without DB access and rejected inputs never return memories or supplied values', async t => {
  const root = await mkdtemp(path.join(tmpdir(), 'kiokuko-chatgpt-absent-'));
  const owner = new ChatgptRuntimeOwner(path.join(root, 'absent', 'db.sqlite3'));
  t.after(async () => { owner.close(); await rm(root, { recursive: true, force: true }); });
  const client = await connect(t, owner);
  const result = await client.callTool({ name: 'memory_policy', arguments: {} });
  assert.deepEqual(result.structuredContent, CHATGPT_MEMORY_POLICY);
  for (const [input, code] of [
    [{}, 'POLICY_REQUIRED'], [{ policy: { ...policy, read: false } }, 'POLICY_REQUIRED'],
    [{ policy: { ...policy, digest: 'bad' } }, 'POLICY_VERSION_MISMATCH'],
    [{ policy: { ...policy, version: 'old' } }, 'POLICY_VERSION_MISMATCH'],
    [{ policy, cwd: '/private/sentinel' }, 'VALIDATION_ERROR'],
    [{ policy, capabilities: [] }, 'VALIDATION_ERROR'],
    [{ policy, query: 'sk-' + 'a'.repeat(48) }, 'SECURITY_REJECTION'],
    [{ policy }, 'SERVICE_UNAVAILABLE'],
  ] as const) {
    const failure = await client.callTool({ name: 'memory_recall', arguments: { query: 'memory', ...input } });
    assert.equal(failure.isError, true);
    assert.equal((failure.structuredContent as Record<string, unknown>)?.code, code);
    assert.ok(!JSON.stringify(failure).includes('sentinel'));
    assert.ok(!JSON.stringify(failure).includes(root));
    assert.deepEqual(JSON.parse((failure.content as Array<{ text: string }>)[0]!.text), failure.structuredContent);
  }
  assert.deepEqual(await readdir(root), []);
});

test('Global scope, Japanese/subject queries and JSON character budgets match the local gated path', async t => {
  const { owner, db, global } = await fixture(t);
  const client = await connect(t, owner);
  const before = snapshot(db);
  for (const maxContextChars of [100, 450, 1500, 12000]) {
    const args = { query: '日本語', subjects: ['Japanese'], limit: 1, maxContextChars };
    const response = await client.callTool({ name: 'memory_recall', arguments: { ...args, policy } });
    assert.notEqual(response.isError, true);
    const data = chatgptRecallOutputSchema.parse(response.structuredContent);
    assert.deepEqual(data, JSON.parse((response.content as Array<{ text: string }>)[0]!.text));
    assert.ok(Array.from(JSON.stringify(data.items)).length <= maxContextChars);
    assert.equal(data.characterCount, data.items.length ? Array.from(JSON.stringify(data.items)).length : 0);
    assert.ok(data.items.every(item => item.entryId === global.id && item.revision === global.revision));
    assert.ok(!JSON.stringify(data).includes('private-sentinel'));
    if (maxContextChars === 100) assert.equal(data.truncated, true);
    if (maxContextChars === 12000) assert.equal(data.items.length, 1);
    const local = await recallInteractionMemory(db, { ...args, soulRead: true,
      capabilities: [{ kind: 'skill', name: 'kiokuko-soul' }, { kind: 'skill', name: 'memory-reasoning' }] });
    assert.deepEqual(data.items, local.items);
    assert.equal(data.truncated, local.truncated);
    assert.deepEqual(data.retrieval, { mode: 'lexical', degraded: false });
  }
  const absent = await client.callTool({ name: 'memory_recall', arguments: { policy, query: 'no-match-zzzz', subjects: ['physics'] } });
  assert.deepEqual(chatgptRecallOutputSchema.parse(absent.structuredContent).items, []);
  assert.notEqual(absent.isError, true);
  const blocked = await recallInteractionMemory(db, { query: '日本語', soulRead: true, capabilities: [] });
  assert.equal(blocked.nextAction, 'required_capability_unavailable');
  assert.deepEqual(blocked.items, []);
  const withheld = await recallInteractionMemory(db, { query: '日本語', soulRead: true, capabilities: [{ kind: 'skill', name: 'kiokuko-soul' }] });
  assert.equal(withheld.memoryPolicy.contextWithheld, true);
  assert.deepEqual(withheld.items, []);
  owner.withDatabase(connection => assert.throws(() => connection.exec("DELETE FROM entries"), /readonly/i));
  owner.close(); owner.close();
  assert.throws(() => owner.start(), /closed/);
  assert.deepEqual(snapshot(db), before);
});

test('missing, non-regular, corrupt, outdated and future databases fail without initialization', async t => {
  const { root, databasePath, db } = await fixture(t);
  const missing = path.join(root, 'not-created', 'missing.sqlite3');
  assert.throws(() => openConnection(missing, { readOnly: true }));
  assert.equal(existsSync(path.dirname(missing)), false);
  const corrupt = path.join(root, 'corrupt');
  await writeFile(corrupt, 'not sqlite');
  const link = path.join(root, 'link');
  await symlink(databasePath, link);
  for (const candidate of [missing, root, corrupt, link]) {
    const owner = new ChatgptRuntimeOwner(candidate);
    assert.throws(() => owner.start(), { code: 'SERVICE_UNAVAILABLE' });
    owner.close();
  }
  db.exec('DELETE FROM schema_migrations WHERE version = (SELECT MAX(version) FROM schema_migrations)');
  const old = snapshot(db);
  assert.throws(() => new ChatgptRuntimeOwner(databasePath).start(), { code: 'SERVICE_UNAVAILABLE' });
  assert.deepEqual(snapshot(db), old);
  db.exec("INSERT INTO schema_migrations VALUES (999, 'future', 'future', 'now')");
  const future = snapshot(db);
  assert.throws(() => new ChatgptRuntimeOwner(databasePath).start(), { code: 'SERVICE_UNAVAILABLE' });
  assert.deepEqual(snapshot(db), future);
});

test('real stdio CLI defaults to read, returns Global memory and leaves WAL database logically unchanged', async t => {
  const { root, db, global } = await fixture(t);
  const before = snapshot(db);
  const filesBefore = await readdir(root);
  const transport = new StdioClientTransport({ command: process.execPath,
    args: ['--import', 'tsx', 'src/bin/kiokuko.ts', 'mcp', '--profile', 'chatgpt-memory'],
    env: { PATH: process.env.PATH ?? '', KIOKUKO_DATA_DIR: root }, stderr: 'pipe' });
  const client = new Client({ name: 'forged-local-admin', version: '1' });
  t.after(async () => client.close());
  await client.connect(transport);
  assert.deepEqual((await client.listTools()).tools.map(tool => tool.name).sort(), ['memory_policy', 'memory_recall']);
  const remotePolicy = chatgptPolicyOutputSchema.parse((await client.callTool({ name: 'memory_policy', arguments: {} })).structuredContent);
  const found = await client.callTool({ name: 'memory_recall', arguments: { query: '日本語',
    policy: { version: remotePolicy.policyVersion, digest: remotePolicy.policyDigest, read: true } } });
  const data = chatgptRecallOutputSchema.parse(found.structuredContent);
  assert.equal(data.items[0]?.entryId, global.id);
  assert.equal((await client.callTool({ name: 'memory_capture', arguments: {} })).isError, true);
  assert.ok(client.getServerVersion()?.name === 'kiokuko-chatgpt-memory');
  await client.close();
  assert.deepEqual(snapshot(db), before);
  assert.deepEqual(await readdir(root), filesBefore);
});

for (const termination of ['EOF', 'SIGTERM'] as const) test(`stdio closes cleanly on ${termination}`, { timeout: 15_000 }, async t => {
  const { root, db } = await fixture(t);
  const before = snapshot(db);
  const child = spawn(process.execPath, ['--import', 'tsx', 'src/bin/kiokuko.ts', 'mcp', '--profile', 'chatgpt-memory', '--access', 'read'], {
    env: { PATH: process.env.PATH, KIOKUKO_DATA_DIR: root }, stdio: ['pipe', 'pipe', 'pipe'],
  });
  t.after(() => { if (child.exitCode === null) child.kill('SIGKILL'); });
  const exit = once(child, 'exit');
  child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {
    protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'test', version: '1' },
  } }) + '\n');
  await once(child.stdout, 'data');
  if (termination === 'EOF') child.stdin.end(); else child.kill('SIGTERM');
  assert.deepEqual(await exit, [0, null]);
  assert.deepEqual(snapshot(db), before);
});
