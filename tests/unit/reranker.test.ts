import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { readRerankerConfig } from '../../src/reranker/config.js';
import { LOCAL_RERANKER_PRESET } from '../../src/reranker/preset.js';
import { LocalRerankerRuntime } from '../../src/reranker/runtime.js';
import { reorderScoredCandidates } from '../../src/reranker/service.js';
import { validatePresetManifest } from '../../src/embedding/model-manifest.js';

const workerPath = fileURLToPath(new URL('../fixtures/reranker-worker-fixture.mjs', import.meta.url));

test('reranker is off by default and validates opt-in configuration', () => {
  assert.equal(readRerankerConfig({}).mode, 'off');
  assert.equal(readRerankerConfig({ KIOKUKO_RERANKER_MODE: 'observe' }).mode, 'observe');
  assert.equal(readRerankerConfig({ KIOKUKO_RERANKER_MODE: 'active' }).mode, 'active');
  assert.throws(() => readRerankerConfig({ KIOKUKO_RERANKER_MODE: 'automatic' }), { code: 'VALIDATION_ERROR' });
  assert.throws(() => readRerankerConfig({
    KIOKUKO_RERANKER_MODE: 'active', KIOKUKO_RERANKER_TIMEOUT_MS: '1',
  }), { code: 'VALIDATION_ERROR' });
});

test('pinned reranker preset has bounded, unique hashed artifacts and bundled configuration', () => {
  validatePresetManifest(LOCAL_RERANKER_PRESET);
  assert.equal(LOCAL_RERANKER_PRESET.revision, '90213ffc6a8e6f051a6331269a0f5526cdd896f6');
  assert.equal(LOCAL_RERANKER_PRESET.dtype, 'q8');
  assert.equal(LOCAL_RERANKER_PRESET.files.some((file) => file.path === 'onnx/model_quantized.onnx'), true);
  assert.equal(new Set(LOCAL_RERANKER_PRESET.files.map((file) => file.path)).size, LOCAL_RERANKER_PRESET.files.length);
});

test('scored candidates reorder only scored slots and keep unscored positions stable', () => {
  const candidates = [{ key: 'a' }, { key: 'b' }, { key: 'c' }, { key: 'd' }];
  const ranked = reorderScoredCandidates(candidates, new Map([['a', 0.1], ['c', 0.9]]));
  assert.deepEqual(ranked.map((item) => item.key), ['c', 'b', 'a', 'd']);
  const bounded = reorderScoredCandidates(candidates, new Map([['a', 0.1], ['c', 0.9]]), 2);
  assert.deepEqual(bounded.map((item) => item.key), ['a', 'b', 'c', 'd']);
});

test('child worker protocol serializes inference and rejects excess queued work', async () => {
  const runtime = new LocalRerankerRuntime({ modelDirectory: 'delay-40', workerPath, timeoutMs: 2_000 });
  try {
    const first = runtime.score([{ query: 'q', document: 'first' }]);
    await delay(10);
    const second = runtime.score([{ query: 'q', document: 'second' }]);
    const third = runtime.score([{ query: 'q', document: 'third' }]);
    await assert.rejects(runtime.score([{ query: 'q', document: 'overflow' }]), { code: 'BACKPRESSURE' });
    assert.deepEqual(await first, [{ score: 5 }]);
    assert.deepEqual(await second, [{ score: 6 }]);
    assert.deepEqual(await third, [{ score: 5 }]);
  } finally {
    await runtime.close();
  }
});

test('child worker rejects a batch whose aggregate payload exceeds its bounded protocol budget', async () => {
  const runtime = new LocalRerankerRuntime({ modelDirectory: 'unused', workerPath });
  const pairs = Array.from({ length: 17 }, () => ({ query: 'q', document: 'x'.repeat(262_143) }));
  assert.throws(() => runtime.score(pairs), { code: 'VALIDATION_ERROR' });
  await runtime.close();
});

test('cancellation and timeout stop child inference; malformed scores are rejected', async () => {
  const cancelled = new LocalRerankerRuntime({ modelDirectory: 'delay-200', workerPath, timeoutMs: 2_000 });
  const controller = new AbortController();
  const pending = cancelled.score([{ query: 'q', document: 'slow' }], { signal: controller.signal });
  await delay(20);
  controller.abort();
  await assert.rejects(pending, { code: 'SERVICE_UNAVAILABLE' });
  await cancelled.close();

  const timed = new LocalRerankerRuntime({ modelDirectory: 'delay-200', workerPath, timeoutMs: 30 });
  await assert.rejects(timed.score([{ query: 'q', document: 'slow' }]), { code: 'SERVICE_UNAVAILABLE' });
  await timed.close();

  const malformed = new LocalRerankerRuntime({ modelDirectory: 'malformed', workerPath, timeoutMs: 2_000 });
  await assert.rejects(malformed.score([{ query: 'q', document: 'bad' }]), { code: 'INTEGRITY_ERROR' });
  await malformed.close();
});
