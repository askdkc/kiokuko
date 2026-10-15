import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, realpathSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createServer } from 'node:http';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { openConnection } from '../../src/db/connection.js';
import { migrateDatabase } from '../../src/db/migrate.js';
import { observeMemory, memoryContext, improveMemory } from '../../src/memory/observations.js';
import { createKiokukoMcpServer } from '../../src/mcp/server.js';
import { createPassiveMemoryRoute } from '../../src/server/routes/passive-memory.js';
import { createApp } from '../../src/server/app.js';
import { MemoryMaintenance } from '../../src/memory/maintenance.js';
import { handleCodexHook } from '../../src/assurance/codex-hooks.js';
import { lifecycleObservation } from '../../src/memory/hook-observation-dispatch.js';
import { readReplayObservation } from '../../src/memory/replay-observations.js';

function fixture() {
 const root=realpathSync(mkdtempSync(path.join(tmpdir(),'kiokuko-passive-')));
 execFileSync('git',['init','-q'],{cwd:root});
 const file=path.join(root,'memory.sqlite3'); const db=openConnection(file);migrateDatabase(db);
 return {root,file,db,cleanup:()=>{try{db.close();}catch{}rmSync(root,{recursive:true,force:true});}};
}
function observation(cwd:string,eventId:string,overrides:Record<string,unknown>={}) {
 return {cwd,eventId,sessionId:'same-session',kind:'completion',summary:'Recorded public actions and outcome',
  tags:['runtime'],source:{producer:'codex',runId:eventId},...overrides};
}
test('passive observation and improvement never save derived memory before human review', async()=>{
 const f=fixture();try {
  for (const kind of ['completion','compaction','model_switch','complaint','praise']) {
   const result=await observeMemory(f.db,observation(f.root,kind,{kind}));
   assert.equal(result.recorded,false);assert.equal(result.workMayContinue,true);
  }
  assert.equal((await improveMemory(f.db,{cwd:f.root})).recorded,false);
  assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM entries').get<{n:number}>()?.n,0);
  assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM memory_observation_heads').get<{n:number}>()?.n,0);
  assert.deepEqual((await memoryContext(f.db,{cwd:f.root})).entries,[]);
 }finally{f.cleanup();}
});
test('MCP passive APIs are real protocol tools; an unavailable DB fails only its record',async()=>{
 const f=fixture();const server=createKiokukoMcpServer({databasePath:f.file,cwd:()=>f.root});
 const client=new Client({name:'passive-test',version:'1'});const [a,b]=InMemoryTransport.createLinkedPair();
 await server.connect(b);await client.connect(a);
 try {
  const tools=await client.listTools();assert.ok(['memory_observe','memory_context','memory_improve'].every(name=>tools.tools.some(t=>t.name===name)));
  const saved=await client.callTool({name:'memory_observe',arguments:observation(f.root,'mcp')});
  assert.equal((saved.structuredContent as Record<string, unknown> | undefined)?.recorded,false);assert.equal((saved.structuredContent as Record<string, unknown> | undefined)?.workMayContinue,true);
  const context=await client.callTool({name:'memory_context',arguments:{cwd:f.root,sessionId:'same-session'}});
  assert.equal((context.structuredContent as Record<string, unknown> | undefined)?.available,true);
 } finally {await client.close();await server.close();f.cleanup();}
 const broken=createKiokukoMcpServer({initializeDatabase:()=>{throw new Error('fixture unavailable');}});
 const c=new Client({name:'broken-memory-test',version:'1'});const [x,y]=InMemoryTransport.createLinkedPair();await broken.connect(y);await c.connect(x);
 try {const result=await c.callTool({name:'memory_observe',arguments:observation('/tmp','unavailable')});
  assert.equal((result.structuredContent as Record<string, unknown> | undefined)?.recorded,false);assert.equal((result.structuredContent as Record<string, unknown> | undefined)?.workMayContinue,true);
 } finally {await c.close();await broken.close();}
});
test('HTTP passive aliases retain bearer authorization and scoped record validation',async()=>{
 const f=fixture();const route=createPassiveMemoryRoute({database:f.db,enqueueWrite:async fn=>fn()});
 const server=createServer(createApp({expectedToken:'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',readiness:{ready:true},v1:route}));
 await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));
 const port=(server.address() as {port:number}).port;
 try {
  const post=(endpoint:string,body:unknown,auth=true)=>fetch(`http://127.0.0.1:${port}${endpoint}`,{method:'POST',headers:{'content-type':'application/json',...(auth?{authorization:'Bearer aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'}:{})},body:JSON.stringify(body)});
  assert.equal((await post('/api/memory/observe',observation(f.root,'http'),false)).status,401);
  const saved=await post('/api/memory/observe',observation(f.root,'http'));assert.equal(saved.status,200);assert.equal((await saved.json()).recorded,false);
  const invalid=await post('/api/memory/observe',{cwd:f.root});assert.equal((await invalid.json()).recorded,false);
  const context=await post('/api/v1/memory/context',{cwd:f.root});assert.equal((await context.json()).available,true);
 } finally {route.close?.();await new Promise<void>((resolve,reject)=>server.close(error=>error?reject(error):resolve()));f.cleanup();}
});
test('asynchronous improvement failures never reject the completed observation caller',async()=>{
 let attempts=0;const worker=new MemoryMaintenance(async()=>{attempts++;throw new Error('fixture failure');},60_000);
 try {worker.schedule('/tmp/repo');await worker.runOnce();assert.equal(attempts,1);await worker.runOnce();assert.equal(attempts,2);}
 finally {worker.close();}
 await worker.runOnce();assert.equal(attempts,2);
});
test('production AgenticReplay directory metadata excludes payloads, rejects foreign scope and integrity mismatch',async()=>{
 const f=fixture();try {
  const run=path.join(f.root,'.agenticreplay','runs','run_abcdef');mkdirSync(run,{recursive:true});
  const bytes=JSON.stringify({seq:1,ts:'2026-10-13T00:00:00Z',mono_us:1,turn:1,type:'shell.result',actor:'tool',attrs:{exit_code:0},payload:'private reasoning password=abcdefghijklmnop'})+'\n';
  writeFileSync(path.join(run,'events.jsonl'),bytes);
  const manifest={schema_version:'0.4.0',run_id:'run_abcdef',cwd:f.root,integrity:{events_sha256:createHash('sha256').update(bytes).digest('hex')}};
  writeFileSync(path.join(run,'manifest.json'),JSON.stringify(manifest));
  const input={cwd:f.root,traceDirectory:run,sessionId:'session',kind:'completion' as const};
  const result=await readReplayObservation(input);assert.ok(result.observation);assert.ok(!JSON.stringify(result.observation).includes('password'));assert.equal(result.observation.verification,'unknown');assert.equal(result.observation.actions[0]?.outcome,'passed');
  writeFileSync(path.join(run,'events.jsonl'),bytes+'{}\n');assert.deepEqual((await readReplayObservation(input)).warnings,['replay_integrity_mismatch']);
  assert.equal((await readReplayObservation({...input,traceDirectory:f.root})).observation,undefined);
 } finally {f.cleanup();}
});

