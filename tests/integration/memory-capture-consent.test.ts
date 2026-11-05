import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test, { type TestContext } from 'node:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { ElicitRequestSchema, ErrorCode, McpError } from '@modelcontextprotocol/sdk/types.js';
import { initializeDatabase } from '../../src/commands/init.js';
import { openConnection } from '../../src/db/connection.js';
import { createChatgptMemoryServer } from '../../src/mcp/chatgpt-server.js';
import { ChatgptRuntimeOwner } from '../../src/mcp/chatgpt-runtime.js';
import { createKiokukoMcpServer } from '../../src/mcp/server.js';

const proposedMemory = {
  kind: 'preference',
  title: 'Japanese grammar explanations',
  body: 'Show examples before terminology.',
  scope: 'global',
  portableReason: 'Applies to language explanations across projects.',
  subjects: ['Japanese grammar'],
  basis: 'user_statement',
  summary: 'Make grammar explanations easier to follow.',
};

async function temporaryDatabase(t: TestContext, prefix: string) {
  const root = await mkdtemp(path.join(tmpdir(), prefix));
  execFileSync('git', ['init', '-q', root]);
  const databasePath = path.join(root, 'kiokuko.sqlite3');
  await initializeDatabase({ databasePath });
  const database = openConnection(databasePath);
  t.after(async () => { database.close(); await rm(root, { recursive: true, force: true }); });
  return { root, databasePath, database };
}

test('Codex memory_capture asks native save or decline and persists only the exact accepted proposal', async t => {
  const { root, databasePath, database } = await temporaryDatabase(t, 'kiokuko-codex-consent-');
  const server = createKiokukoMcpServer({ databasePath, cwd: () => root });
  const client = new Client({ name: 'codex-consent-test', version: '1' }, { capabilities: { elicitation: { form: {} } } });
  let answer: 'save' | 'decline' = 'save';
  let prompts = 0;
  client.setRequestHandler(ElicitRequestSchema, async request => {
    prompts += 1;
    assert.match(request.params.message, answer === 'save'
      ? /Show examples before terminology\./u
      : /Do not store this proposal\./u);
    assert.match(request.params.message, /Remember:/u);
    assert.match(request.params.message, /Why remember this: Make grammar explanations easier to follow\./u);
    assert.match(request.params.message, /Use in: All projects and conversations/u);
    assert.doesNotMatch(request.params.message, /operationId|generalCommunication|SHA-256|"memories"/u);
    assert.ok(request.params.message.length <= 1600);
    assert.equal(database.prepare('SELECT COUNT(*) AS n FROM entries').get<{ n: number }>()!.n, prompts === 1 ? 0 : 1);
    return { action: 'accept', content: { choice: answer } };
  });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport); await client.connect(clientTransport);
  t.after(async () => { await client.close(); await server.close(); });
  assert.match(client.getInstructions() ?? '', /In every session/);
  assert.match(client.getInstructions() ?? '', /approval is required only before saving/);
  assert.doesNotMatch(client.getInstructions() ?? '', /propose reusable memory only with the user/);

  const input = { operationId: 'codex-approved-memory', memories: [proposedMemory] };
  const saved = await client.callTool({ name: 'memory_capture', arguments: input });
  assert.equal((saved.structuredContent as any).review.status, 'saved');
  assert.equal((saved.structuredContent as any).items[0].outcome, 'created');
  assert.equal(prompts, 1);
  assert.equal(database.prepare('SELECT COUNT(*) AS n FROM entries').get<{ n: number }>()!.n, 1);

  const retry = await client.callTool({ name: 'memory_capture', arguments: input });
  assert.deepEqual(retry.structuredContent, saved.structuredContent);
  assert.equal(prompts, 1, 'an exact retry reuses the approved result without another prompt');

  const conflict = await client.callTool({ name: 'memory_capture', arguments: {
    ...input, memories: [{ ...proposedMemory, body: 'Changed after approval.' }],
  } });
  assert.equal(conflict.isError, true);
  assert.equal(prompts, 1, 'changed content cannot reuse approval');

  answer = 'decline';
  const declined = await client.callTool({ name: 'memory_capture', arguments: {
    operationId: 'codex-declined-memory', memories: [{ ...proposedMemory, body: 'Do not store this proposal.' }],
  } });
  assert.equal((declined.structuredContent as any).review.status, 'declined');
  assert.deepEqual((declined.structuredContent as any).items, []);
  assert.equal(database.prepare('SELECT COUNT(*) AS n FROM entries').get<{ n: number }>()!.n, 1);
});

