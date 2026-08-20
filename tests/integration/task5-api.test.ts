import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { openConnection } from '../../src/db/connection.js';
import { initializeDatabase } from '../../src/commands/init.js';
import { recordEntry } from '../../src/memory/entries.js';
import { startAgentHttpServer } from '../../src/server/agent-application.js';

const token = 'a'.repeat(64);
const workspace = 'task5-api';

function openRequest() {
  return {
    apiVersion: '1',
    workspace,
    client: { kind: 'codex', version: '1.0.0', sessionId: 'task5-http-session' },
    task: {
      title: 'Implement route context',
      query: 'Implement this route',
      profileHints: {
        taskType: 'build',
        target: 'src/server/routes',
        expected: 'focused tests pass',
        constraints: null,
      },
    },
    captureProfile: 'standard',
    coverage: {
      run: 'declared',
      tool: 'best_effort',
      command: 'best_effort',
      file: 'declared',
      approval: 'unavailable',
    },
  };
}

async function fixture() {
  const directory = await mkdtemp(path.join(tmpdir(), 'kiokuko-task5-api-'));
  const databasePath = path.join(directory, 'data.sqlite3');
  const runtimeDirectory = path.join(directory, 'runtime');
  await initializeDatabase({ databasePath });
  const database = openConnection(databasePath);
  try {
    for (let index = 0; index < 20; index += 1) {
      recordEntry(database, {
        workspace,
        kind: 'reference',
        title: `Implement route context ${index}`,
        body: 'Implement this route and keep focused tests passing.',
        summary: 'Route implementation context',
      });
    }
  } finally {
    database.close();
  }
  const runtime = await startAgentHttpServer({
    databasePath,
    runtimeDirectory,
    descriptorPath: path.join(runtimeDirectory, 'server.json'),
    capabilityToken: token,
  });
  return runtime;
}

async function request(baseUrl: string, pathname: string, options: { method?: string; body?: unknown; key?: string } = {}) {
  const headers: Record<string, string> = { authorization: `Bearer ${token}` };
  if (options.body !== undefined) headers['content-type'] = 'application/json';
  if (options.key !== undefined) headers['idempotency-key'] = options.key;
  const response = await fetch(`${baseUrl}${pathname}`, {
    method: options.method ?? 'GET',
    headers,
    ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
  });
  return { response, value: await response.json() as any };
}

function dataOf(value: any): any {
  assert.equal(value.ok, true);
  return value.data;
}

test('Task 5 checkpoint, feedback, context query and delivery-list routes share authenticated v1 composition', async () => {
  const runtime = await fixture();
  try {
    const opened = await request(runtime.url, '/api/v1/agent/runs', {
      method: 'POST',
      key: 'task5-open',
      body: openRequest(),
    });
    assert.equal(opened.response.status, 200);
    assert.equal(opened.value.operation, 'agent.open');
    const openedData = dataOf(opened.value);
    assert.equal(openedData.intakeStatus, 'ready');
    assert.equal(openedData.context.untrusted, true);
    assert.equal(openedData.context.items.length, 20);
    const runId = openedData.runId as string;
    const deliveryId = openedData.context.deliveryId as string;
    const entryId = openedData.context.items[0].entryId as string;

    const deliveries = await request(runtime.url, `/api/v1/agent/runs/${encodeURIComponent(runId)}/context-deliveries?limit=1`);
    assert.equal(deliveries.response.status, 200);
    assert.equal(deliveries.value.operation, 'agent.context-deliveries.list');
    assert.equal(dataOf(deliveries.value).items.length, 1);
    assert.equal(dataOf(deliveries.value).items[0].deliveryId, deliveryId);

    const query = await request(runtime.url, '/api/v1/context/query', {
      method: 'POST',
      body: {
        apiVersion: '1',
        workspace,
        task: 'Implement route',
        taskProfile: { taskType: 'build', target: 'src/server/routes', expected: 'focused tests pass', constraints: null },
        limit: 1,
      },
    });
    assert.equal(query.response.status, 200);
    assert.equal(query.value.operation, 'context.query');
    assert.equal(dataOf(query.value).context.items.length, 1);

    const feedbackRequest = {
      apiVersion: '1',
      category: 'context',
      feedbackId: 'task5-feedback-1',
      deliveryId,
      entryId,
      verdict: 'helpful',
      comment: 'Useful route context',
    };
    const feedback = await request(runtime.url, `/api/v1/agent/runs/${encodeURIComponent(runId)}/feedback`, {
      method: 'POST',
      key: 'task5-feedback-key',
      body: feedbackRequest,
    });
    assert.equal(feedback.response.status, 200);
    assert.equal(feedback.value.operation, 'agent.feedback');
    assert.equal(dataOf(feedback.value).category, 'context');
    const feedbackReplay = await request(runtime.url, `/api/v1/agent/runs/${encodeURIComponent(runId)}/feedback`, {
      method: 'POST',
      key: 'task5-feedback-key',
      body: feedbackRequest,
    });
    assert.deepEqual(feedbackReplay.value, feedback.value);

    const checkpoint = await request(runtime.url, `/api/v1/agent/runs/${encodeURIComponent(runId)}/checkpoints`, {
      method: 'POST',
      key: 'task5-checkpoint-key',
      body: { apiVersion: '1', currentGoal: 'verify route context', characterBudget: 8000 },
    });
    assert.equal(checkpoint.response.status, 200);
    assert.equal(checkpoint.value.operation, 'agent.checkpoint');
    assert.equal(dataOf(checkpoint.value).taskProfile.source, 'akinator+ledger-revisions');
    assert.equal(typeof dataOf(checkpoint.value).acceptedThrough, 'number');

    const invalid = await request(runtime.url, '/api/v1/context/query?unexpected=1', {
      method: 'POST',
      body: { apiVersion: '1' },
    });
    assert.equal(invalid.response.status, 400);
    assert.equal(invalid.value.operation, 'context.query');
  } finally {
    await runtime.close();
  }
});
