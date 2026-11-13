import assert from 'node:assert/strict';
import test from 'node:test';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { gzipSync } from 'node:zlib';
import { extractReplayProposal } from '../../src/memory/replay-extract.js';

const hash = (bytes: Buffer | string) => createHash('sha256').update(bytes).digest('hex');

for (const compressed of [false, true]) test(`${compressed ? 'gzip' : 'raw'} duplicate references consume the full 32 MiB budget, including boundary + 1`, async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'replay-budget-'));
  try {
    const directory = path.join(root, '.agenticreplay/runs/run_abcdef');
    const blobs = [Buffer.from(JSON.stringify('a'.repeat(2 * 1024 * 1024 - 2))), Buffer.from('0')];
    for (const bytes of blobs) {
      const file = path.join(directory, 'blobs', hash(bytes).slice(0, 2), hash(bytes));
      await mkdir(path.dirname(file), { recursive: true });
      await writeFile(file + (compressed ? '.gz' : ''), compressed ? gzipSync(bytes) : bytes);
    }
    await writeFile(path.join(directory, 'manifest.json'), JSON.stringify({ schema_version: '0.4.0', run_id: 'run_abcdef', cwd: root }));
    const event = (seq: number, bytes: Buffer) => ({ seq, type: 'user.message', payload: { $blob: `sha256:${hash(bytes)}`, bytes: bytes.length } });
    const events = Array.from({ length: 16 }, (_, i) => event(i, blobs[0]!));
    const input = { cwd: root, traceDirectory: directory, taskId: 'task', sessionId: 'session', workspace: 'repo' };
    await writeFile(path.join(directory, 'events.jsonl'), events.map(e => JSON.stringify(e)).join('\n'));
    assert.equal((await extractReplayProposal(input)).source.traces[0]?.eventsRead, 16);
    events.push(event(16, blobs[1]!));
    await writeFile(path.join(directory, 'events.jsonl'), events.map(e => JSON.stringify(e)).join('\n'));
    await assert.rejects(extractReplayProposal(input), { message: 'replay_blob_budget_exceeded' });
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('raw, mixed, gzip and dual-format blobs produce identical public proposals', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'replay-gzip-'));
  try {
    const directory = path.join(root, '.agenticreplay/runs/run_abcdef');
    const values = [
      JSON.stringify({ messages: [
        { role: 'system', content: 'private system instructions' },
        { role: 'user', content: 'Fix sqlite using TypeScript' },
        { role: 'assistant', content: [{ type: 'reasoning', text: 'private reasoning' }] },
      ] }),
      { command: 'node test.ts' },
      { stdout: 'password=abcdefghijklmnop' },
    ];
    const blobs = values.map(value => Buffer.from(JSON.stringify(value)));
    const files = blobs.map(bytes => path.join(directory, 'blobs', hash(bytes).slice(0, 2), hash(bytes)));
    for (const [i, file] of files.entries()) {
      await mkdir(path.dirname(file), { recursive: true });
      await writeFile(file, blobs[i]!);
    }
    const events = blobs.map((bytes, i) => ({ seq: i + 1,
      type: ['model.request', 'tool.call', 'tool.result'][i],
      attrs: i === 0 ? {} : { name: 'bash', attemptId: 'one', ...(i === 2 ? { permission_decision: 'deny' } : {}) },
      payload: { $blob: `sha256:${hash(bytes)}`, bytes: bytes.length },
    }));
    const eventBytes = events.map(event => JSON.stringify(event)).join('\n') + '\n';
    await writeFile(path.join(directory, 'events.jsonl'), eventBytes);
    await writeFile(path.join(directory, 'manifest.json'), JSON.stringify({ schema_version: '0.4.0', run_id: 'run_abcdef', cwd: root, integrity: { events_sha256: hash(eventBytes) } }));
    const input = { cwd: root, traceDirectory: directory, taskId: 'task', sessionId: 'session', workspace: 'repo' };
    const expected = await extractReplayProposal(input);
    assert.equal(expected.request.text, 'Fix sqlite using TypeScript');
    assert.equal(expected.attempts[0]?.execution, 'denied');
    assert.deepEqual(expected.attempts[0]?.payloadHashes, blobs.slice(1).map(hash));
    assert.doesNotMatch(JSON.stringify(expected), /private system|private reasoning|abcdefghijklmnop/);
    // Every intermediate conversion is a mixed-format run; manifest/events stay untouched.
    for (const [i, file] of files.entries()) {
      await writeFile(file + '.gz', gzipSync(blobs[i]!));
      await rm(file);
      assert.deepEqual(await extractReplayProposal(input), expected);
    }
    for (const [i, file] of files.entries()) {
      await writeFile(file, blobs[i]!);
      await writeFile(file + '.gz', 'invalid gzip must not override raw');
    }
    assert.deepEqual(await extractReplayProposal(input), expected);
    await writeFile(files[0]!, '{}');
    await writeFile(files[0]! + '.gz', gzipSync(blobs[0]!));
    await assert.rejects(extractReplayProposal(input), /replay_blob_integrity/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