test('cancelling native memory review does not save or ask again on exact retry', async t => {
  const { root, databasePath, database } = await temporaryDatabase(t, 'kiokuko-review-cancel-');
  const server = createKiokukoMcpServer({ databasePath, cwd: () => root });
  const client = new Client({ name: 'review-cancel-test', version: '1' }, { capabilities: { elicitation: { form: {} } } });
  let prompts = 0;
  client.setRequestHandler(ElicitRequestSchema, async () => {
    prompts++;
    return { action: 'cancel' };
  });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport); await client.connect(clientTransport);
  t.after(async () => { await client.close(); await server.close(); });
  const input = { operationId: 'cancel-proposal', memories: [proposedMemory] };
  for (let attempt = 0; attempt < 2; attempt++) {
    const result = await client.callTool({ name: 'memory_capture', arguments: input });
    assert.equal((result.structuredContent as any).review.status, 'declined');
    assert.deepEqual((result.structuredContent as any).items, []);
  }
  assert.equal(prompts, 1);
  assert.equal(database.prepare('SELECT COUNT(*) AS n FROM entries').get<{ n: number }>()!.n, 0);
});

test('ChatGPT memory_capture uses the same native yes/no review before its existing atomic save', async t => {
  const { databasePath, database } = await temporaryDatabase(t, 'kiokuko-chatgpt-consent-');
  const owner = new ChatgptRuntimeOwner(databasePath, 'read-write');
  const server = createChatgptMemoryServer(owner);
  const client = new Client({ name: 'chatgpt-consent-test', version: '1' }, { capabilities: { elicitation: { form: {} } } });
  let answer: 'save' | 'decline' = 'save';
  let prompts = 0;
  client.setRequestHandler(ElicitRequestSchema, async request => {
    prompts += 1;
    assert.match(request.params.message, answer === 'save'
      ? /Show examples before terminology\./u
      : /Do not store this proposal\./u);
    assert.match(request.params.message, /Remember:/u);
    assert.match(request.params.message, /Use in: All projects and conversations/u);
    assert.doesNotMatch(request.params.message, /operationId|generalCommunication|SHA-256|"memories"/u);
    assert.ok(request.params.message.length <= 1600);
    return { action: 'accept', content: { choice: answer } };
  });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport); await client.connect(clientTransport);
  t.after(async () => { await client.close(); await server.close(); await owner.close(); });
  assert.match(client.getInstructions() ?? '', /In every session/);
  assert.match(client.getInstructions() ?? '', /approval is required only before saving/);

  const policyResult = await client.callTool({ name: 'memory_policy', arguments: {} });
  const policyValue = policyResult.structuredContent as { policyVersion: string; policyDigest: string };
  const policy = { version: policyValue.policyVersion, digest: policyValue.policyDigest, read: true };
  const memories = [{ ...proposedMemory }];
  delete (memories[0] as { scope?: string }).scope;

  const saved = await client.callTool({ name: 'memory_capture', arguments: { policy, operationId: 'chatgpt-approved-memory', memories } });
  assert.equal((saved.structuredContent as any).review.status, 'saved');
  assert.equal((saved.structuredContent as any).items[0].outcome, 'created');
  assert.equal(prompts, 1);

  answer = 'decline';
  const declined = await client.callTool({ name: 'memory_capture', arguments: {
    policy, operationId: 'chatgpt-declined-memory', memories: [{ ...memories[0], body: 'Do not store this proposal.' }],
  } });
  assert.equal((declined.structuredContent as any).review.status, 'declined');
  assert.deepEqual((declined.structuredContent as any).items, []);
  assert.equal(database.prepare('SELECT COUNT(*) AS n FROM entries').get<{ n: number }>()!.n, 1);
});

