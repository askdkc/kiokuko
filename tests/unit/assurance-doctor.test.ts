import assert from 'node:assert/strict';
import test from 'node:test';
import { assuranceDoctor } from '../../src/assurance/doctor.js';
import type { SqliteDatabase } from '../../src/db/adapter.js';

test('ordinary doctor does not turn many unrequested live verifications into findings', () => {
  const active = Array.from({ length: 21 }, (_, index) => ({
    run_id: `run-${index}`, repository_root: `/repository-${index}`,
  }));
  const database = {
    prepare(sql: string) {
      if (sql.includes('FROM codex_hook_requests')) return { get: () => ({ count: 0 }) };
      if (sql.includes('FROM task_assurance')) return { all: () => active };
      if (sql.includes('FROM codex_hook_observations')) return { get: () => undefined };
      throw new Error(`Unexpected doctor query: ${sql}`);
    },
  } as unknown as SqliteDatabase;

  const result = assuranceDoctor(database);
  assert.equal(result.status, 'ok');
  assert.equal(result.count, 0);
  assert.deepEqual(result.findings, []);
  assert.match(result.detail, /repositoryVerification=not_requested/u);
  assert.match(result.detail, /sampled=true/u);
});
