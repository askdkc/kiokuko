import assert from 'node:assert/strict';
import test from 'node:test';
import {
  memoryCheckpointInputSchema,
  memoryCheckpointVariantsSchema,
  runBoundCheckpointSchema,
  standaloneMemoryCheckpointSchema,
} from '../../src/memory/checkpoint-contract.js';

const memory = {
  kind: 'lesson' as const,
  title: 'Checkpoint contract',
  body: 'Use the explicit checkpoint contract.',
};

test('checkpoint schemas accept each content lane and standalone memory', () => {
  assert.equal(runBoundCheckpointSchema.safeParse({
    runId: 'run-memory',
    outcome: 'completed',
    memories: [memory],
  }).success, true);
  assert.equal(runBoundCheckpointSchema.safeParse({
    runId: 'run-evidence',
    outcome: 'failed',
    evidence: { tests: [{ runner: 'node --test', outcome: 'failed' }] },
  }).success, true);
  assert.equal(runBoundCheckpointSchema.safeParse({
    runId: 'run-feedback',
    deliveryId: 'delivery-1',
    outcome: 'completed',
    feedback: [{ entryId: 'entry-1', entryRevision: 1, verdict: 'helpful' }],
  }).success, true);
  assert.equal(standaloneMemoryCheckpointSchema.safeParse({ memories: [memory] }).success, true);
  assert.equal(memoryCheckpointVariantsSchema.safeParse({ memories: [memory] }).success, true);
});

test('checkpoint schemas reject empty lanes and cross-variant fields', () => {
  assert.equal(runBoundCheckpointSchema.safeParse({ runId: 'run-1', outcome: 'completed' }).success, false);
  assert.equal(runBoundCheckpointSchema.safeParse({ runId: 'run-1', memories: [memory] }).success, false);
  assert.equal(runBoundCheckpointSchema.safeParse({
    runId: 'run-1',
    outcome: 'completed',
    evidence: {},
  }).success, false);
  assert.equal(runBoundCheckpointSchema.safeParse({
    runId: 'run-1',
    outcome: 'completed',
    feedback: [{ entryId: 'entry-1', entryRevision: 1, verdict: 'helpful' }],
  }).success, false);
  assert.equal(memoryCheckpointInputSchema.safeParse({
    memories: [memory],
    outcome: 'completed',
  }).success, false);
  assert.equal(memoryCheckpointInputSchema.safeParse({
    memories: [memory],
    evidence: { tests: [{ runner: 'node --test', outcome: 'passed' }] },
  }).success, false);
  assert.equal(memoryCheckpointInputSchema.safeParse({
    runId: 'run-1',
    outcome: 'completed',
    evidence: { checks: [] },
  }).success, false);
});
