import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { openConnection } from '../../src/db/connection.js';
import { migrateDatabase } from '../../src/db/migrate.js';
import { prepareAgentTask } from '../../src/akinator/agent-task.js';
import { resolveProjectWorkspace } from '../../src/memory/workspaces.js';
import { recordEntry, updateCandidateEntry } from '../../src/memory/entries.js';
import { taskAssuranceReport, reviewTaskMemory } from '../../src/assurance/service.js';
import { handleCodexHook } from '../../src/assurance/codex-hooks.js';
import { LedgerStore } from '../../src/ledger/store.js';
import { isBookkeepingFailure } from '../../src/assurance/bookkeeping-policy.js';
import { createKiokukoMcpServer } from '../../src/mcp/server.js';
import { KiokukoError } from '../../src/errors.js';
import { renderAgentFile, AGENT_TEMPLATE_VERSION } from '../../src/agent-file/render.js';

const capabilities=[{kind:'skill',name:'kiokuko-soul'},{kind:'skill',name:'memory-reasoning'}];
async function fixture(withMemory=false) {
 const base=mkdtempSync(path.join(tmpdir(),'kiokuko-bookkeeping-'));const root=path.join(base,'repo');mkdirSync(root);
 execFileSync('git',['init','-q',root]);writeFileSync(path.join(root,'source.ts'),'export const x=1;\n');
 execFileSync('git',['-C',root,'add','.']);execFileSync('git',['-C',root,'-c','user.name=Fixture','-c','user.email=fixture@example.invalid','commit','-qm','fixture']);
 const db=openConnection(path.join(base,'memory.sqlite3'));migrateDatabase(db);
 const project=await resolveProjectWorkspace(db,root);assert.ok(project);
 const entry=withMemory?recordEntry(db,{workspace:project.workspace,kind:'decision',title:'source.ts verification',body:'Fix source.ts and verify source.ts with a regression test.',tags:['source.ts']}):undefined;
 const hook={cwd:root,session_id:'narrow',turn_id:'request'};
 const prompt=handleCodexHook(db,{...hook,hook_event_name:'UserPromptSubmit'}) as any;
 const requestId=/Kiokuko request (codex-[a-f0-9]+)/u.exec(prompt.hookSpecificOutput.additionalContext)![1]!;
 const prepared=await prepareAgentTask(db,{cwd:root,requestId,task:'Fix source.ts and verify source.ts',capabilities,skillDiscoveryMode:'off',profileHints:{taskType:'build',target:'source.ts',expected:'source.ts regression test passes',constraints:'preserve source.ts behavior'}});
 handleCodexHook(db,{...hook,hook_event_name:'PostToolUse',tool_name:'mcp__kiokuko__task_prepare',tool_use_id:'prepare',tool_input:{cwd:root,requestId},tool_response:{structuredContent:prepared}});
 let count=0;const ordinary=()=>handleCodexHook(db,{...hook,hook_event_name:'PreToolUse',tool_name:'Bash',tool_use_id:`ordinary-${++count}`,tool_input:{command:'true'}}) as any;
 return {base,root,db,entry,hook,requestId,prepared,ordinary,close:()=>{try{db.close();}catch{}rmSync(base,{recursive:true,force:true});}};
}
for(const condition of ['pending','stale'] as const)test(`${condition} memory rejects unsatisfied record completion without denying unrelated coding`,async()=>{
 const f=await fixture(true);try {
  assert.ok(f.entry);const runId=f.prepared.run.runId;
  assert.ok(taskAssuranceReport(f.db,runId).pending.length);
  if(condition==='stale')updateCandidateEntry(f.db,{workspace:f.entry.workspace,entryId:f.entry.id,expectedRevision:f.entry.revision,kind:'decision',title:f.entry.title,body:'Changed source.ts condition',tags:f.entry.tags});
  const result=f.ordinary();assert.notEqual(result.hookSpecificOutput?.permissionDecision,'deny');assert.notEqual(result.continue,false);
  assert.match(result.systemMessage,/memory_(review_pending|stale)/u);
  assert.throws(()=>reviewTaskMemory(f.db,{runId,requestId:'invalid-review',cwd:f.root,expectedRevision:taskAssuranceReport(f.db,runId).revision!,deliveryId:f.prepared.context!.deliveryId!,entryId:f.entry!.id,entryRevision:0,decision:'adopted',basis:'invalid'}));
  assert.equal(new LedgerStore(f.db).readRun(runId)!.status,'active');
  assert.equal(f.db.prepare('SELECT stop_notified FROM codex_hook_requests WHERE request_id=?').get<{stop_notified:number}>(f.requestId)?.stop_notified,0);
 }finally{f.close();}
});
for(const status of ['completed','failed'] as const)test(`terminal ${status} memory rejects its record call but leaves unrelated coding available`,async()=>{
 const f=await fixture();try {
  new LedgerStore(f.db).updateRunStatus(f.prepared.run.runId,status);
  const record=handleCodexHook(f.db,{...f.hook,hook_event_name:'PreToolUse',tool_name:'mcp__kiokuko__task_memory_review',tool_use_id:'terminal-record',tool_input:{cwd:f.root,runId:f.prepared.run.runId}}) as any;
  assert.equal(record.hookSpecificOutput?.permissionDecision,'deny');
  const ordinary=f.ordinary();assert.notEqual(ordinary.hookSpecificOutput?.permissionDecision,'deny');assert.match(ordinary.systemMessage,/task_record_terminal/u);
  assert.equal(f.db.prepare('SELECT stop_notified FROM codex_hook_requests WHERE request_id=?').get<{stop_notified:number}>(f.requestId)?.stop_notified,0);
 }finally{f.close();}
});
test('foreign run identity rejection and user interruption remain denials',async()=>{
 for(const condition of ['identity','interrupt']){
  const f=await fixture();try {
   if(condition==='identity'){
    const rejected=handleCodexHook(f.db,{...f.hook,hook_event_name:'PreToolUse',tool_name:'mcp__kiokuko__task_memory_status',tool_use_id:'foreign-run',tool_input:{cwd:f.root,runId:'foreign-run'}}) as any;
    assert.equal(rejected.hookSpecificOutput?.permissionDecision,'deny');
   }else handleCodexHook(f.db,{...f.hook,hook_event_name:'Interrupt'});
   assert.equal(f.ordinary().hookSpecificOutput?.permissionDecision,'deny');
  }finally{f.close();}
 }
});
test('database observation failure does not grant permission or manufacture a recorded completion',async()=>{
 const f=await fixture();try {
  f.db.close();const result=f.ordinary();assert.notEqual(result.hookSpecificOutput?.permissionDecision,'deny');assert.notEqual(result.continue,false);
  assert.match(result.systemMessage,/bookkeeping failed.*database_error/u);assert.equal(result.hookSpecificOutput?.permissionDecision,undefined);
 }finally{f.close();}
});
test('MCP annotates database bookkeeping errors while retaining security errors and original failure',async()=>{
 for(const code of ['DATABASE_ERROR','SECURITY_REJECTION','AUTHENTICATION_ERROR'] as const){
  const server=createKiokukoMcpServer({initializeDatabase:()=>{throw new KiokukoError(code,'fixture failure');}});
  const client=new Client({name:'boundary-test',version:'1'});const [a,b]=InMemoryTransport.createLinkedPair();await server.connect(b);await client.connect(a);
  try{const result=await client.callTool({name:'task_memory_status',arguments:{cwd:'/tmp',runId:'run'}});const fields=result.structuredContent as Record<string,unknown>;
   assert.equal(result.isError,true);assert.equal(fields.code,code);assert.notEqual(fields.nextAction,'proceed');assert.notEqual(fields.recorded,true);
   assert.equal(fields.workMayContinue,code==='DATABASE_ERROR'?true:undefined);
  }finally{await client.close();await server.close();}
 }
});
test('classification never treats identity/ownership/access/host authorization or cancellation as bookkeeping',()=>{
 for(const reason of ['run_binding_mismatch','repository_binding_mismatch','identity_violation','request_id_reused','ownership_mismatch','access_denied','host_authorization_denied','request_interrupted']){assert.equal(isBookkeepingFailure({code:'CONFLICT',reason}),false);assert.equal(isBookkeepingFailure({code:'DATABASE_ERROR',reason}),false);}
 for(const code of ['AUTHENTICATION_ERROR','SECURITY_REJECTION','MCP_REQUEST_CANCELLED'])assert.equal(isBookkeepingFailure({code}),false);
 assert.equal(isBookkeepingFailure({reason:'run_terminal',runStatus:'interrupted'}),false);
 assert.equal(isBookkeepingFailure({reason:'assurance_incomplete',nextAction:'read_task_memory_status'}),true);
});
test('managed template migration preserves user text, scopes procedure stops to records, and keeps identity denial',()=>{
 const old='User instructions remain.\n<!-- BEGIN KIOKUKO MANAGED BLOCK -->\n<!-- kiokuko-template-version: 38 -->\nOld procedure stop.\n<!-- END KIOKUKO MANAGED BLOCK -->\n';
 const rendered=renderAgentFile(old,{repositoryId:'12345678-1234-4123-8123-123456789abc',workspace:'project',cliCommand:'kiokuko'});
 assert.equal(rendered.action,'updated');assert.match(rendered.content,/User instructions remain/u);assert.match(rendered.content,new RegExp(`kiokuko-template-version: ${AGENT_TEMPLATE_VERSION}`));
 assert.ok(!rendered.content.includes('Old procedure stop.'));assert.match(rendered.content,/Unrelated authorized tools may continue/u);
 assert.match(rendered.content,/An authorization or identity denial ends the turn/u);
 assert.ok(!rendered.content.includes('stop and report the unavailable policy'));
});

test('checkout-free missing preparation cannot deny independent coding or invent a project record',()=>{
 const base=mkdtempSync(path.join(tmpdir(),'kiokuko-no-checkout-'));const db=openConnection(path.join(base,'memory.sqlite3'));migrateDatabase(db);
 try{
  const event={cwd:base,session_id:'no-repo',turn_id:'request',hook_event_name:'PreToolUse',tool_use_id:'ordinary',tool_name:'Bash',tool_input:{command:'true'}};
  const ordinary=handleCodexHook(db,event) as any;assert.notEqual(ordinary.hookSpecificOutput?.permissionDecision,'deny');assert.match(ordinary.systemMessage,/No Git checkout/u);
  const record=handleCodexHook(db,{...event,tool_use_id:'record',tool_name:'mcp__kiokuko__task_prepare',tool_input:{cwd:base,requestId:'request'}}) as any;
  assert.equal(record.hookSpecificOutput?.permissionDecision,'deny');
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM ledger_runs').get<{n:number}>()?.n,0);
 }finally{db.close();rmSync(base,{recursive:true,force:true});}
});
