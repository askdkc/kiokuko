import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';

const execute = promisify(execFile);
const root = fileURLToPath(new URL('../../', import.meta.url));
const fixture = await mkdtemp(path.join(tmpdir(), 'kiokuko-agenticreplay-'));
const recorder = process.env.AGENTICREPLAY_BIN ?? 'agenticreplay';
const requests = [];
const server = createServer(async (request, response) => {
  try {
    assert.equal(request.url, '/v1/chat/completions');
    const chunks = [];
    let bytes = 0;
    for await (const chunk of request) {
      bytes += chunk.length;
      assert.ok(bytes < 1_000_000, 'Fixture request exceeds limit');
      chunks.push(chunk);
    }
    requests.push(JSON.parse(Buffer.concat(chunks).toString('utf8')));
    const message = requests.length === 1
      ? { role: 'assistant', content: null, tool_calls: [{ id: 'call_skill', type: 'function',
        function: { name: 'task_inspect', arguments: JSON.stringify({ cwd: fixture, operation: 'skill' }) } }] }
      : { role: 'assistant', content: 'Kiokuko skill read.' };
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ id: 'completion_smoke', object: 'chat.completion',
      model: 'kiokuko-smoke', choices: [{ index: 0, message,
        finish_reason: requests.length === 1 ? 'tool_calls' : 'stop' }],
      usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } }));
  } catch (error) {
    response.writeHead(500);
    response.end(String(error));
  }
});

// Do not forward credentials, proxies or personal gateway settings into the fixture.
const env = { PATH: process.env.PATH, NO_COLOR: '1',
  XDG_CONFIG_HOME: path.join(fixture, 'config'), TMPDIR: path.join(fixture, 'tmp') };
async function command(args) {
  try {
    const { stdout } = await execute(recorder, args, { cwd: fixture, env,
      timeout: 60_000, maxBuffer: 2_000_000 });
    return stdout.trim();
  } catch (error) {
    throw new Error(`AgenticReplay ${args[0]} failed: ${error.stdout ?? ''}${error.stderr ?? error.message}`, { cause: error });
  }
}

async function payload(runDir, event) {
  let value = event.payload;
  if (value && typeof value === 'object' && '$blob' in value) {
    const digest = value.$blob.replace(/^sha256:/u, '');
    assert.match(digest, /^[a-f0-9]{64}$/u);
    value = JSON.parse(await readFile(path.join(runDir, 'blobs', digest.slice(0, 2), digest), 'utf8'));
  }
  return typeof value === 'string' ? JSON.parse(value) : value;
}

try {
  await mkdir(env.TMPDIR);
  const version = await command(['--version']);
  assert.equal(version, '0.1.2', 'This compatibility check targets AgenticReplay 0.1.2');
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const upstream = `http://127.0.0.1:${server.address().port}`;
  const recording = JSON.parse(await command(['record', 'node', '--upstream-openai', upstream,
    '--no-fs', '--no-shell', '--no-agent-spans', '--json', '--', process.execPath,
    path.join(root, 'tests/ci/agenticreplay-host.mjs')]));
  assert.equal(recording.exitCode, 0);
  assert.match(recording.runId, /^run_[a-f0-9]+$/u);
  assert.equal(requests.length, 2);
  const parameters = requests[0].tools[0].function.parameters;
  assert.equal(parameters.type, 'object');
  assert.ok(parameters.properties.operation);
  const result = JSON.parse(requests[1].messages.at(-1).content);
  assert.equal(result.structuredContent.contract.id, 'kiokuko/model-managed');
  assert.match(result.structuredContent.text, /# Kiokuko SOUL router/u);

  const runDir = path.join(fixture, '.agenticreplay/runs', recording.runId);
  const events = (await readFile(path.join(runDir, 'events.jsonl'), 'utf8')).trim().split('\n').map(JSON.parse);
  const captured = events.filter(({ type, attrs }) => type === 'net.request' && attrs.phase === 'body');
  assert.equal(captured.length, 2);
  assert.deepEqual((await payload(runDir, captured[0])).tools, requests[0].tools);
  assert.deepEqual(JSON.parse((await payload(runDir, captured[1])).messages.at(-1).content), result);

  // The recorded origin must be unavailable during exact replay.
  await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  const replay = JSON.parse(await command(['replay', recording.runId, '--in-place', '--no-fs',
    '--no-trace', '--quiet', '--json']));
  assert.equal(replay.mode, 'exact');
  assert.equal(replay.exitCode, 0);
  assert.equal(replay.canonicalExact, 2);
  for (const key of ['divergences', 'unmatched', 'liveCalls']) assert.equal(replay[key], 0, key);
  console.log(`AgenticReplay ${version}: real Kiokuko schema/result captured; 2 canonical exact offline matches, 0 live calls.`);
} finally {
  if (server.listening) {
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
  }
  await rm(fixture, { recursive: true, force: true });
}
