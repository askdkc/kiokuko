import { completeVerification } from '../../scripts/verification-completion.mjs';
import { createHash } from 'node:crypto';
import assert from 'node:assert/strict';
import semver from 'semver';
import { execFile } from 'node:child_process';
import { mkdtemp, mkdir, readFile, realpath, rm } from 'node:fs/promises';
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
let replayServer;
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
    const bytes = await readFile(path.join(runDir, 'blobs', digest.slice(0, 2), digest));
    assert.equal(createHash('sha256').update(bytes).digest('hex'), digest, 'Recorded blob integrity mismatch');
    value = JSON.parse(bytes.toString('utf8'));
  }
  return typeof value === 'string' ? JSON.parse(value) : value;
}

try {
  await mkdir(env.TMPDIR);
  const version = await command(['--version']);
  const declaredRange = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8')).devDependencies?.agenticreplay;
  assert.ok(typeof declaredRange === 'string' && semver.validRange(declaredRange), 'AgenticReplay compatibility range is missing');
  assert.ok(semver.satisfies(version, declaredRange), `AgenticReplay ${version} does not satisfy ${declaredRange}`);
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

  const runDir = recording.runDir;
  assert.equal(await realpath(path.dirname(runDir)),await realpath(path.join(fixture,'.agenticreplay/runs')));
  const manifest = JSON.parse(await readFile(path.join(runDir, 'manifest.json'), 'utf8'));
  assert.equal(manifest.run_id, recording.runId);
  const eventBytes = await readFile(path.join(runDir, 'events.jsonl'));
  assert.match(manifest.integrity?.events_sha256, /^[a-f0-9]{64}$/u);
  assert.equal(createHash('sha256').update(eventBytes).digest('hex'), manifest.integrity.events_sha256, 'Recorded event integrity mismatch');
  const events = eventBytes.toString('utf8').trim().split('\n').map(JSON.parse);
  const captured = events.filter(({ type, attrs }) => type === 'net.request' && attrs.phase === 'body');
  assert.equal(captured.length, 2);
  assert.deepEqual((await payload(runDir, captured[0])).tools, requests[0].tools);
  assert.deepEqual(JSON.parse((await payload(runDir, captured[1])).messages.at(-1).content), result);

  // The recorded origin must be unavailable during exact replay.
  await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  // Current AgenticReplay exposes the captured request/response payloads, but no
  // longer exposes a replay CLI command. Replay those exact captured exchanges
  // against a fresh Kiokuko host while the original provider is closed.
  const exchanges = await Promise.all(captured.map(async requestEvent => {
    const responseEvent = events.find(event => event.type === 'net.response'
      && event.attrs.request_id === requestEvent.attrs.request_id);
    assert.ok(responseEvent?.attrs.response_complete);
    assert.equal(responseEvent.attrs.status, 200);
    return { request: await payload(runDir, requestEvent), response: await payload(runDir, responseEvent) };
  }));
  assert.equal(exchanges.length, 2);
  assert.deepEqual(exchanges[0].request.tools, requests[0].tools);
  assert.equal(exchanges[1].request.model, requests[1].model);
  assert.equal(exchanges[1].request.messages.at(-1).role, 'tool');
  const replayErrors = [];
  let replayCount = 0;
  replayServer = createServer(async (request, response) => {
    try {
      assert.equal(request.url, '/v1/chat/completions');
      assert.equal(request.method, 'POST');
      const exchange = exchanges[replayCount++];
      assert.ok(exchange, 'Unexpected live model request');
      const chunks = [];
      for await (const chunk of request) chunks.push(chunk);
      const observed = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      if (replayCount === 1) {
        const fingerprint = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
        assert.equal(fingerprint(observed), fingerprint(requests[0]), 'Initial model request changed');
      } else {
        const original = requests[1];
        assert.equal(observed.model, original.model);
        assert.deepEqual(observed.tools, original.tools);
        assert.deepEqual(observed.messages.map(message => message.role), original.messages.map(message => message.role));
        const delivered = JSON.parse(observed.messages.at(-1).content);
        assert.equal(delivered.structuredContent.contract.id, 'kiokuko/model-managed');
        assert.match(delivered.structuredContent.text, /# Kiokuko SOUL router/u);
      }
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify(exchange.response));
    } catch (error) {
      replayErrors.push(String(error));
      response.writeHead(500);
      response.end('offline replay mismatch');
    }
  });
  await new Promise((resolve, reject) => {
    replayServer.once('error', reject);
    replayServer.listen(0, '127.0.0.1', resolve);
  });
  const replayUrl = `http://127.0.0.1:${replayServer.address().port}/v1`;
  let replayFailure;
  try {
    await execute(process.execPath, [path.join(root, 'tests/ci/agenticreplay-host.mjs')], {
      cwd: fixture, env: { ...env, OPENAI_BASE_URL: replayUrl }, timeout: 60_000, maxBuffer: 2_000_000,
    });
  } catch (error) { replayFailure = error; }
  assert.deepEqual(replayErrors, []);
  if (replayFailure) throw new Error('Offline replay host failed', { cause: replayFailure });
  assert.equal(replayCount, 2);
  assert.equal(requests.length, 2, 'Original provider received no replay traffic');
  console.log(`AgenticReplay ${version}: real Kiokuko schema/result captured; 2 recorded responses replayed offline with matching request contracts, 0 original-provider replay calls.`);
} finally {
  for (const active of [server, replayServer]) if (active?.listening) {
    active.closeAllConnections();
    await new Promise(resolve => active.close(resolve));
  }
  await rm(fixture, { recursive: true, force: true });
}

completeVerification({});
