import assert from 'node:assert/strict';
import test from 'node:test';
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { mkdtemp, mkdir, realpath, writeFile, appendFile, rm } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';
import path from 'node:path';

const lifecycleCases = [
  { outcome: 'completed', resumed: false },
  { outcome: 'completed', resumed: true },
  { outcome: 'interrupted', resumed: false },
] as const;

for (const { outcome, resumed } of lifecycleCases) test(`ordinary ${outcome} hook finalizes recording${resumed ? ' from a resumed Desktop transcript' : ''} without a memory run or usable DB`, async () => {
  const root=await realpath(await mkdtemp('/tmp/kk-finish-'));
  const home=path.join(root,'codex'); await mkdir(path.join(home,'sessions'),{recursive:true});
  const transcript=path.join(home,'sessions',`rollout-fixture-chat${resumed ? '_resume-turn' : ''}.jsonl`);
  const rows=[{type:'session_meta',payload:{id:'chat',cwd:root,originator:'Codex Desktop'}},
    {type:'event_msg',payload:{type:'task_started',turn_id:'turn',root_turn_id:'turn',started_at:10}},
    {type:'turn_context',payload:{turn_id:'turn',cwd:root}}];
  await writeFile(transcript,rows.map(r=>JSON.stringify(r)).join('\n')+'\n',{mode:0o600});
  const socket=path.join(root,'recorder.sock'); const received: unknown[]=[];
  const server=createServer(client=>{let input='';client.on('data',chunk=>{input+=chunk;if(input.endsWith('\n')){received.push(JSON.parse(input));client.end('{"status":"finalized","capture":"complete"}\n');}});});
  await new Promise<void>(resolve=>server.listen(socket,resolve));
  const {chmod}=await import('node:fs/promises');await chmod(socket,0o600);
  const invoke=()=>new Promise<number|null>((resolve,reject)=>{
    const child=spawn(process.execPath,['--import','tsx','src/bin/kiokuko.ts','codex-hook','--database',path.join(root,'missing.sqlite3'),'--codex-dock-record','--codex-config',path.join(home,'config.toml')],{
      cwd:process.cwd(),env:{...process.env,CODEX_HOME:home,AGENTICREPLAY_CODEX_REVIEW_SOCKET:socket},stdio:['pipe','ignore','ignore']});
    child.on('error',reject);child.on('close',resolve);child.stdin.end(JSON.stringify({hook_event_name:outcome==='completed'?'Stop':'Interrupt',session_id:'chat',turn_id:'turn',cwd:root,transcript_path:transcript}));
  });
  try {
    const start=Date.now();await invoke();assert.ok(Date.now()-start<3000,'hook must not wait for host completion');
    assert.equal(received.length,0,'Stop/Interrupt alone is not terminal evidence');
    await appendFile(transcript,JSON.stringify({type:'event_msg',payload:{type:outcome==='completed'?'task_complete':'turn_aborted',turn_id:'turn',root_turn_id:'turn',completed_at:11}})+'\n');
    const deadline=Date.now()+6000;while(!received.length&&Date.now()<deadline)await delay(50);
    assert.deepEqual(received[0],{action:'finish',outcome,cwd:root,sessionId:'chat',turnId:'turn'});
    await delay(100);assert.equal(received.length,1,'one terminal hook must send one completion handoff');
  } finally { await new Promise<void>(resolve=>server.close(()=>resolve()));await rm(root,{recursive:true,force:true}); }
});

