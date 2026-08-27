import assert from 'node:assert/strict';
import path from 'node:path';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import test from 'node:test';
import { openConnection } from '../../src/db/connection.js';
import { migrateDatabase } from '../../src/db/migrate.js';
import { AgentGatewayService } from '../../src/gateway/agent-service.js';
import { CheckpointService, FeedbackService } from '../../src/gateway/checkpoint-service.js';
import { evaluateProfile } from '../../src/akinator/domain.js';
import { canonicalContentHash, canonicalJson } from '../../src/serialization/validate.js';

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
  const stored = db.prepare(
    'SELECT response_json AS responseJson FROM gateway_idempotency WHERE scope = ?',
  ).get<{ responseJson: string }>(`agent.checkpoint.${opened.runId}`);
  assert.ok(stored);
  const persisted = JSON.parse(stored.responseJson) as Record<string, unknown>;
  assert.ok(Object.hasOwn(persisted, 'recommendations'));
  assert.equal(Object.hasOwn(persisted, 'preliminaryRecommendations'), false);
  assert.deepEqual(persisted.recommendations, first.recommendations);
  assert.equal(persisted.nudge, null);
  assert.equal(persisted.context, null);
  assert.equal(persisted.untrusted, true);
  const replay = service.checkpoint({ runId: opened.runId, idempotencyKey: 'checkpoint-1', request });
  assert.deepEqual(replay, first);
  assert.equal(first.acceptedThrough, 5);
  assert.equal(first.intakeStatus, 'ready');
  assert.equal(first.taskProfile.target, 'src/revised.ts');
  assert.equal(first.taskProfile.source, 'akinator+ledger-revisions');
  assert.equal(first.projection.taskProfile.target, 'src/revised.ts');
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM ledger_events WHERE run_id = ?').get<{ count: number }>(opened.runId)?.count, 5);
  assert.throws(() => service.checkpoint({ runId: opened.runId, idempotencyKey: 'checkpoint-1', request: { apiVersion: '1', currentStep: 'different' } }), (error: unknown) => (error as { code?: string }).code === 'CONFLICT');
});

test('replays pre-refactor checkpoint idempotency records through the legacy service', async () => {
  const db = await database();
  try {
    const gateway = new AgentGatewayService(db, { now: () => now });
    const opened = open(gateway, 'checkpoint-legacy-replay');
    const service = new CheckpointService(db, () => now);
    const request = {
      apiVersion: '1',
      currentStep: 'continue bounded work',
      characterBudget: 9000,
    };
    const first = service.checkpoint({
      runId: opened.runId,
      idempotencyKey: 'checkpoint-legacy-replay-1',
      request,
    });
    const stored = db.prepare(
      'SELECT response_json AS responseJson FROM gateway_idempotency WHERE scope = ?',
    ).get<{ responseJson: string }>(`agent.checkpoint.${opened.runId}`);
    assert.ok(stored);
    const legacyResponse: Record<string, unknown> = {
      ...first,
      recommendations: first.recommendations,
      nudge: null,
      context: null,
      untrusted: true,
    };
    delete legacyResponse.preliminaryRecommendations;
    db.prepare('UPDATE gateway_idempotency SET response_json = ? WHERE scope = ?').run(
      canonicalJson(legacyResponse),
      `agent.checkpoint.${opened.runId}`,
    );

    const replay = service.checkpoint({
      runId: opened.runId,
      idempotencyKey: 'checkpoint-legacy-replay-1',
      request,
    });
    assert.deepEqual(replay, first);
    assert.equal(
      db.prepare('SELECT COUNT(*) AS count FROM ledger_events WHERE run_id = ?').get<{ count: number }>(opened.runId)?.count,
      first.acceptedThrough,
    );
  } finally {
    db.close();
  }
});

test('checkpoint rejects intake runs before appending work events', async () => {
  const db = await database();
  const gateway = new AgentGatewayService(db, { now: () => now });
  const opened = open(gateway, 'checkpoint-intake', false);
  const service = new CheckpointService(db, () => now);
  assert.throws(() => service.checkpoint({ runId: opened.runId, idempotencyKey: 'checkpoint-intake-1', request: { apiVersion: '1', currentStep: 'blocked' } }), (error: unknown) => (error as { code?: string }).code === 'CONFLICT');
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM ledger_events WHERE run_id = ?').get<{ count: number }>(opened.runId)?.count, 1);
});

