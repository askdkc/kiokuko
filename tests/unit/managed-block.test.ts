import assert from 'node:assert/strict';
import test from 'node:test';
import { BEGIN_MARKER, END_MARKER, upsertManagedBlock } from '../../src/agent-file/managed-block.js';

const block = `${BEGIN_MARKER}\nmanaged\n${END_MARKER}`;

test('adds a managed block without changing existing content', () => {
  const result = upsertManagedBlock('header\n', block);
  assert.equal(result.action, 'created');
  assert.match(result.content, /^header\n\n\n<!-- BEGIN KIOKUKO MANAGED BLOCK -->/);
  assert.match(result.content, /managed/);
});

test('updates only a balanced block and is idempotent', () => {
  const original = `before\n${block}\nafter\n`;
  const updated = upsertManagedBlock(original, `${BEGIN_MARKER}\nnew\n${END_MARKER}`);
  assert.equal(updated.content, `before\n${BEGIN_MARKER}\nnew\n${END_MARKER}\nafter\n`);
  assert.equal(upsertManagedBlock(updated.content, `${BEGIN_MARKER}\nnew\n${END_MARKER}`).action, 'unchanged');
});

test('preserves CRLF outside the managed block', () => {
  const original = `before\r\n${block.replaceAll('\n', '\r\n')}\r\nafter\r\n`;
  const updated = upsertManagedBlock(original, `${BEGIN_MARKER}\nchanged\n${END_MARKER}`);
  assert.match(updated.content, /before\r\n/);
  assert.match(updated.content, /changed\r\n/);
  assert.match(updated.content, /after\r\n$/);
});

test('rejects malformed marker pairs without repairing them', () => {
  assert.throws(() => upsertManagedBlock(`${BEGIN_MARKER}\nonly start`, block), /malformed/i);
  assert.throws(() => upsertManagedBlock(`${block}\n${block}`, block), /malformed/i);
});
