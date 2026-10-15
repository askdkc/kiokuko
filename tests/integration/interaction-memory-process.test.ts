import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { openConnection } from '../../src/db/connection.js';
import { getGlobalDatabasePath } from '../../src/config/paths.js';

const capabilities = [{ kind: 'skill', name: 'kiokuko-soul' }, { kind: 'skill', name: 'memory-reasoning' }];
const preference = { kind: 'preference', title: 'Japanese grammar', body: 'Japanese grammar: two train examples before terminology.',
  scope: 'global', subjects: ['Japanese grammar'], portableReason: 'Applies to grammar explanations across projects.', basis: 'user_statement' };

test('fresh stdio processes refuse model capture, correction and replay without native human approval', { timeout: 45_000 }, async (t) => {
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
  // Real native approval and purge/revision positives live in replay-write-boundary/replay-review tests.
  for(const [id,memory] of [['A',preference],['B',{...preference,basis:'user_correction'}],['A',preference]] as const){
    const result=await capture(id,[memory]);assert.notEqual(result.isError,true);
    assert.deepEqual(result.structuredContent,{accepted:false,recorded:false,workMayContinue:true,warnings:['post_task_review_required']});
  }
  const disabled=await call('memory_capture',{operationId:'disabled',memories:[preference]},{KIOKUKO_INTERACTION_MEMORY:'off'});
  assert.equal((disabled.structuredContent as {recorded:boolean}).recorded,false);
  const recall=await call('memory_recall',{soulRead:true,capabilities,query:'Japanese grammar'});
  assert.notEqual(recall.isError,true);assert.deepEqual((recall.structuredContent as {items:unknown[]}).items,[]);
  const database=openConnection(getGlobalDatabasePath({env}),{readOnly:true});
  try{assert.equal(database.prepare('SELECT COUNT(*) n FROM entries').get<{n:number}>()!.n,0);}finally{database.close();}
});
