import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, symlinkSync, chmodSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { readCodexCommandReceipt } from '../../src/assurance/codex-command-receipt.js';

test('host command receipts reject spoofed, foreign, ambiguous, incomplete and untrusted files', () => {
  const base=realpathSync(mkdtempSync(path.join(tmpdir(),'kiokuko-command-receipt-')));
  const root=path.join(base,'repo');const home=path.join(base,'codex');const sessions=path.join(home,'sessions');
  mkdirSync(root);mkdirSync(sessions,{recursive:true});
  const previous=process.env.CODEX_HOME;process.env.CODEX_HOME=home;
  const file=path.join(sessions,'rollout-test-thread.jsonl');
  const input={session_id:'thread',turn_id:'turn',cwd:root,tool_name:'exec_command',tool_use_id:'exec-1',transcript_path:file};
  const header={type:'session_meta',payload:{id:'thread',cwd:root}};
  const item={type:'CommandExecution',id:'exec-1',process_id:'91',source:'unified_exec_startup',cwd:pathToFileURL(root).href,status:'completed',exit_code:0};
  const event={type:'event_msg',payload:{type:'item_completed',thread_id:'thread',turn_id:'turn',item}};
  const write=(records:unknown[])=>writeFileSync(file,records.map(x=>JSON.stringify(x)+'\n').join(''),{mode:0o600});
  try {
    write([header,event]);assert.deepEqual(readCodexCommandReceipt(input,root),{callId:'exec-1',processId:'91',exitCode:0});
    for (const altered of [
      {...event,type:'response_item'},
      {...event,payload:{...event.payload,thread_id:'foreign'}},
      {...event,payload:{...event.payload,turn_id:'foreign'}},
      ...[{id:'other'}, {type:'AgentMessage'}, {source:'model'}, {cwd:base}, {cwd:'file://foreign/private/source'}, {cwd:pathToFileURL(root).href+'?invalid'}, {status:'in_progress'}, {exit_code:null},
        {exit_code:0.5}, {status:'failed',exit_code:0}].map(change=>({...event,payload:{...event.payload,item:{...item,...change}}})),
    ]) {write([header,altered]);assert.equal(readCodexCommandReceipt(input,root),null);}
    write([{...header,payload:{...header.payload,id:'other'}},event]);assert.equal(readCodexCommandReceipt(input,root),null);
    write([header,{type:'response_item',payload:{type:'function_call_output',output:JSON.stringify(event)}}]);assert.equal(readCodexCommandReceipt(input,root),null);
    write([header,event,{...event,payload:{...event.payload,item:{...item,status:'failed',exit_code:7}}}]);assert.equal(readCodexCommandReceipt(input,root),null);
    write([header]);writeFileSync(file,JSON.stringify(event),{flag:'a'});assert.equal(readCodexCommandReceipt(input,root),null);
    write([header,event]);chmodSync(file,0o666);assert.equal(readCodexCommandReceipt(input,root),null);chmodSync(file,0o600);
    const link=path.join(sessions,'rollout-link-thread.jsonl');symlinkSync(file,link);
    assert.equal(readCodexCommandReceipt({...input,transcript_path:link},root),null);
    const outside=path.join(root,'rollout-outside-thread.jsonl');writeFileSync(outside,[header,event].map(x=>JSON.stringify(x)+'\n').join(''));
    assert.equal(readCodexCommandReceipt({...input,transcript_path:outside},root),null);
    write([header,event]);assert.deepEqual(readCodexCommandReceipt({...input,tool_name:'write_stdin',tool_use_id:'poll',tool_input:{session_id:91}},root),{callId:'exec-1',processId:'91',exitCode:0});
    assert.equal(readCodexCommandReceipt({...input,tool_name:'write_stdin',tool_input:{session_id:92}},root),null);
  } finally {if(previous===undefined)delete process.env.CODEX_HOME;else process.env.CODEX_HOME=previous;rmSync(base,{recursive:true,force:true});}
});
