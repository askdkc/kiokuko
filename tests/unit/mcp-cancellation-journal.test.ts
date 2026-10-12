import assert from 'node:assert/strict';
import test from 'node:test';
import { createHash } from 'node:crypto';
import { McpCancellationJournal, MAX_MCP_CANCELLATION_RECEIPTS } from '../../src/mcp/cancellation-journal.js';

test('server cancellation journal scopes receipts and separates abort reception from handler settlement', () => {
  const journal = new McpCancellationJournal();
  const observation = journal.begin('task_memory_refresh', 12, 'a'.repeat(64));
  observation.bind('run', '/repo');
  assert.deepEqual(journal.read('run', '/repo').receipts, []);
  observation.callerAborted();
  const pending = journal.read('run', '/repo');
  assert.equal(pending.provenance, 'server_observed');
  assert.equal(pending.receipts.length, 1);
  assert.equal(pending.receipts[0]!.handlerSettled, false);
  assert.equal(pending.receipts[0]!.handlerSettledAt, null);
  assert.equal(pending.receipts[0]!.transportRequestHash, createHash('sha256').update('12').digest('hex'));
  assert.deepEqual(journal.read('foreign', '/repo').receipts, []);
  assert.deepEqual(journal.read('run', '/foreign').receipts, []);
  observation.callerAborted();
  observation.operationSettled();
  const settled = journal.read('run', '/repo');
  assert.equal(settled.receipts.length, 1);
  assert.equal(settled.receipts[0]!.receiptId, pending.receipts[0]!.receiptId);
  assert.equal(settled.receipts[0]!.abortReceivedAt, pending.receipts[0]!.abortReceivedAt);
  assert.equal(settled.receipts[0]!.handlerSettled, true);
  assert.ok(settled.receipts[0]!.handlerSettledAt);
  settled.receipts[0]!.requestHash = 'tampered';
  assert.equal(journal.read('run', '/repo').receipts[0]!.requestHash, 'a'.repeat(64));
});

test('completed and unbound requests never become abort receipts; separate transports stay distinct', () => {
  const journal = new McpCancellationJournal();
  const normal = journal.begin('task_answer', 'normal', 'a'.repeat(64));
  normal.bind('run', '/repo'); normal.operationSettled(); normal.callerAborted();
  const unbound = journal.begin('task_answer', 'unbound', 'b'.repeat(64));
  unbound.callerAborted(); unbound.operationSettled();
  assert.deepEqual(journal.read('run', '/repo').receipts, []);
  for (const id of [1, 2]) {
    const cancelled = journal.begin('task_answer', id, 'c'.repeat(64));
    cancelled.bind('run', '/repo'); cancelled.callerAborted(); cancelled.operationSettled();
  }
  assert.equal(journal.read('run', '/repo').receipts.length, 2);
  assert.notEqual(journal.read('run', '/repo').receipts[0]!.transportRequestHash, journal.read('run', '/repo').receipts[1]!.transportRequestHash);
  assert.notEqual(new McpCancellationJournal().read('run', '/repo').serverInstanceId, journal.read('run', '/repo').serverInstanceId);
});

test('cancellation retention is bounded, reports loss, and never evicts a pending handler to claim it settled', () => {
  const journal = new McpCancellationJournal();
  const observations = [];
  for (let id = 0; id < MAX_MCP_CANCELLATION_RECEIPTS; id++) {
    const observation = journal.begin('task_answer', id, 'd'.repeat(64));
    observation.bind('run', '/repo'); observation.callerAborted(); observations.push(observation);
  }
  const dropped = journal.begin('task_answer', 'overflow', 'e'.repeat(64));
  dropped.bind('run', '/repo'); dropped.callerAborted(); dropped.operationSettled();
  const pending = journal.read('run', '/repo');
  assert.equal(pending.receipts.length, MAX_MCP_CANCELLATION_RECEIPTS);
  assert.equal(pending.droppedReceipts, 1);
  assert.ok(pending.receipts.every(receipt => !receipt.handlerSettled));
  observations[0]!.operationSettled();
  const latest = journal.begin('task_answer', 'latest', 'f'.repeat(64));
  latest.bind('run', '/repo'); latest.callerAborted(); latest.operationSettled();
  const after = journal.read('run', '/repo');
  assert.equal(after.receipts.length, MAX_MCP_CANCELLATION_RECEIPTS);
  assert.equal(after.droppedReceipts, 2);
  assert.equal(after.receipts.at(-1)?.requestHash, 'f'.repeat(64));
});
