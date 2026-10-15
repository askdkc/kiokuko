import { defineTaskVerification, recordTaskVerification } from '../../src/assurance/verification.js';
import assert from 'node:assert/strict';
import test from 'node:test';
import { buildCli } from '../../src/cli.js';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, symlinkSync, unlinkSync, realpathSync, truncateSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { execFileSync, spawnSync } from 'node:child_process';
import { spawn } from 'node:child_process';
import { initializeDatabase } from '../../src/commands/init.js';
import { runDoctor } from '../../src/commands/doctor.js';
import { openConnection } from '../../src/db/connection.js';
import { prepareAgentTask, answerAgentTask } from '../../src/akinator/agent-task.js';
import { inspectTask } from '../../src/assurance/inspect.js';
import { resolveProjectWorkspace } from '../../src/memory/workspaces.js';
import { recordEntry, updateCandidateEntry } from '../../src/memory/entries.js';
import { assuranceState, reviewTaskMemory, recordTaskEvidence, taskAssuranceReport, taskMemoryStatus, assertAssuranceCompletion, memoryReviewNextAction } from '../../src/assurance/service.js';
import { repositoryStateDigest } from '../../src/assurance/snapshot.js';
import { codexHookCorrelationId, codexHookFailureCode, handleCodexHook, observedExitCode } from '../../src/assurance/codex-hooks.js';
import { codexHookDiagnostics } from '../../src/assurance/hook-diagnostics.js';
import { KiokukoError } from '../../src/errors.js';
import { LedgerStore } from '../../src/ledger/store.js';
import { refreshTaskMemory } from '../../src/assurance/refresh.js';
import { acceptCodexToolHook, runCodexNestedTool } from '../fixtures/codex-hook-output.mjs';
const caps = [{ kind: 'skill', name: 'kiokuko-soul' }, { kind: 'skill', name: 'memory-reasoning' }];
function lastHookDiagnostic(db: ReturnType<typeof openConnection>): any {
  const row = db.prepare('SELECT response_shape FROM codex_hook_observations ORDER BY rowid DESC LIMIT 1').get<{ response_shape: string }>()!;
  return (codexHookDiagnostics(db, JSON.parse(row.response_shape).call) as any).events.at(-1);
}
function assertMemoryAdvisory(value: any): void {
  assert.notEqual(value.hookSpecificOutput?.permissionDecision, 'deny');
  assert.notEqual(value.hookSpecificOutput?.permissionDecision, 'allow');
  assert.notEqual(value.continue, false);
  assert.equal(typeof value.systemMessage, 'string');
}
test('checkout-free inquiry permits global memory and bundled Skills, without permitting project execution', async () => {
  const base = mkdtempSync(path.join(tmpdir(), 'kiokuko-checkout-free-'));
  const databasePath = path.join(base, 'memory.sqlite3');
  await initializeDatabase({ databasePath });
  const db = openConnection(databasePath);
  const common = { session_id: 'inquiry', turn_id: 'outside', cwd: base };
  try {
    const prompt = handleCodexHook(db, { ...common, hook_event_name: 'UserPromptSubmit' }) as any;
    assert.match(prompt.hookSpecificOutput.additionalContext, /memory_recall/u);
    for (const name of ['memory_recall', 'memory_capture', 'task_inspect']) {
      assert.deepEqual(handleCodexHook(db, { ...common, hook_event_name: 'PreToolUse', tool_name: `mcp__kiokuko__${name}`,
        tool_use_id: name, tool_input: name === 'task_inspect' ? { operation: 'skill', cwd: base } : {} }), {});
    }
    for (const [name, args] of [['exec_command', { cmd: 'true' }], ['mcp__kiokuko__task_prepare', { cwd: base }],
      ['mcp__kiokuko__task_inspect', { cwd: base, operation: 'read', path: 'memory.sqlite3' }]] as const) {
      const result = handleCodexHook(db, { ...common, hook_event_name: 'PreToolUse', tool_name: name, tool_use_id: name, tool_input: args }) as any;
      if (name === 'exec_command') assertMemoryAdvisory(result);
      else { assert.equal(result.hookSpecificOutput.permissionDecision, 'deny'); assert.equal(lastHookDiagnostic(db).reason, 'repository_required'); }
    }
    assert.deepEqual(handleCodexHook(db, { ...common, hook_event_name: 'Stop' }), {});
    assert.equal(db.prepare('SELECT COUNT(*) count FROM task_execution_evidence').get<{ count: number }>()!.count, 0);
    assert.equal(db.prepare('SELECT COUNT(*) count FROM codex_hook_requests').get<{ count: number }>()!.count, 0);
  } finally { db.close(); rmSync(base, { recursive: true, force: true }); }
});
async function fixture() {
  const base = mkdtempSync(path.join(tmpdir(), 'kiokuko-assurance-'));
  const root = path.join(base, 'repo');
  execFileSync('git', ['init', '-q', root]);
  writeFileSync(path.join(root, 'source.ts'), 'export const versions = [1,2,3];\n');
  const databasePath = path.join(base, 'memory.sqlite3');
  await initializeDatabase({ databasePath });
  const db = openConnection(databasePath);
  const project = await resolveProjectWorkspace(db, root);
  assert.ok(project);
  const entry = recordEntry(db, { workspace: project.workspace, kind: 'decision', title: 'migration expectations', body: 'Derive migration expectations from the bundled migration list; next migration must not need a fixed array update.', tags: ['migration', 'source.ts'], confidence: 0.8 });
  const prepared = await prepareAgentTask(db, { cwd: root, requestId: 'test-request', task: 'Implement migration expectations', capabilities: caps, skillDiscoveryMode: 'off', profileHints: {
    taskType: 'build', target: 'source.ts migration expectations code', expected: 'next migration tests pass', constraints: 'preserve historical fixtures',
  } });
  return { base, root, db, entry, prepared, databasePath };
}
test('requires current memory decisions and passing evidence, persists across restart, rejects stale/reused evidence', async () => {
  const f = await fixture();
  let db = f.db;
  try {
    const runId = f.prepared.run.runId;
    const deliveryId = f.prepared.context!.deliveryId!;
    assert.ok(deliveryId);
    assert.equal(taskAssuranceReport(db, runId).complete, false);
    assert.throws(() => assertAssuranceCompletion(db, runId, 'completed'), /incomplete/);
    const review = { runId, requestId: 'review', expectedRevision: taskAssuranceReport(db, runId).revision!, cwd: f.root,
      deliveryId, entryId: f.entry.id, entryRevision: f.entry.revision, decision: 'adopted', basis: 'source.ts contains a fixed current-migration array',
      invariant: 'Adding the next migration requires no expectation update', counterexample: 'Add migration 004 in an isolated fixture', verification: 'Run the next-migration fixture', evidenceIds: [] };
    const reviewed = reviewTaskMemory(db, review);
    assert.deepEqual(reviewTaskMemory(db, review), reviewed);
    assert.throws(() => reviewTaskMemory(db, { ...review, basis: 'different input' }), /reused/);
    assert.equal(taskAssuranceReport(db, runId).complete, false);
    const failed = recordTaskEvidence(db, { runId, requestId: 'failed', expectedRevision: reviewed.revision, cwd: f.root, deliveryId,
      execution: 'next-migration fixture', stateDigest: repositoryStateDigest(f.root), outcome: 'failed', exitCode: 1 });
    reviewTaskMemory(db, { ...review, requestId: 'failed-review', expectedRevision: failed.revision, evidenceIds: [failed.evidenceId] });
    assert.throws(() => assertAssuranceCompletion(db, runId, 'completed'), /incomplete/);
    assert.doesNotThrow(() => assertAssuranceCompletion(db, runId, 'failed'));
    writeFileSync(path.join(f.root, 'source.ts'), 'export const versions = loadMigrationSnapshot().migrations.map(m => m.version);\n');
    const passed = recordTaskEvidence(db, { runId, requestId: 'passed', expectedRevision: taskAssuranceReport(db, runId).revision!, cwd: f.root, deliveryId,
      execution: 'next-migration fixture', stateDigest: repositoryStateDigest(f.root), outcome: 'passed', exitCode: 0 });
    reviewTaskMemory(db, { ...review, requestId: 'passed-review', expectedRevision: passed.revision, evidenceIds: [passed.evidenceId] });
    assert.equal(taskAssuranceReport(db, runId).complete, true);
    assert.equal(taskAssuranceReport(db, runId).observed, false);
    db.close(); db = openConnection(f.databasePath);
    assert.equal(taskAssuranceReport(db, runId).complete, true);
    writeFileSync(path.join(f.root, 'source.ts'), 'changed after verification\n');
    assert.equal(taskAssuranceReport(db, runId).complete, false);
    const refreshed = await refreshTaskMemory(db, { runId, cwd: f.root, requestId: 'refresh', expectedRevision: taskAssuranceReport(db, runId).revision!, capabilities: caps, changedPaths: ['source.ts'], errorSignatures: ['migration'] });
    assert.ok(refreshed);
    assert.equal(taskAssuranceReport(db, runId).complete, false);
  } finally { db.close(); rmSync(f.base, { recursive: true, force: true }); }
});
test('doctor inspects adopted memory across a symlink and nested Git repositories', async () => {
  const f = await fixture();
  try {
    const link = path.join(f.root, 'CLAUDE.md');
    symlinkSync('source.ts', link);
    const moduleRoot = path.join(f.root, 'module');
    const nestedRoot = path.join(moduleRoot, 'nested');
    execFileSync('git', ['init', '-q', moduleRoot]);
    execFileSync('git', ['init', '-q', nestedRoot]);
    writeFileSync(path.join(nestedRoot, 'nested.ts'), 'export const value = 1;\n');
    execFileSync('git', ['-C', moduleRoot, 'update-index', '--add', '--cacheinfo', `160000,${'b'.repeat(40)},nested`]);
    execFileSync('git', ['-C', f.root, 'update-index', '--add', '--cacheinfo', `160000,${'a'.repeat(40)},module`]);
    const runId = f.prepared.run.runId;
    const deliveryId = f.prepared.context!.deliveryId!;
    const evidence = recordTaskEvidence(f.db, {
      runId, requestId: 'symlink-evidence', expectedRevision: taskAssuranceReport(f.db, runId).revision!, cwd: f.root,
      deliveryId, execution: 'symlink fixture', stateDigest: repositoryStateDigest(f.root), outcome: 'passed', exitCode: 0,
    });
    reviewTaskMemory(f.db, {
      runId, requestId: 'symlink-review', expectedRevision: evidence.revision, cwd: f.root, deliveryId,
      entryId: f.entry.id, entryRevision: f.entry.revision, decision: 'adopted',
      basis: 'Fixture contains the current source', invariant: 'The source remains at its verified state',
      counterexample: 'Change the link target after verification', verification: 'Run doctor against the fixture',
      evidenceIds: [evidence.evidenceId],
    });
    const healthy = await runDoctor({ databasePath: f.databasePath });
    assert.equal(healthy.checks.memoryAssurance.ok, true);
    assert.match(healthy.checks.memoryAssurance.detail!, /inspectionErrors=0/u);

    writeFileSync(path.join(nestedRoot, 'nested.ts'), 'export const value = 2;\n');
    const changedModule = await runDoctor({ databasePath: f.databasePath });
    assert.match(changedModule.checks.memoryAssurance.detail!, /pending=1; stale=0; missingVerification=0; inspectionErrors=0/u);
    writeFileSync(path.join(nestedRoot, 'nested.ts'), 'export const value = 1;\n');

    writeFileSync(path.join(f.root, 'other.ts'), 'export const other = true;\n');
    unlinkSync(link);
    symlinkSync('other.ts', link);
    const stale = await runDoctor({ databasePath: f.databasePath });
    assert.equal(stale.checks.memoryAssurance.ok, true);
    assert.match(stale.checks.memoryAssurance.detail!, /pending=1; stale=0; missingVerification=0; inspectionErrors=0/u);

    unlinkSync(link);
    const outside = path.join(f.base, 'outside.ts');
    writeFileSync(outside, 'export const secret = true;\n');
    symlinkSync(outside, link);
    assert.throws(() => repositoryStateDigest(f.root), /symlink escapes the repository/u);
  } finally { f.db.close(); rmSync(f.base, { recursive: true, force: true }); }
});

test('doctor names failed task inspections and their actual exception in JSON and human output', async () => {
  const f = await fixture();
  try {
    const outside = path.join(f.base, 'outside.ts');
    writeFileSync(outside, 'external source\n');
    symlinkSync(outside, path.join(f.root, 'escape.ts'));
    const result = await runDoctor({ databasePath: f.databasePath });
    const check = result.checks.memoryAssurance as any;
    assert.equal(check.ok, false);
    assert.match(check.detail, /inspectionErrors=1/u);
    assert.deepEqual(check.findings, [{
      reason: 'task_inspection_failed',
      runId: f.prepared.run.runId,
      repositoryRoot: realpathSync(f.root),
      code: 'VALIDATION_ERROR',
      message: 'Snapshot symlink escapes the repository',
      action: 'Check this task\'s repository files and access, correct the reported inspection error, then rerun kiokuko doctor. Keep task records and memory intact.',
    }]);
    let stdout = '';
    const original = process.stdout.write;
    const previousExitCode = process.exitCode;
    try {
      process.stdout.write = ((chunk: string | Uint8Array) => {
        stdout += chunk.toString(); return true;
      }) as typeof process.stdout.write;
      process.exitCode = undefined;
      await buildCli({ doctorDatabasePath: f.databasePath }).parseAsync(['node', 'kiokuko', 'doctor']);
      assert.equal(process.exitCode, 8);
      assert.ok(stdout.includes(f.prepared.run.runId));
      assert.ok(stdout.includes(realpathSync(f.root)));
      assert.match(stdout, /VALIDATION_ERROR: Snapshot symlink escapes the repository/u);
      assert.match(stdout, /Keep task records and memory intact/u);
    } finally { process.stdout.write = original; process.exitCode = previousExitCode; }
    assert.equal(f.db.prepare('SELECT status FROM ledger_runs WHERE run_id=?').get<{status:string}>(f.prepared.run.runId)!.status, 'active');
  } finally { f.db.close(); rmSync(f.base, { recursive: true, force: true }); }
});

