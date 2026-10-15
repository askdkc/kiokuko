import { completeVerification } from '../../scripts/verification-completion.mjs';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { openConnection } from '../../dist/db/connection.js';
import { getGlobalDatabasePath } from '../../dist/config/paths.js';
import { createApprovedReplayMemoryStore } from '../../dist/memory/replay-store.js';
import { reviewCompletedReplay } from '../../dist/memory/replay-review.js';
import { toolData } from '../../scripts/lib/interaction-live-session.mjs';

assert.deepEqual(toolData({ result: { structured_content: { code: 'VALIDATION_ERROR' } } }), { code: 'VALIDATION_ERROR' });
assert.deepEqual(toolData({ result: { structuredContent: { enabled: true } } }), { enabled: true });
assert.deepEqual(toolData({ result: { content: [{ type: 'text', text: '{"items":[]}' }] } }), { items: [] });

const root = process.cwd();
const fixture = await mkdtemp(path.join(tmpdir(), 'kiokuko-fault-smoke-'));
const memory = { kind: 'preference', title: 'Japanese grammar', body: 'Use train examples for Japanese grammar.', scope: 'global',
  subjects: ['Japanese grammar'], portableReason: 'Grammar preferences apply across projects.', basis: 'user_statement' };
const capabilities = [{ kind: 'skill', name: 'kiokuko-soul' }, { kind: 'skill', name: 'memory-reasoning' }];
try {
  const env = { PATH: process.env.PATH, KIOKUKO_DATA_DIR: path.join(fixture, 'mcp'), KIOKUKO_EMBEDDINGS: 'off', KIOKUKO_SKILL_DISCOVERY: 'off' };
  // A reconnect or retry must never turn a model's capture into human consent.
  for (let restart = 0; restart < 2; restart++) {
    const client = new Client({ name: 'fault-harness-test', version: '1' });
    const transport = new StdioClientTransport({ command: process.execPath,
      args: [path.join(root, 'dist/bin/kiokuko.js'), 'mcp'], env, stderr: 'pipe' });
    try {
      await client.connect(transport);
      for (const basis of ['user_statement', 'user_correction']) {
        const result = await client.callTool({ name: 'memory_capture', arguments: { operationId: 'save', memories: [{ ...memory, basis }] } });
        assert.deepEqual(result.structuredContent, { accepted: false, recorded: false, workMayContinue: true, warnings: ['post_task_review_required'] });
      }
      const recall = await client.callTool({ name: 'memory_recall', arguments: { soulRead: true, capabilities, query: 'Japanese grammar' } });
      assert.deepEqual(recall.structuredContent.items, []);
    } finally { await client.close(); }
  }
  const unchanged = openConnection(getGlobalDatabasePath({ env }), { readOnly: true });
  try { assert.equal(unchanged.prepare('SELECT COUNT(*) AS n FROM entries').get().n, 0); } finally { unchanged.close(); }
  for (const fault of ['response-loss', 'uncommitted']) {
    const file = path.join(fixture, `${fault}.sqlite3`), db = openConnection(file);
    let injected = false, retained;
    const adapter = { filePath: db.filePath, close: () => db.close(), prepare: db.prepare.bind(db), exec(sql) {
      if (fault === 'uncommitted' && ['COMMIT', 'ROLLBACK'].includes(sql)) { injected = true; throw new Error('before SQL execution'); }
      db.exec(sql);
      if (fault === 'response-loss' && sql === 'COMMIT' && !injected) { injected = true; throw new Error('lost commit acknowledgement'); }
    } };
    try {
      const proposal = { schemaVersion: 1, proposalId: 'initial', revision: 1,
        source: { workspace: 'fixture', taskId: 'task', sessionId: 'session', traces: [] },
        request: { text: 'Check SQLite recovery', evidenceRefs: [] }, languages: [], attempts: [],
        findings: [{ kind: 'key_point', text: 'Read exact approved identity after uncertain commit', basis: 'inferred', evidenceRefs: [] }],
        tags: ['sqlite'], keywords: ['recovery'] };
      const result = await reviewCompletedReplay({ completed: true, workspace: 'fixture', taskId: 'task', sessionId: 'session',
        extract: async () => proposal, ask: async question => ({ questionId: question.id, choice: question.phase === 'organize' ? 'organize' : 'approve' }),
        onApproved: (p, key) => { retained = { p, key }; }, save: async (p, key) => createApprovedReplayMemoryStore(adapter, 'fixture').save(p, key) });
      assert.equal(injected, true);
      assert.ok(retained);
      assert.equal(result.status, fault === 'response-loss' ? 'saved' : 'unavailable');
      const observer = openConnection(file, { readOnly: true });
      try { const count = observer.prepare("SELECT 1 FROM sqlite_master WHERE name='replay_memories'").get() ? observer.prepare('SELECT COUNT(*) AS n FROM replay_memories').get().n : 0; assert.equal(count, fault === 'response-loss' ? 1 : 0); } finally { observer.close(); }
      if (fault === 'uncommitted') db.exec('ROLLBACK');
      assert.equal(createApprovedReplayMemoryStore(db, 'fixture').reconcile(retained.p, retained.key), fault === 'response-loss' ? 'saved' : 'unavailable');
      console.log(`${fault}: exact approved identity reconciled without a write retry`);
    } finally { db.close(); }
  }
} finally { await rm(fixture, { recursive: true, force: true }); }

completeVerification({});
