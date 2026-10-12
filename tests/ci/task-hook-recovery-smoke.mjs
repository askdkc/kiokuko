import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { acceptCodexToolHook, runCodexNestedTool } from '../fixtures/codex-hook-output.mjs';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { createHash } from 'node:crypto';
import { verifyInstalledMissingPromptRecovery } from './missing-prompt-hook-smoke.mjs';

// Real SDK/stdio cancellation, with only external discovery replaced by a bounded fixture.
async function verifyInstalledMcpCancellation(installedRoot, fixtureRoot) {
  const root = path.join(fixtureRoot, 'cancel-repo');
  await mkdir(root, {recursive:true});
  execFileSync('git', ['init', '-q', root]);
  await writeFile(path.join(root, 'package.json'), '{"dependencies":{"typescript":"^5.0.0"}}');
  const entry = path.join(fixtureRoot, 'cancel-server.mjs');
  const serverModule = pathToFileURL(path.join(installedRoot, 'dist/mcp/server.js')).href;
  await writeFile(entry, `import {runMcpServer} from ${JSON.stringify(serverModule)};
await runMcpServer({databasePath:${JSON.stringify(path.join(fixtureRoot,'cancel.sqlite3'))}, fetchImpl:async (_url, init) => {
  process.stderr.write('KIOKUKO_PACKAGE_DISCOVERY_STARTED\\n');
  return await new Promise((_resolve,reject) => {
    const signal=init.signal;
    if(signal.aborted)reject(signal.reason);
    else signal.addEventListener('abort',()=>reject(signal.reason),{once:true});
  });
}});
`);
  const client = new Client({name:'installed-cancellation-smoke',version:'1'});
  const transport = new StdioClientTransport({command:process.execPath,args:[entry],cwd:root,
    env:{PATH:process.env.PATH??'',KIOKUKO_SKILL_DISCOVERY:'official'},stderr:'pipe'});
  let started;
  const discoveryStarted = new Promise(resolve=>{started=resolve;});
  let diagnostic = '';
  transport.stderr.on('data',chunk=>{
    diagnostic=(diagnostic+chunk.toString()).slice(-256);
    if(diagnostic.includes('KIOKUKO_PACKAGE_DISCOVERY_STARTED'))started();
  });
  await client.connect(transport);
  const capabilities=[{kind:'skill',name:'kiokuko-soul'},{kind:'skill',name:'memory-reasoning'}];
  const answers={taskType:'build',target:'TypeScript service',expected:'CLI starts',constraints:'preserve behavior'};
  let input;
  try {
    const prepared=await client.callTool({name:'task_prepare',arguments:{cwd:root,requestId:'installed-wire-cancel',soulRead:true,
      task:'Build a TypeScript service',capabilities}});
    assert.notEqual(prepared.isError,true);let pending=prepared.structuredContent;
    while(pending.intake.status==='needs_answer'){
      const controller=new AbortController();
      input={cwd:root,runId:pending.run.runId,sessionId:pending.intake.sessionId,
        questionId:pending.intake.question.id,value:answers[pending.intake.question.id],capabilities,maxContextChars:12000};
      const answer=client.callTool({name:'task_answer',arguments:input},undefined,{signal:controller.signal,timeout:10000});
      const result=await Promise.race([answer.then(value=>({value})),discoveryStarted.then(()=>({started:true}))]);
      if(result.started){controller.abort(new Error('package caller cancellation'));await assert.rejects(answer);break;}
      assert.notEqual(result.value.isError,true);pending=result.value.structuredContent;
    }
    assert.ok(input);
    const resumed=await client.callTool({name:'task_answer',arguments:input});
    assert.notEqual(resumed.isError,true);assert.equal(resumed.structuredContent.run.status,'active');
    assert.deepEqual(resumed.structuredContent.skillDiscovery.failures,[{stage:'search',code:'task_request_cancelled'}]);
    const status=await client.callTool({name:'task_memory_status',arguments:{cwd:root,runId:input.runId}});
    assert.notEqual(status.isError,true);
    const journal=status.structuredContent.mcpCancellation;
    assert.equal(journal.contract,'kiokuko/mcp-cancellation@1');assert.equal(journal.provenance,'server_observed');
    assert.equal(journal.receipts.length,1);assert.equal(journal.receipts[0].handlerSettled,true);
    // Input uses a fixed property order independent of the server's canonicalizer.
    const canonical=value=>Array.isArray(value)?value.map(canonical):value&&typeof value==='object'
      ?Object.fromEntries(Object.keys(value).sort().map(key=>[key,canonical(value[key])])):value;
    assert.equal(journal.receipts[0].requestHash,createHash('sha256').update(JSON.stringify(canonical(input))).digest('hex'));
    const healthy=await client.callTool({name:'task_memory_status',arguments:{cwd:root,runId:input.runId}});
    assert.equal(healthy.structuredContent.mcpCancellation.serverInstanceId,journal.serverInstanceId);
    assert.deepEqual(healthy.structuredContent.mcpCancellation.receipts,journal.receipts);
  } finally {await client.close();}
}

