import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { initializeDatabase } from '../../src/commands/init.js';
import { openConnection } from '../../src/db/connection.js';
import { recordEntry } from '../../src/memory/entries.js';
import { buildStructuredScope } from '../../src/memory/structured-memory.js';
import { linkEntries } from '../../src/memory/lifecycle.js';
import { ChatgptRuntimeOwner } from '../../src/mcp/chatgpt-runtime.js';
import { createChatgptMemoryServer } from '../../src/mcp/chatgpt-server.js';

test('ChatGPT recall exposes 16k Unicode body and typed links in the final model text, with explicit budget failures', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'relation-chatgpt-')), databasePath = path.join(root, 'data.sqlite3');
  await initializeDatabase({ databasePath });
  const database = openConnection(databasePath);
  const scope = buildStructuredScope({ visibility: 'global', retrievalScope: 'global', portableReason: 'General database boundary knowledge.' });
  const a = recordEntry(database, { workspace: 'global', kind: 'fact', title: 'quartzmarker context', body: '😀'.repeat(12000), scope });
  const b = recordEntry(database, { workspace: 'global', kind: 'fact', title: 'quartzmarker exception', body: 'A counterexample.', scope });
  for (const relation of ['supports', 'contradicts'] as const) linkEntries(database, { workspace: 'global', fromEntryId: a.id, toEntryId: b.id, relation });
  const owner = new ChatgptRuntimeOwner(databasePath), server = createChatgptMemoryServer(owner);
  const client = new Client({ name: 'relation-test', version: '1' }), [c,s] = InMemoryTransport.createLinkedPair();
  const old = process.env.KIOKUKO_RELATION_CHARACTER_BUDGET;
  await server.connect(s); await client.connect(c);
  try {
    const policy = (await client.callTool({ name: 'memory_policy', arguments: {} })).structuredContent as { policyVersion: string; policyDigest: string };
    const args = { query: 'quartzmarker', policy: { version: policy.policyVersion, digest: policy.policyDigest, read: true } };
    const response = await client.callTool({ name: 'memory_recall', arguments: args });
    assert.notEqual(response.isError, true, JSON.stringify(response));
    const text = (response.content as Array<{text: string}>)[0]!.text;
    const output = JSON.parse(text);
    assert.deepEqual(JSON.parse(text), JSON.parse(JSON.stringify(response.structuredContent)));
    assert.ok(output.characterCount > 8000 && output.characterCount <= 16000);
    assert.equal(output.relationDelivery.status, 'complete'); assert.equal(output.relationDelivery.edges.length, 2);
    assert.ok(output.items.every((item: {workspace: string}) => item.workspace === 'global'));
    assert.ok(Array.from(JSON.stringify(output.relationDelivery)).length <= 8000);
    const bounded = await client.callTool({ name: 'memory_recall', arguments: { ...args, maxContextChars: 500 } });
    assert.notEqual(bounded.isError, true); assert.ok(Number((bounded.structuredContent as { characterCount: number }).characterCount) <= 500);
    process.env.KIOKUKO_RELATION_CHARACTER_BUDGET = '1';
    const failed = await client.callTool({ name: 'memory_recall', arguments: args });
    assert.equal(failed.isError, true); assert.equal((failed.structuredContent as { code: string })?.code, 'VALIDATION_ERROR');
  } finally {
    if (old === undefined) delete process.env.KIOKUKO_RELATION_CHARACTER_BUDGET; else process.env.KIOKUKO_RELATION_CHARACTER_BUDGET = old;
    await client.close(); await server.close(); await owner.close(); database.close(); await rm(root,{recursive:true,force:true});
  }
});