test('host compaction and completion projections carry only public lifecycle identity',()=>{
 for(const hook_event_name of ['PostCompact','Stop','SubagentStop']) {
  const event=lifecycleObservation({hook_event_name,cwd:'/tmp/repository',session_id:'same-session',turn_id:'turn',
    transcript_path:'/private/transcript',tool_response:'private reasoning',tool_input:{secret:'hidden'}});
  assert.ok(event);assert.equal(event.verification,'unknown');assert.equal(event.sessionId,'same-session');
  assert.ok(!JSON.stringify(event).includes('private'));assert.ok(!JSON.stringify(event).includes('hidden'));
 }
 assert.equal(lifecycleObservation({hook_event_name:'PreToolUse'}),undefined);
});

test('missing optional preparation and CLI DB failures do not emit ordinary-tool denial or a turn stop',()=>{
 const f=fixture();try {
  const input={hook_event_name:'PreToolUse',cwd:f.root,session_id:'session',turn_id:'turn',tool_name:'Bash',tool_use_id:'call',tool_input:{command:'fixture-private-command'}};
  const response=handleCodexHook(f.db,input) as {continue?:boolean;hookSpecificOutput?:{permissionDecision?:string}};
  assert.notEqual(response.continue,false);assert.notEqual(response.hookSpecificOutput?.permissionDecision,'deny');
  const missing=path.join(f.root,'missing.sqlite3');
  const cli=path.resolve('dist/bin/kiokuko.js');
  for(const hook_event_name of ['PreToolUse','PostToolUse','Stop','PostCompact']) {
   const child=spawnSync(process.execPath,[cli,'codex-hook','--database',missing],{input:JSON.stringify({...input,hook_event_name}),encoding:'utf8',timeout:10_000});
   assert.equal(child.status,0,child.stderr);
   const output=JSON.parse(child.stdout);assert.notEqual(output.continue,false);assert.notEqual(output.hookSpecificOutput?.permissionDecision,'deny');
   assert.ok(!child.stdout.includes('fixture-private-command'));
  }
 } finally {f.cleanup();}
});
