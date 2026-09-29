import assert from 'node:assert/strict';
import test from 'node:test';
import { runStdioServer } from '../../src/mcp/stdio-runner.js';

test('stdio cleanup preserves connection and both cleanup failures and removes signal listeners', async () => {
  const before = [process.listenerCount('SIGTERM'), process.listenerCount('SIGINT')];
  const connectError = new Error('connect');
  const serverError = new Error('server close');
  const ownerError = new Error('owner close');
  let closed = 0;
  await assert.rejects(runStdioServer({
    connect: async () => { throw connectError; },
    close: async () => { throw serverError; },
  }, { close: () => { closed++; throw ownerError; } }), (error: unknown) => {
    assert.ok(error instanceof AggregateError);
    assert.deepEqual(error.errors, [connectError, serverError, ownerError]);
    return true;
  });
  assert.equal(closed, 1);
  assert.deepEqual([process.listenerCount('SIGTERM'), process.listenerCount('SIGINT')], before);
});

test('stdio transport close releases its owner once', async () => {
  let closed = 0;
  await runStdioServer({ connect: async transport => { transport.onclose?.(); }, close: async () => {} },
    { close: () => { closed++; } });
  assert.equal(closed, 1);
});
