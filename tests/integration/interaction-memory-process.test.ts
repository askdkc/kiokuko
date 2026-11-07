import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { ElicitRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { openConnection } from '../../src/db/connection.js';
import { getGlobalDatabasePath } from '../../src/config/paths.js';

const capabilities = [{ kind: 'skill', name: 'kiokuko-soul' }, { kind: 'skill', name: 'memory-reasoning' }];
const preference = { kind: 'preference', title: 'Japanese grammar', body: 'Japanese grammar: two train examples before terminology.',
  scope: 'global', subjects: ['Japanese grammar'], portableReason: 'Applies to grammar explanations across projects.', basis: 'user_statement' };

test('stdio capture rejects unsavable global scope before prompting and saves a corrected proposal', { timeout: 20_000 }, async (t) => {
  const data = await mkdtemp(path.join(tmpdir(), 'kiokuko-process-capture-'));
  const env = { PATH: process.env.PATH ?? '', KIOKUKO_DATA_DIR: data, KIOKUKO_EMBEDDINGS: 'off', KIOKUKO_SKILL_DISCOVERY: 'off' };
  const client = new Client({ name: 'codex-cli', version: '1' }, { capabilities: { elicitation: { form: {} } } });
  t.after(async () => { await client.close(); await rm(data, { recursive: true, force: true }); });
  const transport = new StdioClientTransport({ command: process.execPath,
    args: ['--import', 'tsx', 'src/bin/kiokuko.ts', 'mcp'], env, stderr: 'pipe' });
  const { portableReason, ...memory } = preference;
  const readStoredBodies = () => {
    const database = openConnection(getGlobalDatabasePath({ env }), { readOnly: true });
    try { return database.prepare('SELECT body FROM entry_revisions').all<{ body: string }>().map(row => row.body); }
    finally { database.close(); }
  };
  let prompts = 0;
  client.setRequestHandler(ElicitRequestSchema, async request => {
    prompts++;
    assert.match(request.params.message, /two train examples before terminology/u);
    assert.deepEqual(readStoredBodies(), []);
    return { action: 'accept', content: { choice: 'save' } };
  });
  await client.connect(transport);
  const capture = (operationId: string, proposal: Record<string, unknown>) => client.callTool({
    name: 'memory_capture', arguments: { operationId, memories: [proposal] },
  });
  const rejected = [
    await capture('wrong-scope', { ...memory, retrievalScope: 'ecosystem' }),
    await capture('missing-reason', { ...memory, retrievalScope: 'global' }),
  ];
  assert.equal(prompts, 0, 'a proposal that cannot be saved must not request approval');
  assert.deepEqual(readStoredBodies(), []);
  for (const [index, reason] of ['incompatible_retrieval_scope', 'global_scope_qualification_required'].entries()) {
    const result = rejected[index]!;
    assert.equal(result.isError, true);
    assert.deepEqual(result.structuredContent, { code: 'VALIDATION_ERROR', reason, retryable: false });
  }
  const result = await capture('corrected-proposal', { ...memory, portableReason });
  assert.notEqual(result.isError, true);
  const receipt = result.structuredContent as { review: { status: string }; items: { outcome: string }[] };
  assert.equal(receipt.review.status, 'saved');
  assert.deepEqual(receipt.items.map(item => item.outcome), ['created']);
  assert.equal(prompts, 1);
  assert.deepEqual(readStoredBodies(), [memory.body]);
});

test('fresh stdio processes refuse capture without native human approval', { timeout: 45_000 }, async (t) => {
  const data = await mkdtemp(path.join(tmpdir(), 'kiokuko-process-correction-'));
  t.after(() => rm(data, { recursive: true, force: true }));
  const env = { PATH: process.env.PATH ?? '', KIOKUKO_DATA_DIR: data, KIOKUKO_EMBEDDINGS: 'off', KIOKUKO_SKILL_DISCOVERY: 'off' };
  async function call(name: string, args: Record<string, unknown>, overrides: Record<string, string> = {}) {
    const client = new Client({ name: 'correction-process-test', version: '1' });
    const transport = new StdioClientTransport({ command: process.execPath,
      args: ['--import', 'tsx', 'src/bin/kiokuko.ts', 'mcp'], env: { ...env, ...overrides }, stderr: 'pipe' });
    try {
      await client.connect(transport);
      return await client.callTool({ name, arguments: args }, undefined, { timeout: 10_000 });
    } finally { await client.close(); }
  }
  const capture = (operationId: string, memories: unknown[]) => call('memory_capture', { operationId, memories });
  // User-reviewed contract: model claims of user_statement/user_correction and retry IDs are not consent.
  // Real native approval is covered by memory-capture-consent tests.
  for(const [id,memory] of [['A',preference],['B',{...preference,basis:'user_correction'}],['A',preference]] as const){
    const result=await capture(id,[memory]);assert.notEqual(result.isError,true);
    assert.equal((result.structuredContent as any).review.status,'unavailable');
    assert.deepEqual((result.structuredContent as any).items,[]);
  }
  const disabled=await call('memory_capture',{operationId:'disabled',memories:[preference]},{KIOKUKO_INTERACTION_MEMORY:'off'});
  assert.equal((disabled.structuredContent as any).enabled,false);
  assert.equal((disabled.structuredContent as any).review.status,'unavailable');
  const recall=await call('memory_recall',{soulRead:true,capabilities,query:'Japanese grammar'});
  assert.notEqual(recall.isError,true);assert.deepEqual((recall.structuredContent as {items:unknown[]}).items,[]);
  const database=openConnection(getGlobalDatabasePath({env}),{readOnly:true});
  try{assert.equal(database.prepare('SELECT COUNT(*) n FROM entries').get<{n:number}>()!.n,0);}finally{database.close();}
});