test('terminal proof rejects foreign, partial, duplicate and non-desktop transcripts', async()=>{
  const {readDesktopTurnOutcome}=await import('../../src/assurance/codex-desktop-turn.js');
  const root=await realpath(await mkdtemp('/tmp/kk-proof-'));
  const previous=process.env.CODEX_HOME;process.env.CODEX_HOME=root;
  const sessions=path.join(root,'sessions');await mkdir(sessions);
  const transcript=path.join(sessions,'rollout-fixture-chat.jsonl');
  const header={type:'session_meta',payload:{id:'chat',cwd:root,originator:'Codex Desktop'}};
  const start={type:'event_msg',payload:{type:'task_started',turn_id:'turn',root_turn_id:'turn',started_at:10}};
  const context={type:'turn_context',payload:{turn_id:'turn',cwd:root}};
  const complete={type:'event_msg',payload:{type:'task_complete',turn_id:'turn',root_turn_id:'turn',completed_at:11}};
  const binding={sessionId:'chat',turnId:'turn',transcriptPath:transcript};
  const write=async(rows:unknown[])=>writeFile(transcript,rows.map(r=>JSON.stringify(r)).join('\n')+'\n',{mode:0o600});
  try {
    await write([header,start,context]);assert.equal(readDesktopTurnOutcome(binding,root),null);
    await write([header,start,context,complete]);assert.equal(readDesktopTurnOutcome(binding,root),'completed');
    assert.equal(readDesktopTurnOutcome({...binding,turnId:'other'},root),null);
    assert.equal(readDesktopTurnOutcome({...binding,sessionId:'other'},root),null);
    for(const rows of [[header,start,complete],[header,start,context,complete,complete],
      [{...header,payload:{...header.payload,originator:'untrusted'}},start,context,complete],
      [header,start,{...context,payload:{...context.payload,cwd:'/'}},complete]]) {
      await write(rows);assert.equal(readDesktopTurnOutcome(binding,root),null);
    }
    await write([header,start,context,{type:'event_msg',payload:{type:'turn_aborted',turn_id:'turn'}}]);
    assert.equal(readDesktopTurnOutcome(binding,root),'interrupted');
  } finally { if(previous===undefined)delete process.env.CODEX_HOME;else process.env.CODEX_HOME=previous; await rm(root,{recursive:true,force:true}); }
});

test('long turns keep terminal proof beyond the old 8 MiB tail and retry notification until durable finalization', async()=>{
  const {readDesktopTurnOutcome}=await import('../../src/assurance/codex-desktop-turn.js');
  const {finishCodexRecording}=await import('../../src/agenticreplay/codex-completion.js');
  const root=await realpath(await mkdtemp('/tmp/kk-retry-'));const priorHome=process.env.CODEX_HOME;const priorSocket=process.env.AGENTICREPLAY_CODEX_REVIEW_SOCKET;
  process.env.CODEX_HOME=root;await mkdir(root+'/sessions');const transcript=root+'/sessions/rollout-fixture-chat.jsonl';const socket=root+'/recorder.sock';process.env.AGENTICREPLAY_CODEX_REVIEW_SOCKET=socket;
  const rows=[{type:'session_meta',payload:{id:'chat',cwd:root,originator:'Codex Desktop'}},
    {type:'event_msg',payload:{type:'task_started',turn_id:'turn',root_turn_id:'turn',started_at:10}},
    {type:'turn_context',payload:{turn_id:'turn',cwd:root}},
    {type:'event_msg',payload:{type:'tool_output',text:'x'.repeat(9*1024*1024)}},
    {type:'event_msg',payload:{type:'task_complete',turn_id:'turn',root_turn_id:'turn',completed_at:11}}];
  await writeFile(transcript,rows.map(r=>JSON.stringify(r)).join('\n')+'\n',{mode:0o600});
  let calls=0;const server=createServer(c=>{c.on('data',()=>{calls++;if(calls===1){c.destroy();return;}c.end(JSON.stringify({status:calls===2?'pending':'finalized',capture:'complete'})+'\n');});});
  try {
    assert.equal(readDesktopTurnOutcome({sessionId:'chat',turnId:'turn',transcriptPath:transcript},root),'completed');
    const work=finishCodexRecording({hook_event_name:'Stop',cwd:root,session_id:'chat',turn_id:'turn',transcript_path:transcript});
    await delay(100);await new Promise<void>(resolve=>server.listen(socket,resolve));const {chmod}=await import('node:fs/promises');await chmod(socket,0o600);
    await work;assert.equal(calls,3);
  } finally {await new Promise<void>(resolve=>server.close(()=>resolve()));if(priorHome===undefined)delete process.env.CODEX_HOME;else process.env.CODEX_HOME=priorHome;if(priorSocket===undefined)delete process.env.AGENTICREPLAY_CODEX_REVIEW_SOCKET;else process.env.AGENTICREPLAY_CODEX_REVIEW_SOCKET=priorSocket;await rm(root,{recursive:true,force:true});}
});
