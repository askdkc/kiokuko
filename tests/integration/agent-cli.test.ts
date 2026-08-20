import assert from 'node:assert/strict';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { initializeDatabase } from '../../src/commands/init.js';
import { runCli } from '../../src/cli.js';
import { createServerClient, type FetchImplementation } from '../../src/client/server-client.js';
import { startAgentHttpServer } from '../../src/server/agent-application.js';

const token = 'a'.repeat(64);

type CapturedRequest = {
  url: string;
  method: string;
  headers: Record<string, string>;
  body?: string;
};

async function captureOutput<T>(operation: () => Promise<T>): Promise<{ result: T; stdout: string; stderr: string }> {
  let stdout = '';
  let stderr = '';
  const originalStdout = process.stdout.write;
  const originalStderr = process.stderr.write;
  process.stdout.write = ((chunk: string | Uint8Array) => {
    stdout += typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8');
    return true;
  }) as typeof process.stdout.write;
  process.stderr.write = ((chunk: string | Uint8Array) => {
    stderr += typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8');
    return true;
  }) as typeof process.stderr.write;
  try {
    return { result: await operation(), stdout, stderr };
  } finally {
    process.stdout.write = originalStdout;
    process.stderr.write = originalStderr;
  }
}

function parsed(output: string): Record<string, any> {
  assert.equal(output.endsWith('\n'), true);
  return JSON.parse(output) as Record<string, any>;
}

async function fixture() {
  const directory = await mkdtemp(path.join(tmpdir(), 'kiokuko-agent-cli-'));
  const databasePath = path.join(directory, 'data.sqlite3');
  const runtimeDirectory = path.join(directory, 'runtime');
  const descriptorPath = path.join(runtimeDirectory, 'server.json');
  await initializeDatabase({ databasePath });
  const runtime = await startAgentHttpServer({
    databasePath,
    runtimeDirectory,
    descriptorPath,
    capabilityToken: token,
  });
  const requests: CapturedRequest[] = [];
  const fetchImplementation: FetchImplementation = async (url, init = {}) => {
    const headers = new Headers(init.headers);
    const captured: CapturedRequest = {
      url,
      method: init.method ?? 'GET',
      headers: Object.fromEntries(headers.entries()),
    };
    if (typeof init.body === 'string') captured.body = init.body;
    requests.push(captured);
    return fetch(url, init);
  };
  const keyValues = ['cli-open-key', 'cli-answer-type', 'cli-answer-target', 'cli-answer-expected', 'cli-checkpoint-key', 'cli-close-key', 'cli-feedback-key'];
  let keyIndex = 0;
  const agent = {
    createClient: () => createServerClient({
      descriptorPath,
      isPidAlive: () => true,
      fetchImplementation,
    }),
    idempotencyKeyFactory: () => keyValues[keyIndex++] ?? `unexpected-key-${keyIndex}`,
  };
  return { directory, runtime, requests, agent };
}

async function invoke(args: string[], agent: Awaited<ReturnType<typeof fixture>>['agent']): Promise<Record<string, any>> {
  const captured = await captureOutput(() => runCli(['node', 'kiokuko', ...args], { agent }));
  assert.equal(captured.result, 0, `${args.join(' ')}: ${captured.stderr}${captured.stdout}`);
  assert.equal(captured.stderr, '');
  return parsed(captured.stdout);
}

test('generic agent CLI opens and answers intake without fabricating lifecycle data', async () => {
  const value = await fixture();
  try {
    const opened = await invoke([
      'agent', 'open', '--workspace', 'cli-workspace', '--client', 'generic', '--task', 'Implement the feature', '--json',
    ], value.agent);
    assert.equal(opened.operation, 'agent.open');
    assert.equal(opened.data.intakeStatus, 'needs_answer');
    assert.equal(opened.data.runStatus, 'intake');
    assert.equal(opened.data.context, null);
    const runId = opened.data.runId as string;
    const firstQuestionId = opened.data.currentQuestion.id as string;

    const answeredType = await invoke([
      'agent', 'answer', runId, '--question-id', firstQuestionId, '--value', 'build', '--json',
    ], value.agent);
    assert.equal(answeredType.operation, 'agent.answer');
    assert.equal(answeredType.data.runStatus, 'intake');
    assert.equal(answeredType.data.context, null);

    const secondQuestionId = answeredType.data.currentQuestion.id as string;
    const answeredTarget = await invoke([
      'agent', 'answer', runId, '--question-id', secondQuestionId, '--value', 'src/feature.ts', '--json',
    ], value.agent);
    let finalAnswer = answeredTarget;
    if (answeredTarget.data.runStatus === 'intake') {
      const thirdQuestionId = answeredTarget.data.currentQuestion.id as string;
      finalAnswer = await invoke([
        'agent', 'answer', runId, '--question-id', thirdQuestionId, '--value', 'focused tests pass', '--json',
      ], value.agent);
    }
    assert.equal(finalAnswer.data.runStatus, 'active');
    assert.equal(['ready', 'exhausted'].includes(finalAnswer.data.intakeStatus), true);
    assert.equal(finalAnswer.data.context.untrusted, true);
    assert.equal(finalAnswer.data.untrusted, true);

    const openRequest = value.requests[0];
    assert.equal(openRequest?.method, 'POST');
    assert.equal(new URL(openRequest?.url ?? '').pathname, '/api/v1/agent/runs');
    assert.equal(openRequest?.headers.authorization, `Bearer ${token}`);
    assert.equal(openRequest?.headers['idempotency-key'], 'cli-open-key');
    const openBody = JSON.parse(openRequest?.body ?? '{}') as Record<string, any>;
    assert.deepEqual(openBody.client, { kind: 'generic' });
    assert.equal(openBody.task.title, 'Implement the feature');
    assert.equal(openBody.task.query, 'Implement the feature');
    assert.equal(openBody.captureProfile, 'standard');
    assert.equal(openBody.coverage.run, 'declared');
    assert.equal(openBody.coverage.approval, 'unavailable');
    assert.equal(JSON.stringify(openBody).includes('complete'), false);
  } finally {
    await value.runtime.close();
  }
});