for (const profile of ['codex', 'chatgpt'] as const) {
  test(`${profile} rejects an oversized review before elicitation and accepts a shorter new proposal`, async t => {
    const { root, databasePath, database } = await temporaryDatabase(t, 'kiokuko-bounded-review-');
    const owner = profile === 'chatgpt' ? new ChatgptRuntimeOwner(databasePath, 'read-write') : undefined;
    const server = owner ? createChatgptMemoryServer(owner) : createKiokukoMcpServer({ databasePath, cwd: () => root });
    const client = new Client({ name: 'bounded-review-test', version: '1' }, { capabilities: { elicitation: { form: {} } } });
    let prompts = 0;
    client.setRequestHandler(ElicitRequestSchema, async request => {
      prompts++;
      assert.match(request.params.message, /Show examples before terminology\./u);
      return { action: 'accept', content: { choice: 'save' } };
    });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport); await client.connect(clientTransport);
    t.after(async () => { await client.close(); await server.close(); await owner?.close(); });
    let policy;
    if (owner) {
      const result = (await client.callTool({ name: 'memory_policy', arguments: {} })).structuredContent as any;
      policy = { version: result.policyVersion, digest: result.policyDigest, read: true };
    }
    const { scope, ...globalMemory } = proposedMemory;
    const memory = owner ? globalMemory : proposedMemory;
    for (const [index, body] of ['Long evidence. '.repeat(130), 'Detail\n'.repeat(60), '説明'.repeat(600)].entries()) {
      const result = await client.callTool({ name: 'memory_capture', arguments: {
        ...(policy ? { policy } : {}), operationId: `oversized-${index}`, memories: [{ ...memory, body }],
      } });
      assert.notEqual(result.isError, true);
      const value = result.structuredContent as any;
      assert.equal(value.review.status, 'unavailable');
      assert.equal(value.review.reason, 'proposal_too_large');
      assert.match(value.review.guidance, /shorten/iu);
      assert.equal(prompts, 0, 'do not display a clipped or unscrollable consent prompt');
      assert.equal(database.prepare('SELECT COUNT(*) AS n FROM entries').get<{ n: number }>()!.n, 0);
    }
    const saved = await client.callTool({ name: 'memory_capture', arguments: {
      ...(policy ? { policy } : {}), operationId: 'shortened-proposal', memories: [memory],
    } });
    assert.equal((saved.structuredContent as any).review.status, 'saved');
    assert.match((saved.structuredContent as any).review.digest, /^[a-f0-9]{64}$/u);
    assert.equal(prompts, 1);
    assert.equal(database.prepare('SELECT COUNT(*) AS n FROM entries').get<{ n: number }>()!.n, 1);
  });
}

test('memory_capture reports unavailable and writes nothing when native elicitation is unsupported', async t => {
  const { root, databasePath, database } = await temporaryDatabase(t, 'kiokuko-consent-unavailable-');
  const server = createKiokukoMcpServer({ databasePath, cwd: () => root });
  const client = new Client({ name: 'no-elicitation-test', version: '1' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport); await client.connect(clientTransport);
  t.after(async () => { await client.close(); await server.close(); });

  const result = await client.callTool({ name: 'memory_capture', arguments: {
    operationId: 'unsupported-review', memories: [proposedMemory],
  } });
  assert.equal((result.structuredContent as any).review.status, 'unavailable');
  assert.equal((result.structuredContent as any).review.reason, 'elicitation_not_supported');
  assert.deepEqual((result.structuredContent as any).items, []);
  assert.equal(database.prepare('SELECT COUNT(*) AS n FROM entries').get<{ n: number }>()!.n, 0);
});

test('native review reports a protocol error without leaking secret data or writing memory', async t => {
  const { root, databasePath, database } = await temporaryDatabase(t, 'kiokuko-consent-error-');
  const server = createKiokukoMcpServer({ databasePath, cwd: () => root });
  const client = new Client({ name: 'review-error-test', version: '1' }, { capabilities: { elicitation: { form: {} } } });
  client.setRequestHandler(ElicitRequestSchema, async () => {
    throw new McpError(ErrorCode.InvalidParams, 'Unsupported requestedSchema; token=sk-1234567890abcdefghijkl',
      { privatePayload: 'Do not expose request bodies or error data.' });
  });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await server.connect(b); await client.connect(a);
  t.after(async () => { await client.close(); await server.close(); });
  const result = await client.callTool({ name: 'memory_capture', arguments: {
    operationId: 'protocol-error', memories: [proposedMemory],
  } });
  const value = result.structuredContent as any;
  assert.equal(value.review.status, 'unavailable');
  assert.equal(value.review.reason, 'elicitation_request_failed');
  assert.equal(value.review.diagnostic.code, ErrorCode.InvalidParams);
  assert.equal(value.review.diagnostic.category, 'invalid_params');
  assert.doesNotMatch(JSON.stringify(value), /sk-1234567890|privatePayload|Do not expose/u);
  assert.equal(database.prepare('SELECT COUNT(*) AS n FROM entries').get<{ n: number }>()!.n, 0);
});

test('a client with URL elicitation only receives an explicit form-unsupported result', async t => {
  const { root, databasePath, database } = await temporaryDatabase(t, 'kiokuko-consent-url-only-');
  const server = createKiokukoMcpServer({ databasePath, cwd: () => root });
  const client = new Client({ name: 'url-only-review', version: '1' }, { capabilities: { elicitation: { url: {} } } });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await server.connect(b); await client.connect(a);
  t.after(async () => { await client.close(); await server.close(); });
  const result = await client.callTool({ name: 'memory_capture', arguments: {
    operationId: 'url-only', memories: [proposedMemory],
  } });
  assert.equal((result.structuredContent as any).review.reason, 'form_elicitation_not_supported');
  assert.equal(database.prepare('SELECT COUNT(*) AS n FROM entries').get<{ n: number }>()!.n, 0);
});
