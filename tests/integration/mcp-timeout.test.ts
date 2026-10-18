import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createKiokukoMcpServer } from '../../src/mcp/server.js';
import { openConnection } from '../../src/db/connection.js';
import { migrateDatabase } from '../../src/db/migrate.js';
import type { McpDatabaseOwner } from '../../src/mcp/runtime-owner.js';
import { prepareAgentTask } from '../../src/akinator/agent-task.js';
import { canonicalContentHash } from '../../src/serialization/validate.js';
import { taskAssuranceReport } from '../../src/assurance/service.js';

async function createMigratedDatabase(): Promise<{ root: string; databasePath: string }> {
  const root = await mkdtemp(path.join(tmpdir(), 'kiokuko-mcp-timeout-repo-'));
  execFileSync('git', ['init', '-q', root]);
  const data = await mkdtemp(path.join(tmpdir(), 'kiokuko-mcp-timeout-data-'));
  const databasePath = path.join(data, 'kiokuko.sqlite3');
  const database = openConnection(databasePath);
  try {
    migrateDatabase(database);
  } finally {
    database.close();
  }
  return { root, databasePath };
}

test('MCP tool timeout returns a stable public error and the same connection serves the next request', async () => {
  const { root, databasePath } = await createMigratedDatabase();
  let calls = 0;
  const owner: McpDatabaseOwner = {
    async withDatabase(operation) {
      calls += 1;
      if (calls === 1) return await new Promise<never>(() => undefined);
      const database = openConnection(databasePath);
      try {
        return await operation(database, undefined as never);
      } finally {
        database.close();
      }
    },
    async close() {},
  };
  const server = createKiokukoMcpServer({
    cwd: () => root,
    databaseOwner: owner,
    deadlinePolicy: { readMs: 20, externalMs: 20, mutationMs: 20, hardMaxMs: 30 },
  });
  const client = new Client({ name: 'mcp-timeout-test', version: '1.0.0' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  try {
    const timedOut = await client.callTool({ name: 'curator_check', arguments: { cwd: root } });
    assert.equal(timedOut.isError, true);
    assert.deepEqual(timedOut.structuredContent, {
      code: 'MCP_REQUEST_TIMEOUT', workMayContinue: true, bookkeepingFailure: true,
      message: 'MCP request timed out',
      operation: 'curator_check',
      retryable: true,
    });
    assert.equal(JSON.stringify(timedOut).includes(databasePath), false);

    const healthy = await client.callTool({ name: 'curator_check', arguments: { cwd: root } });
    assert.equal(healthy.isError, undefined);
    assert.equal((healthy.structuredContent as { candidates?: unknown[] }).candidates?.length, 0);
    assert.equal(calls, 2);
  } finally {
    await client.close();
    if (server.isConnected()) await server.close();
  }
});

test('aborted task preparation closes the run and discovery attempt as failed', async () => {
  const { root, databasePath } = await createMigratedDatabase();
  await writeFile(path.join(root, 'package.json'), '{"name":"timeout-fixture","dependencies":{"typescript":"^5.0.0"}}\n');
  const database = openConnection(databasePath);
  const controller = new AbortController();
  let started = false;
  const fetchImpl: typeof fetch = async (_input, init) => {
    started = true;
    const signal = init?.signal;
    return await new Promise<Response>((_resolve, reject) => {
      if (signal?.aborted) {
        reject(signal.reason);
        return;
      }
      signal?.addEventListener('abort', () => reject(signal.reason), { once: true });
    });
  };
  try {
    const preparation = prepareAgentTask(database, {
      requestId: 'mcp-timeout-run-recovery',
      cwd: root,
      task: 'Build a TypeScript service',
      profileHints: { taskType: 'build', target: 'TypeScript service', expected: 'cancellable discovery' },
      capabilities: [{ kind: 'skill', name: 'kiokuko-soul' }, { kind: 'skill', name: 'memory-reasoning' }],
      skillDiscoveryMode: 'official',
      fetchImpl,
      signal: controller.signal,
    });
    const deadline = Date.now() + 1_000;
    while (!started) {
      if (Date.now() >= deadline) throw new Error('Timed out waiting for discovery');
      await new Promise<void>((resolve) => setTimeout(resolve, 5));
    }
    controller.abort();
    await assert.rejects(preparation);
    const run = database.prepare('SELECT status FROM ledger_runs WHERE task_hash IS NOT NULL ORDER BY created_at DESC LIMIT 1').get<{ status: string }>();
    assert.equal(run?.status, 'failed');
    const attempt = database.prepare('SELECT state FROM agent_task_skill_discovery_attempts ORDER BY started_at DESC LIMIT 1').get<{ state: string }>();
    assert.equal(attempt?.state, 'failed');
  } finally {
    database.close();
  }
});

test('MCP caller cancellation of final intake recovers on the same connection without repeating discovery', async () => {
  const {root,databasePath}=await createMigratedDatabase();
  await writeFile(path.join(root,'package.json'),'{"dependencies":{"typescript":"^5.0.0"}}');
  const db=openConnection(databasePath);let searches=0;let notifications=0;
  let started!:()=>void;const discoveryStarted=new Promise<void>(resolve=>{started=resolve;});
  const owner:McpDatabaseOwner={async withDatabase(operation){return await operation(db,undefined as never);},async close(){}};
  const fetchImpl:typeof fetch=async(_url,init)=>{searches++;started();return await new Promise<Response>((_resolve,reject)=>{
    const signal=init?.signal;assert.ok(signal);if(signal.aborted)reject(signal.reason);
    else signal.addEventListener('abort',()=>reject(signal.reason),{once:true});
  });};
  const server=createKiokukoMcpServer({cwd:()=>root,databaseOwner:owner,fetchImpl,
    deadlinePolicy:{readMs:5000,externalMs:5000,mutationMs:5000,hardMaxMs:5000}});
  const client=new Client({name:'mcp-cancellation-regression',version:'1'});
  const [ct,st]=InMemoryTransport.createLinkedPair();const send=ct.send.bind(ct);
  ct.send=async message=>{if('method' in message && message.method==='notifications/cancelled')notifications++;return send(message);};
  await server.connect(st);await client.connect(ct);
  const capabilities=[{kind:'skill',name:'kiokuko-soul'},{kind:'skill',name:'memory-reasoning'}];
  let last:any;
  const previous=process.env.KIOKUKO_SKILL_DISCOVERY;process.env.KIOKUKO_SKILL_DISCOVERY='official';
  try {
    const prepared=await client.callTool({name:'task_prepare',arguments:{cwd:root,requestId:'wire-cancel',soulRead:true,task:'Build a TypeScript service',capabilities}});
    assert.notEqual(prepared.isError,true);let pending=prepared.structuredContent as any;
    const answers:Record<string,string>={taskType:'build',target:'TypeScript service',expected:'CLI starts',constraints:'preserve behavior'};
    while(pending.intake.status==='needs_answer'){
      const controller=new AbortController();
      const q=pending.intake.question;
      last={cwd:root,runId:pending.run.runId,sessionId:pending.intake.sessionId,questionId:q.id,value:answers[q.id],capabilities};
      const answer=client.callTool({name:'task_answer',arguments:last},undefined,{signal:controller.signal});
      const result=await Promise.race([answer.then(value=>({value})),discoveryStarted.then(()=>({discovery:true}))]);
      if('discovery' in result){controller.abort(new Error('Caller cancelled only this request'));await assert.rejects(answer);break;}
      assert.notEqual(result.value.isError,true,JSON.stringify(result.value.structuredContent));pending=result.value.structuredContent;
    }
    // Wait for domain cleanup, not merely the client-side rejection.
    const deadline=Date.now()+2000;
    while(!db.prepare("SELECT 1 FROM agent_task_skill_discovery_attempts WHERE run_id=? AND state='failed'").get(last.runId)){
      assert.ok(Date.now()<deadline,'Cancellation cleanup did not finish');await new Promise(resolve=>setTimeout(resolve,5));
    }
    assert.equal(notifications,1);assert.ok(searches>0);
    const before=searches;const resumed=await client.callTool({name:'task_answer',arguments:last});
    assert.notEqual(resumed.isError,true);const value=resumed.structuredContent as any;
    assert.equal(value.run.runId,last.runId);assert.equal(value.run.status,'active');assert.equal(value.intake.status,'ready');
    assert.deepEqual(value.skillDiscovery.failures,[{stage:'search',code:'task_request_cancelled'}]);assert.deepEqual(value.skillDiscovery.selected,[]);assert.equal(searches,before);
    const status=await client.callTool({name:'task_memory_status',arguments:{cwd:root,runId:last.runId}});assert.notEqual(status.isError,true);
    const cancellation=(status.structuredContent as any).mcpCancellation;
    assert.equal(cancellation?.contract,'kiokuko/mcp-cancellation@1','Server abort acknowledgment is missing');
    assert.equal(cancellation.provenance,'server_observed');
    assert.equal(cancellation.receipts.length,1);
    const receipt=cancellation.receipts[0];
    assert.equal(receipt.operation,'task_answer');
    assert.equal(receipt.requestHash,canonicalContentHash(last));
    assert.equal(receipt.source,'mcp_sdk_signal');
    assert.equal(receipt.handlerSettled,true);
    assert.equal(typeof receipt.abortReceivedAt,'string');
    assert.equal(typeof receipt.handlerSettledAt,'string');
    assert.equal(JSON.stringify(cancellation).includes('Caller cancelled only this request'),false);
    const replay=await client.callTool({name:'task_answer',arguments:last});assert.equal((replay.structuredContent as any).context.deliveryId,value.context.deliveryId);assert.equal(searches,before);
    const budget=db.prepare('SELECT reserved_query_count,consumed_query_count FROM agent_task_skill_discovery_attempts WHERE run_id=?').get<any>(last.runId)!;
    assert.equal(budget.consumed_query_count,budget.reserved_query_count);
  } finally {if(previous===undefined)delete process.env.KIOKUKO_SKILL_DISCOVERY;else process.env.KIOKUKO_SKILL_DISCOVERY=previous;await client.close();if(server.isConnected())await server.close();db.close();}
});

test('wire-cancelled prepared refresh acknowledges the exact request after drainage and preserves the active run', async () => {
  const {root,databasePath}=await createMigratedDatabase();
  const db=openConnection(databasePath);
  const capabilities=[{kind:'skill',name:'kiokuko-soul'},{kind:'skill',name:'memory-reasoning'}];
  const prepared=await prepareAgentTask(db,{cwd:root,requestId:'prepared-refresh',task:'Fix cancellation',capabilities,
    skillDiscoveryMode:'off',profileHints:{taskType:'debug',target:'MCP cancellation',expected:'same connection recovers'}});
  const runId=prepared.run.runId;
  const revision=taskAssuranceReport(db,runId).revision;
  let entered!:()=>void;const started=new Promise<void>(resolve=>{entered=resolve;});
  let release!:()=>void;const gate=new Promise<void>(resolve=>{release=resolve;});
  let calls=0;
  const owner:McpDatabaseOwner={async withDatabase(operation){if(++calls===1){entered();await gate;}return await operation(db,undefined as never);},async close(){}};
  const server=createKiokukoMcpServer({cwd:()=>root,databaseOwner:owner,
    deadlinePolicy:{readMs:5000,externalMs:5000,mutationMs:5000,hardMaxMs:5000}});
  const client=new Client({name:'prepared-refresh-cancellation',version:'1'});
  const [ct,st]=InMemoryTransport.createLinkedPair();
  const send=ct.send.bind(ct);let transportId:string|number|undefined;let notifications=0;
  ct.send=async message=>{
    if('method' in message && message.method==='tools/call' && message.params?.name==='task_memory_refresh' && 'id' in message)transportId=message.id;
    if('method' in message && message.method==='notifications/cancelled' && message.params?.requestId===transportId)notifications++;
    return send(message);
  };
  await server.connect(st);await client.connect(ct);
  try {
    const input={cwd:root,runId,capabilities,expectedRevision:revision,requestId:'only-this-refresh',changedPaths:['package.json']};
    const controller=new AbortController();
    const pending=client.callTool({name:'task_memory_refresh',arguments:input},undefined,{signal:controller.signal});
    await started;
    await client.notification({method:'notifications/cancelled',params:{requestId:'foreign',reason:'forged'}});
    const beforeAbort=await client.callTool({name:'task_memory_status',arguments:{cwd:root,runId}});
    assert.deepEqual((beforeAbort.structuredContent as any).mcpCancellation.receipts,[]);
    controller.abort(new Error('private caller reason'));await assert.rejects(pending);release();
    // Drain the delayed handler before asking status to prove recovery.
    await new Promise(resolve=>setImmediate(resolve));
    const status=await client.callTool({name:'task_memory_status',arguments:{cwd:root,runId}});
    assert.notEqual(status.isError,true);
    const value=status.structuredContent as any;const receipt=value.mcpCancellation.receipts[0];
    assert.equal(notifications,1);assert.equal(value.revision,revision);
    assert.equal(receipt.operation,'task_memory_refresh');assert.equal(receipt.requestHash,canonicalContentHash(input.requestId));
    assert.equal(receipt.transportRequestHash,canonicalContentHash(transportId));assert.equal(receipt.handlerSettled,true);
    assert.equal(db.prepare('SELECT status FROM ledger_runs WHERE run_id=?').get<any>(runId)?.status,'active');
    assert.equal(db.prepare('SELECT COUNT(*) n FROM task_assurance_requests WHERE run_id=? AND request_id=?').get<any>(runId,input.requestId)?.n,0);
    // Late/foreign notifications and model-provided acknowledgment fields cannot create receipts.
    await client.notification({method:'notifications/cancelled',params:{requestId:transportId!,reason:'duplicate'}});
    await client.notification({method:'notifications/cancelled',params:{requestId:'foreign',reason:'forged'}});
    const forged=await client.callTool({name:'task_memory_status',arguments:{cwd:root,runId,mcpCancellation:{handlerSettled:true}}});
    assert.equal(forged.isError,true);
    const recovered=await client.callTool({name:'task_memory_refresh',arguments:input});assert.notEqual(recovered.isError,true);
    const after=await client.callTool({name:'task_memory_status',arguments:{cwd:root,runId}});
    const acknowledgment=(after.structuredContent as any).mcpCancellation;
    assert.equal(acknowledgment.serverInstanceId,value.mcpCancellation.serverInstanceId);
    assert.deepEqual(acknowledgment.receipts,value.mcpCancellation.receipts);
    assert.equal(db.prepare('SELECT COUNT(*) n FROM task_assurance_requests WHERE run_id=? AND request_id=?').get<any>(runId,input.requestId)?.n,1);
    const foreign=await client.callTool({name:'task_memory_status',arguments:{cwd:await mkdtemp(path.join(tmpdir(),'foreign-cancel-scope-')),runId}});
    assert.equal(foreign.isError,true);assert.equal((foreign.structuredContent as any)?.mcpCancellation,undefined);
  } finally {release();await client.close();if(server.isConnected())await server.close();db.close();}
});
