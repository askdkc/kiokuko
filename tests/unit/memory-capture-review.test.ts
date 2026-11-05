import assert from 'node:assert/strict';
import test from 'node:test';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { ErrorCode, McpError } from '@modelcontextprotocol/sdk/types.js';
import { createMcpMemoryCaptureReview } from '../../src/mcp/memory-capture-review.js';
import type { MemoryCaptureProposal } from '../../src/mcp/memory-capture-presentation.js';

const proposal: MemoryCaptureProposal = { operationId: 'review-diagnostic', memories: [{
  scope: 'project', kind: 'decision', basis: 'user_statement', generalCommunication: false,
  title: 'Native memory consent', body: 'Save only after the human approves the displayed proposal.',
}] };

for (const [code, category, reason] of [
  [ErrorCode.InvalidParams, 'invalid_params', 'elicitation_request_failed'],
  [ErrorCode.MethodNotFound, 'method_not_found', 'elicitation_request_failed'],
  [ErrorCode.RequestTimeout, 'timeout', 'elicitation_timeout'],
  [ErrorCode.ConnectionClosed, 'connection_closed', 'elicitation_request_failed'],
] as const) {
  test(`native review exposes ${category} without treating it as approval`, async t => {
    const server = new McpServer({ name: 'diagnostic-test', version: '1' });
    t.mock.method(server.server, 'getClientCapabilities', () => ({ elicitation: { form: {} } }));
    t.mock.method(server.server, 'elicitInput', async () => { throw new McpError(code, 'Native request failed'); });
    const review = createMcpMemoryCaptureReview(server);
    t.after(() => review.close());
    let saves = 0;
    const result = await review.review({ operationId: proposal.operationId, proposal, save: async () => { saves++; } });
    assert.equal(result.review.reason, reason);
    assert.equal(result.review.diagnostic?.category, category);
    assert.equal(result.review.diagnostic?.code, code);
    assert.match(result.review.diagnostic?.message ?? '', /Native request failed/u);
    assert.equal(saves, 0);
  });
}

for (const closeServer of [false, true]) {
  test(`native review distinguishes ${closeServer ? 'server shutdown' : 'request cancellation'}`, async t => {
    const server = new McpServer({ name: 'cancel-diagnostic-test', version: '1' });
    const review = createMcpMemoryCaptureReview(server), abort = new AbortController();
    t.after(() => review.close());
    t.mock.method(server.server, 'getClientCapabilities', () => ({ elicitation: { form: {} } }));
    t.mock.method(server.server, 'elicitInput', async () => {
      if (closeServer) review.close(); else abort.abort();
      throw new Error('Request interrupted');
    });
    let saves = 0;
    const result = await review.review({ operationId: proposal.operationId, proposal, signal: abort.signal,
      save: async () => { saves++; } });
    assert.equal(result.review.reason, closeServer ? 'server_closed' : 'request_cancelled');
    assert.equal(saves, 0);
  });
}

test('native error diagnostics are bounded and never expose error data or stacks', async t => {
  const server = new McpServer({ name: 'bounded-diagnostic-test', version: '1' });
  t.mock.method(server.server, 'getClientCapabilities', () => ({ elicitation: { form: {} } }));
  t.mock.method(server.server, 'elicitInput', async () => {
    throw new McpError(ErrorCode.InvalidParams, 'failed to parse typed MCP elicitation schema\n' + 'x'.repeat(2000),
      { privatePayload: 'Do not expose this.' });
  });
  const review = createMcpMemoryCaptureReview(server);
  t.after(() => review.close());
  const result = await review.review({ operationId: proposal.operationId, proposal, save: async () => assert.fail('must not save') });
  assert.ok(result.review.diagnostic!.message.length <= 500);
  assert.match(result.review.diagnostic!.message, /failed to parse typed MCP elicitation schema/u);
  assert.doesNotMatch(JSON.stringify(result), /privatePayload|Do not expose|\\n|\.test\.ts:/u);
});
