import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createKiokukoMcpServer } from '../../src/mcp/server.js';
import { openConnection } from '../../src/db/connection.js';
import { migrateDatabase } from '../../src/db/migrate.js';

test('capture without native elicitation and checkpoint memories cannot persist',async()=>{
 const root=mkdtempSync(path.join(tmpdir(),'replay-boundary-'));const file=path.join(root,'db.sqlite3');const db=openConnection(file);migrateDatabase(db);
 const server=createKiokukoMcpServer({databasePath:file,cwd:()=>root});const client=new Client({name:'model',version:'1'});const [a,b]=InMemoryTransport.createLinkedPair();await server.connect(b);await client.connect(a);
 try {
  const calls=[{name:'memory_capture',arguments:{operationId:'model-claims-user',memories:[{kind:'preference',title:'Unapproved',body:'Unapproved',scope:'global',basis:'user_statement',generalCommunication:true}]}},{name:'memory_checkpoint',arguments:{memories:[{kind:'lesson',title:'Unapproved',body:'Unapproved',scope:'global'}]}}];
  for(const call of calls){const result=await client.callTool(call);assert.equal(result.isError,undefined);const output=result.structuredContent as any;if(call.name==='memory_capture'){assert.equal(output.review.status,'unavailable');assert.deepEqual(output.items,[]);}else{assert.equal(output.recorded,false);assert.equal(output.workMayContinue,true);}}
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM entries').get<{n:number}>()?.n,0);
 }finally{await client.close();await server.close();db.close();rmSync(root,{recursive:true,force:true});}
});

