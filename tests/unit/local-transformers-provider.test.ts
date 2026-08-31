import assert from 'node:assert/strict';
import test from 'node:test';
import { LOCAL_SMALL_PRESET } from '../../src/embedding/presets/local-small.js';
import { createLocalEmbeddingProfile } from '../../src/embedding/profile.js';
import { LocalTransformersEmbeddingProvider } from '../../src/embedding/local-transformers-provider.js';

const profile = createLocalEmbeddingProfile(LOCAL_SMALL_PRESET).identity;

function vector(value: number): Float32Array {
  const result = new Float32Array(384);
  result[0] = value;
  result[1] = 1;
  return result;
}

test('loads the local model lazily, validates dimensions, and disposes once', async () => {
  let loads = 0;
  let disposes = 0;
  const provider = new LocalTransformersEmbeddingProvider({
    profile,
    modelDirectory: '/verified/model-root',
    loader: {
      load: async () => {
        loads += 1;
        return { embed: async (inputs) => inputs.map(() => vector(1)), dispose: () => { disposes += 1; } };
      },
    },
  });
  const first = await provider.embed(['passage: one']);
  const second = await provider.embed(['query: two']);
  assert.equal(loads, 1);
  assert.equal(first[0]?.length, 384);
  assert.equal(second[0]?.length, 384);
  await provider.close();
  await provider.close();
  assert.equal(disposes, 1);
});

test('rejects invalid input and malformed model output', async () => {
  const bad = new LocalTransformersEmbeddingProvider({
    profile,
    modelDirectory: '/verified/model-root',
    loader: { load: async () => ({ embed: async () => [new Float32Array(3)] }) },
  });
  await assert.rejects(bad.embed(['query: invalid output']), { code: 'VALIDATION_ERROR' });
  await assert.rejects(bad.embed(['bad\u0000input']), { code: 'VALIDATION_ERROR' });
});
