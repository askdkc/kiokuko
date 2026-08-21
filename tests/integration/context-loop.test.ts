import assert from 'node:assert/strict';
import path from 'node:path';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import test from 'node:test';
import { openConnection } from '../../src/db/connection.js';
import { migrateDatabase } from '../../src/db/migrate.js';
import { AgentGatewayService } from '../../src/gateway/agent-service.js';
import { ContextBroker } from '../../src/context/broker.js';
import { recordEntry } from '../../src/memory/entries.js';

const migrations = path.resolve(import.meta.dirname, '../../migrations');
const now = '2026-08-20T00:00:00.000Z';

async function database() {
  const directory = await mkdtemp(path.join(tmpdir(), 'kiokuko-context-loop-'));
  const value = openConnection(path.join(directory, 'data.sqlite3'));
  migrateDatabase(value, migrations);
  return value;
}

function open(service: AgentGatewayService, workspace: string, hints: Record<string, unknown>) {
  return service.openRun({
    idempotencyKey: `open-${workspace}`,
    request: {
      apiVersion: '1', workspace,
      client: { kind: 'context-test' },
      task: { title: 'Implement local context', query: 'Implement local context', profileHints: hints },
      captureProfile: 'standard',
      coverage: { run: 'complete', tool: 'complete', command: 'complete', file: 'complete', approval: 'complete' },
      metadata: {},
    },
  });
}

test('context broker returns no context and never prepares sources for needs_answer', async () => {
  const db = await database();
  const service = new AgentGatewayService(db, { now: () => now });
  const opened = open(service, 'needs-answer', { taskType: 'build' });
  let fetched = false;
  const broker = new ContextBroker(db, { fetchImpl: (async () => { fetched = true; throw new Error('network'); }) as typeof fetch });
  const result = await broker.query({ workspace: 'needs-answer', runId: opened.runId });
  assert.equal(result.status, 'needs_answer');
  assert.equal(result.context, null);
  assert.equal(fetched, false);
});

test('ready context is local-first, stores one deterministic delivery, and suppresses the retry', async () => {
  const db = await database();
  const service = new AgentGatewayService(db, { now: () => now });
  const opened = open(service, 'ready-local', { taskType: 'build', target: 'src/app.ts', expected: 'tests pass' });
  recordEntry(db, {
    workspace: 'ready-local', kind: 'reference', title: 'Implement local context src/app.ts tests pass',
    body: 'Local context data.', summary: 'Implement local context src/app.ts tests pass',
    tags: ['bot:builder', 'skill:test-driven-development'], createdBy: 'test', actor: 'test',
  }, { now });
  let fetched = false;
  const broker = new ContextBroker(db, { fetchImpl: (async () => { fetched = true; throw new Error('network'); }) as typeof fetch });
  const first = await broker.query({ workspace: 'ready-local', runId: opened.runId, limit: 1 });
  const second = await broker.query({ workspace: 'ready-local', runId: opened.runId, limit: 1 });
  assert.equal(first.status, 'ready');
  assert.ok(first.context);
  assert.equal(first.context?.items.length, 1);
  assert.equal(second.context?.deliveryId, first.context?.deliveryId);
  assert.equal(fetched, false);
  const count = db.prepare('SELECT COUNT(*) AS count FROM context_deliveries').get<{ count: number }>();
  assert.equal(count?.count, 1);
});

test('unbound broker prepares official sources only after an empty local result, persists, and requeries', async () => {
  const db = await database();
  const fetchImpl = (async (input) => {
    const url = String(input);
    const body = url.includes('/commits/')
      ? JSON.stringify({ sha: 'test-sentinel-1' })
      : url.includes('/git/trees/')
        ? JSON.stringify({ tree: [{ path: 'skills/external/SKILL.md', type: 'blob' }] })
        : '# External context\n\nImplement external context and pass tests.';
    return { ok: true, status: 200, text: async () => body } as unknown as Response;
  }) as typeof fetch;
  const broker = new ContextBroker(db, { fetchImpl, allowExternalSkillFallback: true });
  const result = await broker.query({
    workspace: 'external-requery',
    task: 'Implement external context',
    taskProfile: { taskType: 'build', target: 'src/external.ts', expected: 'tests pass', constraints: null },
    limit: 1,
  });
  assert.equal(result.status, 'unbound');
  assert.equal(result.context?.items.length, 1);
  assert.equal(result.externalSyncSummary.imported, 1);
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM entries WHERE workspace = ?').get<{ count: number }>('external-requery')?.count, 1);
});

test('unbound broker does not fetch fallback skills without explicit zero-skill policy', async () => {
  const db = await database();
  let fetched = false;
  const broker = new ContextBroker(db, {
    fetchImpl: (async () => {
      fetched = true;
      throw new Error('network must stay disabled');
    }) as typeof fetch,
  });
  const result = await broker.query({
    workspace: 'external-disabled',
    task: 'Implement external context',
    taskProfile: { taskType: 'build', target: 'src/external.ts', expected: 'tests pass', constraints: null },
    limit: 1,
  });

  assert.equal(result.context?.items.length, 0);
  assert.equal(result.externalSyncSummary.attempted, false);
  assert.equal(fetched, false);
});
