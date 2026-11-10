import assert from 'node:assert/strict';
import test from 'node:test';
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { mkdtemp, mkdir, realpath, writeFile, appendFile, rm } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';
import path from 'node:path';

test('child terminal proof binds root session, child thread, exact turn and workspace without relaxing parent proof', async () => {
  const { readDesktopSubagentTurnOutcome, readDesktopTurnOutcome } = await import('../../src/assurance/codex-desktop-turn.js');
  const root = await realpath(await mkdtemp('/tmp/kk-child-proof-'));
  const previous = process.env.CODEX_HOME;
  process.env.CODEX_HOME = root;
  await mkdir(path.join(root, 'sessions'));
  const transcriptPath = path.join(root, 'sessions', 'rollout-fixture-child.jsonl');
  const binding = { sessionId: 'child', turnId: 'child-turn', parentSessionId: 'parent', transcriptPath };
  const header = { type: 'session_meta', payload: { id: 'child', session_id: 'parent', parent_thread_id: 'parent',
    cwd: root, originator: 'codex_work_desktop', source: { subagent: { thread_spawn: { parent_thread_id: 'parent', depth: 1 } } } } };
  const start = { type: 'event_msg', payload: { type: 'task_started', turn_id: 'child-turn', root_turn_id: 'root-turn', started_at: 10 } };
  const context = { type: 'turn_context', payload: { turn_id: 'child-turn', cwd: root } };
  const end = { type: 'event_msg', payload: { type: 'task_complete', turn_id: 'child-turn', root_turn_id: 'root-turn', started_at: 10, completed_at: 11 } };
  const write = (rows: unknown[]) => writeFile(transcriptPath, rows.map(row => JSON.stringify(row)).join('\n') + '\n', { mode: 0o600 });
  try {
    await write([header, start, context, end]);
    assert.equal(readDesktopSubagentTurnOutcome(binding, root), 'completed');
    assert.equal(readDesktopTurnOutcome(binding, root), null, 'root contract remains strict');
    const inherited = [start, context, end].map((row, ordinal) => ({ ...row, ordinal,
      payload: { ...row.payload, turn_id: 'inherited-turn' } }));
    const forkHeader = { ...header, payload: { ...header.payload, history_mode: 'paginated',
      forked_from_id: 'parent', subagent_history_start_ordinal: 3 } };
    await write([forkHeader, ...inherited, ...[start, context, end].map((row, index) => ({ ...row, ordinal: index + 3 }))]);
    assert.equal(readDesktopSubagentTurnOutcome({ ...binding, turnId: 'inherited-turn' }, root), null, 'inherited parent history cannot prove child completion');
    assert.equal(readDesktopSubagentTurnOutcome(binding, root), 'completed');
    for (const boundary of [undefined, -1, 1.5, '3']) {
      await write([{ ...forkHeader, payload: { ...forkHeader.payload, subagent_history_start_ordinal: boundary } }, start, context, end]);
      assert.equal(readDesktopSubagentTurnOutcome(binding, root), null, 'fork requires a valid host history boundary');
    }
    await write([forkHeader, start, context, end]);
    assert.equal(readDesktopSubagentTurnOutcome(binding, root), null, 'paginated lifecycle requires host ordinals');
    await write([header, start, context, end]);
    for (const override of [{ sessionId: 'sibling' }, { parentSessionId: 'foreign' }, { turnId: 'root-turn' }, { turnId: 'old-turn' }]) {
      assert.equal(readDesktopSubagentTurnOutcome({ ...binding, ...override }, root), null);
    }
    // Nested agents share the root session, while their immediate parent is another child.
    await write([{ ...header, payload: { ...header.payload, parent_thread_id: 'middle', source: { subagent: { thread_spawn: { parent_thread_id: 'middle', depth: 2 } } } } }, start, context, end]);
    assert.equal(readDesktopSubagentTurnOutcome(binding, root), 'completed');
    const rejected = [
      [header, start, context], [header, start, end], [header, end, start, context],
      [header, start, start, context, end], [header, start, context, end, end],
      [{ ...header, payload: { ...header.payload, id: 'sibling' } }, start, context, end],
      [{ ...header, payload: { ...header.payload, session_id: 'foreign' } }, start, context, end],
      [{ ...header, payload: { ...header.payload, parent_thread_id: 'foreign' } }, start, context, end],
      [{ ...header, payload: { ...header.payload, source: 'cli' } }, start, context, end],
      [{ ...header, payload: { ...header.payload, originator: 'untrusted' } }, start, context, end],
      [header, start, { ...context, payload: { ...context.payload, cwd: '/' } }, end],
      [header, start, context, { ...end, payload: { ...end.payload, root_turn_id: 'different' } }],
      [header, start, context, { ...end, payload: { ...end.payload, turn_id: 'other-turn' } }],
      [header, start, context, { ...end, payload: { ...end.payload, started_at: 9 } }],
      [header, start, context, { ...end, payload: { ...end.payload, completed_at: 9 } }],
      [header, start, context, { ...end, payload: { ...end.payload, type: 'turn_aborted', root_turn_id: 'different' } }],
      [header, start, context, end, { ...end, payload: { ...end.payload, type: 'turn_aborted' } }],
    ];
    for (const [index, rows] of rejected.entries()) {
      await write(rows);
      assert.equal(readDesktopSubagentTurnOutcome(binding, root), null, `rejection case ${index}`);
    }
    await write([header, start, context, end]);
    await appendFile(transcriptPath, '{');
    assert.equal(readDesktopSubagentTurnOutcome(binding, root), null, 'partial host write is retried');
  } finally {
    if (previous === undefined) delete process.env.CODEX_HOME; else process.env.CODEX_HOME = previous;
    await rm(root, { recursive: true, force: true });
  }
});

