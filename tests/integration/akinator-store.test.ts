import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { openConnection } from '../../src/db/connection.js';
import { migrateDatabase } from '../../src/db/migrate.js';
import {
  insertAkinatorAnswer,
  insertAkinatorSession,
  insertRunIntakeLink,
  finalizeRunIntakeLink,
  markRunIntakeProfileSource,
  readAkinatorAnswer,
  readAkinatorSession,
  readRunIntakeLink,
  updateAkinatorSession,
} from '../../src/akinator/store.js';

const migrations = path.resolve(import.meta.dirname, '../../migrations');
const now = '2026-08-20T00:00:00.000Z';

async function setup() {
  const directory = await mkdtemp(path.join(tmpdir(), 'kiokuko-akinator-store-'));
  const database = openConnection(path.join(directory, 'data.sqlite3'));
  migrateDatabase(database, migrations);
  return database;
}

const profile = {
  taskType: 'build' as const,
  target: 'src/feature.ts',
  expected: 'tests pass',
  constraints: null,
};

function assertStoreError(
  operation: () => unknown,
  code: string,
  sentinel?: string,
  expectedMessage?: string,
): void {
  assert.throws(operation, (error: unknown) => {
    const typed = error as { code?: string; message?: string; details?: unknown };
    assert.equal(typed.code, code);
    if (expectedMessage !== undefined) assert.equal(typed.message, expectedMessage);
    if (sentinel !== undefined) {
      assert.equal(typed.message?.includes(sentinel), false);
      assert.equal(JSON.stringify(typed.details ?? {}).includes(sentinel), false);
    }
    return true;
  });
}

