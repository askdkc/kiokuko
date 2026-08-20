import assert from 'node:assert/strict';
import path from 'node:path';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import test from 'node:test';
import { openConnection } from '../../src/db/connection.js';
import { migrateDatabase } from '../../src/db/migrate.js';
import { AgentGatewayService } from '../../src/gateway/agent-service.js';
import { CheckpointService, FeedbackService } from '../../src/gateway/checkpoint-service.js';

const migrations = path.resolve(import.meta.dirname, '../../migrations');
const now = '2026-08-20T00:00:00.000Z';

async function database() {
  const directory = await mkdtemp(path.join(tmpdir(), 'kiokuko-checkpoint-'));
  const database = openConnection(path.join(directory, 'data.sqlite3'));
  migrateDatabase(database, migrations);
  return database;
}

function open(service: AgentGatewayService, workspace: string, ready = true) {
  return service.openRun({
    idempotencyKey: `open-${workspace}`,
    request: {
      apiVersion: '1', workspace,
      client: { kind: 'checkpoint-test' },
      task: { title: 'Checkpoint task', query: 'Checkpoint task', profileHints: ready ? { taskType: 'build', target: 'src/app.ts', expected: 'tests pass' } : { taskType: 'build' } },
      captureProfile: 'standard',
      coverage: { run: 'complete', tool: 'complete', command: 'complete', file: 'complete', approval: 'complete' },
      metadata: {},
    },
  });
}

test('checkpoint appends, projects task profile revisions, and replays canonically', async () => {
  const db = await database();
  const gateway = new AgentGatewayService(db, { now: () => now });
  const opened = open(gateway, 'checkpoint-ready');
  const service = new CheckpointService(db, () => now);
  const request = {
    apiVersion: '1',
    taskProfileRevision: { target: 'src/revised.ts' },
    currentGoal: 'make tests pass',
    characterBudget: 9000,
  };
  const first = service.checkpoint({ runId: opened.runId, idempotencyKey: 'checkpoint-1', request });
  const replay = service.checkpoint({ runId: opened.runId, idempotencyKey: 'checkpoint-1', request });
  assert.deepEqual(replay, first);
  assert.equal(first.acceptedThrough, 5);
  assert.equal(first.taskProfile.target, 'src/revised.ts');
  assert.equal(first.taskProfile.source, 'akinator+ledger-revisions');
  assert.equal(first.projection.taskProfile.target, 'src/revised.ts');
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM ledger_events WHERE run_id = ?').get<{ count: number }>(opened.runId)?.count, 5);
  assert.throws(() => service.checkpoint({ runId: opened.runId, idempotencyKey: 'checkpoint-1', request: { apiVersion: '1', currentStep: 'different' } }), (error: unknown) => (error as { code?: string }).code === 'CONFLICT');
});

test('checkpoint rejects intake runs before appending work events', async () => {
  const db = await database();
  const gateway = new AgentGatewayService(db, { now: () => now });
  const opened = open(gateway, 'checkpoint-intake', false);
  const service = new CheckpointService(db, () => now);
  assert.throws(() => service.checkpoint({ runId: opened.runId, idempotencyKey: 'checkpoint-intake-1', request: { apiVersion: '1', currentStep: 'blocked' } }), (error: unknown) => (error as { code?: string }).code === 'CONFLICT');
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM ledger_events WHERE run_id = ?').get<{ count: number }>(opened.runId)?.count, 1);
});

test('feedback service composes run feedback with durable idempotency without changing the profile', async () => {
  const db = await database();
  const gateway = new AgentGatewayService(db, { now: () => now });
  const opened = open(gateway, 'feedback-service');
  const service = new FeedbackService(db, () => now);
  const beforeEvents = db.prepare('SELECT COUNT(*) AS count FROM ledger_events WHERE run_id = ?').get<{ count: number }>(opened.runId)?.count;
  const request = {
    apiVersion: '1',
    category: 'run',
    feedbackId: 'feedback-service-1',
    outcome: 'completed',
    rating: 5,
  };
  const first = service.feedback({ runId: opened.runId, idempotencyKey: 'feedback-service-key', request });
  const replay = service.feedback({ runId: opened.runId, idempotencyKey: 'feedback-service-key', request });
  assert.deepEqual(replay, first);
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM run_feedback').get<{ count: number }>()?.count, 1);
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM ledger_events WHERE run_id = ?').get<{ count: number }>(opened.runId)?.count, beforeEvents);
});