test('checkpoint reports the authoritative exhausted intake status instead of inferring ready from the profile', async () => {
  const db = await database();
  const gateway = new AgentGatewayService(db, { now: () => now });
  const opened = open(gateway, 'checkpoint-exhausted-status');
  const exhaustedProfile = {
    taskType: 'build' as const,
    target: 'src/app.ts',
    expected: null,
    constraints: null,
  };
  const exhausted = evaluateProfile(exhaustedProfile, 3);
  assert.equal(exhausted.status, 'exhausted');
  db.prepare(`
    UPDATE akinator_sessions
       SET profile_json = ?, status = 'exhausted', question_count = 3, updated_at = ?
     WHERE id = ?
  `).run(canonicalJson(exhaustedProfile), now, opened.intakeSessionId);
  db.prepare(`
    UPDATE run_intakes
       SET initial_profile_hash = ?, recommended_tags_json = ?
     WHERE run_id = ?
  `).run(
    canonicalContentHash(exhaustedProfile),
    canonicalJson(exhausted.recommendedTags),
    opened.runId,
  );

  const service = new CheckpointService(db, () => now);
  const response = service.checkpoint({
    runId: opened.runId,
    idempotencyKey: 'checkpoint-exhausted-status-1',
    request: { apiVersion: '1', currentStep: 'continue bounded work' },
  });

  assert.equal(response.intakeStatus, 'exhausted');
  assert.equal(response.projection.intakeIncomplete, true);
  assert.deepEqual(response.projection.missingProfileFields, ['expected']);
});