test('native MCP elicitation reviews a zero-based trace; only host approval makes it searchable',async()=>{
 const {ElicitRequestSchema}=await import('@modelcontextprotocol/sdk/types.js');
 const {LedgerStore}=await import('../../src/ledger/store.js');
 const {resolveProjectWorkspace}=await import('../../src/memory/workspaces.js');
 const {mkdirSync,writeFileSync}=await import('node:fs');const {execFileSync}=await import('node:child_process');const {createHash}=await import('node:crypto');
 const root=mkdtempSync(path.join(tmpdir(),'replay-elicitation-'));execFileSync('git',['init','-q',root]);const file=path.join(root,'db.sqlite3');const db=openConnection(file);migrateDatabase(db);
 const project=await resolveProjectWorkspace(db,root);assert.ok(project);const ledger=new LedgerStore(db);
 ledger.createRunInTransaction({runId:'completed-run',workspace:project.workspace,protocolVersion:'1',client:{kind:'codex',sessionId:'session'},captureProfile:'minimal',coverage:{run:'best_effort',tool:'declared',command:'declared',file:'declared',approval:'unavailable'},task:{title:'Check sqlite',query:'Check sqlite',profileHints:{taskType:null,target:null,expected:null,constraints:null}},metadata:{intakeRequired:false}});ledger.updateRunStatusInTransaction('completed-run','completed');
 const trace=path.join(root,'.agenticreplay','runs','run_abcdef');mkdirSync(trace,{recursive:true});
 const events=[{seq:0,type:'run.start'},{seq:1,type:'user.message',payload:{text:'Check sqlite'}}];
 const bytes=events.map(event=>JSON.stringify(event)).join('\n')+'\n';
 writeFileSync(path.join(trace,'events.jsonl'),bytes);writeFileSync(path.join(trace,'manifest.json'),JSON.stringify({schema_version:'0.4.0',run_id:'run_abcdef',cwd:root,integrity:{events_sha256:createHash('sha256').update(bytes).digest('hex')}}));
 let serviceLookups=0;
 const server=createKiokukoMcpServer({databasePath:file,cwd:()=>root,discoverCodexDockSocket:async()=>{serviceLookups++;return undefined;}});const client=new Client({name:'human-ui-host',version:'1'},{capabilities:{elicitation:{form:{}}}});let prompts=0;
 client.setRequestHandler(ElicitRequestSchema,async request=>{
  prompts++;
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM entries').get<{n:number}>()?.n,0);
  assert.ok('requestedSchema' in request.params);
  assert.deepEqual(request.params.requestedSchema.properties,{});
  assert.ok(!request.params.requestedSchema.required?.length);
  assert.match(request.params.message,/Check sqlite/);
  assert.match(request.params.message,/^今回の内容を記憶として保存しますか？/u);
  assert.doesNotMatch(request.params.message,/run_abcdef|revision|session|SHA-256|"schemaVersion"|"payloadHashes"/);
  return {action:'accept',content:{}};
 });
 const [a,b]=InMemoryTransport.createLinkedPair();await server.connect(b);await client.connect(a);
 try{const result=await client.callTool({name:'memory_review_completed',arguments:{runId:'completed-run',cwd:root,traceDirectory:trace}});assert.equal((result.structuredContent as Record<string,unknown>|undefined)?.status,'saved');assert.equal(prompts,1);assert.equal(db.prepare('SELECT COUNT(*) AS n FROM entries').get<{n:number}>()?.n,1);assert.equal(ledger.readRun('completed-run')?.status,'completed');
  ledger.createRunInTransaction({runId:'declined-run',workspace:project.workspace,protocolVersion:'1',client:{kind:'codex',sessionId:'declined-session'},captureProfile:'minimal',coverage:{run:'best_effort',tool:'declared',command:'declared',file:'declared',approval:'unavailable'},task:{title:'Check sqlite',query:'Check sqlite',profileHints:{taskType:null,target:null,expected:null,constraints:null}},metadata:{intakeRequired:false}});
  ledger.updateRunStatusInTransaction('declined-run','completed');
  let declinedPrompts=0;
  client.setRequestHandler(ElicitRequestSchema,async()=>{
   declinedPrompts++;
   return {action:'decline'};
  });
  const declined=await client.callTool({name:'memory_review_completed',arguments:{runId:'declined-run',cwd:root,traceDirectory:trace}});
  assert.equal((declined.structuredContent as {status?:string})?.status,'declined');
  assert.equal(declinedPrompts,1,'decline never reopens the confirmation');
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM entries').get<{n:number}>()?.n,1);
  ledger.createRunInTransaction({runId:'queued-run',workspace:project.workspace,protocolVersion:'1',client:{kind:'codex',sessionId:'queued-session'},captureProfile:'minimal',coverage:{run:'best_effort',tool:'declared',command:'declared',file:'declared',approval:'unavailable'},task:{title:'Check sqlite again',query:'Check sqlite again',profileHints:{taskType:null,target:null,expected:null,constraints:null}},metadata:{intakeRequired:false}});ledger.updateRunStatusInTransaction('queued-run','active');
  let dismiss!:(value:{action:'decline'})=>void;let offered!:()=>void;const offer=new Promise<void>(r=>offered=r);
  client.setRequestHandler(ElicitRequestSchema,async()=>{offered();return await new Promise<{action:'decline'}>(r=>dismiss=r);});
  const oldTrace=process.env.AGENTICREPLAY_RUN_DIR;process.env.AGENTICREPLAY_RUN_DIR=trace;
  try {
    const completed=await client.callTool({name:'memory_checkpoint',arguments:{cwd:root,runId:'queued-run',outcome:'completed',memories:[],evidence:{tests:[{runner:'node',target:'sqlite',outcome:'passed'}]}}});
    assert.equal(completed.isError,undefined);assert.equal((completed.structuredContent as any).run.status,'completed');
    await offer;
    assert.equal(serviceLookups,0,'explicit attached recording takes precedence over service discovery');
    const ordinary=await client.callTool({name:'memory_context',arguments:{cwd:root,query:'sqlite'}});assert.equal(ordinary.isError,undefined);
    const context=ordinary.structuredContent as {entries:{summary:string}[]};
    assert.deepEqual(context.entries.map(entry=>entry.summary),['Check sqlite']);
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM entries').get<{n:number}>()?.n,1,'optional question did not hold task completion or save new memory');
    dismiss({action:'decline'});await new Promise(r=>setTimeout(r,20));assert.equal(ledger.readRun('queued-run')?.status,'completed');
  }finally{if(oldTrace===undefined)delete process.env.AGENTICREPLAY_RUN_DIR;else process.env.AGENTICREPLAY_RUN_DIR=oldTrace;}

  ledger.createRunInTransaction({
    runId: 'legacy-answer-run', workspace: project.workspace, protocolVersion: '1',
    client: { kind: 'codex', sessionId: 'legacy-answer-session' }, captureProfile: 'minimal',
    coverage: { run: 'best_effort', tool: 'declared', command: 'declared', file: 'declared', approval: 'unavailable' },
    task: { title: 'Check sqlite', query: 'Check sqlite', profileHints: { taskType: null, target: null, expected: null, constraints: null } },
    metadata: { intakeRequired: false },
  });
  ledger.updateRunStatusInTransaction('legacy-answer-run', 'completed');
  let unexpectedPrompts = 0;
  client.setRequestHandler(ElicitRequestSchema, async request => {
    unexpectedPrompts++;
    assert.ok('requestedSchema' in request.params);
    assert.deepEqual(request.params.requestedSchema.properties, {});
    return unexpectedPrompts === 1
      ? { action: 'accept', content: { comment: 'test works' } }
      : { action: 'cancel' };
  });
  const unexpected = await client.callTool({ name: 'memory_review_completed', arguments: {
    runId: 'legacy-answer-run', cwd: root, traceDirectory: trace,
  } });
  assert.equal((unexpected.structuredContent as { status?: string })?.status, 'declined');
  assert.equal(unexpectedPrompts, 1, 'unexpected form values never cause another confirmation or a save');
  const stored = db.prepare('SELECT revision, proposal_json FROM replay_memories WHERE task_id = ?')
    .get<{ revision: number; proposal_json: string }>('legacy-answer-run');
  assert.equal(stored, undefined, 'a legacy correction response cannot approve an undisplayed form action');

 }finally{await client.close();await server.close();db.close();rmSync(root,{recursive:true,force:true});}
});

