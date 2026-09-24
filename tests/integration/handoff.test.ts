import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { initializeDatabase } from '../../src/commands/init.js';
import { openConnection } from '../../src/db/connection.js';
import { saveHandoff, loadHandoff, discardHandoff } from '../../src/memory/handoff.js';
import { createKiokukoMcpServer } from '../../src/mcp/server.js';
import { McpRuntimeOwner } from '../../src/mcp/runtime-owner.js';
import { prepareAgentTask } from '../../src/akinator/agent-task.js';
import { handleCodexHook } from '../../src/assurance/codex-hooks.js';
import { LedgerStore } from '../../src/ledger/store.js';

const capabilities = [{ kind: 'skill', name: 'kiokuko-soul' }, { kind: 'skill', name: 'memory-reasoning' }];

test('handoff survives reopening, updates only on new content, and expires after 24 hours', async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), 'kiokuko-handoff-'));
  const databasePath = path.join(root, 'db.sqlite3');
  await initializeDatabase({ databasePath });
  t.after(async () => rm(root, { recursive: true, force: true }));
  let now = new Date('2026-09-24T00:00:00.000Z');
  const options = { cwd: root, clientKind: 'codex', now: () => now };
  const state = { goal: 'Continue the current conversation', corrections: ['Use Japanese'] };
  const db = openConnection(databasePath);
  const create = { operationId: 'create', state };
  const first = await saveHandoff(db, create, options);
  assert.ok(first.enabled);
  assert.equal(first.outcome, 'created');
  assert.deepEqual(await saveHandoff(db, create, options), first);
  assert.throws(() => loadHandoff(db, { handoffId: first.handoffId, soulRead: true, capabilities }, { ...options, clientKind: 'claude' }), /unavailable/);
  const otherCwd = await mkdtemp(path.join(tmpdir(), 'kiokuko-handoff-other-'));
  t.after(async () => rm(otherCwd, { recursive: true, force: true }));
  assert.throws(() => loadHandoff(db, { handoffId: first.handoffId, soulRead: true, capabilities, cwd: otherCwd }, options), /unavailable/);
  const loaded = loadHandoff(db, { handoffId: first.handoffId, soulRead: true, capabilities }, options);
  assert.ok(loaded.state);
  assert.equal(loaded.state.state.goal, state.goal);
  assert.equal(loadHandoff(db, { handoffId: first.handoffId, soulRead: true, capabilities: [] }, options).state, null);
  now = new Date('2026-09-24T01:00:00.000Z');
  const same = await saveHandoff(db, { operationId: 'same', handoffId: first.handoffId, expectedRevision: 1, state }, options);
  assert.ok(same.enabled);
  assert.equal(same.outcome, 'unchanged');
  assert.equal(same.expiresAt, first.expiresAt);
  const revised = await saveHandoff(db, { operationId: 'update', handoffId: first.handoffId, expectedRevision: 1,
    state: { ...state, nextAction: 'Check the result' } }, options);
  assert.ok(revised.enabled);
  assert.equal(revised.revision, 2);
  assert.notEqual(revised.expiresAt, first.expiresAt);
  await assert.rejects(saveHandoff(db, { operationId: 'update', handoffId: first.handoffId, expectedRevision: 1, state }, options), /Idempotency key/);
  await assert.rejects(saveHandoff(db, { operationId: 'stale', handoffId: first.handoffId, expectedRevision: 1, state }, options), /revision/);
  db.close();
  const reopened = openConnection(databasePath);
  t.after(() => reopened.close());
  assert.equal(loadHandoff(reopened, { handoffId: first.handoffId, soulRead: true, capabilities }, options).revision, 2);
  now = new Date(revised.expiresAt);
  assert.throws(() => loadHandoff(reopened, { handoffId: first.handoffId, soulRead: true, capabilities }, options), /unavailable/);
  assert.deepEqual(await saveHandoff(reopened, create, options), first);
  assert.equal(reopened.prepare('SELECT COUNT(*) n FROM conversation_handoffs').get<{ n: number }>()!.n, 1);
});

