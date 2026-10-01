import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, writeFileSync, rmSync, symlinkSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { spawn } from 'node:child_process';
import { initializeDatabase } from '../../src/commands/init.js';
import { runDoctor } from '../../src/commands/doctor.js';
import { openConnection } from '../../src/db/connection.js';
import { prepareAgentTask, answerAgentTask } from '../../src/akinator/agent-task.js';
import { inspectTask } from '../../src/assurance/inspect.js';
import { resolveProjectWorkspace } from '../../src/memory/workspaces.js';
import { recordEntry } from '../../src/memory/entries.js';
import { assuranceState, reviewTaskMemory, recordTaskEvidence, taskAssuranceReport, assertAssuranceCompletion, memoryReviewNextAction } from '../../src/assurance/service.js';
import { repositoryStateDigest } from '../../src/assurance/snapshot.js';
import { codexHookFailureCode, handleCodexHook, observedExitCode } from '../../src/assurance/codex-hooks.js';
import { KiokukoError } from '../../src/errors.js';
import { refreshTaskMemory } from '../../src/assurance/refresh.js';
const caps = [{ kind: 'skill', name: 'kiokuko-soul' }, { kind: 'skill', name: 'memory-reasoning' }];
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
  const entry = recordEntry(db, { workspace: project.workspace, kind: 'decision', title: 'migration expectations', body: 'Derive migration expectations from the bundled migration list; next migration must not need a fixed array update.', tags: ['migration'], confidence: 0.8 });
  const prepared = await prepareAgentTask(db, { cwd: root, requestId: 'test-request', task: 'Implement migration expectations', capabilities: caps, skillDiscoveryMode: 'off', profileHints: {
    taskType: 'build', target: 'migration expectations code', expected: 'next migration tests pass', constraints: 'preserve historical fixtures',
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
    assert.match(changedModule.checks.memoryAssurance.detail!, /missingVerification=1; inspectionErrors=0/u);
    writeFileSync(path.join(nestedRoot, 'nested.ts'), 'export const value = 1;\n');

    writeFileSync(path.join(f.root, 'other.ts'), 'export const other = true;\n');
    unlinkSync(link);
    symlinkSync('other.ts', link);
    const stale = await runDoctor({ databasePath: f.databasePath });
    assert.equal(stale.checks.memoryAssurance.ok, true);
    assert.match(stale.checks.memoryAssurance.detail!, /missingVerification=1; inspectionErrors=0/u);

    unlinkSync(link);
    const outside = path.join(f.base, 'outside.ts');
    writeFileSync(outside, 'export const secret = true;\n');
    symlinkSync(outside, link);
    assert.throws(() => repositoryStateDigest(f.root), /symlink escapes the repository/u);
  } finally { f.db.close(); rmSync(f.base, { recursive: true, force: true }); }
});
test('Codex blocks unprepared edits and does not inherit another agent or interrupted request', async () => {
  const f = await fixture();
  try {
    const common = { session_id: 'client', turn_id: 'turn', cwd: f.root };
    handleCodexHook(f.db, { ...common, hook_event_name: 'UserPromptSubmit' });
    const edit = { ...common, hook_event_name: 'PreToolUse', tool_name: 'apply_patch', tool_use_id: 'edit', tool_input: { command: 'patch' } };
    assert.equal((handleCodexHook(f.db, edit) as any).hookSpecificOutput.permissionDecision, 'deny');
    assert.equal((handleCodexHook(f.db, { ...edit, agent_id: 'child' }) as any).hookSpecificOutput.permissionDecision, 'deny');
    handleCodexHook(f.db, { ...common, hook_event_name: 'Interrupt' });
    assert.deepEqual(handleCodexHook(f.db, { ...common, hook_event_name: 'Stop' }), {});
  } finally { f.db.close(); rmSync(f.base, { recursive: true, force: true }); }
});
test('hook command exposes policy block reasons to the user without leaking tool input', async () => {
  const f = await fixture();
  try {
    const common = { session_id: 'visible-block', turn_id: 'request', cwd: f.root };
    const event = { ...common, hook_event_name: 'PreToolUse', tool_name: 'exec_command', tool_use_id: 'blocked',
      tool_input: { cmd: 'private-command-body' } };
    const checkBlock = (expected: RegExp) => {
      const result = spawnSync(process.execPath, ['--import', 'tsx', 'src/bin/kiokuko.ts', 'codex-hook', '--database', f.databasePath],
        { cwd: process.cwd(), input: JSON.stringify(event), encoding: 'utf8' });
      assert.equal(result.status, 0, result.stderr);
      const output = JSON.parse(result.stdout);
      assert.equal(output.hookSpecificOutput.permissionDecision, 'deny');
      assert.match(output.hookSpecificOutput.permissionDecisionReason, expected);
      assert.equal(output.systemMessage, `Kiokuko blocked this tool call: ${output.hookSpecificOutput.permissionDecisionReason}`);
      assert.match(result.stderr, expected);
      assert.ok(result.stderr.includes(output.systemMessage));
      assert.doesNotMatch(result.stdout + result.stderr, /private-command-body/u);
      assert.equal(output.continue, undefined);
      assert.equal(output.stopReason, undefined);
      assert.equal(output.suppressOutput, undefined);
      assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM codex_hook_tools').get<{ n: number }>()!.n, 0);
    };
    checkBlock(/request start/u);
    handleCodexHook(f.db, { ...common, hook_event_name: 'UserPromptSubmit' });
    checkBlock(/task_prepare/u);
    const requestId = f.db.prepare('SELECT request_id FROM codex_hook_requests').get<{ request_id: string }>()!.request_id;
    handleCodexHook(f.db, { ...common, hook_event_name: 'PostToolUse', tool_name: 'mcp__kiokuko__task_prepare',
      tool_use_id: 'prepare', tool_input: { cwd: f.root, requestId }, tool_response: { structuredContent: f.prepared } });
    checkBlock(/1 pending.*0 stale.*task_memory_status.*task_memory_review/u);
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
      for (const skill of ['kiokuko-soul', 'memory-reasoning', 'natural-japanese-output']) {
        const args = { cwd: f.root, operation: 'skill', path: skill };
        const read = call('task_inspect', skill, args, () => inspectTask(args));
        assert.match((read.result as { text: string }).text, new RegExp(`name: ${skill}`));
      }
      const args = { cwd: f.root, requestId, soulRead: true, task: 'Implement migration expectations', capabilities: caps,
        skillDiscoveryMode: 'off' as const, profileHints: withIntake ? {} : {
          taskType: 'build' as const, target: 'migration expectations code', expected: 'next migration tests pass', constraints: 'preserve historical fixtures',
        } };
      call('task_prepare', 'prepare', args, () => undefined);
      let prepared = await prepareAgentTask(f.db, args);
      const post = (name: string, input: object, result: unknown) => handleCodexHook(f.db, { ...common,
        hook_event_name: 'PostToolUse', tool_name: `mcp__kiokuko__${name}`, tool_use_id: name,
        tool_input: input, tool_response: { structuredContent: result } }) as any;
      let guidance = post('task_prepare', args, prepared);
      const answers = { taskType: 'build', target: 'migration expectations code', expected: 'next migration tests pass', constraints: 'preserve historical fixtures' };
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
    assert.throws(() => handleCodexHook(f.db, { ...a, tool_input: { cmd: 'other' }, hook_event_name: 'PostToolUse', tool_response: { exit_code: 0 } }), /matching start/u);
    const changed = f.event('changed');
    handleCodexHook(f.db, { ...changed, hook_event_name: 'PreToolUse' });
    writeFileSync(path.join(f.root, 'source.ts'), 'updated after tool start\n');
    handleCodexHook(f.db, { ...changed, hook_event_name: 'PostToolUse', tool_response: { exit_code: 0 } });
    const afterChange = taskAssuranceReport(f.db, f.prepared.run.runId).revision;
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
    assert.equal(result.status, 2);
    assert.match(result.stderr, /event=PostToolUse stage=post_completion reason=state_conflict id=[0-9a-f]{16}.*Tool already executed/u);
    assert.doesNotMatch(result.stderr, /private-command-body/u);
    const observation = f.db.prepare("SELECT response_shape FROM codex_hook_observations WHERE event_name='PostToolUse' AND decision='CONFLICT' ORDER BY rowid DESC LIMIT 1")
      .get<{ response_shape: string }>();
    assert.ok(observation);
    assert.match(result.stderr, new RegExp(`id=${JSON.parse(observation.response_shape).call}\\.`));
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
    const common = { session_id: 'decisive-client', turn_id: 'request', cwd: f.root };
    handleCodexHook(f.db, { ...common, hook_event_name: 'UserPromptSubmit' });
    const requestId = f.db.prepare('SELECT request_id FROM codex_hook_requests WHERE last_event = ?').get<{ request_id: string }>('UserPromptSubmit')!.request_id;
    const args = { requestId, cwd: f.root, soulRead: true, task: 'Implement migration expectations', capabilities: caps,
      profileHints: { taskType: 'build' as const, target: 'migration expectations code', expected: 'next migration tests pass', constraints: 'historical fixtures are valid' } };
    const gate = handleCodexHook(f.db, { ...common, hook_event_name: 'PreToolUse', tool_name: 'mcp__kiokuko__task_prepare', tool_use_id: 'prepare', tool_input: args });
    assert.deepEqual(gate, {});
    assert.equal(args.soulRead, true);
    const prepared = await prepareAgentTask(f.db, { ...args, skillDiscoveryMode: 'off' });
    handleCodexHook(f.db, { ...common, hook_event_name: 'PostToolUse', tool_name: 'mcp__kiokuko__task_prepare', tool_use_id: 'prepare', tool_input: args, tool_response: { structuredContent: { ...prepared, nextAction: 'required_capability_unavailable' } } });
    const blocked = handleCodexHook(f.db, { ...common, hook_event_name: 'PreToolUse', tool_name: 'apply_patch', tool_use_id: 'blocked-edit', tool_input: {} }) as any;
    assert.equal(blocked.hookSpecificOutput.permissionDecision, 'deny');
    assert.equal((handleCodexHook(f.db, { ...common, hook_event_name: 'Stop' }) as any).continue, false);
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
    const failedEvidence = observedRun('fixed-array');
    reviewTaskMemory(f.db, { ...review, requestId: 'fixed-result', expectedRevision: taskAssuranceReport(f.db, runId).revision!, evidenceIds: [failedEvidence] });
    assert.throws(() => assertAssuranceCompletion(f.db, runId, 'completed'), /incomplete/);
    writeFileSync(verifier, moduleHeader + `const expected=loadMigrationSnapshot(${JSON.stringify(migrations)}).migrations.map(m=>m.version); assert.deepEqual(actual, expected); assert.deepEqual(actual.slice(0,2), [1,2]);\n`);
    const passedEvidence = observedRun('derived-array');
    reviewTaskMemory(f.db, { ...review, requestId: 'derived-result', expectedRevision: taskAssuranceReport(f.db, runId).revision!, evidenceIds: [passedEvidence] });
    assert.equal(taskAssuranceReport(f.db, runId).complete, true);
    assert.equal(taskAssuranceReport(f.db, runId).observed, true);
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
    assert.deepEqual(httpStatus.data, status.structuredContent);
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
});
test('code plans require memory decisions but no implementation test; another run cannot donate evidence', async () => {
  const f = await fixture();
  try {
    const originalId = f.prepared.run.runId;
    const originalDelivery = f.prepared.context!.deliveryId!;
    const evidence = recordTaskEvidence(f.db, { runId: originalId, cwd: f.root, deliveryId: originalDelivery, requestId: 'original-evidence', expectedRevision: taskAssuranceReport(f.db, originalId).revision!, execution: 'test', stateDigest: repositoryStateDigest(f.root), outcome: 'passed', exitCode: 0 });
    const plan = await prepareAgentTask(f.db, { cwd: f.root, requestId: 'plan-request', task: 'Plan migration code changes', capabilities: caps, skillDiscoveryMode: 'off', profileHints: { taskType: 'analysis', target: 'migration code', expected: 'implementation plan only', constraints: 'do not implement' } });
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