test('native adapter retains approved identity after lost save response and reconciles without another prompt or write',async()=>{
 const {ElicitRequestSchema}=await import('@modelcontextprotocol/sdk/types.js');
 const {LedgerStore}=await import('../../src/ledger/store.js');const {resolveProjectWorkspace}=await import('../../src/memory/workspaces.js');
 const {createMcpReplayReview}=await import('../../src/mcp/replay-review.js');
 const {mkdirSync,writeFileSync}=await import('node:fs');const {execFileSync}=await import('node:child_process');const {createHash}=await import('node:crypto');
 const root=mkdtempSync(path.join(tmpdir(),'replay-reconcile-host-'));execFileSync('git',['init','-q',root]);const file=path.join(root,'db.sqlite3');const db=openConnection(file);migrateDatabase(db);
 const project=await resolveProjectWorkspace(db,root);assert.ok(project);const ledger=new LedgerStore(db);ledger.createRunInTransaction({runId:'reconcile-run',workspace:project.workspace,protocolVersion:'1',client:{kind:'codex',sessionId:'session'},captureProfile:'minimal',coverage:{run:'best_effort',tool:'declared',command:'declared',file:'declared',approval:'unavailable'},task:{title:'Check sqlite',query:'Check sqlite',profileHints:{taskType:null,target:null,expected:null,constraints:null}},metadata:{intakeRequired:false}});ledger.updateRunStatusInTransaction('reconcile-run','completed');
 const trace=path.join(root,'.agenticreplay','runs','run_abcdef');mkdirSync(trace,{recursive:true});const bytes=JSON.stringify({seq:1,type:'user.message',payload:{text:'Check sqlite'}})+'\n';writeFileSync(path.join(trace,'events.jsonl'),bytes);writeFileSync(path.join(trace,'manifest.json'),JSON.stringify({schema_version:'0.4.0',run_id:'run_abcdef',cwd:root,integrity:{events_sha256:createHash('sha256').update(bytes).digest('hex')}}));
 const server=createKiokukoMcpServer({databasePath:file,cwd:()=>root});const client=new Client({name:'human-review',version:'1'},{capabilities:{elicitation:{form:{}}}});let prompts=0;
 client.setRequestHandler(ElicitRequestSchema,async()=>{prompts++;return {action:'accept',content:{}};});const [a,b]=InMemoryTransport.createLinkedPair();await server.connect(b);await client.connect(a);
 let acquisitions=0;const adapter=createMcpReplayReview(server,async fn=>{const result=await fn(db);if(++acquisitions===2)throw new Error('response unavailable after committed save');return result;});
 try{const input={runId:'reconcile-run',cwd:root,traceDirectory:trace};const first=await adapter.review(input);assert.equal(first.status,'unavailable');assert.ok(first.approvalKey);assert.equal(db.prepare('SELECT COUNT(*) n FROM entries').get<{n:number}>()!.n,1);const second=await adapter.review(input);assert.equal(second.status,'saved');assert.equal(second.approvalKey,first.approvalKey);assert.equal(prompts,1);assert.equal(db.prepare('SELECT COUNT(*) n FROM entries').get<{n:number}>()!.n,1);}finally{adapter.close();await client.close();await server.close();db.close();rmSync(root,{recursive:true,force:true});}
});
