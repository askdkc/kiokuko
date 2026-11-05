import assert from 'node:assert/strict';
import test from 'node:test';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createServer } from 'node:net';
import { chmodSync, mkdirSync, mkdtempSync, realpathSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { setTimeout } from 'node:timers/promises';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { ElicitRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { handleCodexHook } from '../../src/assurance/codex-hooks.js';
import { canonicalContentHash } from '../../src/serialization/validate.js';
import { createKiokukoMcpServer } from '../../src/mcp/server.js';
import { openConnection } from '../../src/db/connection.js';
import { migrateDatabase } from '../../src/db/migrate.js';

for (const scenario of ['explicit', 'service', 'stopped', 'unavailable', 'unsafe', 'cancelled'] as const) test(`desktop replay ${scenario} preserves exact-turn approval and checkpoint completion`, { timeout: 30_000 }, async t => {
  const useService = scenario !== 'explicit';
  const base = realpathSync(mkdtempSync(path.join(tmpdir(), 'kiokuko-desktop-review-')));
  const root = path.join(base, 'repo');
  execFileSync('git', ['init', '-q', root]);
  const codexHome = path.join(base, 'codex');
  const sessions = path.join(codexHome, 'sessions');
  mkdirSync(sessions, { recursive: true });
  const previousHome = process.env.CODEX_HOME;
  const previousSocket = process.env.AGENTICREPLAY_CODEX_REVIEW_SOCKET;
  const previousAttached = process.env.AGENTICREPLAY_RUN_DIR;
  // The suite's nested TMPDIR can exceed the Unix socket path limit on macOS.
  const socketDirectory = mkdtempSync(path.join(realpathSync('/tmp'), 'kk-review-'));
  const socketPath = path.join(socketDirectory, 'review.sock');
  if (useService) {
    delete process.env.AGENTICREPLAY_CODEX_REVIEW_SOCKET;
    delete process.env.AGENTICREPLAY_RUN_DIR;
  } else {
    process.env.AGENTICREPLAY_CODEX_REVIEW_SOCKET = socketPath;
    process.env.AGENTICREPLAY_RUN_DIR = path.join(base, 'not-the-desktop-trace');
  }
  process.env.CODEX_HOME = codexHome;
  t.after(() => {
    if (previousHome === undefined) delete process.env.CODEX_HOME;
    else process.env.CODEX_HOME = previousHome;
    if (previousSocket === undefined) delete process.env.AGENTICREPLAY_CODEX_REVIEW_SOCKET;
    else process.env.AGENTICREPLAY_CODEX_REVIEW_SOCKET = previousSocket;
    if (previousAttached === undefined) delete process.env.AGENTICREPLAY_RUN_DIR;
    else process.env.AGENTICREPLAY_RUN_DIR = previousAttached;
    rmSync(socketDirectory, { recursive: true, force: true });
    rmSync(base, { recursive: true, force: true });
  });

  const databasePath = path.join(base, 'memory.sqlite3');
  const database = openConnection(databasePath);
  let discoveries = 0;
  const server = createKiokukoMcpServer({ databasePath, discoverCodexDockSocket: async cwd => {
    assert.equal(cwd, root);
    discoveries++;
    return scenario === 'stopped' ? undefined : socketPath;
  } });
  const client = new Client({ name: 'desktop-fixture', version: '1' }, { capabilities: { elicitation: { form: {} } } });
  t.after(async () => { await client.close(); await server.close(); database.close(); });
  migrateDatabase(database);
  const sessionId = 'desktop-fixture-chat';
  const turnId = 'desktop-fixture-turn';
  const transcript = path.join(sessions, `rollout-fixture-${sessionId}.jsonl`);
  const identity = canonicalContentHash({ session: sessionId, turn: turnId, agent: 'main', root });
  const requestId = `codex-${identity}`;
  const start = Math.floor(Date.now() / 1000);
  assert.match(JSON.stringify(handleCodexHook(database, {
    hook_event_name: 'UserPromptSubmit', session_id: sessionId, turn_id: turnId, cwd: root, transcript_path: transcript,
  })), new RegExp(requestId));
  const event = (type: string, payload: Record<string, unknown>) => ({ type: 'event_msg', payload: { type, ...payload } });
  const entries = [
    { type: 'session_meta', payload: { id: sessionId, cwd: root, originator: 'codex_work_desktop' } },
    event('task_started', { turn_id: turnId, root_turn_id: turnId, started_at: start }),
    { type: 'turn_context', payload: { turn_id: turnId, cwd: root } },
    event('item_completed', { thread_id: sessionId, turn_id: turnId, item: { type: 'UserMessage', content: [{ type: 'text', text: 'searchable desktopfixture' }] } }),
    event('item_completed', { thread_id: sessionId, turn_id: turnId, item: {
      type: 'CommandExecution', source: 'unified_exec_startup', id: 'fixture-command',
      cwd: root, command: 'echo desktopfixture', status: 'completed', exit_code: 0, aggregated_output: 'excluded output',
    } }),
    event('item_completed', { thread_id: sessionId, turn_id: 'other', item: { type: 'UserMessage', content: [{ type: 'text', text: 'foreign fixture' }] } }),
    event('task_complete', { turn_id: 'other', root_turn_id: 'other', completed_at: start }),
  ];
  const append = (records: unknown[]) => writeFileSync(transcript, records.map(record => JSON.stringify(record) + '\n').join(''), { mode: 0o600, flag: 'a' });
  append(entries);
  const trace = path.join(root, '.agenticreplay', 'runs', 'run_abcdef');
  mkdirSync(trace, { recursive: true });
  const wire = [
    { seq: 0, type: 'run.start', attrs: { source: 'codex-desktop-api', sessionId, turnId } },
    { seq: 1, type: 'model.request', attrs: { request_id: 'wire-request' }, payload: { input: [
      { role: 'user', metadata: { turn_id: 'older' }, content: [{ type: 'input_text', text: 'historical API input' }] },
      { role: 'user', metadata: { turn_id: turnId }, content: [{ type: 'input_text', text: 'searchable desktopfixture from API' }] },
    ] } },
    { seq: 2, type: 'net.request', attrs: { request_id: 'wire-request', headers: {
      'x-codex-turn-metadata': JSON.stringify({ thread_id: sessionId, turn_id: turnId }),
    } } },
    { seq: 3, type: 'net.response', causes: [2], attrs: {
      request_id: 'wire-request', response_complete: true, capture_incomplete: false,
    } },
    { seq: 4, type: 'model.response', attrs: { request_id: 'wire-request' }, payload: 'data: ' + JSON.stringify({
      type: 'response.completed', response: { status: 'completed', output: [
        { type: 'function_call', call_id: 'repository-read', name: 'repositoryRead', arguments: '{"cmd":"git rev-parse --show-toplevel"}' },
      ] },
    }) + '\n\n' },
    { seq: 5, type: 'model.request', attrs: { request_id: 'wire-next' }, payload: { input: [
      { type: 'function_call_output', call_id: 'unrelated-history', output: 'historical tool result' },
      { type: 'function_call_output', call_id: 'repository-read', output: 'maple-ledger-tool-result' },
    ] } },
    { seq: 6, type: 'net.request', attrs: { request_id: 'wire-next', headers: {
      'x-codex-turn-metadata': JSON.stringify({ thread_id: sessionId, turn_id: turnId }),
    } } },
    { seq: 7, type: 'net.response', causes: [6], attrs: { request_id: 'wire-next', response_complete: true, capture_incomplete: false } },
    { seq: 8, type: 'model.response', attrs: { request_id: 'wire-next' }, payload: 'data: ' + JSON.stringify({
      type: 'response.completed', response: { status: 'completed', output: [
        { type: 'reasoning', summary: [{ type: 'summary_text', text: 'private reasoning' }] },
        { type: 'message', role: 'assistant', phase: 'final_answer', content: [{ type: 'output_text', text: 'Repository name is maple-ledger.' }] },
      ] },
    }) + '\n\n' },
    { seq: 9, type: 'run.end' },
  ].map(event => JSON.stringify(event) + '\n').join('');
  writeFileSync(path.join(trace, 'events.jsonl'), wire);
  writeFileSync(path.join(trace, 'manifest.json'), JSON.stringify({
    cwd: root, schema_version: '0.4.0', run_id: 'run_abcdef', adapter: { id: 'codex-desktop-api' },
    capture: { status: 'complete' }, integrity: { events_sha256: createHash('sha256').update(wire).digest('hex') },
  }));
  let sealRequests = 0;
  const recorder = createServer(connection => {
    connection.once('data', bytes => {
      assert.deepEqual(JSON.parse(bytes.toString()), { cwd: root, sessionId, turnId });
      sealRequests++;
      const reply = scenario === 'unavailable' ? { status: 'unavailable' }
        : sealRequests === 1 ? { status: 'pending' } : { status: 'sealed', traceDirectory: trace };
      connection.end(JSON.stringify(reply) + '\n');
    });
  });
  await new Promise<void>((resolve, reject) => {
    recorder.once('error', reject);
    recorder.listen(socketPath, resolve);
  });
  chmodSync(socketPath, 0o600);
  if (scenario === 'unsafe') chmodSync(socketPath, 0o666);
  t.after(() => { recorder.close(); });

  let showReview!: (message: string) => void;
  let approveReview!: () => void;
  const review = new Promise<string>(resolve => { showReview = resolve; });
  const approve = new Promise<void>(resolve => { approveReview = resolve; });
  let prompts = 0;
  client.setRequestHandler(ElicitRequestSchema, async request => {
    prompts++;
    assert.ok('requestedSchema' in request.params);
    assert.deepEqual(Object.keys(request.params.requestedSchema.properties), ['reviewAction', 'comment']);
    showReview(request.params.message);
    await approve;
    return { action: 'accept', content: {} };
  });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  // Code Mode calls MCP directly. No preparation or checkpoint tool hook is emitted.
  const prepared = await client.callTool({ name: 'task_prepare', arguments: {
    requestId: 'code-mode-opaque-id', cwd: root, soulRead: true, task: 'Analyze desktopfixture in the current repository',
    profileHints: { taskType: 'analysis', target: 'desktopfixture', expected: 'Check the repository name', constraints: 'Read only' },
    capabilities: [{ kind: 'skill', name: 'kiokuko-soul' }, { kind: 'skill', name: 'memory-reasoning' }],
  } });
  assert.notEqual(prepared.isError, true, JSON.stringify(prepared.structuredContent));
  const runId = (prepared.structuredContent as { run: { runId: string } }).run.runId;
  const response = await client.callTool({ name: 'memory_checkpoint', arguments: {
    cwd: root, runId, outcome: 'completed', evidence: { tests: [{ runner: 'node', target: 'desktop fixture', outcome: 'passed' }] },
  } });
  assert.equal(response.isError, undefined);
  assert.deepEqual((response.structuredContent as Record<string, unknown> | undefined)?.memoryReview, { status: 'queued', workMayContinue: true });
  const toolResult = (tool: string, argumentsValue: Record<string, unknown>, result: unknown) => event('item_completed', {
    turn_id: turnId, thread_id: sessionId,
    item: { type: 'McpToolCall', server: 'kiokuko', tool, status: 'completed', arguments: argumentsValue, result },
  });
  const stop = () => handleCodexHook(database, {
    hook_event_name: 'Stop', session_id: sessionId, turn_id: turnId, cwd: root, transcript_path: transcript,
  });
  assert.deepEqual(stop(), {});
  assert.equal(database.prepare('SELECT count(*) n FROM codex_desktop_replay_bindings').get()?.n, 0);
  append([
    toolResult('task_prepare', { cwd: root, requestId: 'code-mode-opaque-id' }, prepared),
    toolResult('memory_checkpoint', { cwd: root, runId }, response),
  ]);
  assert.deepEqual(stop(), {});
  await setTimeout(550);
  assert.equal(prompts, 0);
  assert.equal(sealRequests, 0);
  append([
    event('task_complete', { turn_id: turnId, root_turn_id: turnId, completed_at: Math.floor(Date.now() / 1000) }),
    event('item_completed', { thread_id: sessionId, turn_id: turnId, item: { type: 'UserMessage', content: [{ type: 'text', text: 'late fixture' }] } }),
  ]);
  if (scenario === 'cancelled') await server.close();
  if (['stopped', 'unavailable', 'unsafe', 'cancelled'].includes(scenario)) {
    await setTimeout(1100);
    assert.equal(prompts, 0);
    assert.equal(database.prepare('SELECT COUNT(*) AS n FROM entries').get<{ n: number }>()!.n, 0);
    assert.equal(database.prepare('SELECT status FROM ledger_runs WHERE run_id=?').get<{ status: string }>(runId)?.status, 'completed');
    assert.equal(sealRequests, scenario === 'unavailable' ? 1 : 0);
    return;
  }
  const message = await Promise.race([review, setTimeout(15_000, undefined, { ref: false }).then(() => { throw new Error('No desktop review requested'); })]);
  assert.match(message, /searchable desktopfixture from API/);
  assert.ok(message.length < 1400);
  assert.match(message, /Repository name is maple-ledger/);
  assert.match(message, /Tool result excerpt/);
  assert.match(message, /maple-ledger-tool-result/);
  assert.doesNotMatch(message, /"schemaVersion"|"payloadHashes"/);
  assert.doesNotMatch(message, /historical API input|historical tool result|private reasoning|foreign fixture|late fixture|excluded output|echo desktopfixture/);
  assert.equal(sealRequests, 2);
  assert.equal(discoveries, useService ? 1 : 0);
  assert.equal(readdirSync(path.join(root, '.agenticreplay', 'runs')).length, 1);
  const count = () => database.prepare('SELECT COUNT(*) AS n FROM entries').get<{ n: number }>()!.n;
  assert.equal(count(), 0);
  approveReview();
  for (let retry = 0; retry < 50 && count() === 0; retry++) await setTimeout(20);
  assert.equal(count(), 1);
  const context = await client.callTool({ name: 'memory_context', arguments: { cwd: root, query: 'maple-ledger-tool-result' } });
  const { entries: entriesFound } = context.structuredContent as { entries: Array<{ summary: string; sourceEventIds: string[] }> };
  assert.equal(entriesFound.length, 1);
  assert.ok(entriesFound[0]!.sourceEventIds.includes('run_abcdef:8'), 'search must retain the source of the extracted final key points');
  assert.match(entriesFound[0]!.summary, /Repository name is maple-ledger/);
  const saved = JSON.parse(database.prepare('SELECT proposal_json AS body FROM replay_memories').get<{ body: string }>()!.body);
  assert.equal(saved.attempts.length, 1);
  assert.equal(saved.attempts[0].outputExcerpt, 'maple-ledger-tool-result');
  assert.equal(saved.findings[0].basis, 'inferred');
  if (scenario === 'service') {
    await client.close();
    await server.close();
    const resumedServer = createKiokukoMcpServer({ databasePath });
    const resumedClient = new Client({ name: 'desktop-resumed', version: '1' }, { capabilities: { elicitation: { form: {} } } });
    let resumedPrompts = 0;
    resumedClient.setRequestHandler(ElicitRequestSchema, async request => {
      resumedPrompts++;
      assert.match(request.params.message, /searchable desktopfixture from API/);
      assert.doesNotMatch(request.params.message, /historical API input|late fixture/);
      return { action: 'accept', content: { comment: 'test works' } };
    });
    const [resumedClientTransport, resumedServerTransport] = InMemoryTransport.createLinkedPair();
    await resumedServer.connect(resumedServerTransport);
    await resumedClient.connect(resumedClientTransport);
    try {
      const recovered = await resumedClient.callTool({ name: 'memory_review_completed', arguments: {
        runId, cwd: root, traceDirectory: trace,
      } });
      assert.equal((recovered.structuredContent as { status?: string })?.status, 'saved');
      assert.equal(resumedPrompts, 1);
      assert.equal(count(), 1, 'reopened review preserves the original source and deduplicates it');
    } finally {
      await resumedClient.close();
      await resumedServer.close();
    }
  }
});