test('handoff rejects secrets and oversized content; discard is revision-bound', async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), 'kiokuko-handoff-'));
  const databasePath = path.join(root, 'db.sqlite3');
  await initializeDatabase({ databasePath });
  const db = openConnection(databasePath);
  t.after(async () => { db.close(); await rm(root, { recursive: true, force: true }); });
  const options = { cwd: root, clientKind: 'codex' };
  await assert.rejects(saveHandoff(db, { operationId: 'secret', state: { goal: 'sk-123456789012345678901234567890123456' } }, options), /secret/i);
  await assert.rejects(saveHandoff(db, { operationId: 'oversize', state: { goal: 'x'.repeat(2000), decisions: Array(4).fill('x'.repeat(1200)) } }, options), /Invalid handoff/);
  await assert.rejects(saveHandoff(db, { operationId: 'unknown', state: { goal: 'G', transcript: 'raw' } }, options), /Invalid handoff/);
  const first = await saveHandoff(db, { operationId: 'first', state: { goal: 'G' } }, options);
  assert.ok(first.enabled);
  process.env.KIOKUKO_HANDOFF = 'off';
  try {
    assert.deepEqual(await saveHandoff(db, { operationId: 'off', state: { goal: 'Do not save' } }, options), { enabled: false });
    assert.ok(loadHandoff(db, { handoffId: first.handoffId, soulRead: true, capabilities }, options).state);
  } finally { delete process.env.KIOKUKO_HANDOFF; }
  assert.throws(() => discardHandoff(db, { operationId: 'wrong', handoffId: first.handoffId, expectedRevision: 2 }, options), /revision/);
  const removed = discardHandoff(db, { operationId: 'remove', handoffId: first.handoffId, expectedRevision: 1 }, options);
  assert.equal(removed.outcome, 'discarded');
  assert.deepEqual(discardHandoff(db, { operationId: 'remove', handoffId: first.handoffId, expectedRevision: 1 }, options), removed);
  assert.throws(() => loadHandoff(db, { handoffId: first.handoffId, soulRead: true, capabilities }, options), /unavailable/);
  assert.deepEqual(await saveHandoff(db, { operationId: 'first', state: { goal: 'G' } }, options), first);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM conversation_handoffs').get<{ n: number }>()!.n, 0);
});

test('concurrent updates cannot overwrite the winner', async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), 'kiokuko-handoff-race-'));
  const databasePath = path.join(root, 'db.sqlite3');
  await initializeDatabase({ databasePath });
  const db = openConnection(databasePath);
  t.after(async () => { db.close(); await rm(root, { recursive: true, force: true }); });
  const options = { cwd: root, clientKind: 'codex' };
  const first = await saveHandoff(db, { operationId: 'race-create', state: { goal: 'G' } }, options);
  assert.ok(first.enabled);
  const updates = await Promise.allSettled(['A', 'B'].map(goal => saveHandoff(db, {
    operationId: `race-${goal}`, handoffId: first.handoffId, expectedRevision: 1, state: { goal },
  }, options)));
  assert.equal(updates.filter(result => result.status === 'fulfilled').length, 1);
  assert.equal(updates.filter(result => result.status === 'rejected').length, 1);
  assert.equal(loadHandoff(db, { handoffId: first.handoffId, soulRead: true, capabilities }, options).revision, 2);
});

test('normal MCP startup removes expired handoff bodies', async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), 'kiokuko-handoff-cleanup-'));
  const databasePath = path.join(root, 'db.sqlite3');
  await initializeDatabase({ databasePath });
  const db = openConnection(databasePath);
  const options = { cwd: root, clientKind: 'codex', now: () => new Date('2020-01-01T00:00:00.000Z') };
  const saved = await saveHandoff(db, { operationId: 'old', state: { goal: 'Expired' } }, options);
  assert.ok(saved.enabled);
  db.close();
  const owner = new McpRuntimeOwner({ databasePath });
  t.after(async () => { await owner.close(); await rm(root, { recursive: true, force: true }); });
  await owner.withDatabase(database => {
    assert.equal(database.prepare('SELECT COUNT(*) n FROM conversation_handoffs').get<{ n: number }>()!.n, 0);
  });
});