test('checkpoint validates authoritative intake and the full event hash chain before any mutation', async () => {
  for (const corruption of ['intake-profile-hash', 'event-hash-chain'] as const) {
    const db = await database();
    try {
      const gateway = new AgentGatewayService(db, { now: () => now });
      const opened = open(gateway, `checkpoint-preflight-${corruption}`);
      const service = new CheckpointService(db, () => now);
      if (corruption === 'intake-profile-hash') {
        db.prepare('UPDATE run_intakes SET initial_profile_hash = ? WHERE run_id = ?')
          .run('f'.repeat(64), opened.runId);
      } else {
        service.checkpoint({
          runId: opened.runId,
          idempotencyKey: 'checkpoint-preflight-seed-revision',
          request: { apiVersion: '1', taskProfileRevision: { target: 'src/seed.ts' } },
        });
        const revised = db.prepare(`
          SELECT event_id AS eventId, payload_json AS payloadJson
            FROM ledger_events
           WHERE run_id = ? AND event_type = 'task_profile.revised'
        `).get<{ eventId: string; payloadJson: string }>(opened.runId);
        assert.ok(revised);
        const payload = JSON.parse(revised.payloadJson) as { profile: Record<string, unknown> };
        db.prepare('UPDATE ledger_events SET payload_json = ? WHERE event_id = ?').run(
          canonicalJson({ ...payload, profile: { ...payload.profile, target: 'src/tampered.ts' } }),
          revised.eventId,
        );
      }

      const snapshot = {
        run: db.prepare('SELECT last_sequence, updated_at FROM ledger_runs WHERE run_id = ?').get(opened.runId),
        events: db.prepare('SELECT * FROM ledger_events WHERE run_id = ? ORDER BY sequence').all(opened.runId),
        idempotency: db.prepare('SELECT * FROM gateway_idempotency ORDER BY scope, key_hash').all(),
        feedback: db.prepare('SELECT * FROM context_feedback ORDER BY feedback_id').all(),
      };

      assert.throws(
        () => service.checkpoint({
          runId: opened.runId,
          idempotencyKey: `checkpoint-preflight-${corruption}`,
          request: { apiVersion: '1', currentStep: 'must not persist' },
        }),
        (error: unknown) => error instanceof Error
          && 'code' in error
          && error.code === 'INTEGRITY_ERROR'
          && error.message === (corruption === 'intake-profile-hash'
            ? 'Context run intake link does not match its session state'
            : 'Stored context ledger hash chain is invalid'),
      );

      assert.deepEqual(
        db.prepare('SELECT last_sequence, updated_at FROM ledger_runs WHERE run_id = ?').get(opened.runId),
        snapshot.run,
      );
      assert.deepEqual(db.prepare('SELECT * FROM ledger_events WHERE run_id = ? ORDER BY sequence').all(opened.runId), snapshot.events);
      assert.deepEqual(db.prepare('SELECT * FROM gateway_idempotency ORDER BY scope, key_hash').all(), snapshot.idempotency);
      assert.deepEqual(db.prepare('SELECT * FROM context_feedback ORDER BY feedback_id').all(), snapshot.feedback);
    } finally {
      db.close();
    }
  }
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

test('feedback defaults only omitted createdAt and intake sessionId fields', async () => {
  const db = await database();
  const gateway = new AgentGatewayService(db, { now: () => now });
  const opened = open(gateway, 'feedback-default-boundary');
  const service = new FeedbackService(db, () => now);

  const defaulted = service.feedback({
    runId: opened.runId,
    idempotencyKey: 'feedback-default-created-at-key',
    request: {
      apiVersion: '1',
      category: 'run',
      feedbackId: 'feedback-default-created-at',
      outcome: 'completed',
    },
  });
  assert.equal((defaulted.record as { createdAt: string }).createdAt, now);

  const requestedCreatedAt = '2026-08-20T00:00:01.000Z';
  const explicit = service.feedback({
    runId: opened.runId,
    idempotencyKey: 'feedback-explicit-created-at-key',
    request: {
      apiVersion: '1',
      category: 'run',
      feedbackId: 'feedback-explicit-created-at',
      outcome: 'completed',
      createdAt: requestedCreatedAt,
    },
  });
  assert.equal((explicit.record as { createdAt: string }).createdAt, requestedCreatedAt);

  const defaultedSession = service.feedback({
    runId: opened.runId,
    idempotencyKey: 'feedback-default-session-key',
    request: {
      apiVersion: '1',
      category: 'intake',
      feedbackId: 'feedback-default-session',
      profileField: 'target',
      verdict: 'helpful',
    },
  });
  assert.equal((defaultedSession.record as { sessionId: string }).sessionId, opened.intakeSessionId);

  for (const [index, createdAt] of [null, undefined, 0, '2026-08-20T00:00:00Z', '+010000-01-01T00:00:00.000Z'].entries()) {
    assert.throws(
      () => service.feedback({
        runId: opened.runId,
        idempotencyKey: `feedback-invalid-created-at-key-${index}`,
        request: {
          apiVersion: '1',
          category: 'run',
          feedbackId: `feedback-invalid-created-at-${index}`,
          outcome: 'completed',
          createdAt,
        },
      }),
      (error: unknown) => (error as { code?: string }).code === 'VALIDATION_ERROR',
    );
  }

  for (const [index, sessionId] of [null, undefined, 0, false].entries()) {
    assert.throws(
      () => service.feedback({
        runId: opened.runId,
        idempotencyKey: `feedback-invalid-session-key-${index}`,
        request: {
          apiVersion: '1',
          category: 'intake',
          feedbackId: `feedback-invalid-session-${index}`,
          sessionId,
          profileField: 'target',
          verdict: 'helpful',
        },
      }),
      (error: unknown) => (error as { code?: string }).code === 'VALIDATION_ERROR',
    );
  }

  const accessorRequest = {
    apiVersion: '1',
    category: 'run',
    feedbackId: 'feedback-accessor-request',
    outcome: 'completed',
  } as Record<string, unknown>;
  Object.defineProperty(accessorRequest, 'createdAt', {
    enumerable: true,
    get: () => { throw new Error('feedback-accessor-sentinel'); },
  });
  for (const [index, request] of [
    accessorRequest,
    new Proxy({ apiVersion: '1', category: 'run', feedbackId: 'feedback-proxy-request', outcome: 'completed' }, {
      get: () => { throw new Error('feedback-proxy-sentinel'); },
    }),
  ].entries()) {
    assert.throws(
      () => service.feedback({
        runId: opened.runId,
        idempotencyKey: `feedback-invalid-object-key-${index}`,
        request,
      }),
      (error: unknown) => {
        assert.equal((error as { code?: string }).code, 'VALIDATION_ERROR');
        assert.doesNotMatch((error as Error).message, /feedback-(?:accessor|proxy)-sentinel/);
        return true;
      },
    );
  }

  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM run_feedback').get<{ count: number }>()?.count, 2);
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM intake_feedback').get<{ count: number }>()?.count, 1);
});
