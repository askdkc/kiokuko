import assert from 'node:assert/strict';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import test from 'node:test';
import { OPENCODE_LOOP_GUARD_MARKER, renderOpenCodeLoopGuard } from '../../src/setup/opencode-loop-guard.js';

async function loadGuard() {
  const directory = await mkdtemp(path.join(tmpdir(), 'kiokuko-opencode-guard-'));
  const filePath = path.join(directory, 'guard.mjs');
  const rendered = renderOpenCodeLoopGuard(undefined);
  await writeFile(filePath, rendered.content);
  const module = await import(`${pathToFileURL(filePath).href}?test=${Date.now()}`) as {
    KiokukoLoopGuard: () => Promise<Record<string, (...args: any[]) => Promise<void>>>;
  };
  return module.KiokukoLoopGuard();
}

test('renders a managed OpenCode loop guard without overwriting an unmanaged file', () => {
  const created = renderOpenCodeLoopGuard(undefined);
  assert.equal(created.action, 'created');
  assert.ok(created.content.startsWith(OPENCODE_LOOP_GUARD_MARKER));
  assert.equal(renderOpenCodeLoopGuard(created.content).action, 'unchanged');
  assert.throws(() => renderOpenCodeLoopGuard('export const HumanPlugin = async () => ({})\n'), /unmanaged file/);
});

test('caps visible OpenCode agents at twelve steps while preserving stricter limits', async () => {
  const hooks = await loadGuard();
  const config = {
    agent: {
      custom: { steps: 30 },
      strict: { steps: 5 },
      summary: {},
      hidden: { hidden: true, steps: 30 },
    },
  };
  await hooks.config!(config);
  assert.equal(config.agent.custom.steps, 12);
  assert.equal(config.agent.strict.steps, 5);
  assert.equal('steps' in config.agent.summary, false);
  assert.equal(config.agent.hidden.steps, 30);
  for (const name of ['build', 'plan', 'general', 'explore', 'scout']) {
    assert.equal((config.agent as Record<string, { steps?: number }>)[name]?.steps, 12);
  }
});

test('allows task_prepare and memory_checkpoint only once per user request and closes tools after checkpoint', async () => {
  const hooks = await loadGuard();
  const before = hooks['tool.execute.before']!;
  const after = hooks['tool.execute.after']!;
  const chat = hooks['chat.message']!;
  const sessionID = 'session-1';

  await chat({ sessionID, messageID: 'message-1' }, {});
  await before({ tool: 'kiokuko_task_prepare', sessionID, callID: 'call-1' }, { args: { task: 'build' } });
  await assert.rejects(
    before({ tool: 'kiokuko_task_prepare', sessionID, callID: 'call-2' }, { args: { task: 'build' } }),
    /limited to once per user request/,
  );

  await chat({ sessionID, messageID: 'message-2' }, {});
  await before({ tool: 'mcp__kiokuko__task_prepare', sessionID, callID: 'call-3' }, { args: { task: 'build' } });
  await before({ tool: 'kiokuko_memory_checkpoint', sessionID, callID: 'call-4' }, { args: { memories: [] } });
  await after(
    { tool: 'kiokuko_memory_checkpoint', sessionID, callID: 'call-4', args: { memories: [] } },
    { title: 'checkpoint', output: 'stored', metadata: {} },
  );
  await assert.rejects(
    before({ tool: 'read', sessionID, callID: 'call-5' }, { args: { filePath: 'README.md' } }),
    /tool phase is closed/,
  );
  await assert.rejects(
    before({ tool: 'kiokuko_memory_checkpoint', sessionID, callID: 'call-6' }, { args: { memories: [] } }),
    /limited to once per user request/,
  );
});

test('blocks consecutive identical calls and repeated no-progress results', async () => {
  const hooks = await loadGuard();
  const before = hooks['tool.execute.before']!;
  const after = hooks['tool.execute.after']!;
  const chat = hooks['chat.message']!;
  const sessionID = 'session-repeat';

  await chat({ sessionID, messageID: 'message-repeat' }, {});
  for (let index = 0; index < 3; index += 1) {
    await before({ tool: 'read', sessionID, callID: `call-${index}` }, { args: { filePath: 'README.md' } });
  }
  await assert.rejects(
    before({ tool: 'read', sessionID, callID: 'call-4' }, { args: { filePath: 'README.md' } }),
    /fourth consecutive tool call with identical arguments/,
  );

  await chat({ sessionID, messageID: 'message-stagnant' }, {});
  for (let index = 0; index < 3; index += 1) {
    const input = { tool: 'grep', sessionID, callID: `grep-${index}`, args: { pattern: `missing-${index}` } };
    await before(input, { args: input.args });
    await after(input, { title: 'No matches', output: '', metadata: { matches: 0 } });
  }
  await assert.rejects(
    before({ tool: 'read', sessionID, callID: 'after-stagnation' }, { args: { filePath: 'README.md' } }),
    /three consecutive tool calls produced the same result/,
  );

  await chat({ sessionID, messageID: 'message-mutating' }, {});
  for (let index = 0; index < 4; index += 1) {
    const input = { tool: 'apply_patch', sessionID, callID: `patch-${index}`, args: { patch: `change-${index}` } };
    await before(input, { args: input.args });
    await after(input, { title: 'Applied', output: 'Done!', metadata: {} });
  }
});