// Exercise the installed tarball's code and CLI, never source modules.
export async function verifyInstalledTaskHookRecovery(installedRoot, fixtureRoot) {
  await verifyInstalledMissingPromptRecovery(installedRoot, path.join(fixtureRoot, 'missing-prompt'));
  const load = file => import(pathToFileURL(path.join(installedRoot, 'dist', file)).href);
  const { initializeDatabase } = await load('commands/init.js');
  const { openConnection } = await load('db/connection.js');
  const { prepareAgentTask, answerAgentTask } = await load('akinator/agent-task.js');
  const { refreshTaskMemory } = await load('assurance/refresh.js');
  const { taskAssuranceReport } = await load('assurance/service.js');
  const root = path.join(fixtureRoot, 'repo');
  await mkdir(root, { recursive: true });
  execFileSync('git', ['init', '-q', root]);
  await writeFile(path.join(root, 'package.json'), '{"dependencies":{"typescript":"^5.0.0"}}');
  const databasePath = path.join(fixtureRoot, 'memory.sqlite3');
  await initializeDatabase({ databasePath });
  const db = openConnection(databasePath);
  const capabilities = [{ kind: 'skill', name: 'kiokuko-soul' }, { kind: 'skill', name: 'memory-reasoning' }];
  const common = { session_id: 'installed-recovery', turn_id: 'request', cwd: root };
  const codeHome = path.join(fixtureRoot, 'codex');
  await mkdir(path.join(codeHome, 'sessions'), {recursive:true});
  const cli = path.join(installedRoot, 'dist/bin/kiokuko.js');
  const hookProcess = event => spawnSync(process.execPath, [cli, 'codex-hook', '--database', databasePath],
      { input: JSON.stringify({ ...common, ...event }), encoding: 'utf8', env:{...process.env,CODEX_HOME:codeHome} });
  const hook = event => {
    const result = hookProcess(event);
    assert.equal(result.status, 0, result.stderr);
    return ['PreToolUse', 'PostToolUse'].includes(event.hook_event_name)
      ? acceptCodexToolHook(result.stdout, event.hook_event_name) : JSON.parse(result.stdout);
  };
  try {
    hook({ hook_event_name: 'UserPromptSubmit' });
    const requestId = db.prepare('SELECT request_id FROM codex_hook_requests').get().request_id;
    let deniedExecutions = 0;
    const unprepared = { tool_name: 'read_file', tool_use_id: 'unprepared', tool_input: { path: 'package.json' } };
    await assert.rejects(runCodexNestedTool(hookProcess, unprepared, async () => { deniedExecutions++; return 'should not execute'; }), /Preparation was missing/);
    assert.equal(deniedExecutions, 0);
    assert.equal(db.prepare('SELECT COUNT(*) n FROM codex_hook_tools').get().n, 0);
    const args = { cwd: root, requestId, capabilities, skillDiscoveryMode: 'off', task: 'Build a TypeScript service',
      profileHints: { taskType: 'build', target: 'TypeScript service', expected: 'CLI starts' } };
    const prepared = await prepareAgentTask(db, args);
    hook({ hook_event_name: 'PostToolUse', tool_name: 'mcp__kiokuko__task_prepare', tool_use_id: 'prepare',
      tool_input: args, tool_response: { structuredContent: prepared } });
    const start = { tool_name: 'exec_command', tool_use_id: 'start', tool_input: { cmd: 'true' } };
    hook({ ...start, hook_event_name: 'PreToolUse' });
    await refreshTaskMemory(db, { runId: prepared.run.runId, cwd: root, requestId: 'refresh',
      expectedRevision: taskAssuranceReport(db, prepared.run.runId).revision, capabilities, changedPaths: ['package.json'] });
    hook({ ...start, hook_event_name: 'PostToolUse', tool_response: { session_id: 91 } });
    const poll = { hook_event_name: 'PostToolUse', tool_name: 'write_stdin', tool_use_id: 'poll',
      tool_input: { session_id: 91 }, tool_response: { exit_code: 0 } };
    assert.match(hook(poll).hookSpecificOutput.additionalContext, /Delivery changed/);
    hook(poll);
    assert.equal(db.prepare('SELECT COUNT(*) n FROM task_execution_evidence').get().n, 0);

    const transcript = path.join(codeHome, 'sessions', `rollout-package-${common.session_id}.jsonl`);
    const header = {type:'session_meta',payload:{id:common.session_id,cwd:root}};
    for (const exit of [0,7]) {
      const command = {tool_name:'exec_command',tool_use_id:`host-exit-${exit}`,tool_input:{cmd:'true'}};
      hook({...command,hook_event_name:'PreToolUse'});
      const record = {type:'event_msg',payload:{type:'item_completed',thread_id:common.session_id,turn_id:common.turn_id,
        item:{type:'CommandExecution',id:command.tool_use_id,process_id:'93',source:'unified_exec_startup',cwd:pathToFileURL(root).href,status:exit === 0 ? 'completed':'failed',exit_code:exit}}};
      await writeFile(transcript,[header,record].map(x=>JSON.stringify(x)+'\n').join(''),{mode:0o600});
      const event={...command,hook_event_name:'PostToolUse',tool_response:'{"exit_code":0}',transcript_path:transcript};
      hook(event);hook(event);
      const evidence=db.prepare('SELECT outcome,exit_code,provenance FROM task_execution_evidence ORDER BY rowid DESC LIMIT 1').get();
      assert.deepEqual({...evidence},{outcome:exit === 0 ? 'passed':'failed',exit_code:exit,provenance:'client_observed'});
    }
    assert.equal(db.prepare('SELECT COUNT(*) n FROM task_execution_evidence').get().n,2);

    // The installed CLI must preserve every inner result even when its own
    // evidence write fails after execution. No host or tool-output rescue.
    db.exec("CREATE TRIGGER package_post_fault BEFORE INSERT ON task_execution_evidence BEGIN SELECT RAISE(ABORT, 'private-post-fault'); END");
    let executions = 0;
    const results = await Promise.all(Array.from({length:3}, (_,i) => runCodexNestedTool(hookProcess,
      {tool_name:'exec_command',tool_use_id:`nested-${i}`,tool_input:{cmd:'fixture execution'}},
      async () => { executions++; return {exit_code:i,output:`private-output-${i}`}; })));
    assert.deepEqual(results,Array.from({length:3},(_,i)=>({exit_code:i,output:`private-output-${i}`})));
    assert.equal(executions,3);
    assert.equal(db.prepare('SELECT COUNT(*) n FROM task_execution_evidence').get().n,2);
    db.exec('DROP TRIGGER package_post_fault');
    const unavailable = spawnSync(process.execPath,[cli,'codex-hook','--database',path.join(fixtureRoot,'absent.sqlite3')],
      {input:JSON.stringify({...common,...unprepared,hook_event_name:'PreToolUse'}),encoding:'utf8'});
    assert.equal(unavailable.status,0);
    assert.equal(acceptCodexToolHook(unavailable.stdout,'PreToolUse').hookSpecificOutput.permissionDecision,'deny');

    const controller = new AbortController();
    let searches = 0;
    const fetchImpl = async () => { searches++; controller.abort(new Error('Request timeout')); throw controller.signal.reason; };
    let pending = await prepareAgentTask(db, { cwd: root, requestId: 'cancelled-intake', capabilities,
      skillDiscoveryMode: 'official', task: 'Build a TypeScript service', fetchImpl });
    const answers = { taskType: 'build', target: 'TypeScript service', expected: 'CLI starts', constraints: 'preserve behavior' };
    let last;
    while (pending.intake.status === 'needs_answer') {
      last = { cwd: root, runId: pending.run.runId, sessionId: pending.intake.sessionId,
        questionId: pending.intake.question.id, value: answers[pending.intake.question.id], capabilities,
        skillDiscoveryMode: 'official', fetchImpl, signal: controller.signal };
      try { pending = await answerAgentTask(db, last); }
      catch (error) { assert.equal(error, controller.signal.reason); break; }
    }
    assert.ok(searches > 0);
    const before = searches;
    const resumed = await answerAgentTask(db, { ...last, signal: new AbortController().signal });
    assert.equal(resumed.intake.status, 'ready');
    assert.equal(resumed.run.status, 'active');
    assert.deepEqual(resumed.skillDiscovery.failures, [{ stage: 'search', code: 'task_request_cancelled' }]);
    assert.deepEqual(resumed.skillDiscovery.selected, []);
    assert.equal(searches, before);
  } finally { db.close(); }
  await verifyInstalledMcpCancellation(installedRoot, fixtureRoot);
  process.stdout.write('Installed task recovery verified host exit receipts, post-only polls, and SDK/stdio cancellation acknowledgment and recovery.\n');
}
