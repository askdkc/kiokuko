import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { acceptCodexToolHook, runCodexNestedTool } from '../fixtures/codex-hook-output.mjs';

// Use the installed CLI and MCP server across separate hook processes. The
// lifecycle events are a host fixture, not evidence of an active desktop reload.
export async function verifyInstalledMissingPromptRecovery(installedRoot, fixtureRoot, options = {}) {
  const root = path.join(fixtureRoot, 'repo');
  const data = path.join(fixtureRoot, 'data');
  await mkdir(root, { recursive: true });
  await mkdir(data, { recursive: true });
  execFileSync('git', ['init', '-q', root]);
  await writeFile(path.join(root, 'source.ts'), 'export const value = 1;\n');
  const cli = path.join(installedRoot, 'dist/bin/kiokuko.js');
  const database = path.join(data, 'kiokuko.sqlite3');
  const env = { ...process.env, KIOKUKO_DATA_DIR: data, KIOKUKO_SKILL_DISCOVERY: 'off' };
  execFileSync(process.execPath, [options.managementCli ?? cli, 'init', '--json'], { env });
  let common = { session_id: 'installed-missing-prompt', turn_id: 'previous', cwd: root };
  const hookProcess = event => spawnSync(options.runtimeNode ?? process.execPath, [cli, 'codex-hook', '--database', database], {
    env, cwd: root, input: JSON.stringify({ ...common, ...event }), encoding: 'utf8', timeout: 10000,
  });
  const hook = event => {
    const result = hookProcess(event);
    assert.equal(result.status, 0, result.stderr);
    return ['PreToolUse', 'PostToolUse'].includes(event.hook_event_name)
      ? acceptCodexToolHook(result.stdout, event.hook_event_name) : JSON.parse(result.stdout);
  };
  const client = new Client({ name: 'codex', version: 'missing-prompt-fixture' });
  const transport = new StdioClientTransport({ command: options.runtimeNode ?? process.execPath, args: [cli, 'mcp'], cwd: root, env, stderr: 'pipe' });
  await client.connect(transport);
  let calls = 0;
  const call = (name, args) => runCodexNestedTool(hookProcess,
    { tool_name: `mcp__kiokuko__${name}`, tool_use_id: `${common.turn_id}-${name}-${calls++}`, tool_input: args },
    () => client.callTool({ name, arguments: args }));
  const capabilities = [{ kind: 'skill', name: 'kiokuko-soul' }, { kind: 'skill', name: 'memory-reasoning' }];
  const prepare = requestId => call('task_prepare', { cwd: root, requestId, soulRead: true, capabilities,
    task: 'Repair the source.ts fixture', profileHints: { taskType: 'debug', target: 'source.ts',
      expected: 'The fixture command runs', constraints: 'Preserve unrelated files' } });
  try {
    const prompt = hook({ hook_event_name: 'UserPromptSubmit' });
    const previousId = /Kiokuko request (codex-[0-9a-f]{64})/u.exec(prompt.hookSpecificOutput.additionalContext)[1];
    const previous = await prepare(previousId);
    assert.notEqual(previous.isError, true);
    hook({ hook_event_name: 'Interrupt' });
    common = { ...common, turn_id: 'resumed-without-prompt' };
    let executions = 0;
    await assert.rejects(runCodexNestedTool(hookProcess, {
      tool_name: 'mcp__kiokuko__task_prepare', tool_use_id: 'stale-prepare', tool_input: { cwd: root, requestId: previousId },
    }, async () => { executions++; }), /Current Kiokuko request codex-[0-9a-f]{64}.*in this turn/u);
    assert.equal(executions, 0);
    const missing = hook({ hook_event_name: 'PreToolUse', agent_id: 'fresh-child',
      tool_name: 'exec_command', tool_use_id: 'unprepared-child', tool_input: { cmd: 'true' } });
    assert.equal(missing.hookSpecificOutput.permissionDecision, 'deny');
    // The parent binding must not be borrowed even when its ID is supplied.
    const childMismatch = hook({ hook_event_name: 'PreToolUse', agent_id: 'fresh-child',
      tool_name: 'mcp__kiokuko__task_prepare', tool_use_id: 'foreign-prepare', tool_input: { cwd: root, requestId: previousId } });
    assert.match(childMismatch.systemMessage, /stopped this turn/u);
    const inspection = await call('task_inspect', { cwd: root, operation: 'skill' });
    assert.notEqual(inspection.isError, true);
    await call('task_inspect', { cwd: root, operation: 'skill', path: 'kiokuko-codex-memory-reasoning' });
    const blocked = hook({ hook_event_name: 'PreToolUse', tool_name: 'exec_command', tool_use_id: 'unprepared', tool_input: { cmd: 'true' } });
    assert.equal(blocked.hookSpecificOutput.permissionDecision, 'deny');
    const requestId = /requestId (codex-[0-9a-f]{64})/u.exec(blocked.systemMessage)[1];
    assert.notEqual(requestId, previousId);
    const prepared = await prepare(requestId);
    assert.notEqual(prepared.isError, true);
    assert.equal(prepared.structuredContent.nextAction, 'proceed');
    assert.notEqual(prepared.structuredContent.run.runId, previous.structuredContent.run.runId);
    const command = { tool_name: 'exec_command', tool_use_id: 'prepared-command', tool_input: { cmd: 'fixture command' } };
    const completed = await runCodexNestedTool(hookProcess, command, async () => {
      executions++;
      const result = spawnSync(process.execPath, ['-e', 'process.stdout.write("accepted")'], { encoding: 'utf8', cwd: root });
      return { exit_code: result.status, output: result.stdout };
    });
    assert.deepEqual(completed, { exit_code: 0, output: 'accepted' });
    assert.equal(executions, 1);
    hook({ hook_event_name: 'Interrupt' });
    await assert.rejects(prepare(requestId), /interrupted/u);
  } finally { await client.close(); }
}
