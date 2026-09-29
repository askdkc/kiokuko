import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { buildCli } from '../../src/cli.js';
import { CHATGPT_MEMORY_POLICY, chatgptPolicyError } from '../../src/chatgpt/memory-policy.js';
import { chatgptPolicyInputSchema, chatgptRecallInputSchema } from '../../src/mcp/chatgpt-contract.js';

test('policy digest and version come from one bundled source; attestation is exact', () => {
  const source = JSON.parse(readFileSync(new URL('../../templates/chatgpt/memory-policy.json', import.meta.url), 'utf8'));
  assert.equal(CHATGPT_MEMORY_POLICY.instructions, source.instructions);
  assert.equal(CHATGPT_MEMORY_POLICY.policyVersion, source.version);
  assert.equal(CHATGPT_MEMORY_POLICY.policyDigest, createHash('sha256').update(source.instructions).digest('hex'));
  const policy = { version: source.version, digest: CHATGPT_MEMORY_POLICY.policyDigest, read: true };
  assert.equal(chatgptPolicyError(policy), undefined);
  for (const invalid of [undefined, {}, { ...policy, read: false }, { read: true }]) {
    assert.equal(chatgptPolicyError(invalid), 'POLICY_REQUIRED');
  }
  for (const invalid of [{ ...policy, version: 'old' }, { ...policy, digest: '0'.repeat(64) }]) {
    assert.equal(chatgptPolicyError(invalid), 'POLICY_VERSION_MISMATCH');
  }
});

test('remote schemas enforce limits and reject local authority and unknown fields', () => {
  assert.equal(chatgptRecallInputSchema.parse({ query: 'memory' }).limit, 8);
  assert.equal(chatgptRecallInputSchema.parse({ query: 'memory' }).maxContextChars, 4000);
  for (const extra of [
    { query: '' }, { query: 'x'.repeat(4001) }, { limit: 0 }, { limit: 21 },
    { maxContextChars: 99 }, { maxContextChars: 12001 }, { subjects: [] },
    { subjects: ['x'.repeat(81)] }, { subjects: ['a', 'b', 'c', 'd', 'e', 'f'] },
    ...['scope', 'workspace', 'cwd', 'databasePath', 'capabilities', 'runId', 'access', 'client', 'soulRead'].map(key => ({ [key]: 'forbidden' })),
    { policy: { extra: true } },
  ]) assert.equal(chatgptRecallInputSchema.safeParse({ query: 'memory', ...extra }).success, false);
  assert.equal(chatgptPolicyInputSchema.safeParse({ cwd: '/private' }).success, false);
});

test('CLI rejects invalid and unsupported profile/access combinations before opening a database', async () => {
  for (const args of [
    ['--profile', 'other'], ['--access', 'read'], ['--access', 'read-write'],
    ['--profile', 'chatgpt-memory', '--access', 'other'],
  ]) await assert.rejects(buildCli().parseAsync(['node', 'kiokuko', 'mcp', ...args]), { code: 'USAGE_ERROR' });
});
