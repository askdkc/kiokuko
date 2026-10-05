import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { openConnection } from '../../src/db/connection.js';
import { getGlobalDatabasePath } from '../../src/config/paths.js';

const capabilities = [{ kind: 'skill', name: 'kiokuko-soul' }, { kind: 'skill', name: 'memory-reasoning' }];
const preference = { kind: 'preference', title: 'Japanese grammar', body: 'Japanese grammar: two train examples before terminology.',
  scope: 'global', subjects: ['Japanese grammar'], portableReason: 'Applies to grammar explanations across projects.', basis: 'user_statement' };

test('fresh stdio processes preserve correction chains, replay, conflict, disable and purge boundaries', { timeout: 45_000 }, async (t) => {
  const data = await mkdtemp(path.join(tmpdir(), 'kiokuko-process-correction-'));
  t.after(() => rm(data, { recursive: true, force: true }));
  const env = { PATH: process.env.PATH ?? '', KIOKUKO_DATA_DIR: data, KIOKUKO_EMBEDDINGS: 'off', KIOKUKO_SKILL_DISCOVERY: 'off' };
  async function call(name: string, args: Record<string, unknown>, overrides: Record<string, string> = {}) {
    const client = new Client({ name: 'correction-process-test', version: '1' });
    const transport = new StdioClientTransport({ command: process.execPath,
      args: ['--import', 'tsx', 'src/bin/kiokuko.ts', 'mcp'], env: { ...env, ...overrides }, stderr: 'pipe' });
    try {
      await client.connect(transport);
      return await client.callTool({ name, arguments: args }, undefined, { timeout: 10_000 });
    } finally { await client.close(); }
  }
  const capture = (operationId: string, memories: unknown[]) => call('memory_capture', { operationId, memories });
  const payload = (response: Awaited<ReturnType<typeof call>>) => {
    assert.notEqual(response.isError, true, JSON.stringify(response));
    return response.structuredContent as { enabled: boolean; items: Array<{ entryId: string; revision: number; outcome: string; availability: string }> };
  };
  const a = payload(await capture('A', [preference])).items[0]!;
  const bMemory = { ...preference, body: 'Japanese grammar: terminology first, then one cooking example.', basis: 'user_correction',
    replaces: { entryId: a.entryId, expectedRevision: a.revision } };
  const b = payload(await capture('B', [bMemory])).items[0]!;
  assert.equal(b.outcome, 'corrected');
  const cMemory = { ...bMemory, body: 'Japanese grammar: two shopping examples before terminology.',
    replaces: { entryId: b.entryId, expectedRevision: b.revision } };
  const c = payload(await capture('C', [cMemory])).items[0]!;
  assert.equal(c.outcome, 'corrected');
  assert.equal(c.availability, 'current');
  assert.deepEqual(payload(await capture('C', [cMemory])).items[0], c);
  for (const query of ['Japanese grammar', 'Japanese grammar trains cooking']) {
    const recall = await call('memory_recall', { soulRead: true, capabilities, query });
    assert.notEqual(recall.isError, true);
    const items = (recall.structuredContent as { items: Array<{ entryId: string }> }).items;
    assert.ok(items.some((item) => item.entryId === c.entryId));
    assert.ok(items.every((item) => item.entryId !== a.entryId && item.entryId !== b.entryId));
  }
  assert.equal((await capture('C', [{ ...cMemory, body: 'Changed payload' }])).isError, true);
  assert.equal((await capture('stale', [preference, bMemory])).isError, true);
  const disabled = await call('memory_capture', { operationId: 'disabled', memories: [preference] }, { KIOKUKO_INTERACTION_MEMORY: 'off' });
  assert.deepEqual(disabled.structuredContent, { enabled: false, items: [] });
  const database = openConnection(getGlobalDatabasePath({ env }), { readOnly: true });
  try {
    const rows = database.prepare('SELECT id, status, trust_level FROM entries ORDER BY id').all<{ id: string; status: string; trust_level: string }>();
    assert.equal(rows.length, 3, 'Rejected batch and disabled capture must not create entries');
    assert.equal(rows.find((row) => row.id === c.entryId)?.status, 'candidate');
    assert.ok(rows.every((row) => row.trust_level === 'untrusted'));
    assert.ok(rows.filter((row) => row.id !== c.entryId).every((row) => row.status === 'superseded'));
  } finally { database.close(); }
  // Superseded entries hold foreign keys to their replacements. Purge the
  // fixture's chain in reference order; do not bypass that history constraint.
  for (const entry of [a, b, c]) {
    execFileSync(process.execPath, ['--import', 'tsx', 'src/bin/kiokuko.ts', 'purge', entry.entryId, '--workspace', 'global', '--confirm', '--json'], { env, encoding: 'utf8' });
  }
  assert.equal(payload(await capture('C', [cMemory])).items[0]!.availability, 'unavailable');
  const afterPurge = await call('memory_recall', { soulRead: true, capabilities, query: 'Japanese grammar' });
  assert.deepEqual((afterPurge.structuredContent as { items: unknown[] }).items, []);
});
