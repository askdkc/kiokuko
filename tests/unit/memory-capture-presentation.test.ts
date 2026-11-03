import assert from 'node:assert/strict';
import test from 'node:test';
import { memoryCaptureReviewMessage, type MemoryCaptureProposal } from '../../src/mcp/memory-capture-presentation.js';

const memory: MemoryCaptureProposal['memories'][number] = {
  kind: 'lesson', title: 'Match the CI revision',
  body: 'Check against the same dependency revision as CI. Local checks passed; remote CI has not been rerun.',
  summary: 'Avoid a misleading local success when CI uses a different revision.',
  scope: 'project', subjects: ['ci'], basis: 'observed_result', generalCommunication: false,
};

test('project review preserves qualifications, applicability and correction identities without raw JSON', () => {
  const message = memoryCaptureReviewMessage({ operationId: 'private-operation-id', memories: [{
    ...memory, basis: 'user_correction', replaces: { entryId: 'existing-memory', expectedRevision: 2 },
    applicability: { branches: ['main'] }, signals: { paths: ['src/compiler.ts'] },
  }] });
  assert.ok(message);
  assert.ok(message.includes(memory.body));
  assert.ok(message.includes(memory.summary!));
  assert.match(message, /Use in: This project/u);
  assert.match(message, /Based on: Your correction/u);
  assert.match(message, /Only applies to: branches: main/u);
  assert.match(message, /Find this when matching: paths: src\/compiler.ts/u);
  assert.match(message, /Replaces existing memory: entry id: existing-memory; expected revision: 2/u);
  assert.doesNotMatch(message, /private-operation-id|generalCommunication|"memories"|SHA-256/u);
});

test('long metadata and a many-item batch cannot hide behind short bodies', () => {
  assert.equal(memoryCaptureReviewMessage({ operationId: 'long-metadata', memories: [{
    ...memory, signals: { paths: Array.from({ length: 30 }, (_, i) => `src/long-path-${i}/compiler-implementation.ts`) },
  }] }), undefined);
  assert.equal(memoryCaptureReviewMessage({ operationId: 'many-items', memories: Array.from({ length: 5 }, () => memory) }), undefined);
});
