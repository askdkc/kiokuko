import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createKiokukoMcpServer } from '../../src/mcp/server.js';
import type { PreparedAgentTask } from '../../src/akinator/agent-task.js';

test('public preparation delivers the complete required coding core without catalog similarity or a local routine', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'kiokuko-coding-routine-'));
  const cwd = path.join(root, 'repo');
  execFileSync('git', ['init', '-q', cwd]);
  const server = createKiokukoMcpServer({ databasePath: path.join(root, 'memory.sqlite3'), cwd: () => cwd });
  const client = new Client({ name: 'codex', version: 'coding-routine-test' });
  const [ct, st] = InMemoryTransport.createLinkedPair();
  await server.connect(st); await client.connect(ct);
  // No routine descriptor: the package supplies its own required core.
  const capabilities = [{ kind: 'skill', name: 'kiokuko-codex-soul' }];
  const call = async (name: string, args: Record<string, unknown>) => {
    const response = await client.callTool({ name, arguments: { cwd, capabilities, ...args } });
    assert.notEqual(response.isError, true, JSON.stringify(response));
    const content = response.content as Array<{ text: string }>;
    assert.deepEqual(JSON.parse(content[0]!.text), JSON.parse(JSON.stringify(response.structuredContent)));
    return response.structuredContent as unknown as PreparedAgentTask;
  };
  const expected = await readFile(new URL('../../skills/coding-ideal-routine-skill/SKILL.md', import.meta.url), 'utf8');
  const verify = (response: PreparedAgentTask) => {
    assert.ok(response.codingRoutine, 'coding preparation must load the bundled core automatically');
    assert.equal(response.codingRoutine.required, true);
    assert.equal(response.codingRoutine.name, 'coding-ideal-routine-skill');
    assert.equal(response.codingRoutine.text, expected);
    assert.equal(response.codingRoutine.contentHash, createHash('sha256').update(expected).digest('hex'));
    assert.match(response.codingRoutine.applyWhen, /intake.*memory review/u);
  };
  try {
    for (const [taskType, task, target] of [
      ['build', 'Add persistence', 'src/settings.ts'],
      ['debug', '保存後に値が消える不具合を修正', 'settings'],
      ['analysis', 'Plan a code refactor', 'src/parser.ts'],
      ['writing', 'Write a Python function', 'src/settings.py'],
    ]) {
      verify(await call('task_prepare', { requestId: `ready-${taskType}`, soulRead: true, task,
        profileHints: { taskType, target, expected: 'requested behavior is verified' }, maxContextChars: 1000 }));
    }
    const pending = await call('task_prepare', { requestId: 'pending', soulRead: true, task: 'Implement persistence',
      profileHints: { taskType: 'build' }, maxContextChars: 1000 });
    assert.equal(pending.intake.status, 'needs_answer');
    assert.equal(pending.codingRoutine, undefined, 'do not enter the coding route before intake');
    let current = pending;
    while (current.intake.status === 'needs_answer') {
      const q = current.intake.question;
      assert.ok(q);
      current = await call('task_answer', { runId: current.run.runId, sessionId: current.intake.sessionId,
        questionId: q.id, value: q.id === 'target' ? 'src/settings.ts' : 'saved settings survive restart', maxContextChars: 1000 });
    }
    verify(current);
    for (const [taskType, task, constraints] of [
      ['writing', 'Write a project announcement', null],
      ['research', 'Explain how this code works', 'no code changes'],
      ['build', 'Update documentation only', 'documentation only'],
    ]) {
      const response = await call('task_prepare', { requestId: `noncoding-${taskType}`, soulRead: true, task,
        profileHints: { taskType, target: 'README.md', expected: 'answer the request', constraints } });
      assert.equal(response.codingRoutine, undefined);
    }
  } finally {
    await client.close(); await server.close(); await rm(root, { recursive: true, force: true });
  }
});