const lifecycleCases = [
  { outcome: 'completed', resumed: false, subagent: false },
  { outcome: 'completed', resumed: true, subagent: false },
  { outcome: 'interrupted', resumed: false, subagent: false },
  { outcome: 'completed', resumed: false, subagent: true },
  { outcome: 'completed', resumed: true, subagent: true },
  { outcome: 'interrupted', resumed: false, subagent: true },
] as const;

for (const { outcome, resumed, subagent } of lifecycleCases) test(`ordinary ${subagent ? 'subagent ' : ''}${outcome} hook finalizes recording${resumed ? ' from a resumed Desktop transcript' : ''} without a memory run or usable DB`, async () => {
  const root=await realpath(await mkdtemp('/tmp/kk-finish-'));
  const home=path.join(root,'codex'); await mkdir(path.join(home,'sessions'),{recursive:true});
  const transcript=path.join(home,'sessions',`rollout-fixture-chat${resumed ? '_resume-turn' : ''}.jsonl`);
  const rootTurn=subagent?'parent-turn':'turn';
  const rows=[{type:'session_meta',payload:{id:'chat',cwd:root,originator:'Codex Desktop',
    ...(subagent?{session_id:'parent',parent_thread_id:'parent',source:{subagent:{thread_spawn:{parent_thread_id:'parent',depth:1}}}}:{})}},
    {type:'event_msg',payload:{type:'task_started',turn_id:'turn',root_turn_id:rootTurn,started_at:10}},
    {type:'turn_context',payload:{turn_id:'turn',cwd:root}}];
  await writeFile(transcript,rows.map(r=>JSON.stringify(r)).join('\n')+'\n',{mode:0o600});
  const socket=path.join(root,'recorder.sock'); const received: unknown[]=[];
  const server=createServer(client=>{let input='';client.on('data',chunk=>{input+=chunk;if(input.endsWith('\n')){received.push(JSON.parse(input));client.end('{"status":"finalized","capture":"complete"}\n');}});});
  await new Promise<void>(resolve=>server.listen(socket,resolve));
  const {chmod}=await import('node:fs/promises');await chmod(socket,0o600);
  const invoke=()=>new Promise<number|null>((resolve,reject)=>{
    const child=spawn(process.execPath,['--import','tsx','src/bin/kiokuko.ts','codex-hook','--database',path.join(root,'missing.sqlite3'),'--codex-dock-record','--codex-config',path.join(home,'config.toml')],{
      cwd:process.cwd(),env:{...process.env,CODEX_HOME:home,AGENTICREPLAY_CODEX_REVIEW_SOCKET:socket},stdio:['pipe','ignore','ignore']});
    child.on('error',reject);child.on('close',resolve);child.stdin.end(JSON.stringify(subagent
      ? {hook_event_name:'SubagentStop',session_id:'parent',turn_id:'turn',cwd:root,agent_id:'chat',agent_transcript_path:transcript,transcript_path:path.join(home,'sessions','rollout-fixture-parent.jsonl')}
      : {hook_event_name:outcome==='completed'?'Stop':'Interrupt',session_id:'chat',turn_id:'turn',cwd:root,transcript_path:transcript}));
  });
  try {
    const start=Date.now();await invoke();assert.ok(Date.now()-start<3000,'hook must not wait for host completion');
    assert.equal(received.length,0,'Stop/Interrupt alone is not terminal evidence');
    await appendFile(transcript,JSON.stringify({type:'event_msg',payload:{type:outcome==='completed'?'task_complete':'turn_aborted',turn_id:'turn',root_turn_id:rootTurn,completed_at:11}})+'\n');
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
