import assert from 'node:assert/strict';
import test from 'node:test';
import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { gzipSync } from 'node:zlib';
import { readReplayBlob } from '../../src/memory/replay-blob.js';

const MAX = 2 * 1024 * 1024;
const hash = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');
async function fixture(bytes: Buffer, run: (f: { root: string; directory: string; file: string; digest: string; read: (declared?: number, remaining?: number) => Promise<Buffer> }) => Promise<void>) {
  const root = await fs.mkdtemp(path.join(tmpdir(), 'replay-blob-'));
  try {
    const directory = await fs.realpath(root);
    const digest = hash(bytes), file = path.join(directory, 'blobs', digest.slice(0, 2), digest);
    await fs.mkdir(path.dirname(file), { recursive: true });
    await run({ root, directory, file, digest, read: (declared = bytes.length, remaining = 32 * 1024 * 1024) => readReplayBlob(directory, digest, declared, remaining) });
  } finally { await fs.rm(root, { recursive: true, force: true }); }
}
const rejects = (promise: Promise<unknown>, message: string) => assert.rejects(promise, { message });

test('validates digest and budgets before any file access', async () => {
  const digest = 'a'.repeat(64);
  for (const invalid of ['../outside', 'A'.repeat(64), 'a'.repeat(63)]) {
    await rejects(readReplayBlob('/missing', invalid, 0, MAX), 'replay_blob_invalid');
  }
  for (const invalid of [-1, 0.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1]) {
    await rejects(readReplayBlob('/missing', digest, invalid, MAX), 'replay_blob_invalid');
    await rejects(readReplayBlob('/missing', digest, 0, invalid), 'replay_blob_invalid');
  }
  await rejects(readReplayBlob('/missing', digest, MAX + 1, 32 * MAX), 'replay_source_bound');
  await rejects(readReplayBlob('/missing', digest, 2, 1), 'replay_blob_budget_exceeded');
});

for (const gzip of [false, true]) test(`${gzip ? 'gzip' : 'raw'}: exact 2 MiB and zero-byte limits, length and hash integrity`, async () => {
  for (const bytes of [Buffer.alloc(0), Buffer.alloc(MAX, 97)]) await fixture(bytes, async f => {
    await fs.writeFile(f.file + (gzip ? '.gz' : ''), gzip ? gzipSync(bytes) : bytes);
    assert.deepEqual(await f.read(bytes.length, bytes.length), bytes);
    await rejects(f.read(bytes.length + 1), bytes.length === MAX ? 'replay_source_bound' : 'replay_blob_integrity');
    if (bytes.length) await rejects(f.read(bytes.length - 1), gzip ? 'replay_source_bound' : 'replay_blob_integrity');
  });
  await fixture(Buffer.from('abc'), async f => {
    await fs.writeFile(f.file + (gzip ? '.gz' : ''), gzip ? gzipSync('abd') : 'abd');
    await rejects(f.read(), 'replay_blob_integrity');
  });
});

test('gzip corruption, truncation and trailing garbage have a fixed private error', async () => {
  await fixture(Buffer.from('abc'), async f => {
    const compressed = gzipSync('abc');
    for (const bytes of [Buffer.from('secret invalid gzip'), compressed.subarray(0, -1), Buffer.concat([compressed, Buffer.from('invalid')])]) {
      await fs.writeFile(f.file + '.gz', bytes);
      await rejects(f.read(), 'replay_blob_gzip_invalid');
    }
  });
});

test('stored gzip input has an independent size cap; a small gzip bomb stops at the output cap', async () => {
  await fixture(Buffer.from('abc'), async f => {
    await fs.writeFile(f.file + '.gz', Buffer.alloc(MAX + 64 * 1024 + 1));
    await rejects(f.read(), 'replay_source_bound');
    await fs.writeFile(f.file + '.gz', gzipSync(Buffer.alloc(MAX * 8)));
    await rejects(f.read(), 'replay_source_bound');
    await fs.writeFile(f.file + '.gz', gzipSync('a'));
    await rejects(f.read(0), 'replay_blob_integrity');
    await fs.writeFile(f.file + '.gz', gzipSync('ab'));
    await rejects(f.read(0), 'replay_source_bound');
  });
});

test('concatenated gzip members are checked as one complete bounded payload', async () => {
  await fixture(Buffer.from('abcd'), async f => {
    await fs.writeFile(f.file + '.gz', Buffer.concat([gzipSync('ab'), gzipSync('cd')]));
    assert.equal((await f.read()).toString(), 'abcd');
    await rejects(f.read(3), 'replay_source_bound');
    await fs.writeFile(f.file + '.gz', Buffer.concat([gzipSync('ab'), gzipSync('cd').subarray(0, -1)]));
    await rejects(f.read(), 'replay_blob_gzip_invalid');
  });
});

test('missing files, non-files and out-of-run links cannot bypass validation via gzip', async () => {
  await fixture(Buffer.from('abc'), async f => {
    await assert.rejects(f.read(), { code: 'ENOENT' });
    await fs.mkdir(f.file);
    await fs.writeFile(f.file + '.gz', gzipSync('abc'));
    await rejects(f.read(), 'replay_source_bound');
    await fs.rm(f.file, { recursive: true });
    await fs.rm(f.file + '.gz');
    const outside = path.join(path.dirname(f.directory), path.basename(f.directory) + '-outside');
    await fs.writeFile(outside, 'abc');
    try {
      await fs.symlink(outside, f.file + '.gz');
      await rejects(f.read(), 'replay_scope_mismatch');
      await fs.rm(f.file + '.gz');
      await fs.writeFile(f.file + '.gz', gzipSync('abc'));
      await fs.symlink(outside, f.file);
      await rejects(f.read(), 'replay_scope_mismatch');
    } finally { await fs.rm(outside); }
  });
});

test('raw integrity and size failures do not fall back to a valid gzip', async () => {
  await fixture(Buffer.from('abc'), async f => {
    await fs.writeFile(f.file + '.gz', gzipSync('abc'));
    for (const bytes of [Buffer.from('abd'), Buffer.alloc(MAX + 1)]) {
      await fs.writeFile(f.file, bytes);
      await rejects(f.read(), bytes.length > MAX ? 'replay_source_bound' : 'replay_blob_integrity');
    }
  });
});

for (const stage of ['before-open', 'after-open', 'permission'] as const) test(`raw migration ${stage} is finite and never masks access denial`, async t => {
  await fixture(Buffer.from('abc'), async f => {
    await fs.writeFile(f.file, 'abc');
    await fs.writeFile(f.file + '.gz', gzipSync('abc'));
    const original = fs.open;
    let opens = 0;
    t.mock.method(fs, 'open', async (...args: Parameters<typeof fs.open>) => {
      if (args[0] === f.file) {
        opens++;
        if (stage === 'permission') throw Object.assign(new Error('permission denied'), { code: 'EACCES' });
        if (stage === 'before-open') await fs.rm(f.file);
        const handle = await original(...args);
        if (stage === 'after-open') await fs.rm(f.file);
        return handle;
      }
      return original(...args);
    });
    syncBuiltinESMExports();
    try {
      if (stage === 'permission') await assert.rejects(f.read(), { code: 'EACCES' });
      else assert.equal((await f.read()).toString(), 'abc');
      assert.equal(opens, 1);
    } finally { t.mock.restoreAll(); syncBuiltinESMExports(); }
  });
});
