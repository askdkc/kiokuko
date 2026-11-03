import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { initializeDatabase } from '../../src/commands/init.js';
import { openConnection } from '../../src/db/connection.js';
import { handleCodexHook, parseCodexHookInput } from '../../src/assurance/codex-hooks.js';
import { renderCodexAssuranceHooks } from '../../src/setup/codex-hooks.js';
import { renderGlobalInstructions } from '../../src/setup/render.js';
import { renderManagedBlock } from '../../src/agent-file/render.js';
import { CHATGPT_MEMORY_POLICY } from '../../src/chatgpt/memory-policy.js';

function assertRecommendation(text: string): void {
  assert.match(text, /every session/iu);
  assert.match(text, /proactively recommend/iu);
  assert.match(text, /approval is required only before saving/iu);
  assert.match(text, /nothing useful/iu);
  assert.doesNotMatch(text, /propose reusable memory only with the user|permission to organize/iu);
}

test('generated project, global and ChatGPT guidance checks every session without a permission-to-propose gate', () => {
  assertRecommendation(renderGlobalInstructions('', 'codex').content);
  assertRecommendation(renderManagedBlock({ repositoryId: 'repo_test', workspace: 'project:test', cliCommand: 'kiokuko' }));
  assertRecommendation(CHATGPT_MEMORY_POLICY.instructions);
});

test('setup adds the session-start reminder and preserves foreign hooks on upgrade', () => {
  const foreign = { hooks: [{ type: 'command', command: 'echo user-hook' }] };
  const upgraded = JSON.parse(renderCodexAssuranceHooks(JSON.stringify({ hooks: { SessionStart: [foreign] } }), 'kiokuko', '/tmp/test.sqlite3'));
  assert.deepEqual(upgraded.hooks.SessionStart[0], foreign);
  assert.equal(upgraded.hooks.SessionStart.length, 2);
  const repeated = JSON.parse(renderCodexAssuranceHooks(JSON.stringify(upgraded), 'kiokuko', '/tmp/test.sqlite3'));
  assert.deepEqual(repeated, upgraded);
});

test('session reminders survive an unavailable database and compaction without writing anything', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'kiokuko-session-reminder-'));
  const databasePath = path.join(root, 'missing.sqlite3');
  const cli = fileURLToPath(new URL('../../dist/bin/kiokuko.js', import.meta.url));
  try {
    for (const event of ['SessionStart', 'PostCompact']) {
      const output = JSON.parse(execFileSync(process.execPath, [cli, 'codex-hook', '--database', databasePath], {
        encoding: 'utf8', input: JSON.stringify({ hook_event_name: event, session_id: 'session', cwd: root,
          ...(event === 'SessionStart' ? {} : { turn_id: 'resumed' }) }),
      }));
      assert.equal(output.hookSpecificOutput.hookEventName, event);
      assertRecommendation(output.hookSpecificOutput.additionalContext);
      assert.equal(existsSync(databasePath), false);
    }
    assert.throws(() => parseCodexHookInput({ hook_event_name: 'PreToolUse', session_id: 'session', cwd: root }),
      /Task assurance input is invalid/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('each session and prompt gets a recommendation check with no project run or memory write', async () => {
  const root = mkdtempSync(path.join(tmpdir(), 'kiokuko-recommendations-'));
  const databasePath = path.join(root, 'memory.sqlite3');
  await initializeDatabase({ databasePath });
  const db = openConnection(databasePath);
  try {
    for (const checkout of [false, true]) {
      if (checkout) execFileSync('git', ['init', '-q', root]);
      for (const session of ['first', 'second']) {
        for (const event of ['SessionStart', 'UserPromptSubmit']) {
          const output = handleCodexHook(db, { hook_event_name: event, session_id: session, cwd: root,
            ...(event === 'SessionStart' ? {} : { turn_id: `turn-${checkout}` }) }) as any;
          assertRecommendation(output.hookSpecificOutput.additionalContext);
          assert.equal(output.continue, undefined);
        }
      }
    }
    assert.equal(db.prepare('SELECT COUNT(*) n FROM entries').get<{ n: number }>()!.n, 0);
    assert.equal(db.prepare('SELECT COUNT(*) n FROM ledger_runs').get<{ n: number }>()!.n, 0);
  } finally { db.close(); rmSync(root, { recursive: true, force: true }); }
});