function seedRun(
  database: ReturnType<typeof openConnection>,
  runId: string,
  sessionId: string,
  workspace = 'workspace-a',
): void {
  insertAkinatorSession(database, {
    id: sessionId,
    workspace,
    task: 'Implement the feature',
    profile,
    status: 'active',
    questionCount: 0,
    createdAt: now,
    updatedAt: now,
  });
  database.prepare(`
    INSERT INTO ledger_runs (
      run_id, workspace, client_kind, protocol_version, capture_profile, coverage_json,
      status, metadata_json, started_at, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(runId, workspace, 'generic', '1', 'standard', '{}', 'intake', '{}', now, now, now);
}

test('inserts and reads an Akinator session with camelCase fields and canonical values', async () => {
  const database = await setup();
  try {
    const input = {
      id: 'session-round-trip',
      workspace: 'workspace-a',
      task: 'Implement the feature',
      profile,
      status: 'active' as const,
      questionCount: 0,
      createdAt: now,
      updatedAt: now,
    };
    const created = insertAkinatorSession(database, input);

    assert.deepEqual(created, {
      id: 'session-round-trip',
      workspace: 'workspace-a',
      task: 'Implement the feature',
      profile,
      status: 'active',
      questionCount: 0,
      createdAt: now,
      updatedAt: now,
    });
    assert.deepEqual(readAkinatorSession(database, { workspace: 'workspace-a', sessionId: input.id }), created);
    assert.deepEqual(input.profile, profile);
  } finally {
    database.close();
  }
});

test('updates a session only from the expected question count and returns the next snapshot', async () => {
  const database = await setup();
  try {
    insertAkinatorSession(database, {
      id: 'session-update',
      workspace: 'workspace-a',
      task: 'Implement the feature',
      profile: { ...profile, expected: null },
      status: 'active',
      questionCount: 0,
      createdAt: now,
      updatedAt: now,
    });

    const updated = updateAkinatorSession(database, {
      workspace: 'workspace-a',
      sessionId: 'session-update',
      expectedQuestionCount: 0,
      profile: { ...profile, expected: 'tests pass' },
      status: 'ready',
      questionCount: 1,
      updatedAt: '2026-08-20T00:01:00.000Z',
    });

    assert.equal(updated.status, 'ready');
    assert.equal(updated.questionCount, 1);
    assert.equal(updated.createdAt, now);
    assert.equal(updated.task, 'Implement the feature');
    assert.equal(updated.profile.expected, 'tests pass');
  } finally {
    database.close();
  }
});

test('inserts, reads, and canonically replays one answer per session question', async () => {
  const database = await setup();
  try {
    insertAkinatorSession(database, {
      id: 'session-answer',
      workspace: 'workspace-a',
      task: 'Implement the feature',
      profile: { ...profile, expected: null },
      status: 'active',
      questionCount: 0,
      createdAt: now,
      updatedAt: now,
    });
    const answer = { value: 'src/feature.ts', metadata: { z: 1, a: 2 } };
    const inserted = insertAkinatorAnswer(database, {
      workspace: 'workspace-a',
      sessionId: 'session-answer',
      questionId: 'target',
      answer,
      createdAt: now,
    });

    assert.equal(inserted.replayed, false);
    assert.deepEqual(inserted.answer, {
      sessionId: 'session-answer',
      questionId: 'target',
      answer,
      createdAt: now,
    });
    assert.deepEqual(readAkinatorAnswer(database, {
      workspace: 'workspace-a', sessionId: 'session-answer', questionId: 'target',
    }), inserted.answer);
    assert.deepEqual(
      insertAkinatorAnswer(database, {
        workspace: 'workspace-a',
        sessionId: 'session-answer',
        questionId: 'target',
        answer: { metadata: { a: 2, z: 1 }, value: 'src/feature.ts' },
        createdAt: '2026-08-20T00:05:00.000Z',
      }),
      { replayed: true, answer: inserted.answer },
    );
    assert.equal(database.prepare('SELECT COUNT(*) AS count FROM akinator_answers').get<{ count: number }>()?.count, 1);
  } finally {
    database.close();
  }
});

test('inserts and reads a workspace-scoped run intake link with stable source and tag snapshots', async () => {
  const database = await setup();
  try {
    insertAkinatorSession(database, {
      id: 'session-link',
      workspace: 'workspace-a',
      task: 'Implement the feature',
      profile,
      status: 'active',
      questionCount: 0,
      createdAt: now,
      updatedAt: now,
    });
    database.prepare(`
      INSERT INTO ledger_runs (
        run_id, workspace, client_kind, protocol_version, capture_profile, coverage_json,
        status, metadata_json, started_at, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run('run-link', 'workspace-a', 'generic', '1', 'standard', '{}', 'intake', '{}', now, now, now);

    const inserted = insertRunIntakeLink(database, {
      runId: 'run-link',
      sessionId: 'session-link',
      workspace: 'workspace-a',
      policyVersion: 'akinator-v1',
      profileSchemaVersion: 1,
      profileSources: { taskType: 'inferred', target: 'client_supplied' },
      initialProfileHash: null,
      recommendedTags: ['bot:builder', 'skill:tdd', 'bot:builder'],
      linkedAt: now,
      finalizedAt: null,
    });

    assert.deepEqual(inserted, {
      runId: 'run-link',
      sessionId: 'session-link',
      workspace: 'workspace-a',
      policyVersion: 'akinator-v1',
      profileSchemaVersion: 1,
      profileSources: { taskType: 'inferred', target: 'client_supplied' },
      initialProfileHash: null,
      recommendedTags: ['bot:builder', 'skill:tdd'],
      linkedAt: now,
      finalizedAt: null,
    });
  } finally {
    database.close();
  }
});

