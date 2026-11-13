import { completeVerification } from '../../scripts/verification-completion.mjs';
import { extractReplayProposal } from '../../dist/memory/replay-extract.js';
import { readReplayBlob } from '../../dist/memory/replay-blob.js';
import { createHash } from 'node:crypto';
import assert from 'node:assert/strict';
import semver from 'semver';
import { managedAgenticReplay } from '../../scripts/agenticreplay-dependency.mjs';
import { execFile } from 'node:child_process';
import { mkdtemp, mkdir, readFile, realpath, rm, stat, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';

const execute = promisify(execFile);
const root = fileURLToPath(new URL('../../', import.meta.url));
const installedRecorder = managedAgenticReplay(root);
const recorder = process.env.AGENTICREPLAY_BIN ?? installedRecorder.binary;
const fixture = await mkdtemp(path.join(tmpdir(), 'kiokuko-agenticreplay-'));
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
    const bytes = await readReplayBlob(await realpath(runDir), digest, value.bytes, 32 * 1024 * 1024);
    value = JSON.parse(bytes.toString('utf8'));
  }
  return typeof value === 'string' ? JSON.parse(value) : value;
}

// Exercise both newly compressed records and migration of legacy raw blobs.
// Only this disposable recording is rewritten; event references and seals stay intact.
async function verifyCompaction(input, events, recordedProposal) {
  const runDir = await realpath(input.traceDirectory);
  const manifestBytes = await readFile(path.join(runDir, 'manifest.json'));
  const eventBytes = await readFile(path.join(runDir, 'events.jsonl'));
  const compressed = new Map();
  for (const event of events) {
    const envelope = event.payload;
    if (!envelope || typeof envelope !== 'object' || !('$blob' in envelope)) continue;
    const match = /^sha256:([a-f0-9]{64})$/u.exec(envelope.$blob);
    assert.ok(match, 'Recorder emitted an invalid blob reference');
    const digest = match[1];
    const raw = path.join(runDir, 'blobs', digest.slice(0, 2), digest);
    try { await stat(`${raw}.gz`); }
    catch (error) { if (error.code === 'ENOENT') continue; throw error; }
    await assert.rejects(stat(raw), { code: 'ENOENT' }, 'New compressed record must not also contain raw bytes');
    compressed.set(raw, { digest, bytes: envelope.bytes });
  }
  assert.ok(compressed.size > 0, 'New recorder must produce gzip blobs; raw-only recording is not compression coverage');
  assert.ok(events.some(event => ['model.request', 'tool.call', 'tool.result'].includes(event.type)
    && compressed.has(path.join(runDir, 'blobs', event.payload?.$blob?.slice(7, 9) ?? '', event.payload?.$blob?.slice(7) ?? ''))),
  'At least one extracted event must reference a gzip blob');
  for (const [raw, envelope] of compressed) {
    const bytes = await readReplayBlob(runDir, envelope.digest, envelope.bytes, 32 * 1024 * 1024);
    await writeFile(raw, bytes, { flag: 'wx', mode: 0o600 });
    assert.deepEqual(await readFile(raw), bytes);
    await rm(`${raw}.gz`);
  }
  const before = await extractReplayProposal(input);
  assert.deepEqual(before, recordedProposal, 'New gzip recording and legacy raw representation must yield identical proposals');
  await command(['compact', path.basename(runDir)]);
  for (const [raw] of compressed) {
    await assert.rejects(stat(raw), { code: 'ENOENT' }, 'Compact must remove the converted raw blob');
    assert.ok((await stat(`${raw}.gz`)).isFile());
  }
  assert.deepEqual(await readFile(path.join(runDir, 'manifest.json')), manifestBytes, 'Compact changed the manifest');
  assert.deepEqual(await readFile(path.join(runDir, 'events.jsonl')), eventBytes, 'Compact changed event bytes');
  assert.deepEqual(await extractReplayProposal(input), before, 'Compact changed the proposal, references or payload hashes');
  return compressed.size;
}

try {
  await mkdir(env.TMPDIR);
  const version = await command(['--version']);
  assert.ok(semver.valid(version), 'AgenticReplay executable must report a valid version');
  const recorderPath = await realpath(recorder);
  console.log(`AgenticReplay executable: ${recorderPath}; version: ${version}; installed dependency: ${installedRecorder.version}`);
  const supportsCompaction = /agenticreplay compact\b/u.test(await command(['--help']));
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
  const extraction = {
    cwd: fixture, traceDirectory: runDir, workspace: 'smoke', taskId: 'smoke', sessionId: 'smoke',
  };
  const proposal = await extractReplayProposal(extraction);
  if (process.env.KIOKUKO_REQUIRE_REPLAY_GZIP === '1') {
    assert.ok(supportsCompaction, 'Gzip acceptance requires a built recorder with compact; set AGENTICREPLAY_BIN');
  }
  if (supportsCompaction) {
    const compactedBlobs = await verifyCompaction(extraction, events, proposal);
    console.log(`Compression: ${compactedBlobs} recorded gzip blobs migrated from raw; proposals, references, payload hashes and seals unchanged.`);
  } else {
    console.log('Legacy recorder compatibility only: gzip/compact acceptance not verified by this invocation.');
  }
  assert.equal(proposal.request.text, 'Read the Kiokuko SOUL skill.');
  const modelRequests = events.filter(event => event.type === 'model.request');
  assert.equal(modelRequests.length, 2);
  assert.deepEqual(proposal.request.evidenceRefs, [`${recording.runId}:${modelRequests[1].seq}`]);
  assert.equal(proposal.attempts[0]?.tool, 'task_inspect');
  assert.ok(proposal.attempts[0]?.resultRef);

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
