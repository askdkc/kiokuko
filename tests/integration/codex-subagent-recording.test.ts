import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { appendFile, mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { pathToFileURL } from 'node:url';
import test from 'node:test';

// Hook contract: https://learn.chatgpt.com/docs/hooks#subagentstop
// Host producer: openai/codex c875667, core/src/hook_runtime.rs run_turn_stop_hooks.
// The root session and child turn come from the hook; child identity and ancestry
// are corroborated by the child's session_meta (including forked/nested threads).
test('built hook finalizes only the proven child through the locked recorder and real Unix socket', async () => {
  const recorderModule = pathToFileURL(path.resolve('node_modules/agenticreplay/packages/cli/dist/codex-turn-capture.js')).href;
  const { openCodexWorktreeCapture } = await import(recorderModule);
  const root = await realpath(await mkdtemp('/tmp/kk-child-record-'));
  const home = path.join(root, 'codex');
  const sessions = path.join(home, 'sessions');
  const runs = path.join(root, 'runs');
  const socket = path.join(root, 'recorder.sock');
  await mkdir(sessions, { recursive: true });
  await mkdir(runs);
  let recorder = await openCodexWorktreeCapture(socket, new Map([[root, runs]]));
  const transcript = (id: string) => path.join(sessions, `rollout-fixture-${id}.jsonl`);
  const invoke = (id: string, direct = false) => new Promise<void>((resolve, reject) => {
    const child = spawn(process.execPath, ['dist/bin/kiokuko.js', 'codex-hook', '--database', path.join(root, 'missing.sqlite3'),
      direct ? '--finish-recording' : '--codex-dock-record'], {
      env: { ...process.env, CODEX_HOME: home, AGENTICREPLAY_CODEX_REVIEW_SOCKET: socket },
      stdio: ['pipe', 'ignore', 'pipe'],
    });
    let stderr = '';
    child.stderr.on('data', chunk => { stderr += chunk; });
    child.on('error', reject);
    child.on('close', code => code === 0 ? resolve() : reject(new Error(`hook exit ${code}: ${stderr}`)));
    child.stdin.end(JSON.stringify({ hook_event_name: id === 'parent' ? 'Stop' : 'SubagentStop',
      cwd: root, session_id: 'parent', turn_id: `${id}-turn`, transcript_path: transcript('parent'),
      ...(id === 'parent' ? {} : { agent_id: id, agent_transcript_path: transcript(id) }) }));
  });
  const end = (id: string) => appendFile(transcript(id), JSON.stringify({ type: 'event_msg', ordinal: id === 'parent' ? 2 : 5, payload: {
    type: 'task_complete', turn_id: `${id}-turn`, root_turn_id: 'parent-turn', started_at: 10, completed_at: 11,
  } }) + '\n');
  async function recordings() {
    const records = new Map<string, { directory: string; ends: number }>();
    for (const name of await readdir(runs)) {
      const directory = path.join(runs, name);
      let text: string;
      try { text = await readFile(path.join(directory, 'events.jsonl'), 'utf8'); }
      catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue; throw error; }
      const rows = text.trim().split('\n').filter(Boolean).map(line => JSON.parse(line));
      const start = rows.find(row => row.type === 'run.start');
      if (start) records.set(start.attrs.sessionId, { directory, ends: rows.filter(row => row.type === 'run.end').length });
    }
    return records;
  }
  async function waitForEnds(expected: number[]) {
    const deadline = Date.now() + 8000;
    let actual: Array<number | undefined> = [];
    do {
      const records = await recordings();
      actual = ['parent', 'child-a', 'child-b'].map(id => records.get(id)?.ends);
      if (JSON.stringify(actual) === JSON.stringify(expected)) return;
      await delay(50);
    } while (Date.now() < deadline);
    assert.deepEqual(actual, expected);
  }
  try {
    for (const id of ['parent', 'child-a', 'child-b']) {
      const rows = [
        { type: 'session_meta', payload: { id, cwd: root, originator: 'codex_work_desktop', session_id: 'parent',
          ...(id === 'parent' ? {} : { history_mode: 'paginated', forked_from_id: 'parent', subagent_history_start_ordinal: 3,
            parent_thread_id: 'parent', source: { subagent: { thread_spawn: { parent_thread_id: 'parent', depth: 1 } } } }) } },
        ...(id === 'parent' ? [] : [
          { type: 'event_msg', ordinal: 0, payload: { type: 'task_started', turn_id: 'inherited-turn', root_turn_id: 'inherited-turn', started_at: 1 } },
          { type: 'turn_context', ordinal: 1, payload: { turn_id: 'inherited-turn', cwd: root } },
          { type: 'event_msg', ordinal: 2, payload: { type: 'task_complete', turn_id: 'inherited-turn', root_turn_id: 'inherited-turn', completed_at: 2 } },
        ]),
        { type: 'event_msg', ordinal: id === 'parent' ? 0 : 3, payload: { type: 'task_started', turn_id: `${id}-turn`, root_turn_id: 'parent-turn', started_at: 10 } },
        { type: 'turn_context', ordinal: id === 'parent' ? 1 : 4, payload: { turn_id: `${id}-turn`, cwd: root } },
      ];
      await writeFile(transcript(id), rows.map(row => JSON.stringify(row)).join('\n') + '\n', { mode: 0o600 });
      const request = { requestId: id, method: 'POST', path: '/backend-api/codex/responses', host: 'fixture.invalid', port: 443,
        requestStartedAt: Date.now(), requestHeaders: { 'thread-id': id,
          'x-codex-turn-metadata': JSON.stringify({ thread_id: id, turn_id: `${id}-turn`, workspaces: { [root]: {} } }) } };
      recorder.start(request);
      recorder.model({ requestId: id, dialect: 'codex', path: request.path, status: 200, streamed: false,
        rawRequest: '{}', rawResponse: '{}', canonicalRequest: { model: 'fixture', messages: [] },
        canonicalResponse: { model: 'fixture', content: [], stop_reason: 'end_turn', usage: { input_tokens: 0, output_tokens: 0 } } });
      recorder.finish({ ...request, modelDialect: 'codex', status: 200, responseHeaders: {}, requestBody: Buffer.from('{}'), responseBody: Buffer.from('{}'),
        requestBytes: 2, responseBytes: 2, requestTruncated: false, responseTruncated: false, responseComplete: true, durationMs: 1 });
    }
    await waitForEnds([0, 0, 0]);
    await invoke('child-a'); // Host terminal evidence is appended only after the hook returns.
    await delay(300);
    await waitForEnds([0, 0, 0]);
    await end('child-a');
    await waitForEnds([0, 1, 0]);
    await Promise.all([invoke('child-a', true), invoke('child-a', true)]);
    await waitForEnds([0, 1, 0]);
    await end('parent');
    await invoke('parent', true);
    await waitForEnds([1, 1, 0]);
    await recorder.close();
    recorder = await openCodexWorktreeCapture(socket, new Map([[root, runs]]));
    await waitForEnds([1, 1, 0]); // Restart must not invent completion of the other child.
    await end('child-b');
    await invoke('child-b', true);
    await waitForEnds([1, 1, 1]);
    await recorder.close();
    recorder = undefined;
    for (const [id, record] of await recordings()) {
      const bytes = await readFile(path.join(record.directory, 'events.jsonl'));
      const manifest = JSON.parse(await readFile(path.join(record.directory, 'manifest.json'), 'utf8'));
      assert.equal(record.ends, 1);
      assert.equal(manifest.integrity.events_sha256, createHash('sha256').update(bytes).digest('hex'));
      assert.equal(manifest.capture.status, id === 'child-b' ? 'incomplete' : 'complete');
    }
  } finally {
    await recorder?.close();
    await rm(root, { recursive: true, force: true });
  }
});