test('finalizes an intake link once and replays only the exact finalization', async () => {
  const database = await setup();
  try {
    insertAkinatorSession(database, {
      id: 'session-finalize',
      workspace: 'workspace-a',
      task: 'Implement the feature',
      profile,
      status: 'active',
      questionCount: 0,
      createdAt: now,
      updatedAt: now,
    });
    database.prepare(`
      INSERT INTO ledger_runs (
        run_id, workspace, client_kind, protocol_version, capture_profile, coverage_json,
        status, metadata_json, started_at, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run('run-finalize', 'workspace-a', 'generic', '1', 'standard', '{}', 'intake', '{}', now, now, now);
    insertRunIntakeLink(database, {
      runId: 'run-finalize',
      sessionId: 'session-finalize',
      workspace: 'workspace-a',
      policyVersion: 'akinator-v1',
      profileSchemaVersion: 1,
      profileSources: { taskType: 'inferred' },
      initialProfileHash: null,
      recommendedTags: [],
      linkedAt: now,
      finalizedAt: null,
    });

    const hash = 'a'.repeat(64);
    const finalized = finalizeRunIntakeLink(database, {
      workspace: 'workspace-a',
      runId: 'run-finalize',
      profileHash: hash,
      recommendedTags: ['bot:builder', 'skill:tdd'],
      finalizedAt: '2026-08-20T00:02:00.000Z',
    });
    assert.equal(finalized.initialProfileHash, hash);
    assert.deepEqual(finalized.recommendedTags, ['bot:builder', 'skill:tdd']);
    assert.equal(finalized.finalizedAt, '2026-08-20T00:02:00.000Z');
    assert.deepEqual(finalizeRunIntakeLink(database, {
      workspace: 'workspace-a',
      runId: 'run-finalize',
      profileHash: hash,
      recommendedTags: ['bot:builder', 'skill:tdd'],
      finalizedAt: '2026-08-20T00:02:00.000Z',
    }), finalized);
    assert.throws(() => finalizeRunIntakeLink(database, {
      workspace: 'workspace-a',
      runId: 'run-finalize',
      profileHash: 'b'.repeat(64),
      recommendedTags: ['bot:builder', 'skill:tdd'],
      finalizedAt: '2026-08-20T00:02:00.000Z',
    }), (error: unknown) => (error as { code?: string }).code === 'CONFLICT');
  } finally {
    database.close();
  }
});

test('uses fixed typed errors for empty/cross-workspace reads and corrupt persisted profiles', async () => {
  const database = await setup();
  try {
    const sentinel = 'untrusted-profile-sentinel-7f2c';
    insertAkinatorSession(database, {
      id: 'session-errors',
      workspace: 'workspace-a',
      task: 'Implement the feature',
      profile,
      status: 'active',
      questionCount: 0,
      createdAt: now,
      updatedAt: now,
    });

    assertStoreError(
      () => readAkinatorSession(database, { workspace: 'workspace-a', sessionId: '' }),
      'VALIDATION_ERROR',
    );
    assertStoreError(
      () => readAkinatorSession(database, { workspace: 'workspace-a', sessionId: 'missing' }),
      'NOT_FOUND',
    );
    assertStoreError(
      () => readAkinatorSession(database, { workspace: 'workspace-b', sessionId: 'session-errors' }),
      'NOT_FOUND',
    );
    assertStoreError(
      () => readAkinatorSession(database, { workspace: 'workspace-a', sessionId: 'session-errors', sentinel }),
      'VALIDATION_ERROR',
      sentinel,
    );

    database.prepare('UPDATE akinator_sessions SET profile_json = ? WHERE id = ?').run(
      JSON.stringify({ taskType: 'build', target: sentinel, expected: null, constraints: null, unexpected: sentinel }),
      'session-errors',
    );
    assertStoreError(() => readAkinatorSession(database, {
      workspace: 'workspace-a', sessionId: 'session-errors',
    }), 'INTEGRITY_ERROR', sentinel);
  } finally {
    database.close();
  }
});

test('conflicts on a different answer and reports corrupted persisted answer without echoing it', async () => {
  const database = await setup();
  try {
    seedRun(database, 'run-answer-errors', 'session-answer-errors');
    insertAkinatorAnswer(database, {
      workspace: 'workspace-a',
      sessionId: 'session-answer-errors',
      questionId: 'target',
      answer: 'first answer',
      createdAt: now,
    });
    assertStoreError(() => insertAkinatorAnswer(database, {
      workspace: 'workspace-a',
      sessionId: 'session-answer-errors',
      questionId: 'target',
      answer: 'different answer',
      createdAt: now,
    }), 'CONFLICT');
    assertStoreError(() => readAkinatorAnswer(database, {
      workspace: 'workspace-b', sessionId: 'session-answer-errors', questionId: 'target',
    }), 'NOT_FOUND');

    const sentinel = 'corrupt-answer-sentinel-91aa';
    database.prepare('UPDATE akinator_answers SET answer_json = ? WHERE session_id = ?').run(
      `not-json-${sentinel}`, 'session-answer-errors',
    );
    assertStoreError(() => readAkinatorAnswer(database, {
      workspace: 'workspace-a', sessionId: 'session-answer-errors', questionId: 'target',
    }), 'INTEGRITY_ERROR', sentinel);
  } finally {
    database.close();
  }
});

test('rejects stale or finalized session updates without changing immutable or profile fields', async () => {
  const database = await setup();
  try {
    insertAkinatorSession(database, {
      id: 'session-stale',
      workspace: 'workspace-a',
      task: 'Original task',
      profile,
      status: 'active',
      questionCount: 0,
      createdAt: now,
      updatedAt: now,
    });
    database.prepare('UPDATE akinator_sessions SET question_count = ? WHERE id = ?').run(1, 'session-stale');
    assertStoreError(() => updateAkinatorSession(database, {
      workspace: 'workspace-a',
      sessionId: 'session-stale',
      expectedQuestionCount: 0,
      profile: { ...profile, target: 'changed' },
      status: 'active',
      questionCount: 1,
      updatedAt: '2026-08-20T00:01:00.000Z',
    }), 'CONFLICT');

    insertAkinatorSession(database, {
      id: 'session-finalized',
      workspace: 'workspace-a',
      task: 'Final task',
      profile,
      status: 'ready',
      questionCount: 0,
      createdAt: now,
      updatedAt: now,
    });
    assertStoreError(() => updateAkinatorSession(database, {
      workspace: 'workspace-a',
      sessionId: 'session-finalized',
      expectedQuestionCount: 0,
      profile: { ...profile, target: 'changed' },
      status: 'active',
      questionCount: 1,
      updatedAt: '2026-08-20T00:01:00.000Z',
    }), 'CONFLICT');
    assert.deepEqual(readAkinatorSession(database, {
      workspace: 'workspace-a', sessionId: 'session-finalized',
    }), {
      id: 'session-finalized',
      workspace: 'workspace-a',
      task: 'Final task',
      profile,
      status: 'ready',
      questionCount: 0,
      createdAt: now,
      updatedAt: now,
    });
  } finally {
    database.close();
  }
});

test('maps intake one-to-one constraint failures to fixed conflicts and validates persisted link JSON', async () => {
  const database = await setup();
  try {
    seedRun(database, 'run-constraints-1', 'session-constraints-1');
    seedRun(database, 'run-constraints-2', 'session-constraints-2');
    const linkInput = {
      workspace: 'workspace-a',
      policyVersion: 'akinator-v1',
      profileSchemaVersion: 1,
      profileSources: { taskType: 'inferred' as const },
      initialProfileHash: null,
      recommendedTags: ['bot:builder'],
      linkedAt: now,
      finalizedAt: null,
    };
    insertRunIntakeLink(database, {
      ...linkInput, runId: 'run-constraints-1', sessionId: 'session-constraints-1',
    });
    assertStoreError(() => insertRunIntakeLink(database, {
      ...linkInput, runId: 'run-constraints-1', sessionId: 'session-constraints-2',
    }), 'CONFLICT');
    assertStoreError(() => insertRunIntakeLink(database, {
      ...linkInput, runId: 'run-constraints-2', sessionId: 'session-constraints-1',
    }), 'CONFLICT');
    assertStoreError(() => readRunIntakeLink(database, {
      workspace: 'workspace-b', runId: 'run-constraints-1',
    }), 'NOT_FOUND', undefined, 'Run intake link not found');

    const sentinel = 'link-json-sentinel-2c8d';
    database.prepare('UPDATE run_intakes SET recommended_tags_json = ? WHERE run_id = ?').run(
      JSON.stringify(['bot:builder', sentinel, 'bot:builder']), 'run-constraints-1',
    );
    assertStoreError(() => readRunIntakeLink(database, {
      workspace: 'workspace-a', runId: 'run-constraints-1',
    }), 'INTEGRITY_ERROR', sentinel);
  } finally {
    database.close();
  }
});

test('uses caller-owned transactions and leaves an outer marker intact after a handled conflict', async () => {
  const database = await setup();
  try {
    database.exec(`
      CREATE TABLE caller_marker (value TEXT NOT NULL);
      INSERT INTO ledger_runs (
        run_id, workspace, client_kind, protocol_version, capture_profile, coverage_json,
        status, metadata_json, started_at, created_at, updated_at
      ) VALUES ('run-transaction', 'workspace-a', 'generic', '1', 'standard', '{}', 'intake', '{}', '${now}', '${now}', '${now}');
    `);
    database.exec('BEGIN IMMEDIATE');
    try {
      database.prepare('INSERT INTO caller_marker (value) VALUES (?)').run('outer survives');
      insertAkinatorSession(database, {
        id: 'session-transaction',
        workspace: 'workspace-a',
        task: 'Transactional task',
        profile,
        status: 'active',
        questionCount: 0,
        createdAt: now,
        updatedAt: now,
      });
      insertAkinatorAnswer(database, {
        workspace: 'workspace-a',
        sessionId: 'session-transaction',
        questionId: 'target',
        answer: 'src/feature.ts',
        createdAt: now,
      });
      insertRunIntakeLink(database, {
        runId: 'run-transaction',
        sessionId: 'session-transaction',
        workspace: 'workspace-a',
        policyVersion: 'akinator-v1',
        profileSchemaVersion: 1,
        profileSources: { taskType: 'inferred' },
        initialProfileHash: null,
        recommendedTags: ['bot:builder'],
        linkedAt: now,
        finalizedAt: null,
      });
      assertStoreError(() => insertRunIntakeLink(database, {
        runId: 'run-transaction',
        sessionId: 'session-transaction',
        workspace: 'workspace-a',
        policyVersion: 'akinator-v1',
        profileSchemaVersion: 1,
        profileSources: { taskType: 'inferred' },
        initialProfileHash: null,
        recommendedTags: ['bot:builder'],
        linkedAt: now,
        finalizedAt: null,
      }), 'CONFLICT');
      assert.equal(database.prepare('SELECT COUNT(*) AS count FROM caller_marker').get<{ count: number }>()?.count, 1);
      assert.equal(database.prepare('SELECT COUNT(*) AS count FROM akinator_answers').get<{ count: number }>()?.count, 1);
      assert.equal(database.prepare('SELECT COUNT(*) AS count FROM run_intakes').get<{ count: number }>()?.count, 1);
    } finally {
      database.exec('ROLLBACK');
    }
    assert.equal(database.prepare('SELECT COUNT(*) AS count FROM caller_marker').get<{ count: number }>()?.count, 0);
    assert.equal(database.prepare('SELECT COUNT(*) AS count FROM akinator_sessions WHERE id = ?').get<{ count: number }>('session-transaction')?.count, 0);
    assert.equal(database.prepare('SELECT COUNT(*) AS count FROM akinator_answers WHERE session_id = ?').get<{ count: number }>('session-transaction')?.count, 0);
    assert.equal(database.prepare('SELECT COUNT(*) AS count FROM run_intakes WHERE run_id = ?').get<{ count: number }>('run-transaction')?.count, 0);
  } finally {
    database.close();
  }
});

test('read operations preserve row counts and stored content', async () => {
  const database = await setup();
  try {
    seedRun(database, 'run-read-only', 'session-read-only');
    insertAkinatorAnswer(database, {
      workspace: 'workspace-a',
      sessionId: 'session-read-only',
      questionId: 'target',
      answer: { value: 'src/feature.ts' },
      createdAt: now,
    });
    insertRunIntakeLink(database, {
      runId: 'run-read-only',
      sessionId: 'session-read-only',
      workspace: 'workspace-a',
      policyVersion: 'akinator-v1',
      profileSchemaVersion: 1,
      profileSources: { taskType: 'inferred' },
      initialProfileHash: null,
      recommendedTags: ['bot:builder'],
      linkedAt: now,
      finalizedAt: null,
    });
    const before = database.prepare(`
      SELECT
        (SELECT COUNT(*) FROM akinator_sessions) AS sessions,
        (SELECT COUNT(*) FROM akinator_answers) AS answers,
        (SELECT COUNT(*) FROM run_intakes) AS links,
        (SELECT profile_json FROM akinator_sessions WHERE id = ?) AS profile_json,
        (SELECT answer_json FROM akinator_answers WHERE session_id = ?) AS answer_json,
        (SELECT recommended_tags_json FROM run_intakes WHERE run_id = ?) AS tags_json
    `).get<{ sessions: number; answers: number; links: number; profile_json: string; answer_json: string; tags_json: string }>(
      'session-read-only', 'session-read-only', 'run-read-only',
    );
    readAkinatorSession(database, { workspace: 'workspace-a', sessionId: 'session-read-only' });
    readAkinatorAnswer(database, { workspace: 'workspace-a', sessionId: 'session-read-only', questionId: 'target' });
    readRunIntakeLink(database, { workspace: 'workspace-a', runId: 'run-read-only' });
    const after = database.prepare(`
      SELECT
        (SELECT COUNT(*) FROM akinator_sessions) AS sessions,
        (SELECT COUNT(*) FROM akinator_answers) AS answers,
        (SELECT COUNT(*) FROM run_intakes) AS links,
        (SELECT profile_json FROM akinator_sessions WHERE id = ?) AS profile_json,
        (SELECT answer_json FROM akinator_answers WHERE session_id = ?) AS answer_json,
        (SELECT recommended_tags_json FROM run_intakes WHERE run_id = ?) AS tags_json
    `).get<{ sessions: number; answers: number; links: number; profile_json: string; answer_json: string; tags_json: string }>(
      'session-read-only', 'session-read-only', 'run-read-only',
    );
    assert.deepEqual(after, before);
  } finally {
    database.close();
  }
});

test('marks one pending profile field as a user answer without replacing other sources', async () => {
  const database = await setup();
  try {
    seedRun(database, 'run-source-mark', 'session-source-mark');
    insertRunIntakeLink(database, {
      runId: 'run-source-mark',
      sessionId: 'session-source-mark',
      workspace: 'workspace-a',
      policyVersion: 'akinator-v1',
      profileSchemaVersion: 1,
      profileSources: { taskType: 'inferred', target: 'client_supplied' },
      initialProfileHash: null,
      recommendedTags: ['bot:builder'],
      linkedAt: now,
      finalizedAt: null,
    });

    const updated = markRunIntakeProfileSource(database, {
      workspace: 'workspace-a',
      runId: 'run-source-mark',
      field: 'expected',
    });

    assert.deepEqual(updated.profileSources, {
      taskType: 'inferred',
      target: 'client_supplied',
      expected: 'user_answer',
    });
    assert.equal(database.prepare('SELECT COUNT(*) AS count FROM run_intakes').get<{ count: number }>()?.count, 1);
  } finally {
    database.close();
  }
});