test('doctor explains the snapshot byte budget without deleting or completing the failed task', async () => {
  const f = await fixture();
  try {
    const large = path.join(f.root, 'archive.bin');
    writeFileSync(large, '');
    truncateSync(large, 64 * 1024 * 1024);
    const result = await runDoctor({ databasePath: f.databasePath });
    const check = result.checks.memoryAssurance as any;
    assert.equal(check.ok, false);
    assert.equal(check.findings[0].runId, f.prepared.run.runId);
    assert.equal(check.findings[0].message, 'Repository snapshot exceeds its byte budget');
    assert.match(check.findings[0].action, /64 MiB.*Git-tracked and unignored/u);
    assert.match(check.findings[0].action, /tracked files still count/u);
    assert.match(check.findings[0].action, /Keep task records and memory intact/u);
    assert.equal(f.db.prepare('SELECT status FROM ledger_runs WHERE run_id=?').get<{status:string}>(f.prepared.run.runId)!.status, 'active');
  } finally { f.db.close(); rmSync(f.base, { recursive: true, force: true }); }
});
test('Codex warns for unprepared edits without inheriting another agent or interrupted request', async () => {
  const f = await fixture();
  try {
    const common = { session_id: 'client', turn_id: 'turn', cwd: f.root };
    handleCodexHook(f.db, { ...common, hook_event_name: 'UserPromptSubmit' });
    const edit = { ...common, hook_event_name: 'PreToolUse', tool_name: 'apply_patch', tool_use_id: 'edit', tool_input: { command: 'patch' } };
    assertMemoryAdvisory((handleCodexHook(f.db, edit) as any));
    assertMemoryAdvisory((handleCodexHook(f.db, { ...edit, agent_id: 'child' }) as any));
    handleCodexHook(f.db, { ...common, hook_event_name: 'Interrupt' });
    assert.deepEqual(handleCodexHook(f.db, { ...common, hook_event_name: 'Stop' }), {});
  } finally { f.db.close(); rmSync(f.base, { recursive: true, force: true }); }
});
test('explicit human interruption stops the turn durably before every recovery and tool path', async () => {
  const f = await fixture();
  try {
    const common = { session_id: 'hard-stop', turn_id: 'first', cwd: f.root };
    const prompt = { ...common, hook_event_name: 'UserPromptSubmit' };
    handleCodexHook(f.db, prompt);
    const requestId = f.db.prepare('SELECT request_id FROM codex_hook_requests').get<{ request_id: string }>()!.request_id;
    const call = (name: string, args: object = {}) => ({ ...common, hook_event_name: 'PreToolUse', tool_name: name, tool_use_id: name, tool_input: args });
    handleCodexHook(f.db,{...common,hook_event_name:'Interrupt'});
    const denied = handleCodexHook(f.db, call('exec_command', {cmd:'true'})) as any;
    assert.equal(denied.hookSpecificOutput.permissionDecision, 'deny');
    assert.match(denied.hookSpecificOutput.permissionDecisionReason, /Do not retry.*new user message/u);
    assert.equal(denied.continue, undefined); // Unsupported here would make Codex fail open.
    const restarted = openConnection(f.databasePath);
    try {
      for (const name of ['exec_command', 'apply_patch', 'mcp__kiokuko__task_inspect', 'mcp__kiokuko__task_prepare',
        'mcp__kiokuko__task_prepare_recover', 'mcp__kiokuko__memory_checkpoint', 'request_user_input_async', 'clockcurr_time']) {
        assert.equal((handleCodexHook(restarted, call(name, { cwd: f.root, requestId })) as any).hookSpecificOutput.permissionDecision, 'deny', name);
      }
      assert.equal((handleCodexHook(restarted, prompt) as any).continue, false); // An event replay cannot reset it.
      const late = handleCodexHook(restarted, { ...call('mcp__kiokuko__task_prepare', { cwd: f.root, requestId }),
        hook_event_name: 'PostToolUse', tool_response: { structuredContent: f.prepared } }) as any;
      assert.deepEqual(late, {}); // Cancelled request ignores late completion rather than requesting continuation.
      assert.equal((handleCodexHook(restarted,call("exec_command",{cmd:"true"})) as any).hookSpecificOutput.permissionDecision,"deny");
      assert.equal(restarted.prepare('SELECT run_id FROM codex_hook_requests').get<{ run_id: string | null }>()!.run_id, null);
      for (const stop_hook_active of [false, true]) {
        assert.deepEqual(handleCodexHook(restarted, { ...common, hook_event_name: 'Stop', stop_hook_active }), {});
        assert.equal((handleCodexHook(restarted,call('exec_command',{cmd:'true'})) as any).hookSpecificOutput.permissionDecision,'deny');
      }
      assert.equal(restarted.prepare('SELECT COUNT(*) AS n FROM codex_hook_tools').get<{ n: number }>()!.n, 0);
      assert.equal(restarted.prepare('SELECT COUNT(*) AS n FROM task_execution_evidence').get<{ n: number }>()!.n, 0);
      const next = { ...common, turn_id: 'second' };
      assert.equal((handleCodexHook(restarted, { ...next, hook_event_name: 'UserPromptSubmit' }) as any).continue, undefined);
      assert.deepEqual(handleCodexHook(restarted, { ...call('mcp__kiokuko__task_inspect', { cwd: f.root, operation: 'skill' }), ...next }), {});
    } finally { restarted.close(); }
  } finally { f.db.close(); rmSync(f.base, { recursive: true, force: true }); }
});
test('Codex permits user clarification and clock reads before preparation and pending memory decisions without granting execution', async () => {
  const f = await fixture();
  try {
    const common = { session_id: 'clarification', turn_id: 'request', cwd: f.root };
    handleCodexHook(f.db, { ...common, hook_event_name: 'UserPromptSubmit' });
    const requestId = f.db.prepare('SELECT request_id FROM codex_hook_requests').get<{ request_id: string }>()!.request_id;
    const ask = (name: string) => ({ ...common, tool_name: name, tool_use_id: name, tool_input: { questions: [] } });
    for (const name of ['request_user_input', 'request_user_input_async', 'clockcurr_time']) {
      assert.deepEqual(handleCodexHook(f.db, { ...ask(name), hook_event_name: 'PreToolUse' }), {});
      assert.deepEqual(handleCodexHook(f.db, { ...ask(name), hook_event_name: 'PostToolUse', tool_response: {} }), {});
    }
    handleCodexHook(f.db, { ...common, hook_event_name: 'PostToolUse', tool_name: 'mcp__kiokuko__task_prepare',
      tool_use_id: 'prepare', tool_input: { cwd: f.root, requestId }, tool_response: { structuredContent: f.prepared } });
    assert.deepEqual(handleCodexHook(f.db, { ...ask('request_user_input_async'), hook_event_name: 'PreToolUse' }), {});
    assert.deepEqual(handleCodexHook(f.db, { ...ask('clockcurr_time'), hook_event_name: 'PreToolUse' }), {});
    assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM task_execution_evidence').get<{ n: number }>()!.n, 0);
    const denied = handleCodexHook(f.db, { ...common, hook_event_name: 'PreToolUse', tool_name: 'exec_command',
      tool_use_id: 'premature', tool_input: { cmd: 'true' } }) as any;
    assertMemoryAdvisory(denied);
    assert.equal(f.db.prepare('SELECT status FROM ledger_runs WHERE run_id=?').get<{ status: string }>(f.prepared.run.runId)!.status, 'active');
    assert.deepEqual(handleCodexHook(f.db, { ...ask('request_user_input_async'), hook_event_name: 'PreToolUse' }), {});
  } finally { f.db.close(); rmSync(f.base, { recursive: true, force: true }); }
});
test('hook command exposes bookkeeping warnings and interruption denials without leaking tool input', async () => {
  const f = await fixture();
  try {
    let common = { session_id: 'visible-block', turn_id: 'request', cwd: f.root };
    const checkBlock = (expected: RegExp) => {
      const result = spawnSync(process.execPath, ['--import', 'tsx', 'src/bin/kiokuko.ts', 'codex-hook', '--database', f.databasePath],
        { cwd: process.cwd(), input: JSON.stringify({ ...common, hook_event_name: 'PreToolUse', tool_name: 'exec_command',
          tool_use_id: 'blocked', tool_input: { cmd: 'private-command-body' } }), encoding: 'utf8' });
      assert.equal(result.status, 0, result.stderr);
      const output = JSON.parse(result.stdout);
      if (expected.source === 'interrupted') assert.equal(output.hookSpecificOutput?.permissionDecision, 'deny');
      else assertMemoryAdvisory(output);
      assert.match(output.systemMessage, expected);
      assert.match(result.stderr, expected);
      assert.ok(result.stderr.includes(output.systemMessage));
      assert.doesNotMatch(result.stdout + result.stderr, /private-command-body/u);
      assert.equal(output.continue, undefined);
      assert.equal(output.stopReason, undefined);
      assert.equal(output.suppressOutput, undefined);
      assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM codex_hook_tools').get<{ n: number }>()!.n, 0);
    };
    checkBlock(/request_not_observed/u);
    checkBlock(/preparation_required/u);
    common = { ...common, turn_id: 'unprepared' };
    handleCodexHook(f.db, { ...common, hook_event_name: 'UserPromptSubmit' });
    checkBlock(/preparation_required/u);
    common = { ...common, turn_id: 'pending-review' };
    handleCodexHook(f.db, { ...common, hook_event_name: 'UserPromptSubmit' });
    const requestId = f.db.prepare('SELECT request_id FROM codex_hook_requests WHERE stop_notified=0 ORDER BY rowid DESC LIMIT 1').get<{ request_id: string }>()!.request_id;
    handleCodexHook(f.db, { ...common, hook_event_name: 'PostToolUse', tool_name: 'mcp__kiokuko__task_prepare',
      tool_use_id: 'prepare', tool_input: { cwd: f.root, requestId }, tool_response: { structuredContent: f.prepared } });
    checkBlock(/memory_review_pending/u);
    handleCodexHook(f.db, { ...common, hook_event_name: 'Interrupt' });
    checkBlock(/interrupted/u);
  } finally { f.db.close(); rmSync(f.base, { recursive: true, force: true }); }
});
for (const withIntake of [false, true]) {
  test(`Codex guides bootstrap and memory decisions before execution (${withIntake ? 'task_answer' : 'task_prepare'})`, async () => {
    const f = await fixture();
    try {
      const common = { session_id: 'ordering-client', turn_id: 'turn', cwd: f.root };
      const prompt = handleCodexHook(f.db, { ...common, hook_event_name: 'UserPromptSubmit' }) as any;
      assert.match(prompt.hookSpecificOutput.additionalContext, /task_inspect.*natural-japanese-output.*do not read Skills through shell commands/u);
      const requestId = f.db.prepare('SELECT request_id FROM codex_hook_requests').get<{ request_id: string }>()!.request_id;
      const call = (name: string, id: string, args: object, execute: () => unknown) => {
        const event = { ...common, tool_name: `mcp__kiokuko__${name}`, tool_use_id: id, tool_input: args };
        assert.deepEqual(handleCodexHook(f.db, { ...event, hook_event_name: 'PreToolUse' }), {});
        const result = execute();
        return { result, event };
      };
      const invalid = { cwd: f.root, operation: 'skill', path: 'skills/unknown/SKILL.md' };
      const attempt = call('task_inspect', 'invalid-selector', invalid, () => undefined);
      assert.throws(() => inspectTask(invalid), /For bundled Skill reads/u);
      handleCodexHook(f.db, { ...attempt.event, hook_event_name: 'PostToolUse', tool_response: {
        isError: true, structuredContent: { code: 'VALIDATION_ERROR', reason: 'skill', recoverable: true, retryable: false },
      } });
      assert.equal(f.db.prepare('SELECT stop_notified FROM codex_hook_requests WHERE request_id=?')
        .get<{ stop_notified: number }>(requestId)!.stop_notified, 0);
      for (const skill of ['kiokuko-soul', 'memory-reasoning', 'natural-japanese-output']) {
        const args = { cwd: f.root, operation: 'skill', path: skill };
        const read = call('task_inspect', skill, args, () => inspectTask(args));
        assert.match((read.result as { text: string }).text, new RegExp(`name: ${skill}`));
      }
      const args = { cwd: f.root, requestId, soulRead: true, task: 'Implement migration expectations', capabilities: caps,
        skillDiscoveryMode: 'off' as const, profileHints: withIntake ? {} : {
          taskType: 'build' as const, target: 'source.ts migration expectations code', expected: 'next migration tests pass', constraints: 'preserve historical fixtures',
        } };
      call('task_prepare', 'prepare', args, () => undefined);
      let prepared = await prepareAgentTask(f.db, args);
      const post = (name: string, input: object, result: unknown) => handleCodexHook(f.db, { ...common,
        hook_event_name: 'PostToolUse', tool_name: `mcp__kiokuko__${name}`, tool_use_id: name,
        tool_input: input, tool_response: { structuredContent: result } }) as any;
      let guidance = post('task_prepare', args, prepared);
      const answers = { taskType: 'build', target: 'source.ts migration expectations code', expected: 'next migration tests pass', constraints: 'preserve historical fixtures' };
      while (prepared.intake.status === 'needs_answer') {
        assert.equal(prepared.nextAction, 'answer_from_evidence_or_ask_user');
        const question = prepared.intake.question!;
        const answer = { cwd: f.root, runId: prepared.run.runId, sessionId: prepared.intake.sessionId,
          questionId: question.id, value: answers[question.id], capabilities: caps, skillDiscoveryMode: 'off' as const };
        call('task_answer', question.id, answer, () => undefined);
        prepared = await answerAgentTask(f.db, answer);
        guidance = post('task_answer', answer, prepared);
      }
      assert.equal(prepared.nextAction, 'review_memory_application');
      assert.deepEqual(prepared.assurance.pending, [f.entry.id]);
      assert.match(guidance.hookSpecificOutput.additionalContext, /review_memory_application.*task_memory_status.*task_memory_review.*task_inspect/u);
      const readArgs = { cwd: f.root, operation: 'read', path: 'source.ts' };
      call('task_inspect', 'evidence', readArgs, () => inspectTask(readArgs));
      const review = { cwd: f.root, runId: prepared.run.runId, requestId: 'ordering-review',
        deliveryId: prepared.context!.deliveryId!, expectedRevision: prepared.assurance.revision!,
        entryId: f.entry.id, entryRevision: f.entry.revision, decision: 'adopted',
        basis: 'source.ts contains the fixed version array', invariant: 'New migrations require no expected-array update',
        counterexample: 'Add another migration', verification: 'Run next-migration fixture' };
      const reviewed = call('task_memory_review', 'review', review, () => reviewTaskMemory(f.db, review));
      const after = post('task_memory_review', review, reviewed.result);
      assert.match(after.hookSpecificOutput.additionalContext, /ordinary tools may proceed.*passing verification/u);
      const report = taskAssuranceReport(f.db, prepared.run.runId);
      assert.equal(memoryReviewNextAction(report), 'proceed');
      assert.equal(report.complete, false); // Missing test evidence must not deadlock execution.
      const execute = { ...common, hook_event_name: 'PreToolUse', tool_name: 'exec_command', tool_use_id: 'search', tool_input: { cmd: 'rg versions source.ts' } };
      assert.deepEqual(handleCodexHook(f.db, execute), {});
      assert.equal(f.db.prepare("SELECT COUNT(*) AS n FROM codex_hook_observations WHERE decision='denied'").get<{ n: number }>()!.n, 0);
    } finally { f.db.close(); rmSync(f.base, { recursive: true, force: true }); }
  });
}
async function boundHookFixture() {
  const f = await fixture();
  reviewTaskMemory(f.db, { runId: f.prepared.run.runId, requestId: 'hook-fixture-review', expectedRevision: taskAssuranceReport(f.db, f.prepared.run.runId).revision!, cwd: f.root,
    deliveryId: f.prepared.context!.deliveryId!, entryId: f.entry.id, entryRevision: f.entry.revision, decision: 'inapplicable',
    basis: 'Migration expectation memory does not govern Codex hook completion.', evidenceIds: [] });
  const common = { session_id: 'concurrent-client', turn_id: 'request', cwd: f.root };
  handleCodexHook(f.db, { ...common, hook_event_name: 'UserPromptSubmit' });
  const requestId = f.db.prepare('SELECT request_id FROM codex_hook_requests').get<{ request_id: string }>()!.request_id;
  const args = { cwd: f.root, requestId };
  handleCodexHook(f.db, { ...common, hook_event_name: 'PostToolUse', tool_name: 'mcp__kiokuko__task_prepare',
    tool_use_id: 'prepare', tool_input: args, tool_response: { structuredContent: f.prepared } });
  const event = (id: string) => ({ ...common, tool_name: 'exec_command', tool_use_id: id, tool_input: { cmd: 'true' } });
  return { ...f, common, event };
}
test('native human Stop racing a delayed preparation or execution completion cannot reopen or verify the turn', async () => {
  for (const phase of ['preparation', 'execution']) {
    const f = await boundHookFixture();
    const common = phase === 'execution' ? f.common : { ...f.common, turn_id: 'racing-prepare' };
    try {
      if (phase === 'preparation') handleCodexHook(f.db, { ...common, hook_event_name: 'UserPromptSubmit' });
      const requestId = f.db.prepare('SELECT request_id FROM codex_hook_requests ORDER BY rowid DESC LIMIT 1').get<{ request_id: string }>()!.request_id;
      const call = { ...common, tool_name: phase === 'preparation' ? 'mcp__kiokuko__task_prepare' : 'exec_command',
        tool_use_id: 'delayed', tool_input: phase === 'preparation' ? { cwd: f.root, requestId } : { cmd: 'true' } };
      assert.deepEqual(handleCodexHook(f.db, { ...call, hook_event_name: 'PreToolUse' }), {});
      const second = openConnection(f.databasePath);
      let raced = false;
      try {
        const racing = new Proxy(f.db, { get(target, key) {
          if (key === 'prepare') return (sql: string) => {
            const statement = target.prepare(sql);
            if (sql !== 'SELECT * FROM codex_hook_requests WHERE identity_digest = ?') return statement;
            return { ...statement, get(...params: Parameters<typeof statement.get>) {
              const snapshot = statement.get(...params);
              if (!raced) {
                raced = true;
                handleCodexHook(second, { ...common, hook_event_name: 'Interrupt' });
              }
              return snapshot;
            } };
          };
          const value = Reflect.get(target, key);
          return typeof value === 'function' ? value.bind(target) : value;
        } });
        const result = handleCodexHook(racing, { ...call, hook_event_name: 'PostToolUse',
          tool_response: phase === 'preparation' ? { structuredContent: f.prepared } : { exit_code: 0 } }) as any;
        assert.equal(result.continue, false, phase);
        assert.equal(raced, true);
        assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM task_execution_evidence').get<{ n: number }>()!.n, 0);
        if (phase === 'preparation') assert.equal(f.db.prepare('SELECT run_id FROM codex_hook_requests WHERE request_id=?').get<{ run_id: string | null }>(requestId)!.run_id, null);
      } finally { second.close(); }
    } finally { f.db.close(); rmSync(f.base, { recursive: true, force: true }); }
  }
});
test('hook command stays quiet for an admitted tool call', async () => {
  const f = await boundHookFixture();
  try {
    const result = spawnSync(process.execPath, ['--import', 'tsx', 'src/bin/kiokuko.ts', 'codex-hook', '--database', f.databasePath],
      { cwd: process.cwd(), input: JSON.stringify({ ...f.event('quiet'), hook_event_name: 'PreToolUse' }), encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(JSON.parse(result.stdout), {});
    assert.equal(result.stderr, '');
  } finally { f.db.close(); rmSync(f.base, { recursive: true, force: true }); }
});
test('Codex accepts normal, recoverable deny, terminal deny and internal PreToolUse failure JSON', async () => {
  const f = await boundHookFixture();
  const cli = (event: object, database = f.databasePath) => spawnSync(process.execPath,
    ['--import', 'tsx', 'src/bin/kiokuko.ts', 'codex-hook', '--database', database],
    { cwd: process.cwd(), input: JSON.stringify(event), encoding: 'utf8' });
  try {
    const valid = cli({ ...f.event('valid'), hook_event_name: 'PreToolUse' });
    assert.equal(valid.status, 0);
    assert.deepEqual(acceptCodexToolHook(valid.stdout, 'PreToolUse'), {});
    const pending = { ...f.event('pending'), turn_id: 'unprepared', hook_event_name: 'PreToolUse' };
    handleCodexHook(f.db, { ...f.common, turn_id: 'unprepared', hook_event_name: 'UserPromptSubmit' });
    const denied = cli(pending);
    assert.equal(denied.status, 0, denied.stderr);
    assertMemoryAdvisory(acceptCodexToolHook(denied.stdout, 'PreToolUse'));
    assert.equal(f.db.prepare('SELECT COUNT(*) n FROM codex_hook_tools WHERE call_id=?').get('pending')?.n, 0);
    const terminal = cli({ ...f.event('terminal'), hook_event_name: 'PreToolUse',
      tool_name: 'mcp__kiokuko__task_memory_status', tool_input: { runId: 'foreign' } });
    assert.equal(terminal.status, 0, terminal.stderr);
    assert.equal(acceptCodexToolHook(terminal.stdout, 'PreToolUse').hookSpecificOutput!.permissionDecision, 'deny');
    const failure = cli({ ...f.event('failure'), hook_event_name: 'PreToolUse' }, path.join(f.base, 'absent.sqlite3'));
    assert.equal(failure.status, 0, failure.stderr);
    assertMemoryAdvisory(acceptCodexToolHook(failure.stdout, 'PreToolUse'));
    assert.match(failure.stderr, /pre_admission/u);
  } finally { f.db.close(); rmSync(f.base, { recursive: true, force: true }); }
});

test('single and batched code-mode inner tools bind each admission and preserve results after Post failure', async () => {
  for (const count of [1, 3]) {
    const f = await boundHookFixture();
    const hook = (event: object) => spawnSync(process.execPath,
      ['--import', 'tsx', 'src/bin/kiokuko.ts', 'codex-hook', '--database', f.databasePath],
      { cwd: process.cwd(), input: JSON.stringify(event), encoding: 'utf8' });
    let executions = 0;
    try {
      f.db.exec("CREATE TRIGGER inject_post_failure BEFORE INSERT ON task_execution_evidence BEGIN SELECT RAISE(ABORT, 'private-fault-details'); END");
      const outputs = await Promise.all(Array.from({ length: count }, (_, i) => {
        const call = f.event(`inner-${i}`);
        return runCodexNestedTool(hook, call, async () => { executions++; return { exit_code: i, output: `private-result-${i}` }; });
      }));
      assert.deepEqual(outputs, Array.from({ length: count }, (_, i) => ({ exit_code: i, output: `private-result-${i}` })));
      assert.equal(executions, count, 'Post recording failure must not rerun a tool');
      assert.equal(f.db.prepare('SELECT COUNT(*) n FROM codex_hook_tools').get()?.n, count);
      assert.equal(f.db.prepare('SELECT COUNT(*) n FROM task_execution_evidence').get()?.n, 0);
      for (let i = 0; i < count; i++) {
        const call = f.event(`inner-${i}`);
        const after = hook({ ...call, hook_event_name: 'PostToolUse', tool_response: outputs[i] });
        assert.equal(after.status, 0, after.stderr);
        const response = acceptCodexToolHook(after.stdout, 'PostToolUse');
        assert.match(response.systemMessage!, /Tool already executed; do not rerun automatically/u);
        assert.doesNotMatch(after.stdout + after.stderr, /private-result|private-fault/u);
        const id = codexHookCorrelationId(call);
        const diagnostic = codexHookDiagnostics(f.db, id) as any;
        const last = diagnostic.events.at(-1);
        assert.equal(last.execution.occurred, true);
        assert.equal(last.execution.completionRecorded, false);
        assert.equal(last.execution.exitCode, i);
      }
      assert.equal(taskAssuranceReport(f.db, f.prepared.run.runId).completionReady, false);
    } finally { f.db.close(); rmSync(f.base, { recursive: true, force: true }); }
  }
});

test('an admitted edit completes after review invalidation; the next inner read keeps pending review advisory', async () => {
  const f = await boundHookFixture();
  const review = () => reviewTaskMemory(f.db, { runId: f.prepared.run.runId, cwd: f.root,
    requestId: `review-${taskAssuranceReport(f.db, f.prepared.run.runId).revision}`,
    expectedRevision: taskAssuranceReport(f.db, f.prepared.run.runId).revision!, deliveryId: f.prepared.context!.deliveryId!,
    entryId: f.entry.id, entryRevision: f.entry.revision, decision: 'adopted', basis: 'source.ts is the current edit target',
    invariant: 'Admitted edits retain completion correlation', counterexample: 'Edit invalidates current review before Post',
    verification: 'Pre edit, edit, Post, reject next read, review, admit read' });
  try {
    review();
    const edit = { ...f.event('edit'), tool_name: 'apply_patch', tool_input: { command: 'fixture edit' } };
    assert.deepEqual(handleCodexHook(f.db, { ...edit, hook_event_name: 'PreToolUse' }), {});
    writeFileSync(path.join(f.root, 'source.ts'), 'export const value = 2;\n');
    assert.ok(taskAssuranceReport(f.db, f.prepared.run.runId).pending.length);
    const post = handleCodexHook(f.db, { ...edit, hook_event_name: 'PostToolUse', tool_response: 'edited' });
    acceptCodexToolHook(JSON.stringify(post), 'PostToolUse');
    const read = { ...f.event('read'), tool_name: 'read_file', tool_input: { path: 'source.ts' } };
    const blocked = handleCodexHook(f.db, { ...read, hook_event_name: 'PreToolUse' }) as any;
    assertMemoryAdvisory(acceptCodexToolHook(JSON.stringify(blocked), 'PreToolUse'));
    assert.equal(f.db.prepare('SELECT COUNT(*) n FROM codex_hook_tools WHERE call_id=?').get('read')?.n, 0);
    review();
    assert.deepEqual(handleCodexHook(f.db, { ...read, hook_event_name: 'PreToolUse' }), {});
    assert.deepEqual(handleCodexHook(f.db, { ...read, hook_event_name: 'PostToolUse', tool_response: 'source' }), {});
  } finally { f.db.close(); rmSync(f.base, { recursive: true, force: true }); }
});
test('independent PostToolUse completions commit across a revision change, and duplicate delivery is idempotent', async () => {
  const f = await boundHookFixture();
  const second = openConnection(f.databasePath);
  try {
    const a = f.event('a'); const b = f.event('b');
    for (const call of [a, b]) assert.deepEqual(handleCodexHook(f.db, { ...call, hook_event_name: 'PreToolUse' }), {});
    let interleaved = false;
    const wrapped = new Proxy(f.db, { get(target, key) {
      if (key === 'exec') return (sql: string) => {
        if (sql === 'BEGIN IMMEDIATE' && !interleaved) {
          interleaved = true;
          handleCodexHook(second, { ...b, hook_event_name: 'PostToolUse', tool_response: { exit_code: 0 } });
        }
        return target.exec(sql);
      };
      const value = Reflect.get(target, key);
      return typeof value === 'function' ? value.bind(target) : value;
    } });
    assert.match((handleCodexHook(wrapped, { ...a, hook_event_name: 'PostToolUse', tool_response: { exit_code: 0 } }) as any).hookSpecificOutput.additionalContext, /outcome: passed/u);
    const ids = f.db.prepare('SELECT call_id, evidence_id FROM codex_hook_tools WHERE call_id IN (?, ?) ORDER BY call_id').all('a', 'b') as Array<{ call_id: string; evidence_id: string }>;
    assert.equal(ids.length, 2);
    assert.ok(ids.every(row => row.evidence_id));
    assert.notEqual(ids[0]!.evidence_id, ids[1]!.evidence_id);
    const revision = taskAssuranceReport(f.db, f.prepared.run.runId).revision;
    handleCodexHook(f.db, { ...a, hook_event_name: 'PostToolUse', tool_response: { exit_code: 0 } });
    assert.equal(taskAssuranceReport(f.db, f.prepared.run.runId).revision, revision);
    assert.equal(f.db.prepare('SELECT COUNT(*) AS count FROM task_execution_evidence').get<{ count: number }>()!.count, 2);
    assert.throws(() => handleCodexHook(f.db, { ...a, tool_input: { cmd: 'other' }, hook_event_name: 'PostToolUse', tool_response: { exit_code: 0 } }), /input changed/u);
    const changed = f.event('changed');
    const changedSibling = f.event('changed-sibling');
    for (const call of [changed, changedSibling]) handleCodexHook(f.db, { ...call, hook_event_name: 'PreToolUse' });
    writeFileSync(path.join(f.root, 'source.ts'), 'updated after tool start\n');
    handleCodexHook(f.db, { ...changed, hook_event_name: 'PostToolUse', tool_response: { exit_code: 0 } });
    const afterChange = taskAssuranceReport(f.db, f.prepared.run.runId).revision;
    const sequence = taskAssuranceReport(f.db, f.prepared.run.runId).observationSequence!;
    handleCodexHook(f.db, { ...changedSibling, hook_event_name: 'PostToolUse', tool_response: { exit_code: 0 } });
    assert.equal(taskAssuranceReport(f.db, f.prepared.run.runId).revision, afterChange);
    assert.equal(taskAssuranceReport(f.db, f.prepared.run.runId).observationSequence, sequence + 1);
    handleCodexHook(f.db, { ...changed, hook_event_name: 'PostToolUse', tool_response: { exit_code: 0 } });
    assert.equal(taskAssuranceReport(f.db, f.prepared.run.runId).revision, afterChange);
    assert.equal(f.db.prepare('SELECT COUNT(*) AS count FROM task_execution_evidence').get<{ count: number }>()!.count, 2);
    assert.equal(codexHookFailureCode(new KiokukoError('CONFLICT', 'Task assurance revision changed')), 'state_conflict');
    assert.equal(codexHookFailureCode(new KiokukoError('BACKPRESSURE', 'busy')), 'database_busy');
    assert.equal(codexHookFailureCode(new KiokukoError('SERVICE_UNAVAILABLE', 'Repository state digest unavailable')), 'state_digest_unavailable');
  } finally { second.close(); f.db.close(); rmSync(f.base, { recursive: true, force: true }); }
});
test('hook diagnostics distinguish an unpaired completion without exposing its command', async () => {
  const f = await boundHookFixture();
  try {
    const { spawnSync } = await import('node:child_process');
    const event = { ...f.event('missing-start'), tool_input: { cmd: 'private-command-body' }, hook_event_name: 'PostToolUse', tool_response: { exit_code: 0 } };
    const result = spawnSync(process.execPath, ['--import', 'tsx', 'src/bin/kiokuko.ts', 'codex-hook', '--database', f.databasePath],
      { cwd: process.cwd(), input: JSON.stringify(event), encoding: 'utf8' });
    assert.equal(result.status, 0);
    const warning = acceptCodexToolHook(result.stdout, 'PostToolUse').systemMessage!;
    assert.match(warning, /completion_without_admission/u);
    assert.match(warning, /No matching PreToolUse admission record was found for this tool call\. Task preparation is separate from per-tool admission\./u);
    assert.match(warning, /Tool already executed; do not rerun automatically/u);
    assert.match(warning, /unrelated authorized work may continue.*Do not claim verified completion/u);
    assert.equal(f.db.prepare('SELECT state,stop_notified FROM codex_hook_requests').get()!.state, 'bound');
    assert.equal(f.db.prepare('SELECT stop_notified FROM codex_hook_requests').get()!.stop_notified, 0);
    assert.equal(f.db.prepare('SELECT status FROM ledger_runs WHERE run_id=?').get(f.prepared.run.runId)!.status, 'active');
    assert.match(result.stderr, /event=PostToolUse stage=post_completion reason=completion_without_admission id=[0-9a-f]{16}.*Tool already executed/u);
    assert.doesNotMatch(result.stderr, /private-command-body/u);
    const observation = f.db.prepare("SELECT response_shape FROM codex_hook_observations WHERE event_name='PostToolUse' AND decision='CONFLICT' ORDER BY rowid DESC LIMIT 1")
      .get<{ response_shape: string }>();
    assert.ok(observation);
    assert.match(result.stderr, new RegExp(`id=${JSON.parse(observation.response_shape).call}\\.`));
    const id = JSON.parse(observation.response_shape).call;
    const before = f.db.prepare('SELECT COUNT(*) AS n FROM codex_hook_observations').get<{ n: number }>()!.n;
    const diagnostic = spawnSync(process.execPath, ['--import', 'tsx', 'src/bin/kiokuko.ts', 'codex-hook', '--database', f.databasePath, '--diagnose-call', id],
      { cwd: process.cwd(), encoding: 'utf8' });
    assert.equal(diagnostic.status, 0, diagnostic.stderr);
    assert.deepEqual(JSON.parse(diagnostic.stdout), codexHookDiagnostics(f.db, id));
    assert.doesNotMatch(diagnostic.stdout, /private-command-body|concurrent-client|test-request/u);
    assert.equal(JSON.parse(diagnostic.stdout).events.length, 1);
    assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM codex_hook_observations').get<{ n: number }>()!.n, before);
    assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM task_execution_evidence').get<{ n: number }>()!.n, 0);
    assert.throws(() => codexHookDiagnostics(f.db, 'not-a-call'), /16 lowercase hex/u);
    const invalid = spawnSync(process.execPath, ['--import', 'tsx', 'src/bin/kiokuko.ts', 'codex-hook', '--database', path.join(f.base, 'absent.sqlite3'), '--diagnose-call', 'invalid'],
      { cwd: process.cwd(), encoding: 'utf8' });
    assert.equal(invalid.status, 2);
    assert.match(invalid.stderr, /validation_unavailable/u);
  } finally { f.db.close(); rmSync(f.base, { recursive: true, force: true }); }
});
test('observation write failure does not replace a completed hook result', async () => {
  const f = await boundHookFixture();
  const call = f.event('observation-failure');
  try {
    handleCodexHook(f.db, { ...call, hook_event_name: 'PreToolUse' });
    const faulty = new Proxy(f.db, { get(target, key) {
      if (key === 'prepare') return (sql: string) => {
        if (sql.startsWith('INSERT INTO codex_hook_observations')) throw new Error('observation unavailable');
        return target.prepare(sql);
      };
      const value = Reflect.get(target, key);
      return typeof value === 'function' ? value.bind(target) : value;
    } });
    const original = process.stderr.write;
    let diagnostic = '';
    process.stderr.write = ((chunk: string) => { diagnostic += chunk; return true; }) as typeof process.stderr.write;
    try {
      assert.match((handleCodexHook(faulty, { ...call, hook_event_name: 'PostToolUse', tool_response: { exit_code: 0 } }) as any).hookSpecificOutput.additionalContext, /outcome: passed/u);
    } finally { process.stderr.write = original; }
    assert.match(diagnostic, /observation_write_failed/u);
    assert.equal(f.db.prepare('SELECT COUNT(*) AS count FROM task_execution_evidence').get<{ count: number }>()!.count, 1);
  } finally { f.db.close(); rmSync(f.base, { recursive: true, force: true }); }
});
test('parallel codex-hook processes retain each completed call on one database', async () => {
  const f = await boundHookFixture();
  try {
    const calls = Array.from({ length: 4 }, (_, i) => f.event(`process-${i}`));
    for (const call of calls) handleCodexHook(f.db, { ...call, hook_event_name: 'PreToolUse' });
    const results = await Promise.all(calls.map(call => new Promise<{ code: number | null; stderr: string }>((resolve, reject) => {
      const child = spawn(process.execPath, ['--import', 'tsx', 'src/bin/kiokuko.ts', 'codex-hook', '--database', f.databasePath], { cwd: process.cwd(), stdio: ['pipe', 'pipe', 'pipe'] });
      let stderr = '';
      child.stderr.setEncoding('utf8');
      child.stderr.on('data', chunk => { stderr += chunk; });
      child.on('error', reject);
      child.on('close', code => resolve({ code, stderr }));
      child.stdin.end(JSON.stringify({ ...call, hook_event_name: 'PostToolUse', tool_response: { exit_code: 0 } }));
    })));
    assert.deepEqual(results, calls.map(() => ({ code: 0, stderr: '' })));
    assert.equal(f.db.prepare('SELECT COUNT(*) AS count FROM task_execution_evidence').get<{ count: number }>()!.count, calls.length);
    const duplicate = f.event('same-call');
    handleCodexHook(f.db, { ...duplicate, hook_event_name: 'PreToolUse' });
    const copies = await Promise.all(Array.from({ length: 3 }, () => new Promise<number | null>((resolve, reject) => {
      const child = spawn(process.execPath, ['--import', 'tsx', 'src/bin/kiokuko.ts', 'codex-hook', '--database', f.databasePath], { cwd: process.cwd(), stdio: ['pipe', 'pipe', 'pipe'] });
      child.stderr.resume(); child.stdout.resume();
      child.on('error', reject);
      child.on('close', resolve);
      child.stdin.end(JSON.stringify({ ...duplicate, hook_event_name: 'PostToolUse', tool_response: { exit_code: 0 } }));
    })));
    assert.deepEqual(copies, [0, 0, 0]);
    assert.equal(f.db.prepare('SELECT COUNT(*) AS count FROM task_execution_evidence').get<{ count: number }>()!.count, calls.length + 1);
  } finally { f.db.close(); rmSync(f.base, { recursive: true, force: true }); }
});
test('PostToolUse cannot attach evidence after delivery replacement or interruption', async () => {
  const f = await boundHookFixture();
  try {
    const stale = f.event('stale-delivery');
    handleCodexHook(f.db, { ...stale, hook_event_name: 'PreToolUse' });
    const previousDelivery = assuranceState(f.db, f.prepared.run.runId)!.delivery_id;
    await refreshTaskMemory(f.db, { runId: f.prepared.run.runId, cwd: f.root, requestId: 'replace-delivery',
      expectedRevision: taskAssuranceReport(f.db, f.prepared.run.runId).revision!, capabilities: caps, changedPaths: ['source.ts'] });
    assert.notEqual(assuranceState(f.db, f.prepared.run.runId)!.delivery_id, previousDelivery);
    assert.match((handleCodexHook(f.db, { ...stale, hook_event_name: 'PostToolUse', tool_response: { exit_code: 0 } }) as any)
      .hookSpecificOutput.additionalContext, /Delivery changed/u);
    assert.equal(f.db.prepare('SELECT COUNT(*) AS count FROM task_execution_evidence').get<{ count: number }>()!.count, 0);

    handleCodexHook(f.db, { ...f.common, hook_event_name: 'Interrupt' });
    assert.deepEqual(handleCodexHook(f.db, { ...stale, hook_event_name: 'PostToolUse', tool_response: { exit_code: 0 } }), {});
    assert.equal(f.db.prepare('SELECT COUNT(*) AS count FROM task_execution_evidence').get<{ count: number }>()!.count, 0);
  } finally { f.db.close(); rmSync(f.base, { recursive: true, force: true }); }
});

test('next-migration counterexample fails a fixed expectation and passes derived expectations through observed Codex evidence', async () => {
  const f = await fixture();
  try {
    const { loadMigrationSnapshot } = await import('../../src/db/migrate.js');
    const { mkdirSync } = await import('node:fs');
    const { spawnSync } = await import('node:child_process');
    const migrations = path.join(f.root, 'migrations');
    mkdirSync(migrations);
    const snapshot = loadMigrationSnapshot();
    for (const migration of snapshot.migrations) writeFileSync(path.join(migrations, migration.name), migration.sql);
    const versions = snapshot.migrations.map(m => m.version);
    const verifier = path.join(f.root, 'verify.mjs');
    const migrationModule = new URL('../../src/db/migrate.ts', import.meta.url).href;
    const connectionModule = new URL('../../src/db/connection.ts', import.meta.url).href;
    const moduleHeader = `import assert from 'node:assert/strict'; import { loadMigrationSnapshot, migrateDatabase } from ${JSON.stringify(migrationModule)}; import { openConnection } from ${JSON.stringify(connectionModule)}; const db=openConnection(':memory:'); const actual=migrateDatabase(db, ${JSON.stringify(migrations)}).applied; db.close();\n`;
    writeFileSync(verifier, moduleHeader + `assert.deepEqual(actual, ${JSON.stringify(versions)});\n`);
    const execute = () => spawnSync(process.execPath, ['--import', 'tsx', verifier], { cwd: process.cwd(), encoding: 'utf8' });
    assert.equal(execute().status, 0);
    const next = versions.at(-1)! + 1;
    writeFileSync(path.join(migrations, `${String(next).padStart(3, '0')}_next.sql`), 'CREATE TABLE next_case(id INTEGER);');
    let common = { session_id: 'decisive-client', turn_id: 'request', cwd: f.root };
    handleCodexHook(f.db, { ...common, hook_event_name: 'UserPromptSubmit' });
    const requestId = f.db.prepare('SELECT request_id FROM codex_hook_requests WHERE last_event = ?').get<{ request_id: string }>('UserPromptSubmit')!.request_id;
    let args = { requestId, cwd: f.root, soulRead: true, task: 'Implement migration expectations', capabilities: caps,
      profileHints: { taskType: 'build' as const, target: 'source.ts migration expectations code', expected: 'next migration tests pass', constraints: 'historical fixtures are valid' } };
    const gate = handleCodexHook(f.db, { ...common, hook_event_name: 'PreToolUse', tool_name: 'mcp__kiokuko__task_prepare', tool_use_id: 'prepare', tool_input: args });
    assert.deepEqual(gate, {});
    assert.equal(args.soulRead, true);
    let prepared = await prepareAgentTask(f.db, { ...args, skillDiscoveryMode: 'off' });
    handleCodexHook(f.db, { ...common, hook_event_name: 'PostToolUse', tool_name: 'mcp__kiokuko__task_prepare', tool_use_id: 'prepare', tool_input: args, tool_response: { structuredContent: { ...prepared, nextAction: 'required_capability_unavailable' } } });
    const blocked = handleCodexHook(f.db, { ...common, hook_event_name: 'PreToolUse', tool_name: 'apply_patch', tool_use_id: 'blocked-edit', tool_input: {} }) as any;
    assertMemoryAdvisory(blocked);
    assertMemoryAdvisory(handleCodexHook(f.db, { ...common, hook_event_name: 'Stop' }));
    common = { ...common, turn_id: 'fresh-request' };
    handleCodexHook(f.db, { ...common, hook_event_name: 'UserPromptSubmit' });
    args = { ...args, requestId: f.db.prepare('SELECT request_id FROM codex_hook_requests WHERE stop_notified=0 ORDER BY rowid DESC LIMIT 1').get<{ request_id: string }>()!.request_id };
    assert.deepEqual(handleCodexHook(f.db, { ...common, hook_event_name: 'PreToolUse', tool_name: 'mcp__kiokuko__task_prepare', tool_use_id: 'prepare', tool_input: args }), {});
    prepared = await prepareAgentTask(f.db, { ...args, skillDiscoveryMode: 'off' });
    handleCodexHook(f.db, { ...common, hook_event_name: 'PostToolUse', tool_name: 'mcp__kiokuko__task_prepare', tool_use_id: 'prepare', tool_input: args, tool_response: { structuredContent: prepared } });
    const runId = prepared.run.runId;
    const deliveryId = prepared.context!.deliveryId!;
    const review = { runId, cwd: f.root, deliveryId, entryId: f.entry.id, entryRevision: f.entry.revision, decision: 'adopted', basis: 'verify.mjs hard-codes all current migration versions', invariant: 'New migrations need no manual expected-array update', counterexample: 'Add next migration to copied migrations directory', verification: 'Execute verify.mjs against the extended migration directory', evidenceIds: [] as string[] };
    reviewTaskMemory(f.db, { ...review, requestId: 'decide', expectedRevision: taskAssuranceReport(f.db, runId).revision! });
    const observedRun = (id: string) => {
      const event = { ...common, tool_name: 'Bash', tool_use_id: id, tool_input: { command: 'node verify.mjs' } };
      assert.deepEqual(handleCodexHook(f.db, { ...event, hook_event_name: 'PreToolUse' }), {});
      const result = execute();
      handleCodexHook(f.db, { ...event, hook_event_name: 'PostToolUse', tool_response: { exit_code: result.status } });
      return f.db.prepare('SELECT evidence_id FROM codex_hook_tools WHERE call_id = ?').get<{ evidence_id: string }>(id)!.evidence_id;
    };
    defineTaskVerification(f.db, { runId, cwd: f.root, requestId: 'define-migration-check', expectedRevision: taskAssuranceReport(f.db, runId).revision!,
      reason: 'Next-migration behavior is the required completion condition', checks: [{ id: 'next-migration', target: `${process.platform}-${process.arch}`, expected: 'Next migration applies without fixed expectations', method: 'Execute the migration verifier' }] });
    const failedEvidence = observedRun('fixed-array');
    reviewTaskMemory(f.db, { ...review, requestId: 'fixed-result', expectedRevision: taskAssuranceReport(f.db, runId).revision!, evidenceIds: [failedEvidence] });
    assert.throws(() => assertAssuranceCompletion(f.db, runId, 'completed'), /incomplete/);
    writeFileSync(verifier, moduleHeader + `const expected=loadMigrationSnapshot(${JSON.stringify(migrations)}).migrations.map(m=>m.version); assert.deepEqual(actual, expected); assert.deepEqual(actual.slice(0,2), [1,2]);\n`);
    reviewTaskMemory(f.db, { ...review, requestId: 'changed-verifier-decision', expectedRevision: taskAssuranceReport(f.db, runId).revision!, evidenceIds: [] });
    const passedEvidence = observedRun('derived-array');
    reviewTaskMemory(f.db, { ...review, requestId: 'derived-result', expectedRevision: taskAssuranceReport(f.db, runId).revision!, evidenceIds: [passedEvidence] });
    assert.equal(taskAssuranceReport(f.db, runId).complete, true);
    assert.equal(taskAssuranceReport(f.db, runId).observed, true);
    recordTaskVerification(f.db, { runId, cwd: f.root, requestId: 'record-migration-check', expectedRevision: taskAssuranceReport(f.db, runId).revision!,
      contractVersion: 1, checkId: 'next-migration', target: `${process.platform}-${process.arch}`, source: { kind: 'local', evidenceId: passedEvidence } });
    assert.doesNotThrow(() => assertAssuranceCompletion(f.db, runId, 'completed'));
  } finally { f.db.close(); rmSync(f.base, { recursive: true, force: true }); }
});

test('MCP and server API share review decisions, revisions and model-only provenance', async () => {
  const f = await fixture();
  const { Client } = await import('@modelcontextprotocol/sdk/client/index.js');
  const { InMemoryTransport } = await import('@modelcontextprotocol/sdk/inMemory.js');
  const { createKiokukoMcpServer } = await import('../../src/mcp/server.js');
  const { createTaskAssuranceRoute } = await import('../../src/server/routes/task-assurance.js');
  const server = createKiokukoMcpServer({ databasePath: f.databasePath, cwd: () => f.root });
  const client = new Client({ name: 'assurance-parity', version: '1' });
  const [ct, st] = InMemoryTransport.createLinkedPair();
  await server.connect(st); await client.connect(ct);
  try {
    const runId = f.prepared.run.runId;
    const review = { runId, cwd: f.root, requestId: 'parity', expectedRevision: taskAssuranceReport(f.db, runId).revision!, deliveryId: f.prepared.context!.deliveryId!, entryId: f.entry.id, entryRevision: f.entry.revision, decision: 'inapplicable', basis: 'This fixture intentionally targets a historical schema.' };
    const result = await client.callTool({ name: 'task_memory_review', arguments: review });
    assert.notEqual(result.isError, true);
    const route = createTaskAssuranceRoute({ database: f.db, enqueueWrite: async fn => fn() });
    const { runId: _, requestId: __, ...body } = review;
    const response = await route({ method: 'POST', url: new URL(`http://localhost/api/v1/agent/runs/${runId}/memory-review`), headers: { 'idempotency-key': review.requestId }, body }) as any;
    assert.deepEqual(response.data, result.structuredContent);
    assert.equal(response.data.provenance, 'model_reported');
    await assert.rejects(route({ method: 'POST', url: new URL(`http://localhost/api/v1/agent/runs/${runId}/memory-review`), headers: { 'idempotency-key': review.requestId }, body: { ...body, basis: 'conflicting request' } }) as Promise<unknown>, /reused/);
    assert.equal(taskAssuranceReport(f.db, runId).complete, true);
    const status = await client.callTool({ name: 'task_memory_status', arguments: { runId, cwd: f.root } });
    assert.equal((status.structuredContent as any).nextAction, 'proceed');
    const httpStatus = await route({ method: 'POST', url: new URL(`http://localhost/api/v1/agent/runs/${runId}/memory-status`),
      headers: { 'idempotency-key': 'status' }, body: { cwd: f.root } }) as any;
    // Transport cancellation receipts are MCP-local; the assurance contract is shared.
    const { mcpCancellation, ...mcpAssurance } = status.structuredContent as any;
    assert.equal(mcpCancellation.contract, 'kiokuko/mcp-cancellation@1');
    assert.equal(mcpCancellation.provenance, 'server_observed');
    assert.equal(mcpCancellation.retention, 'connection_local');
    assert.equal(typeof mcpCancellation.serverInstanceId, 'string');
    assert.equal(mcpCancellation.processId, process.pid);
    assert.deepEqual(mcpCancellation.receipts, []);
    assert.equal(mcpCancellation.droppedReceipts, 0);
    assert.equal('mcpCancellation' in httpStatus.data, false);
    assert.deepEqual(httpStatus.data, mcpAssurance);
  } finally { await client.close(); await server.close(); f.db.close(); rmSync(f.base, { recursive: true, force: true }); }
});

test('rejects stale memory revisions, cross-run evidence, unknown results and concurrent reviews', async () => {
  const f = await fixture();
  try {
    const runId = f.prepared.run.runId; const deliveryId = f.prepared.context!.deliveryId!;
    const base = { runId, cwd: f.root, deliveryId, entryId: f.entry.id, entryRevision: f.entry.revision, decision: 'contradicted', basis: 'Current source contradicts this entry' };
    const revision = taskAssuranceReport(f.db, runId).revision!;
    assert.throws(() => reviewTaskMemory(f.db, { ...base, basis: '', requestId: 'empty', expectedRevision: revision }), /invalid/);
    const first = reviewTaskMemory(f.db, { ...base, requestId: 'first', expectedRevision: revision });
    assert.throws(() => reviewTaskMemory(f.db, { ...base, requestId: 'concurrent', expectedRevision: revision }), /revision changed/);
    assert.equal(taskAssuranceReport(f.db, runId).complete, true);
    for (const outcome of ['skipped', 'unknown'] as const) {
      const evidence = recordTaskEvidence(f.db, { runId, cwd: f.root, deliveryId, requestId: outcome, expectedRevision: taskAssuranceReport(f.db, runId).revision!, execution: 'node verifier', stateDigest: repositoryStateDigest(f.root), outcome, exitCode: null });
      reviewTaskMemory(f.db, { ...base, decision: 'adopted', invariant: 'No fixed current schema', counterexample: 'Next migration', verification: 'node verifier', evidenceIds: [evidence.evidenceId], requestId: `review-${outcome}`, expectedRevision: evidence.revision });
      assert.equal(taskAssuranceReport(f.db, runId).complete, false);
    }
    const { updateCandidateEntry } = await import('../../src/memory/entries.js');
    updateCandidateEntry(f.db, { workspace: f.entry.workspace, entryId: f.entry.id, expectedRevision: f.entry.revision, kind: f.entry.kind, title: f.entry.title, body: f.entry.body + '\nCorrected current evidence.', scope: f.entry.scope, tags: f.entry.tags });
    assert.deepEqual(taskAssuranceReport(f.db, runId).stale, [f.entry.id]);
    assert.equal(memoryReviewNextAction(taskAssuranceReport(f.db, runId)), 'refresh_memory');
    assert.throws(() => reviewTaskMemory(f.db, { ...base, requestId: 'old-entry', expectedRevision: taskAssuranceReport(f.db, runId).revision! }), /revision changed/);
    const refreshed = await refreshTaskMemory(f.db, { runId, cwd: f.root, requestId: 'updated-entry',
      expectedRevision: taskAssuranceReport(f.db, runId).revision!, capabilities: caps, changedPaths: ['source.ts'] });
    assert.equal(refreshed.nextAction, 'review_memory_application');
    assert.deepEqual(taskAssuranceReport(f.db, runId).stale, []);
    assert.ok(first.revision > revision);
  } finally { f.db.close(); rmSync(f.base, { recursive: true, force: true }); }
});
test('refresh acknowledgement failure rolls back its delivery and revision', async () => {
  const f = await fixture();
  try {
    const runId = f.prepared.run.runId;
    const revision = taskAssuranceReport(f.db, runId).revision!;
    const count = () => f.db.prepare('SELECT COUNT(*) n FROM context_deliveries WHERE run_id=?').get<{ n: number }>(runId)!.n;
    const before = count();
    const faulty = { filePath: f.db.filePath, close: () => {}, exec: (sql: string) => f.db.exec(sql), prepare: (sql: string) => {
      if (sql.startsWith('INSERT INTO task_assurance_requests')) throw new Error('injected acknowledgement failure');
      return f.db.prepare(sql);
    } };
    await assert.rejects(refreshTaskMemory(faulty, { runId, cwd: f.root, requestId: 'rollback', expectedRevision: revision, capabilities: caps, changedPaths: ['migration.ts'] }), /injected/);
    assert.equal(count(), before);
    assert.equal(taskAssuranceReport(f.db, runId).revision, revision);
  } finally { f.db.close(); rmSync(f.base, { recursive: true, force: true }); }
});

test('stdout cannot spoof exit metadata and unfinished processes stay unknown', () => {
  assert.equal(observedExitCode('Chunk ID: abc123\nWall time: 0.1 seconds\nProcess exited with code 0\nFinal output:\n'), null);
  assert.equal(observedExitCode('Wall time: 0.1 seconds\nExit code: 1\nOutput:\n'), null);
  assert.equal(observedExitCode('output\nWall time: 0.1 seconds\nExit code: 0\nOutput:\n'), null);
  assert.equal(observedExitCode({ session_id: 12 }), null);
  assert.equal(observedExitCode({ exit_code: 0.5 }), null);
  assert.equal(observedExitCode({ exit_code: 0 }), 0);
  assert.equal(observedExitCode({ exit_code: 1 }), 1);
  assert.equal(observedExitCode('{"exit_code":0}'), null);
  for (const incomplete of [{session_id:12}, {timed_out:true}, {interrupted:true}, {signal:'SIGTERM'}, {status:'running'}, {error:'timeout'}]) {
    assert.equal(observedExitCode({...incomplete,exit_code:0}),null);
  }
});

test('request diagnostics expose protocol field types without leaking command output or other requests', async () => {
  const f = await boundHookFixture();
  try {
    const call = f.event('shape-probe');
    handleCodexHook(f.db, { ...call, hook_event_name: 'PreToolUse' });
    handleCodexHook(f.db, { ...call, hook_event_name: 'PostToolUse', tool_response: 'PRIVATE_STDOUT',
      tool_response_metadata: { exit_code: 0 }, transcript_path: '/private/TRANSCRIPT_PATH', private_field: 'PRIVATE_VALUE' });
    const requestId = f.db.prepare('SELECT request_id FROM codex_hook_requests').get<{request_id:string}>()!.request_id;
    const diagnostic = codexHookDiagnostics(f.db, requestId) as any;
    const last = diagnostic.events.at(-1);
    assert.equal(last.shape.type, 'string');
    assert.equal(last.shape.hostFields.tool_response_metadata, 'object');
    assert.equal(last.shape.hostFields.transcript_path, 'string');
    assert.equal(JSON.stringify(diagnostic).includes('PRIVATE'), false);
    const other = codexHookDiagnostics(f.db, 'codex-' + 'f'.repeat(64)) as any;
    assert.deepEqual(other.events, []);
    assert.throws(() => codexHookDiagnostics(f.db, 'invalid'));
  } finally { f.db.close(); rmSync(f.base, {recursive:true, force:true}); }
});

test('stdout-only hooks recover typed command completion from the exact host log record', async () => {
  const f = await boundHookFixture();
  const previousHome = process.env.CODEX_HOME;
  const codeHome = path.join(f.base, 'codex');
  const sessions = path.join(codeHome, 'sessions');
  mkdirSync(sessions, {recursive:true});
  process.env.CODEX_HOME = codeHome;
  const transcript = path.join(sessions, `rollout-test-${f.common.session_id}.jsonl`);
  const header = {type:'session_meta',payload:{id:f.common.session_id,cwd:f.root,cli_version:'0.162.0-alpha.17.2'}};
  const completion = (id:string, exit:number) => ({type:'event_msg',payload:{type:'item_completed',thread_id:f.common.session_id,turn_id:f.common.turn_id,
    item:{type:'CommandExecution',id,process_id:'91',source:'unified_exec_startup',cwd:pathToFileURL(f.root).href,status:exit === 0 ? 'completed':'failed',exit_code:exit}}});
  try {
    for (const exit of [0,7]) {
      const call = f.event(`host-exit-${exit}`);
      handleCodexHook(f.db, {...call,hook_event_name:'PreToolUse'});
      writeFileSync(transcript, [header, completion(call.tool_use_id,exit)].map(x=>JSON.stringify(x)+'\n').join(''), {mode:0o600});
      const event = {...call,hook_event_name:'PostToolUse',tool_response:'Process exited with code 0',transcript_path:transcript};
      handleCodexHook(f.db,event);handleCodexHook(f.db,event);
      const evidence = f.db.prepare('SELECT outcome,exit_code,provenance FROM task_execution_evidence ORDER BY rowid DESC LIMIT 1').get<any>();
      assert.deepEqual(evidence && {...evidence},{outcome:exit === 0 ? 'passed':'failed',exit_code:exit,provenance:'client_observed'});
    }
    assert.equal(f.db.prepare('SELECT COUNT(*) n FROM task_execution_evidence').get<any>()!.n,2);
    assert.equal(taskAssuranceReport(f.db,f.prepared.run.runId).executionObservation!.structuredExitCalls,2);
  } finally { if(previousHome===undefined) delete process.env.CODEX_HOME; else process.env.CODEX_HOME=previousHome; f.db.close();rmSync(f.base,{recursive:true,force:true}); }
});

test('host receipt binds a post-only poll to its admitted command without trusting stdout session headers', async () => {
  const f=await boundHookFixture();const previous=process.env.CODEX_HOME;
  const home=path.join(f.base,'codex');const sessions=path.join(home,'sessions');mkdirSync(sessions,{recursive:true});process.env.CODEX_HOME=home;
  const transcript=path.join(sessions,`rollout-test-${f.common.session_id}.jsonl`);
  const header={type:'session_meta',payload:{id:f.common.session_id,cwd:f.root}};
  const start=f.event('host-process');
  const record={type:'event_msg',payload:{type:'item_completed',thread_id:f.common.session_id,turn_id:f.common.turn_id,
    item:{type:'CommandExecution',id:start.tool_use_id,process_id:'92',source:'unified_exec_startup',cwd:f.root,status:'completed',exit_code:0}}};
  try {
    handleCodexHook(f.db,{...start,hook_event_name:'PreToolUse'});
    writeFileSync(transcript,JSON.stringify(header)+'\n',{mode:0o600});
    handleCodexHook(f.db,{...start,hook_event_name:'PostToolUse',tool_response:'Process running with session ID 92',transcript_path:transcript});
    assert.equal(f.db.prepare('SELECT COUNT(*) n FROM codex_hook_processes').get<any>()!.n,0);
    writeFileSync(transcript,JSON.stringify(record)+'\n',{flag:'a'});
    const poll={...f.common,hook_event_name:'PostToolUse',tool_name:'write_stdin',tool_use_id:'host-poll',tool_input:{session_id:92},tool_response:'exit_code: 0',transcript_path:transcript};
    handleCodexHook(f.db,poll);
    // Correlation survives eviction of the host event from the bounded log tail.
    writeFileSync(transcript,JSON.stringify(header)+'\n');
    handleCodexHook(f.db,poll);
    assert.equal(f.db.prepare('SELECT COUNT(*) n FROM task_execution_evidence').get<any>()!.n,1);
    const rows=f.db.prepare("SELECT evidence_id FROM codex_hook_tools WHERE call_id IN ('host-process','host-poll')").all<any>();
    assert.equal(rows.length,2);assert.ok(rows[0].evidence_id);assert.equal(rows[0].evidence_id,rows[1].evidence_id);
    assertMemoryAdvisory(handleCodexHook(f.db,{...poll,tool_use_id:'foreign-session',tool_input:{session_id:93}}));
    assert.equal(f.db.prepare('SELECT COUNT(*) n FROM task_execution_evidence').get<any>()!.n,1);
  } finally {if(previous===undefined)delete process.env.CODEX_HOME;else process.env.CODEX_HOME=previous;f.db.close();rmSync(f.base,{recursive:true,force:true});}
});

test('legacy review history without decision dependencies is retained but cannot certify a new delivery', async () => {
  const f = await fixture();
  try {
    const runId = f.prepared.run.runId;
    const deliveryId = f.prepared.context!.deliveryId!;
    f.db.prepare('INSERT INTO task_memory_reviews VALUES (?,?,?,?,?,?,?,?,?,?,?)')
      .run(runId,deliveryId,f.entry.id,1,'inapplicable','legacy basis','','','','[]',new Date().toISOString());
    assert.deepEqual(taskAssuranceReport(f.db,runId).pending,[f.entry.id]);
    const result = await refreshTaskMemory(f.db,{runId,cwd:f.root,requestId:'legacy-refresh',expectedRevision:taskAssuranceReport(f.db,runId).revision!,capabilities:caps,changedPaths:['source.ts']}) as any;
    assert.deepEqual(result.assurance.pending,[f.entry.id]);
    assert.equal(f.db.prepare('SELECT COUNT(*) n FROM task_memory_reviews WHERE run_id=?').get<{n:number}>(runId)!.n,1);
    assert.equal(f.db.prepare('SELECT COUNT(*) n FROM task_memory_decisions WHERE run_id=?').get<{n:number}>(runId)!.n,0);
  } finally { f.db.close();rmSync(f.base,{recursive:true,force:true}); }
});
test('code plans require memory decisions but no implementation test; another run cannot donate evidence', async () => {
  const f = await fixture();
  try {
    const originalId = f.prepared.run.runId;
    const originalDelivery = f.prepared.context!.deliveryId!;
    const evidence = recordTaskEvidence(f.db, { runId: originalId, cwd: f.root, deliveryId: originalDelivery, requestId: 'original-evidence', expectedRevision: taskAssuranceReport(f.db, originalId).revision!, execution: 'test', stateDigest: repositoryStateDigest(f.root), outcome: 'passed', exitCode: 0 });
    const plan = await prepareAgentTask(f.db, { cwd: f.root, requestId: 'plan-request', task: 'Plan migration code changes', capabilities: caps, skillDiscoveryMode: 'off', profileHints: { taskType: 'analysis', target: 'source.ts migration expectations code', expected: 'implementation plan only', constraints: 'do not implement' } });
    const runId = plan.run.runId;
    assert.equal(taskAssuranceReport(f.db, runId).complete, false);
    const review = { runId, cwd: f.root, requestId: 'plan-decision', expectedRevision: taskAssuranceReport(f.db, runId).revision!, deliveryId: plan.context!.deliveryId!, entryId: f.entry.id, entryRevision: f.entry.revision, decision: 'adopted', basis: 'Plan derives current migrations', invariant: 'Next migration requires no manual expectation', counterexample: 'Add a migration', verification: 'Implementation will run the next migration case' };
    assert.throws(() => reviewTaskMemory(f.db, { ...review, evidenceIds: [evidence.evidenceId] }), /another run or delivery/);
    reviewTaskMemory(f.db, review);
    assert.equal(taskAssuranceReport(f.db, runId).complete, true);
    assert.equal(taskAssuranceReport(f.db, runId).observed, false);
  } finally { f.db.close(); rmSync(f.base, { recursive: true, force: true }); }
});

test('retrieval diagnostics distinguish an empty workspace, no match and a search failure', async () => {
  const f = await fixture();
  try {
    const { federatedEntries } = await import('../../src/memory/federated-retrieval.js');
    const emptyRoot = path.join(f.base, 'empty');
    execFileSync('git', ['init', '-q', emptyRoot]);
    const emptyProject = (await resolveProjectWorkspace(f.db, emptyRoot))!;
    let status = '';
    await federatedEntries(f.db, { project: emptyProject, query: 'unmatchabletoken999', limit: 10, observe: d => { status = d.status; } });
    assert.equal(status, 'no_entries');
    const project = (await resolveProjectWorkspace(f.db, f.root))!;
    await federatedEntries(f.db, { project, query: 'unmatchabletoken999', limit: 10, observe: d => { status = d.status; } });
    assert.equal(status, 'no_match');
    const original = f.db.prepare.bind(f.db);
    f.db.prepare = () => { throw new Error('injected search outage'); };
    try {
      await assert.rejects(federatedEntries(f.db, { project, query: 'migration', limit: 10, observe: () => assert.fail('Errors must not be observed as empty retrieval') }), /search outage/);
    } finally { f.db.prepare = original; }
  } finally { f.db.close(); rmSync(f.base, { recursive: true, force: true }); }
});

test('A-B-A refresh rebinds replay and carries latest decisions without resurrecting an old assessment', async () => {
 const f=await fixture();
 try {
  const runId=f.prepared.run.runId;
  const refresh=async(label:string,signals:string[])=>await refreshTaskMemory(f.db,{runId,cwd:f.root,requestId:label,expectedRevision:taskAssuranceReport(f.db,runId).revision!,capabilities:caps,changedPaths:signals}) as any;
  const a=await refresh('a',['a.ts']);
  const review=(deliveryId:string,decision:'inapplicable'|'contradicted',label:string)=>reviewTaskMemory(f.db,{runId,cwd:f.root,requestId:label,expectedRevision:taskAssuranceReport(f.db,runId).revision!,deliveryId,entryId:f.entry.id,entryRevision:1,decision,basis:'Current fixture assessment'});
  review(a.context.deliveryId,'inapplicable','review-a');
  const b=await refresh('b',['b.ts']);
  assert.equal(b.assurance.pending.length,0);
  review(b.context.deliveryId,'contradicted','review-b');
  const back=await refresh('a-again',['a.ts']);
  assert.equal(back.context.deliveryId,a.context.deliveryId);
  assert.equal(assuranceState(f.db,runId)!.delivery_id,a.context.deliveryId);
  assert.equal(back.assurance.pending.length,0);
  const latest=f.db.prepare('SELECT decision_id FROM task_memory_decisions ORDER BY sequence DESC LIMIT 1').get<any>()!.decision_id;
  assert.equal(back.assurance.decisions[0].decisionId,latest);
  review(back.context.deliveryId,'inapplicable','review-return');
  const before=assuranceState(f.db,runId)!.delivery_id;
  await refreshTaskMemory(f.db,{runId,cwd:f.root,requestId:'b',expectedRevision:b.assurance.revision-1,capabilities:caps,changedPaths:['b.ts']});
  assert.equal(assuranceState(f.db,runId)!.delivery_id,before);
 } finally {f.db.close();rmSync(f.base,{recursive:true,force:true});}
});
test('recoverable preparation denial leaves same-turn preparation and review repair available',async()=>{
 const f=await fixture();
 try {
  const common={session_id:'repair',turn_id:'same',cwd:f.root};
  handleCodexHook(f.db,{...common,hook_event_name:'UserPromptSubmit'});
  const requestId=f.db.prepare('SELECT request_id FROM codex_hook_requests').get<any>()!.request_id;
  const pre=(name:string,args:object)=>handleCodexHook(f.db,{...common,hook_event_name:'PreToolUse',tool_name:name,tool_use_id:name,tool_input:args}) as any;
  assertMemoryAdvisory(pre('exec_command',{}));
  assert.equal(lastHookDiagnostic(f.db).reason,'preparation_required');
  assert.equal(f.db.prepare('SELECT stop_notified FROM codex_hook_requests').get<any>()!.stop_notified,0);
  assert.deepEqual(pre('mcp__kiokuko__task_prepare',{requestId,cwd:f.root}),{});
  handleCodexHook(f.db,{...common,hook_event_name:'PostToolUse',tool_name:'mcp__kiokuko__task_prepare',tool_use_id:'prepare',tool_input:{requestId,cwd:f.root},tool_response:{structuredContent:f.prepared}});
  assertMemoryAdvisory(pre('exec_command',{}));
  assert.equal(lastHookDiagnostic(f.db).reason,'memory_review_pending');
  assert.deepEqual(pre('mcp__kiokuko__task_memory_status',{runId:f.prepared.run.runId,cwd:f.root}),{});
  reviewTaskMemory(f.db,{runId:f.prepared.run.runId,cwd:f.root,requestId:'repair-review',expectedRevision:taskAssuranceReport(f.db,f.prepared.run.runId).revision!,deliveryId:f.prepared.context!.deliveryId!,entryId:f.entry.id,entryRevision:1,decision:'inapplicable',basis:'Does not apply to current execution'});
  assert.deepEqual(pre('exec_command',{}),{});
 }finally{f.db.close();rmSync(f.base,{recursive:true,force:true});}
});
for (const firstTool of ['task_prepare', 'task_inspect', 'exec_command']) {
  test(`missing prompt after interruption permits same-turn bootstrap (${firstTool})`, async () => {
    const f = await fixture();
    try {
      const previous = { session_id: 'resumed-client', turn_id: 'interrupted', cwd: f.root };
      handleCodexHook(f.db, { ...previous, hook_event_name: 'UserPromptSubmit' });
      const previousId = f.db.prepare('SELECT request_id FROM codex_hook_requests').get<any>()!.request_id;
      handleCodexHook(f.db, { ...previous, hook_event_name: 'PostToolUse', tool_name: 'mcp__kiokuko__task_prepare',
        tool_use_id: 'old-prepare', tool_input: { cwd: f.root, requestId: previousId }, tool_response: { structuredContent: f.prepared } });
      handleCodexHook(f.db, { ...previous, hook_event_name: 'Interrupt' });
      const current = { ...previous, turn_id: 'resumed-without-prompt' };
      const pre = (tool_name: string, tool_input: object) => handleCodexHook(f.db, {
        ...current, hook_event_name: 'PreToolUse', tool_name, tool_use_id: tool_name, tool_input,
      }) as any;
      const tool = firstTool === 'exec_command' ? firstTool : `mcp__kiokuko__${firstTool}`;
      const blocked = pre(tool, { cwd: f.root, requestId: previousId, operation: 'skill' });
      if (firstTool === 'exec_command') assertMemoryAdvisory(blocked);
      else assert.equal(blocked.hookSpecificOutput.permissionDecision, 'deny');
      assert.equal(lastHookDiagnostic(f.db).reason, 'request_not_observed');
      assert.equal(lastHookDiagnostic(f.db).recoverable, true);
      assert.doesNotMatch(blocked.systemMessage, /wait for a new user message/u);
      const pending = f.db.prepare("SELECT * FROM codex_hook_requests WHERE state='pending'").get<any>()!;
      assert.equal(pending.stop_notified, 0);
      assert.equal(pending.run_id, null);
      assert.notEqual(pending.request_id, previousId);
      assert.match(blocked.hookSpecificOutput?.permissionDecisionReason ?? blocked.systemMessage, new RegExp(pending.request_id));
      assert.equal(f.db.prepare('SELECT COUNT(*) n FROM codex_hook_tools').get<any>()!.n, 0);
      assert.equal(new LedgerStore(f.db).readRun(f.prepared.run.runId)!.status, 'interrupted');
      assert.deepEqual(pre('mcp__kiokuko__task_inspect', { cwd: f.root, operation: 'skill' }), {});
      const args = { cwd: f.root, requestId: pending.request_id, soulRead: true, capabilities: caps,
        task: 'Implement migration expectations', skillDiscoveryMode: 'off' as const,
        profileHints: { taskType: 'build' as const, target: 'source.ts migration expectations code', expected: 'next migration tests pass' } };
      assert.deepEqual(pre('mcp__kiokuko__task_prepare', args), {});
      const prepared = await prepareAgentTask(f.db, args);
      assert.equal(prepared.run.status, 'active');
      handleCodexHook(f.db, { ...current, hook_event_name: 'PostToolUse', tool_name: 'mcp__kiokuko__task_prepare',
        tool_use_id: 'prepare', tool_input: args, tool_response: { structuredContent: prepared } });
      assertMemoryAdvisory(pre('exec_command', { cmd: 'true' }));
      assert.equal(lastHookDiagnostic(f.db).reason, 'memory_review_pending');
      reviewTaskMemory(f.db, { cwd: f.root, runId: prepared.run.runId, requestId: 'resumed-review',
        expectedRevision: taskAssuranceReport(f.db, prepared.run.runId).revision!, deliveryId: prepared.context!.deliveryId!,
        entryId: f.entry.id, entryRevision: 1, decision: 'inapplicable', basis: 'This migration lesson is unrelated to the resumed fixture command' });
      assert.deepEqual(pre('exec_command', { cmd: 'true' }), {});
      handleCodexHook(f.db, { ...current, hook_event_name: 'Interrupt' });
      assert.equal(pre('mcp__kiokuko__task_prepare', args).hookSpecificOutput.permissionDecision, 'deny');
      assert.equal(lastHookDiagnostic(f.db).reason, 'request_interrupted');
    } finally { f.db.close(); rmSync(f.base, { recursive: true, force: true }); }
  });
}
test('missing prompt cannot bootstrap from malformed tools or post-only completion', async () => {
  const f = await fixture();
  try {
    const common = { session_id: 'missing-event', turn_id: 'request', cwd: f.root };
    assert.throws(() => handleCodexHook(f.db, { ...common, hook_event_name: 'PreToolUse' }), /Hook tool identity is missing/u);
    assert.throws(() => handleCodexHook(f.db, { ...common, hook_event_name: 'PostToolUse',
      tool_name: 'exec_command', tool_use_id: 'unadmitted', tool_input: {}, tool_response: { exit_code: 0 } }), /request start was not observed/u);
    assert.equal(f.db.prepare('SELECT COUNT(*) n FROM codex_hook_requests').get<any>()!.n, 0);
    assert.equal(f.db.prepare('SELECT COUNT(*) n FROM task_execution_evidence').get<any>()!.n, 0);
  } finally { f.db.close(); rmSync(f.base, { recursive: true, force: true }); }
});
test('three unchanged reads add observations without review revision or guidance',async()=>{
 const f=await boundHookFixture();
 try {
  const before=taskAssuranceReport(f.db,f.prepared.run.runId).revision;
  for(let i=0;i<3;i++){const call=f.event('read-'+i);handleCodexHook(f.db,{...call,hook_event_name:'PreToolUse'});const result=handleCodexHook(f.db,{...call,hook_event_name:'PostToolUse',tool_response:'{"exit_code":0}'});assert.deepEqual(result,{});}
  const report=taskAssuranceReport(f.db,f.prepared.run.runId);
  assert.equal(report.revision,before);assert.equal(report.observationSequence,3);
  assert.equal(observedExitCode({exit_code:0,timed_out:true}),null);
  assert.equal(observedExitCode({exit_code:0,session_id:3}),null);
 }finally{f.db.close();rmSync(f.base,{recursive:true,force:true});}
});

test('fifteen unchanged decisions carry across deliveries; one revised entry alone returns pending', async () => {
  const f = await fixture();
  try {
    const entries = [f.entry, ...Array.from({ length: 14 }, (_, i) => recordEntry(f.db, {
      workspace: f.prepared.project.workspace, kind: 'lesson', title: `migration expectation ${i}`,
      body: `Migration requirement ${i}`, tags: ['source.ts'],
    }))];
    const runId = f.prepared.run.runId;
    const refresh = (id: string, changedPaths: string[]) => refreshTaskMemory(f.db, {
      runId, cwd: f.root, requestId: id, expectedRevision: taskAssuranceReport(f.db, runId).revision!, capabilities: caps,
      changedPaths,
    }) as Promise<any>;
    const first = await refresh('fifteen-first', ['source.ts']);
    assert.equal(first.context.items.length, 15);
    for (const entry of entries) reviewTaskMemory(f.db, {
      runId, cwd: f.root, requestId: `fifteen-${entry.id}`, expectedRevision: taskAssuranceReport(f.db, runId).revision!,
      deliveryId: first.context.deliveryId, entryId: entry.id, entryRevision: entry.revision,
      decision: 'inapplicable', basis: 'Current fixture contains none of this separate lesson condition',
    });
    const revision = taskAssuranceReport(f.db, runId).revision;
    const same = await refresh('fifteen-same', ['source.ts']);
    assert.equal(same.assurance.revision, revision);
    const second = await refresh('fifteen-second', ['other.ts']);
    assert.equal(second.assurance.pending.length, 0);
    assert.equal(f.db.prepare('SELECT COUNT(*) n FROM task_memory_decisions').get<{n:number}>()!.n, 15);
    updateCandidateEntry(f.db, {workspace: entries[0]!.workspace, entryId: entries[0]!.id, expectedRevision: 1,
      kind: 'decision', title: entries[0]!.title, body: 'Changed requirement', tags: ['source.ts']});
    const changed = await refresh('fifteen-changed', ['source.ts']);
    assert.deepEqual(changed.assurance.pending, [entries[0]!.id]);
    f.db.close();
    const reopened = openConnection(f.databasePath);
    try { assert.deepEqual(taskAssuranceReport(reopened, runId).pending, [entries[0]!.id]); }
    finally { reopened.close(); }
  } finally { try { f.db.close(); } catch {} rmSync(f.base, { recursive: true, force: true }); }
});

test('explicit path and error dependencies invalidate only their stated conditions', async () => {
  const f = await fixture();
  try {
    const runId = f.prepared.run.runId;
    const refreshed = await refreshTaskMemory(f.db, {runId, cwd:f.root, requestId:'dep-delivery',
      expectedRevision:taskAssuranceReport(f.db,runId).revision!, capabilities:caps, changedPaths:['source.ts'], errorSignatures:['migration error']}) as any;
    reviewTaskMemory(f.db, {runId, cwd:f.root, requestId:'dep-review', expectedRevision:taskAssuranceReport(f.db,runId).revision!,
      deliveryId:refreshed.context.deliveryId, entryId:f.entry.id, entryRevision:1, decision:'inapplicable', basis:'Only source.ts and the explicit error matter',
      dependencies:{paths:['source.ts'],errors:['migration error']}});
    writeFileSync(path.join(f.root, 'unrelated.ts'), 'unrelated');
    assert.equal(taskAssuranceReport(f.db,runId).pending.length,0);
    const cleared = await refreshTaskMemory(f.db,{runId,cwd:f.root,requestId:'dep-cleared',expectedRevision:taskAssuranceReport(f.db,runId).revision!,capabilities:caps,changedPaths:['source.ts'],errorSignatures:[]}) as any;
    assert.deepEqual(cleared.assurance.pending,[f.entry.id]);
    writeFileSync(path.join(f.root,'source.ts'),'changed');
    assert.deepEqual(taskAssuranceReport(f.db,runId).pending,[f.entry.id]);
  } finally {f.db.close();rmSync(f.base,{recursive:true,force:true});}
});

test('a child preparation denial does not inherit or fail the parent binding', async () => {
  const f = await boundHookFixture();
  try {
    const child = { ...f.common, agent_id: 'child' };
    handleCodexHook(f.db, { ...child, hook_event_name: 'SubagentStart' });
    const denied = handleCodexHook(f.db, { ...child, hook_event_name: 'PreToolUse', tool_name: 'exec_command',
      tool_use_id: 'child-work', tool_input: {cmd:'true'} }) as any;
    assertMemoryAdvisory(denied);
    assert.equal(lastHookDiagnostic(f.db).reason, 'preparation_required');
    assert.equal(lastHookDiagnostic(f.db).recoverable, true);
    assert.equal(f.db.prepare('SELECT status FROM ledger_runs WHERE run_id=?').get<{status:string}>(f.prepared.run.runId)!.status, 'active');
    assert.deepEqual(handleCodexHook(f.db, { ...f.event('parent-work'), hook_event_name:'PreToolUse' }), {});
  } finally { f.db.close(); rmSync(f.base,{recursive:true,force:true}); }
});

test('MCP contract mismatch preserves diagnosis and blocks ordinary execution without latching', async () => {
  const f = await boundHookFixture();
  try {
    const requestId = f.db.prepare('SELECT request_id FROM codex_hook_requests').get<{request_id:string}>()!.request_id;
    const incompatible = { ...f.prepared, assurance: {...f.prepared.assurance, contract:{id:'foreign/host-only',version:1}} };
    const result = handleCodexHook(f.db, {...f.common, hook_event_name:'PostToolUse',tool_name:'mcp__kiokuko__task_prepare',
      tool_use_id:'mismatch',tool_input:{requestId,cwd:f.root},tool_response:{structuredContent:incompatible}}) as any;
    assert.match(result.hookSpecificOutput.additionalContext,/contract mismatch/);
    assert.equal(f.db.prepare('SELECT stop_notified FROM codex_hook_requests').get<{stop_notified:number}>()!.stop_notified,0);
    assertMemoryAdvisory((handleCodexHook(f.db,{...f.event('blocked'),hook_event_name:'PreToolUse'}) as any));
    assert.equal(lastHookDiagnostic(f.db).recoverable,true);
    assert.deepEqual(handleCodexHook(f.db,{...f.common,hook_event_name:'PreToolUse',tool_name:'mcp__kiokuko__task_inspect',
      tool_use_id:'inspect',tool_input:{cwd:f.root,operation:'skill'}}),{});
  } finally { f.db.close();rmSync(f.base,{recursive:true,force:true}); }
});

test('concurrent exact refresh retries commit one receipt and no redundant transition', async () => {
  const f=await fixture();
  try {
    const input={runId:f.prepared.run.runId,cwd:f.root,requestId:'parallel-refresh',expectedRevision:taskAssuranceReport(f.db,f.prepared.run.runId).revision!,capabilities:caps,changedPaths:['source.ts']};
    const result=await Promise.allSettled([refreshTaskMemory(f.db,input),refreshTaskMemory(f.db,input)]);
    assert.equal(result[0]!.status,'fulfilled');
    if(result[1]!.status==='rejected') assert.equal((result[1]!.reason as any).code,'CONFLICT');
    else assert.deepEqual(result[1]!.value,(result[0] as PromiseFulfilledResult<unknown>).value);
    assert.equal(f.db.prepare('SELECT COUNT(*) n FROM task_assurance_requests WHERE request_id=?').get<{n:number}>('parallel-refresh')!.n,1);
    const current=assuranceState(f.db,input.runId)!;
    assert.equal(current.delivery_id,((result[0] as PromiseFulfilledResult<any>).value).context.deliveryId);
  } finally {f.db.close();rmSync(f.base,{recursive:true,force:true});}
});


test('natural response-only requests and bounded staged inspection finish without preparing a run', async () => {
  const git = (root: string, ...args: string[]) => execFileSync('git', ['-C', root, ...args], { stdio: 'pipe', timeout: 5000 });
  const base = mkdtempSync(path.join(tmpdir(), 'kiokuko-response-only-'));
  const root = path.join(base, 'repo'); mkdirSync(root); git(root, 'init', '-q');
  writeFileSync(path.join(root, 'source.txt'), 'old\n'); git(root, 'add', '.');
  git(root, '-c', 'user.name=Test', '-c', 'user.email=t@example.invalid', 'commit', '-qm', 'init');
  writeFileSync(path.join(root, 'source.txt'), 'new\n'); git(root, 'add', '.');
  const databasePath = path.join(base, 'memory.sqlite3'); await initializeDatabase({ databasePath });
  const db = openConnection(databasePath);
  try {
    // These are hook boundary traces, not a claim that a model selected this route.
    const requests = ['この説明を英訳して: ファイルは確認後に作成します。', '結果: 全5件成功。この結果を説明して。',
      '訂正: 自動再作成ではなく作成するか聞いて。', '変更: 欠落ファイルの作成前に確認する。コミット文面を。'];
    for (const [index, prompt] of requests.entries()) {
      const common = { session_id: 'responses', turn_id: String(index), cwd: root };
      const result = handleCodexHook(db, { ...common, hook_event_name: 'UserPromptSubmit', prompt }) as any;
      assert.match(result.hookSpecificOutput.additionalContext, /zero preparation, memory, or verification calls/u);
      assert.deepEqual(handleCodexHook(db, { ...common, hook_event_name: 'Stop' }), {});
    }
    const common = { session_id: 'responses', turn_id: 'staged', cwd: root };
    handleCodexHook(db, { ...common, hook_event_name: 'UserPromptSubmit', prompt: 'staged 差分からコミットメッセージを書いて。' });
    const call = { ...common, tool_name: 'mcp__kiokuko__task_inspect', tool_use_id: 'diff', tool_input: { cwd: root, operation: 'diff', scope: 'auto' } };
    assert.deepEqual(handleCodexHook(db, { ...call, hook_event_name: 'PreToolUse' }), {});
    const result = inspectTask(call.tool_input);
    assert.equal('scope' in result && result.scope, 'staged');
    handleCodexHook(db, { ...call, hook_event_name: 'PostToolUse', tool_response: { structuredContent: result } });
    assert.deepEqual(handleCodexHook(db, { ...common, hook_event_name: 'Stop' }), {});
    assert.equal(db.prepare('SELECT count(*) AS count FROM ledger_runs').get<{count:number}>()!.count, 0);
    for (const [tool_name, tool_input] of [['exec_command', { cmd: 'git diff --cached' }], ['apply_patch', { patch: 'source.txt を修正する' }], ['js', { code: 'readFileSync("source.txt")' }],
      ['mcp__kiokuko__task_inspect', { cwd: root, operation: 'diff', command: 'touch escaped' }]] as const) {
      const event = { ...common, turn_id: tool_name, hook_event_name: 'PreToolUse', tool_name, tool_use_id: 'fake-read', tool_input };
      handleCodexHook(db, { ...event, hook_event_name: 'UserPromptSubmit', prompt: tool_name === 'apply_patch' ? '修正して' : tool_name === 'exec_command' ? '公開して' : 'just read this' });
      if (tool_name === 'mcp__kiokuko__task_inspect') assert.throws(() => inspectTask(tool_input));
      else assertMemoryAdvisory((handleCodexHook(db, event) as any));
    }
  } finally { db.close(); rmSync(base, { recursive: true, force: true }); }
});

test('duplicate string completions use one counter, no execution evidence, and permit later structured completion', async () => {
 const f = await boundHookFixture();
 try {
  const call = f.event('unknown-duplicate');
  handleCodexHook(f.db, { ...call, hook_event_name: 'PreToolUse' });
  for (let i = 0; i < 2; i++) handleCodexHook(f.db, { ...call, hook_event_name: 'PostToolUse', tool_response: 'Process exited with code 0' });
  assert.equal(f.db.prepare('SELECT COUNT(*) n FROM task_execution_evidence').get<any>()!.n, 0);
  const report = taskAssuranceReport(f.db, f.prepared.run.runId) as any;
  assert.equal(report.executionObservation.unknownExitCalls, 1);
  assert.equal(report.executionObservation.trustedExitMetadata, 'unavailable');
  handleCodexHook(f.db, { ...call, hook_event_name: 'PostToolUse', tool_response: { exit_code: 0 } });
  assert.equal(f.db.prepare('SELECT COUNT(*) n FROM task_execution_evidence').get<any>()!.n, 1);
  assert.equal((taskAssuranceReport(f.db, f.prepared.run.runId) as any).executionObservation.trustedExitMetadata, 'available');
 } finally { f.db.close(); rmSync(f.base, { recursive: true, force: true }); }
});

test('structured asynchronous completion verifies its original execution once', async () => {
 const f=await boundHookFixture();
 try {
  const call=f.event('process-start');
  handleCodexHook(f.db,{...call,hook_event_name:'PreToolUse'});
  handleCodexHook(f.db,{...call,hook_event_name:'PostToolUse',tool_response:{session_id:81,exit_code:0}});
  assert.equal(f.db.prepare('SELECT COUNT(*) n FROM task_execution_evidence').get<any>()!.n,0);
  const poll={...f.event('process-poll'),tool_name:'write_stdin',tool_input:{session_id:81}};
  handleCodexHook(f.db,{...poll,hook_event_name:'PreToolUse'});
  handleCodexHook(f.db,{...poll,hook_event_name:'PostToolUse',tool_response:{exit_code:0}});
  handleCodexHook(f.db,{...poll,hook_event_name:'PostToolUse',tool_response:{exit_code:0}});
  assert.equal(f.db.prepare('SELECT COUNT(*) n FROM task_execution_evidence').get<any>()!.n,1);
  const rows=f.db.prepare("SELECT evidence_id FROM codex_hook_tools WHERE call_id IN ('process-start','process-poll')").all<any>();
  assert.equal(rows.length,2);assert.ok(rows[0].evidence_id);assert.equal(rows[0].evidence_id,rows[1].evidence_id);
 } finally {f.db.close();rmSync(f.base,{recursive:true,force:true});}
});

test('poll completion without another admission resolves the previously admitted process through the CLI', async () => {
  const f = await boundHookFixture();
  try {
    const start = f.event('no-pre-start');
    handleCodexHook(f.db, { ...start, hook_event_name: 'PreToolUse' });
    handleCodexHook(f.db, { ...start, hook_event_name: 'PostToolUse', tool_response: { session_id: 82 } });
    const poll = { ...f.common, hook_event_name: 'PostToolUse', tool_name: 'write_stdin',
      tool_use_id: 'no-pre-poll', tool_input: { session_id: 82, chars: '' }, tool_response: { exit_code: 0 } };
    const cli = (event: object) => spawnSync(process.execPath,
      ['--import', 'tsx', 'src/bin/kiokuko.ts', 'codex-hook', '--database', f.databasePath],
      { input: JSON.stringify(event), encoding: 'utf8' });
    const result = cli(poll);
    assert.equal(result.status, 0, result.stderr);
    assert.match(JSON.parse(result.stdout).hookSpecificOutput.additionalContext, /Execution evidence/u);
    assert.equal(cli(poll).status, 0);
    const changed = cli({ ...poll, tool_input: { session_id: 82, chars: 'changed input' } });
    assert.equal(changed.status, 0);
    assert.match(acceptCodexToolHook(changed.stdout, 'PostToolUse').systemMessage!, /completion_input_mismatch/u);
    assert.equal(f.db.prepare('SELECT COUNT(*) n FROM task_execution_evidence').get<any>()!.n, 1);
    assert.equal(f.db.prepare('SELECT status FROM ledger_runs WHERE run_id=?').get<any>(f.prepared.run.runId)!.status, 'active');
    assert.equal(f.db.prepare('SELECT stop_notified FROM codex_hook_requests').get<any>()!.stop_notified, 0);
    const foreign = cli({ ...poll, tool_use_id: 'foreign-poll', tool_input: { session_id: 999 } });
    assert.equal(foreign.status, 0);
    assert.match(acceptCodexToolHook(foreign.stdout, 'PostToolUse').systemMessage!, /completion_without_admission/u);
  } finally { f.db.close(); rmSync(f.base, { recursive: true, force: true }); }
});

test('cancellation of preparation replay cannot terminate a task already admitted for work', async () => {
  const f = await boundHookFixture();
  try {
    const call = f.event('ongoing-work');
    handleCodexHook(f.db, { ...call, hook_event_name: 'PreToolUse' });
    const controller = new AbortController();
    await assert.rejects(prepareAgentTask(f.db, { cwd: f.root, requestId: 'test-request',
      task: 'Implement migration expectations', capabilities: caps, skillDiscoveryMode: 'off', signal: controller.signal,
      embeddingRuntime: {
        mode: 'required', profileId: null, backendId: 'cancel-fixture', backend: { id: 'cancel-fixture', search: () => [] },
        prepareQuery: async () => {
          controller.abort(new Error('Only this request was cancelled'));
          throw controller.signal.reason;
        },
        drain: async () => ({ claimed: 0, completed: 0, failed: 0, blocked: 0, remaining: 0 }),
        close: async () => {},
      },
      profileHints: { taskType: 'build', target: 'source.ts migration expectations code', expected: 'next migration tests pass', constraints: 'preserve historical fixtures' },
    }));
    assert.equal(f.db.prepare('SELECT status FROM ledger_runs WHERE run_id=?').get<any>(f.prepared.run.runId)!.status, 'active');
    handleCodexHook(f.db, { ...call, hook_event_name: 'PostToolUse', tool_response: { exit_code: 0 } });
    assert.deepEqual(handleCodexHook(f.db, { ...f.event('next-work'), hook_event_name: 'PreToolUse' }), {});
  } finally { f.db.close(); rmSync(f.base, { recursive: true, force: true }); }
});

test('inapplicable decisions without file dependencies survive edits, refresh and restart', async () => {
  const f = await boundHookFixture();
  try {
    const runId = f.prepared.run.runId;
    const decisionId = taskAssuranceReport(f.db, runId).decisions![0]!.decisionId;
    for (let i = 0; i < 3; i++) {
      writeFileSync(path.join(f.root, 'source.ts'), `export const versions = [${i}];\n`);
      assert.deepEqual(taskAssuranceReport(f.db, runId).pending, []);
      await refreshTaskMemory(f.db, { runId, cwd: f.root, requestId: `edited-${i}`,
        expectedRevision: taskAssuranceReport(f.db, runId).revision!, capabilities: caps, changedPaths: ['source.ts'] });
      const report = taskAssuranceReport(f.db, runId);
      assert.deepEqual(report.pending, []);
      assert.equal(report.decisions![0]!.decisionId, decisionId);
    }
    const reopened = openConnection(f.databasePath);
    try { assert.deepEqual(taskAssuranceReport(reopened, runId).pending, []); }
    finally { reopened.close(); }
  } finally { f.db.close(); rmSync(f.base, { recursive: true, force: true }); }
});

test('process correlation survives source changes before yielding without certifying changed execution', async () => {
  const f = await boundHookFixture();
  try {
    const start = f.event('mutating-start');
    handleCodexHook(f.db, { ...start, hook_event_name: 'PreToolUse' });
    writeFileSync(path.join(f.root, 'source.ts'), 'changed by admitted process');
    handleCodexHook(f.db, { ...start, hook_event_name: 'PostToolUse', tool_response: { session_id: 83 } });
    const poll = { ...f.common, hook_event_name: 'PostToolUse', tool_name: 'write_stdin',
      tool_use_id: 'mutating-poll', tool_input: { session_id: 83 }, tool_response: { exit_code: 0 } };
    const result = handleCodexHook(f.db, poll) as any;
    assert.match(result.hookSpecificOutput.additionalContext, /Repository state changed/u);
    assert.equal(f.db.prepare('SELECT COUNT(*) n FROM task_execution_evidence').get<any>()!.n, 0);
    assert.deepEqual(handleCodexHook(f.db, { ...f.event('after-mutation'), hook_event_name: 'PreToolUse' }), {});
  } finally { f.db.close(); rmSync(f.base, { recursive: true, force: true }); }
});

test('refresh before the first yielded completion preserves session correlation', async () => {
 const f=await boundHookFixture();
 try {
  const start=f.event('refresh-before-yield');
  handleCodexHook(f.db,{...start,hook_event_name:'PreToolUse'});
  await refreshTaskMemory(f.db,{runId:f.prepared.run.runId,cwd:f.root,requestId:'review-refresh',expectedRevision:taskAssuranceReport(f.db,f.prepared.run.runId).revision!,capabilities:caps,changedPaths:['source.ts']});
  const yielded=handleCodexHook(f.db,{...start,hook_event_name:'PostToolUse',tool_response:{session_id:84}}) as any;
  assert.match(yielded.hookSpecificOutput.additionalContext,/Delivery changed/);
  const poll={...f.common,hook_event_name:'PostToolUse',tool_name:'write_stdin',tool_use_id:'refresh-poll',tool_input:{session_id:84},tool_response:{exit_code:0}};
  const result=handleCodexHook(f.db,poll) as {hookSpecificOutput:{additionalContext:string}};
  assert.match(result.hookSpecificOutput.additionalContext,/Delivery changed/);
  assert.deepEqual(handleCodexHook(f.db,poll),result);
  assert.throws(()=>handleCodexHook(f.db,{...poll,tool_input:{session_id:84,chars:'changed'}}),/input changed/);
  assert.throws(()=>handleCodexHook(f.db,{...f.event('session-reuse'),hook_event_name:'PreToolUse',tool_input:{cmd:'false'}}) && handleCodexHook(f.db,{...f.event('session-reuse'),hook_event_name:'PostToolUse',tool_input:{cmd:'false'},tool_response:{session_id:84}}),/session ID was reused/);
  assert.equal(f.db.prepare('SELECT COUNT(*) n FROM task_execution_evidence').get<any>()!.n,0);
 } finally {f.db.close();rmSync(f.base,{recursive:true,force:true});}
});
test('default inapplicable judgment invalidates after a new error signature', async () => {
 const f=await boundHookFixture();
 try {
  await refreshTaskMemory(f.db,{runId:f.prepared.run.runId,cwd:f.root,requestId:'review-error',expectedRevision:taskAssuranceReport(f.db,f.prepared.run.runId).revision!,capabilities:caps,changedPaths:['source.ts'],errorSignatures:['migration error']});
  assert.deepEqual(taskAssuranceReport(f.db,f.prepared.run.runId).pending,[f.entry.id]);
 } finally {f.db.close();rmSync(f.base,{recursive:true,force:true});}
});
test('refresh after the yielded completion keeps polling safe without new evidence', async () => {
 const f=await boundHookFixture();
 try {
  const start=f.event('refresh-after-yield');
  handleCodexHook(f.db,{...start,hook_event_name:'PreToolUse'});
  handleCodexHook(f.db,{...start,hook_event_name:'PostToolUse',tool_response:{session_id:85}});
  await refreshTaskMemory(f.db,{runId:f.prepared.run.runId,cwd:f.root,requestId:'review-refresh-after',expectedRevision:taskAssuranceReport(f.db,f.prepared.run.runId).revision!,capabilities:caps,changedPaths:['source.ts']});
  const result=handleCodexHook(f.db,{...f.common,hook_event_name:'PostToolUse',tool_name:'write_stdin',tool_use_id:'after-poll',tool_input:{session_id:85},tool_response:{exit_code:0}}) as any;
  assert.match(result.hookSpecificOutput.additionalContext,/Delivery changed/);
  assert.equal(f.db.prepare('SELECT COUNT(*) n FROM task_execution_evidence').get<any>()!.n,0);
 } finally {f.db.close();rmSync(f.base,{recursive:true,force:true});}
});
test('cancelled final intake answer resumes without repeating optional discovery', async () => {
 const f=await fixture();
 try {
  writeFileSync(path.join(f.root,'package.json'),'{"dependencies":{"typescript":"^5.0.0"}}');
  const controller=new AbortController(); let calls=0;
  const fetchImpl: typeof fetch=async()=>{calls++;controller.abort(new Error('request timeout'));throw controller.signal.reason;};
  let p=await prepareAgentTask(f.db,{cwd:f.root,requestId:'review-intake-cancel',task:'Build a TypeScript service',capabilities:caps,skillDiscoveryMode:'official',fetchImpl});
  const values={taskType:'build',target:'TypeScript service',expected:'cancellable discovery',constraints:'preserve current behavior'};
  let last: Parameters<typeof answerAgentTask>[1] | undefined;
  while(p.intake.status==='needs_answer'){
   const q=p.intake.question!;
   last={cwd:f.root,runId:p.run.runId,sessionId:p.intake.sessionId,questionId:q.id,value:values[q.id],capabilities:caps,skillDiscoveryMode:'official',fetchImpl,signal:controller.signal};
   try {p=await answerAgentTask(f.db,last);} catch(e){assert.ok(controller.signal.aborted);break;}
  }
  assert.ok(calls>0);
  assert.equal(f.db.prepare('SELECT status FROM ledger_runs WHERE run_id=?').get<any>(p.run.runId)!.status,'active');
  assert.ok(last);
  const before=calls;
  const reopened=openConnection(f.databasePath);
  try {
   const resumed=await answerAgentTask(reopened,{...last,signal:new AbortController().signal});
   assert.equal(resumed.run.status,'active');
   assert.equal(resumed.intake.status,'ready');
   assert.deepEqual(resumed.skillDiscovery.selected,[]);
   assert.deepEqual(resumed.skillDiscovery.failures,[{stage:'search',code:'task_request_cancelled'}]);
   assert.equal(calls,before);
   const replayed=await answerAgentTask(reopened,{...last,signal:new AbortController().signal});
   assert.deepEqual(replayed.run,resumed.run);
   assert.deepEqual(replayed.skillDiscovery,resumed.skillDiscovery);
   assert.equal(replayed.context!.deliveryId,resumed.context!.deliveryId);
   assert.equal(calls,before);
   const attempt=reopened.prepare('SELECT consumed_query_count,reserved_query_count FROM agent_task_skill_discovery_attempts WHERE run_id=?').get<{consumed_query_count:number;reserved_query_count:number}>(resumed.run.runId)!;
   assert.equal(attempt.consumed_query_count,attempt.reserved_query_count);
  } finally {reopened.close();}
 } finally {f.db.close();rmSync(f.base,{recursive:true,force:true});}
});

test('MCP sequential review state survives full replacement, errors and restart before admitted verification', async () => {
  const f = await fixture();
  const { Client } = await import('@modelcontextprotocol/sdk/client/index.js');
  const { InMemoryTransport } = await import('@modelcontextprotocol/sdk/inMemory.js');
  const { createKiokukoMcpServer } = await import('../../src/mcp/server.js');
  const server = createKiokukoMcpServer({ databasePath: f.databasePath, cwd: () => f.root });
  const client = new Client({ name: 'review-state-replacement', version: '1' });
  const [ct, st] = InMemoryTransport.createLinkedPair();
  await server.connect(st); await client.connect(ct);
  try {
    const second = recordEntry(f.db, { workspace: f.entry.workspace, kind: 'decision', title: 'source.ts migration review', body: 'Migration changes require checking source.ts historical fixtures.', tags: ['source.ts', 'migration'] });
    const runId = f.prepared.run.runId;
    const refreshed = await refreshTaskMemory(f.db, { runId, cwd: f.root, requestId: 'review-state-refresh', expectedRevision: taskAssuranceReport(f.db, runId).revision!, capabilities: caps, changedPaths: ['source.ts'] }) as any;
    const common = { session_id: 'review-state-client', turn_id: 'review-state-turn', cwd: f.root };
    handleCodexHook(f.db, { ...common, hook_event_name: 'UserPromptSubmit' });
    const requestId = f.db.prepare('SELECT request_id FROM codex_hook_requests').get<{request_id:string}>()!.request_id;
    handleCodexHook(f.db, { ...common, hook_event_name: 'PostToolUse', tool_name: 'mcp__kiokuko__task_prepare', tool_use_id: 'prepare', tool_input: {cwd:f.root,requestId}, tool_response:{structuredContent:f.prepared} });
    const ordinary = { ...common, tool_name: 'exec_command', tool_use_id: 'verification', tool_input: {cmd:'true'} };
    assertMemoryAdvisory((handleCodexHook(f.db,{...ordinary,hook_event_name:'PreToolUse'}) as any));
    let state: any = (await client.callTool({ name:'task_memory_status',arguments:{runId,cwd:f.root} })).structuredContent;
    state = {...state,runId,cwd:f.root,expectedRevision:state.revision};
    assert.equal(state.deliveryId,refreshed.context.deliveryId);
    assert.ok(state.pending.includes(f.entry.id));
    assert.ok(state.pending.includes(second.id));
    assert.equal(refreshed.runId,runId);
    assert.equal(refreshed.deliveryId,refreshed.context.deliveryId);
    assert.equal(refreshed.expectedRevision,refreshed.assurance.revision);
    const stable = state;
    const invalid = await client.callTool({name:'task_memory_review',arguments:{runId,cwd:f.root,requestId:'missing-fields'}});
    assert.equal(invalid.isError,true);
    // Failed tool results are diagnostics, never replacement continuation state.
    if (!invalid.isError) state = invalid.structuredContent;
    assert.equal(state,stable);
    let i=0;
    const receipts:Array<{args:any;response:any}>=[];
    for (const entryId of [...state.pending]) {
      const entry = refreshed.context.items.find((item:any)=>item.entryId===entryId);
      const args = {runId:state.runId,cwd:state.cwd,deliveryId:state.deliveryId,expectedRevision:state.expectedRevision,requestId:`sequential-${i++}`,entryId,entryRevision:entry.revision,decision:'inapplicable',basis:'This isolated hook protocol fixture does not alter migration behavior.'};
      const result = await client.callTool({name:'task_memory_review',arguments:args});
      assert.notEqual(result.isError,true);
      receipts.push({args,response:result.structuredContent});
      state = result.structuredContent; // Exact replacement pattern from generated review loops.
      assert.equal(state.deliveryId,refreshed.context.deliveryId);
      assert.equal(state.runId,runId);
      assert.equal(state.expectedRevision,state.revision);
      assert.equal(state.revision,taskAssuranceReport(f.db,runId).revision);
      assert.deepEqual((await client.callTool({name:'task_memory_review',arguments:args})).structuredContent,state);
    }
    assert.ok(receipts[0]!.response.revision<state.revision);
    assert.deepEqual((await client.callTool({name:'task_memory_review',arguments:receipts[0]!.args})).structuredContent,receipts[0]!.response);
    assert.equal(taskAssuranceReport(f.db,runId).revision,state.revision);
    assert.equal(state.nextAction,'proceed');
    assert.deepEqual(state.pending,[]);
    const reconciled:any=(await client.callTool({name:'task_memory_status',arguments:{runId,cwd:f.root}})).structuredContent;
    for(const key of ['runId','cwd','deliveryId','revision','expectedRevision','nextAction']) assert.equal(reconciled[key],state[key]);
    const restarted=openConnection(f.databasePath);
    try {assert.equal(taskAssuranceReport(restarted,runId).revision,state.revision);} finally {restarted.close();}
    defineTaskVerification(f.db,{runId,cwd:f.root,requestId:'review-state-check',expectedRevision:state.revision,reason:'Verify safe recovery before completing',checks:[{id:'protocol',target:`${process.platform}-${process.arch}`,expected:'Command completes successfully',method:'Execute true once after admission'}]});
    assert.deepEqual(handleCodexHook(f.db,{...ordinary,hook_event_name:'PreToolUse'}),{});
    const execution=spawnSync('true'); assert.equal(execution.status,0);
    handleCodexHook(f.db,{...ordinary,hook_event_name:'PostToolUse',tool_response:{exit_code:execution.status}});
    const evidenceId=f.db.prepare('SELECT evidence_id FROM codex_hook_tools WHERE call_id=?').get<{evidence_id:string}>('verification')!.evidence_id;
    recordTaskVerification(f.db,{runId,cwd:f.root,requestId:'review-state-result',expectedRevision:taskAssuranceReport(f.db,runId).revision!,contractVersion:1,checkId:'protocol',target:`${process.platform}-${process.arch}`,source:{kind:'local',evidenceId}});
    assert.doesNotThrow(()=>assertAssuranceCompletion(f.db,runId,'completed'));
    assert.equal(f.db.prepare('SELECT COUNT(*) n FROM task_execution_evidence').get<{n:number}>()!.n,1);
  } finally {await client.close();await server.close();f.db.close();rmSync(f.base,{recursive:true,force:true});}
});

test('missing preparation Post leaves status reconciliation recoverable without trusting its supplied run', async () => {
  const f = await fixture();
  try {
    const common = {session_id:'lost-prepare-post',turn_id:'repair',cwd:f.root};
    handleCodexHook(f.db,{...common,hook_event_name:'UserPromptSubmit'});
    const requestId=f.db.prepare('SELECT request_id FROM codex_hook_requests').get<{request_id:string}>()!.request_id;
    const args={cwd:f.root,requestId,soulRead:true,task:'Implement migration expectations',capabilities:caps,skillDiscoveryMode:'off' as const,profileHints:{taskType:'build' as const,target:'source.ts migration expectations code',expected:'next migration tests pass',constraints:'preserve historical fixtures'}};
    const prepareEvent={...common,tool_name:'mcp__kiokuko__task_prepare',tool_use_id:'prepare-original',tool_input:args};
    assert.deepEqual(handleCodexHook(f.db,{...prepareEvent,hook_event_name:'PreToolUse'}),{});
    const prepared=await prepareAgentTask(f.db,args); // The host loses only the Post event.
    const statusEvent={...common,tool_name:'mcp__kiokuko__task_memory_status',tool_use_id:'repair-status',tool_input:{cwd:f.root,runId:prepared.run.runId}};
    const denied=handleCodexHook(f.db,{...statusEvent,hook_event_name:'PreToolUse'}) as any;
    assert.equal(denied.hookSpecificOutput.permissionDecision,'deny');
    assert.equal(lastHookDiagnostic(f.db).recoverable,true);
    assert.equal(lastHookDiagnostic(f.db).reason,'preparation_binding_missing');
    assert.match(denied.hookSpecificOutput.permissionDecisionReason,/exact.*task_prepare/);
    const binding=()=>f.db.prepare('SELECT run_id,stop_notified FROM codex_hook_requests').get<{run_id:string|null;stop_notified:number}>()!;
    assert.deepEqual({...binding()},{run_id:null,stop_notified:0});
    assert.equal(new LedgerStore(f.db).readRun(prepared.run.runId)!.status,'active');
    assert.equal(f.db.prepare('SELECT COUNT(*) n FROM codex_hook_tools').get<{n:number}>()!.n,0);
    const retry={...prepareEvent,tool_use_id:'prepare-exact-retry'};
    assert.deepEqual(handleCodexHook(f.db,{...retry,hook_event_name:'PreToolUse'}),{});
    await assert.rejects(prepareAgentTask(f.db,{...args,task:'different request'}));
    const replay=await prepareAgentTask(f.db,args);
    assert.equal(replay.run.runId,prepared.run.runId);
    handleCodexHook(f.db,{...retry,hook_event_name:'PostToolUse',tool_response:{structuredContent:replay}});
    assert.equal(binding().run_id,prepared.run.runId);
    assert.deepEqual(handleCodexHook(f.db,{...statusEvent,hook_event_name:'PreToolUse'}),{});
    const ordinary=handleCodexHook(f.db,{...common,hook_event_name:'PreToolUse',tool_name:'exec_command',tool_use_id:'still-pending',tool_input:{cmd:'true'}}) as any;
    assertMemoryAdvisory(ordinary);
    assert.equal(lastHookDiagnostic(f.db).reason,'memory_review_pending');
    assert.equal(binding().stop_notified,0);
    // A conflicting memory binding is rejected without stopping unrelated work.
    handleCodexHook(f.db,{...statusEvent,hook_event_name:'PreToolUse',tool_input:{cwd:f.root,runId:f.prepared.run.runId}});
    assert.equal(binding().stop_notified,0);
    assert.equal(lastHookDiagnostic(f.db).recoverable,true);
    assert.notEqual((handleCodexHook(f.db,{...common,hook_event_name:"PreToolUse",tool_name:"exec_command",tool_use_id:"after-foreign-memory",tool_input:{cmd:"true"}}) as any).hookSpecificOutput?.permissionDecision,"deny");
    assert.equal(f.db.prepare('SELECT COUNT(*) n FROM task_execution_evidence').get<{n:number}>()!.n,0);
  } finally {f.db.close();rmSync(f.base,{recursive:true,force:true});}
});

test('status continuation reads revision and report from one concurrent database snapshot', async () => {
  const f=await fixture(); const writer=openConnection(f.databasePath);
  try {
    const runId=f.prepared.run.runId, before=taskAssuranceReport(f.db,runId).revision!;
    let raced=false;
    const reader=new Proxy(f.db,{get(target,key){
      if(key!=='prepare') return Reflect.get(target,key,target);
      return (sql:string)=>{
        const statement=target.prepare(sql);
        if(sql!=='SELECT * FROM task_assurance WHERE run_id = ?') return statement;
        return {...statement,get(...params:Parameters<typeof statement.get>){
          const row=statement.get(...params);
          if(!raced){raced=true;writer.prepare("UPDATE task_assurance SET revision=revision+1,retrieval_status='pending' WHERE run_id=?").run(runId);}
          return row;
        }};
      };
    }});
    const status=taskMemoryStatus(reader,runId,f.root);
    assert.equal(raced,true);
    assert.equal(status.revision,before);
    assert.equal(status.expectedRevision,before);
    assert.notEqual(status.retrieval,'pending');
    assert.deepEqual(status.pending,[f.entry.id]);
    assert.deepEqual(taskAssuranceReport(f.db,runId).pending,['memory_retrieval']);
    assert.equal(taskAssuranceReport(f.db,runId).revision,before+1);
  } finally {writer.close();f.db.close();rmSync(f.base,{recursive:true,force:true});}
});