test('generic agent CLI sends exact write paths, bodies, and one idempotency key per operation', async () => {
  const value = await fixture();
  try {
    const opened = await invoke([
      'agent', 'open', '--workspace', 'cli-write-workspace', '--client', 'codex', '--client-version', '1.0', '--session-id', 's1', '--task', 'Complete task', '--capture-profile', 'full', '--json',
    ], value.agent);
    const runId = opened.data.runId as string;
    const answerOne = await invoke(['agent', 'answer', runId, '--question-id', opened.data.currentQuestion.id, '--value', 'build', '--json'], value.agent);
    const answerTwo = await invoke(['agent', 'answer', runId, '--question-id', answerOne.data.currentQuestion.id, '--value', 'src/a.ts', '--json'], value.agent);
    await invoke(['agent', 'answer', runId, '--question-id', answerTwo.data.currentQuestion.id, '--value', 'tests pass', '--json'], value.agent);

    const inputDirectory = path.join(value.directory, 'inputs');
    await mkdir(inputDirectory);
    const eventPath = path.join(inputDirectory, 'events.json');
    const checkpointPath = path.join(inputDirectory, 'checkpoint.json');
    const closePath = path.join(inputDirectory, 'close.json');
    const feedbackPath = path.join(inputDirectory, 'feedback.json');
    await writeFile(eventPath, JSON.stringify({
      idempotencyKey: 'cli-events-key',
      apiVersion: '1',
      events: [{ eventId: 'cli-event-1', eventType: 'step.started', actor: 'cli', occurredAt: '2026-08-20T00:00:00.000Z', payload: { step: 'build' } }],
    }));
    await writeFile(checkpointPath, JSON.stringify({ apiVersion: '1', currentStep: 'verify' }));
    await writeFile(closePath, JSON.stringify({ apiVersion: '1', status: 'completed' }));
    await writeFile(feedbackPath, JSON.stringify({ apiVersion: '1', category: 'run', feedbackId: 'feedback-1', outcome: 'completed', rating: 5 }));

    const events = await invoke(['agent', 'events', runId, '--input-json', eventPath, '--json'], value.agent);
    assert.equal(events.operation, 'agent.events');
    const checkpoint = await invoke(['agent', 'checkpoint', runId, '--input-json', checkpointPath, '--json'], value.agent);
    assert.equal(checkpoint.operation, 'agent.checkpoint');
    const closed = await invoke(['agent', 'close', runId, '--input-json', closePath, '--json'], value.agent);
    assert.equal(closed.operation, 'agent.close');
    const feedback = await invoke(['agent', 'feedback', runId, '--input-json', feedbackPath, '--json'], value.agent);
    assert.equal(feedback.operation, 'agent.feedback');

    const paths = value.requests.slice(-4).map((request) => new URL(request.url).pathname);
    assert.deepEqual(paths, [
      `/api/v1/agent/runs/${encodeURIComponent(runId)}/events`,
      `/api/v1/agent/runs/${encodeURIComponent(runId)}/checkpoints`,
      `/api/v1/agent/runs/${encodeURIComponent(runId)}/close`,
      `/api/v1/agent/runs/${encodeURIComponent(runId)}/feedback`,
    ]);
    assert.deepEqual(value.requests.slice(-4).map((request) => request.headers['idempotency-key']), [
      'cli-events-key', 'cli-checkpoint-key', 'cli-close-key', 'cli-feedback-key',
    ]);
    assert.equal(JSON.parse(value.requests.at(-4)?.body ?? '{}').idempotencyKey, undefined);
    assert.equal(JSON.parse(value.requests.at(-3)?.body ?? '{}').apiVersion, '1');
    assert.equal(JSON.parse(value.requests.at(-2)?.body ?? '{}').status, 'completed');
    assert.equal(JSON.parse(value.requests.at(-1)?.body ?? '{}').feedbackId, 'feedback-1');
  } finally {
    await value.runtime.close();
  }
});

test('agent JSON input rejects trailing data and server absence is a fixed error', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'kiokuko-agent-cli-invalid-'));
  const inputPath = path.join(directory, 'invalid.json');
  await writeFile(inputPath, '{"apiVersion":"1"} trailing');
  const dependency = {
    createClient: async () => { throw new Error('client should not be created'); },
    idempotencyKeyFactory: () => 'unused-key',
  };
  const invalid = await captureOutput(() => runCli([
    'node', 'kiokuko', 'agent', 'events', 'run-1', '--input-json', inputPath, '--json',
  ], { agent: dependency }));
  assert.equal(invalid.result, 3);
  assert.equal(invalid.stderr, '');
  const error = parsed(invalid.stdout);
  assert.equal(error.operation, 'agent.events');
  assert.equal(error.error.code, 'VALIDATION_ERROR');
  assert.equal(JSON.stringify(error).includes(inputPath), false);

  const unavailable = await captureOutput(() => runCli([
    'node', 'kiokuko', 'agent', 'open', '--workspace', 'w', '--client', 'generic', '--task', 't', '--json',
  ]));
  assert.equal(unavailable.result, 6);
  assert.equal(unavailable.stderr, '');
  const unavailableBody = parsed(unavailable.stdout);
  assert.equal(unavailableBody.operation, 'agent.open');
  assert.equal(unavailableBody.error.code, 'SERVICE_UNAVAILABLE');
});