test('four MCP client identities can save and load across a server restart', async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), 'kiokuko-handoff-mcp-'));
  const databasePath = path.join(root, 'db.sqlite3');
  t.after(async () => rm(root, { recursive: true, force: true }));
  const connect = async (name: string) => {
    const server = createKiokukoMcpServer({ databasePath, cwd: () => root });
    const client = new Client({ name, version: '1' });
    const [a, b] = InMemoryTransport.createLinkedPair();
    await server.connect(b); await client.connect(a);
    return { client, server };
  };
  for (const name of ['codex', 'opencode', 'claude-code', 'hermes']) {
    const first = await connect(name);
    let id = '';
    try {
      const tools = (await first.client.listTools()).tools;
      for (const tool of ['handoff_save', 'handoff_load', 'handoff_discard']) assert.ok(tools.some(item => item.name === tool));
      const saved = await first.client.callTool({ name: 'handoff_save', arguments: {
        operationId: `mcp-create-${name}`, state: { goal: 'Resume writing', nextAction: 'Continue' },
      } });
      assert.notEqual(saved.isError, true);
      id = (saved.structuredContent as { handoffId: string }).handoffId;
    } finally { await first.client.close(); await first.server.close(); }
    const second = await connect(name);
    try {
      const loaded = await second.client.callTool({ name: 'handoff_load', arguments: { handoffId: id, soulRead: true, capabilities } });
      assert.notEqual(loaded.isError, true);
      assert.match(JSON.stringify(loaded.structuredContent), /Resume writing/u);
      const discarded = await second.client.callTool({ name: 'handoff_discard', arguments: {
        operationId: `mcp-discard-${name}`, handoffId: id, expectedRevision: 1,
      } });
      assert.notEqual(discarded.isError, true);
    } finally { await second.client.close(); await second.server.close(); }
  }
});

test('run handoff preserves task status and Codex allows runless handoff tools', async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), 'kiokuko-handoff-run-'));
  const databasePath = path.join(root, 'db.sqlite3');
  execFileSync('git', ['init', '-q', root]);
  await initializeDatabase({ databasePath });
  const db = openConnection(databasePath);
  t.after(async () => { db.close(); await rm(root, { recursive: true, force: true }); });
  const common = { session_id: 'session', turn_id: 'turn', cwd: root };
  handleCodexHook(db, { ...common, hook_event_name: 'UserPromptSubmit' });
  for (const tool of ['handoff_save', 'handoff_load', 'handoff_discard']) {
    assert.deepEqual(handleCodexHook(db, { ...common, hook_event_name: 'PreToolUse', tool_name: `mcp__kiokuko__${tool}`,
      tool_use_id: tool, tool_input: {} }), {});
  }
  assert.equal((handleCodexHook(db, { ...common, hook_event_name: 'PreToolUse', tool_name: 'apply_patch',
    tool_use_id: 'edit', tool_input: {} }) as { hookSpecificOutput: { permissionDecision: string } }).hookSpecificOutput.permissionDecision, 'deny');
  const prepared = await prepareAgentTask(db, { requestId: 'handoff-run', task: 'Check project status', cwd: root,
    capabilities, profileHints: { taskType: 'analysis', target: 'project status', expected: 'record the status' }, skillDiscoveryMode: 'off',
    client: { kind: 'codex' } });
  const runId = prepared.run.runId;
  const options = { cwd: root, clientKind: 'codex' };
  await assert.rejects(saveHandoff(db, { operationId: 'run-no-cap', runId, state: { goal: 'Check project status' } }, options), /Capability catalog/);
  const saved = await saveHandoff(db, { operationId: 'run-save', runId, capabilities, state: { goal: 'Check project status' } }, options);
  assert.ok(saved.enabled);
  const loaded = loadHandoff(db, { handoffId: saved.handoffId, soulRead: true, capabilities }, options);
  assert.equal(loaded.run?.runId, runId);
  assert.equal(loaded.run?.status, 'active');
  assert.equal(new LedgerStore(db).readRun(runId)?.status, 'active');
  new LedgerStore(db).updateRunStatusInTransaction(runId, 'interrupted', new Date().toISOString());
  assert.equal(loadHandoff(db, { handoffId: saved.handoffId, soulRead: true, capabilities }, options).run?.status, 'interrupted');
  await assert.rejects(saveHandoff(db, { operationId: 'run-change', handoffId: saved.handoffId, expectedRevision: 1,
    runId, capabilities, state: { goal: 'Continue' } }, options), /Context run|active|terminal|unavailable/i);
});
