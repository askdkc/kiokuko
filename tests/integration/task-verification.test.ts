import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { initializeDatabase } from '../../src/commands/init.js';
import { openConnection } from '../../src/db/connection.js';
import { prepareAgentTask } from '../../src/akinator/agent-task.js';
import { createKiokukoMcpServer } from '../../src/mcp/server.js';
import { createTaskAssuranceRoute } from '../../src/server/routes/task-assurance.js';
import { defineTaskVerification, recordTaskVerification } from '../../src/assurance/verification.js';
import { taskAssuranceReport, recordTaskEvidence, assertAssuranceCompletion } from '../../src/assurance/service.js';
import { repositoryStateDigest } from '../../src/assurance/snapshot.js';
import { handleCodexHook } from '../../src/assurance/codex-hooks.js';
import { LedgerStore } from '../../src/ledger/store.js';
import { AgentGatewayService } from '../../src/gateway/agent-service.js';
import { refreshTaskMemory } from '../../src/assurance/refresh.js';
import { TaskStateConflict } from '../../src/assurance/conflicts.js';

const capabilities = [{ kind: 'skill', name: 'kiokuko-soul' }, { kind: 'skill', name: 'memory-reasoning' }];
const targets = ['linux-x64', 'linux-arm64', 'win32-x64', 'darwin-x64', 'darwin-arm64'];
const checks = targets.map(target => ({ id: target, target, expected: 'Standalone artifact starts successfully', method: 'Run the built artifact with a clean runtime' }));

async function fixture(taskType: 'build' | 'analysis' | 'review' = 'build') {
  const base = mkdtempSync(path.join(tmpdir(), 'kiokuko-verification-'));
  const cwd = path.join(base, 'repo');
  execFileSync('git', ['init', '-q', cwd]);
  writeFileSync(path.join(cwd, 'source.ts'), 'export const value = 1;\n');
  execFileSync('git', ['-C', cwd, 'add', '.']);
  execFileSync('git', ['-C', cwd, '-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-qm', 'fixture']);
  const databasePath = path.join(base, 'memory.sqlite3');
  await initializeDatabase({ databasePath });
  const db = openConnection(databasePath);
  const hook = { session_id: 'verification', turn_id: 'first', cwd };
  const prompt = handleCodexHook(db, { ...hook, hook_event_name: 'UserPromptSubmit' }) as any;
  const requestId = /Kiokuko request (codex-[a-f0-9]+)/u.exec(prompt.hookSpecificOutput.additionalContext)![1]!;
  const prepared = await prepareAgentTask(db, { cwd, requestId, task: 'Verify standalone artifacts', capabilities, skillDiscoveryMode: 'off', maxContextChars: 8000,
    profileHints: { taskType, target: 'standalone artifacts', expected: 'Each supported target starts', constraints: 'Isolated fixture' } });
  const runId = prepared.run.runId;
  handleCodexHook(db, { ...hook, hook_event_name: 'PostToolUse', tool_name: 'mcp__kiokuko__task_prepare', tool_use_id: 'prepare',
    tool_input: { cwd, requestId }, tool_response: { structuredContent: prepared } });
  let sequence = 0;
  const input = () => ({ cwd, runId, expectedRevision: taskAssuranceReport(db, runId).revision!, requestId: `request-${++sequence}` });
  const define = (items = checks) => defineTaskVerification(db, { ...input(), reason: 'Verify the supported artifact targets', checks: items });
  const evidence = (target: string, outcome = 'passed', exitCode: number | null = 0) => recordTaskEvidence(db, {
    ...input(), deliveryId: prepared.context?.deliveryId ?? null, execution: 'Run standalone artifact verification',
    target, stateDigest: repositoryStateDigest(cwd), outcome, exitCode,
  });
  const record = (target: string, contractVersion: number, outcome = 'passed', exitCode: number | null = 0) => {
    const result = evidence(target, outcome, exitCode);
    return recordTaskVerification(db, { ...input(), contractVersion, checkId: target, target, source: { kind: 'local', evidenceId: result.evidenceId } });
  };
  const close = () => { db.close(); rmSync(base, { recursive: true, force: true }); };
  return { base, cwd, db, databasePath, hook, prepared, runId, input, define, evidence, record, close };
}

test('five required targets cannot complete with only ARM success, unknown results, wrong targets or stale source', async () => {
  const f = await fixture();
  try {
    assert.equal(taskAssuranceReport(f.db, f.runId).complete, true);
    assert.equal(taskAssuranceReport(f.db, f.runId).completionReady, false);
    assert.throws(() => assertAssuranceCompletion(f.db, f.runId, 'completed'), /verification is incomplete/u);
    const contract = f.define();
    f.record('darwin-arm64', contract.contractVersion);
    assert.equal(taskAssuranceReport(f.db, f.runId).verification.checks.filter(c => c.status === 'passed').length, 1);
    assert.equal(taskAssuranceReport(f.db, f.runId).completionReady, false);
    const arm = f.evidence('darwin-arm64');
    assert.throws(() => recordTaskVerification(f.db, { ...f.input(), contractVersion: 1, checkId: 'linux-x64', target: 'linux-x64',
      source: { kind: 'local', evidenceId: arm.evidenceId } }), /target/u);
    for (const target of targets.slice(0, 4)) f.record(target, 1);
    assert.equal(taskAssuranceReport(f.db, f.runId).completionReady, true);
    f.record('darwin-x64', 1, 'unknown', null);
    assert.equal(taskAssuranceReport(f.db, f.runId).completionReady, false);
    assert.equal(taskAssuranceReport(f.db, f.runId).verification.checks.find(c => c.id === 'darwin-x64')!.status, 'unknown');
    f.record('darwin-x64', 1, 'failed', 13);
    assert.equal(taskAssuranceReport(f.db, f.runId).completionReady, false);
    f.record('darwin-x64', 1);
    writeFileSync(path.join(f.cwd, 'source.ts'), 'export const value = 2;\n');
    assert.ok(taskAssuranceReport(f.db, f.runId).verification.checks.every(c => c.stale));
    assert.throws(() => assertAssuranceCompletion(f.db, f.runId, 'completed'));
    assert.doesNotThrow(() => assertAssuranceCompletion(f.db, f.runId, 'failed'));
  } finally { f.close(); }
});

test('contract revisions preserve unchanged checks but cannot resurrect a changed or removed check', async () => {
  const f = await fixture();
  try {
    const args = { ...f.input(), reason: 'Initial required target', checks: [checks[0]!] };
    const first = defineTaskVerification(f.db, args);
    assert.deepEqual(defineTaskVerification(f.db, args), first);
    f.record('linux-x64', 1);
    f.define([checks[0]!]);
    assert.equal(taskAssuranceReport(f.db, f.runId).completionReady, true);
    f.define([{ ...checks[0]!, method: 'Run a stricter artifact check' }]);
    assert.equal(taskAssuranceReport(f.db, f.runId).completionReady, false);
    f.define([checks[0]!]);
    assert.equal(taskAssuranceReport(f.db, f.runId).completionReady, false);
    assert.throws(() => f.record('linux-x64', 1), /contract changed/u);
    f.record('linux-x64', 4);
    assert.equal(taskAssuranceReport(f.db, f.runId).completionReady, true);
    const restarted = openConnection(f.databasePath);
    try { assert.equal(taskAssuranceReport(restarted, f.runId).completionReady, true); } finally { restarted.close(); }
    f.define([checks[1]!]); f.define([checks[0]!]);
    assert.equal(taskAssuranceReport(f.db, f.runId).completionReady, false);
  } finally { f.close(); }
});

test('CI evidence requires the exact clean commit and retains model-reported provenance', async () => {
  const f = await fixture();
  try {
    f.define([checks[0]!]);
    const commit = execFileSync('git', ['-C', f.cwd, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
    const source = { kind: 'ci', commit, runUrl: 'https://github.com/example/project/actions/runs/123',
      jobUrl: 'https://github.com/example/project/actions/runs/123/job/456', conclusion: 'success' };
    const args = () => ({ ...f.input(), contractVersion: 1, checkId: 'linux-x64', target: 'linux-x64', source });
    assert.throws(() => recordTaskVerification(f.db, { ...args(), source: { ...source, commit: '0'.repeat(40) } }), /target/u);
    const recorded = recordTaskVerification(f.db, args());
    assert.equal(recorded.provenance, 'model_reported');
    assert.equal(taskAssuranceReport(f.db, f.runId).completionReady, true);
    recordTaskVerification(f.db, { ...args(), source: { ...source, conclusion: 'unknown' } });
    assert.equal(taskAssuranceReport(f.db, f.runId).completionReady, false);
    assert.throws(() => recordTaskVerification(f.db, { ...args(), source: { ...source, runUrl: source.runUrl + '?token=private' } }));
    writeFileSync(path.join(f.cwd, 'untracked.txt'), 'new source');
    assert.throws(() => recordTaskVerification(f.db, args()), /target/u);
  } finally { f.close(); }
});

test('PLAN and review are exempt, legacy runs stay unobserved, and observed changes require checks', async () => {
  for (const type of ['analysis', 'review'] as const) {
    const f = await fixture(type);
    try {
      assert.equal(taskAssuranceReport(f.db, f.runId).completionReady, true);
      const call = { ...f.hook, tool_name: 'apply_patch', tool_use_id: 'edit', tool_input: {} };
      handleCodexHook(f.db, { ...call, hook_event_name: 'PreToolUse' });
      writeFileSync(path.join(f.cwd, 'source.ts'), 'changed');
      handleCodexHook(f.db, { ...call, hook_event_name: 'PostToolUse', tool_response: {} });
      assert.equal(taskAssuranceReport(f.db, f.runId).completionReady, false);
      f.db.prepare('UPDATE task_assurance SET verification_version=0 WHERE run_id=?').run(f.runId);
      assert.equal(taskAssuranceReport(f.db, f.runId).completionReady, null);
      assert.equal(taskAssuranceReport(f.db, f.runId).verification.mode, 'legacy_unobserved');
    } finally { f.close(); }
  }
});

test('losing a bound checkout cannot exempt a project run from verification, including subdirectory events', async () => {
  const f = await fixture();
  try {
    const nested = path.join(f.cwd, 'nested'); mkdirSync(nested);
    rmSync(path.join(f.cwd, '.git'), { recursive: true });
    for (const cwd of [f.cwd, nested]) assert.throws(() => handleCodexHook(f.db, { ...f.hook, cwd, hook_event_name: 'Stop' }), /Bound repository is unavailable/u);
  } finally { f.close(); }
});

test('MCP and HTTP verification share receipts; checkpoint and Stop reject incomplete targets', async () => {
  const f = await fixture();
  const server = createKiokukoMcpServer({ databasePath: f.databasePath, cwd: () => f.cwd });
  const client = new Client({ name: 'verification-parity', version: '1' });
  const [ct, st] = InMemoryTransport.createLinkedPair(); await server.connect(st); await client.connect(ct);
  try {
    const define = { ...f.input(), reason: 'Required artifact target', checks: [checks[0]!] };
    const result = await client.callTool({ name: 'task_verification_define', arguments: define });
    assert.notEqual(result.isError, true);
    const { runId, requestId, ...body } = define;
    const route = createTaskAssuranceRoute({ database: f.db, enqueueWrite: async fn => fn() });
    const http = await route({ method: 'POST', url: new URL(`http://localhost/api/v1/agent/runs/${runId}/verification-define`), headers: { 'idempotency-key': requestId }, body }) as any;
    assert.deepEqual(http.data, result.structuredContent);
    const stop = () => handleCodexHook(f.db, { ...f.hook, hook_event_name: 'Stop' }) as any;
    assert.equal(stop().continue, false);
    const checkpoint = () => client.callTool({ name: 'memory_checkpoint', arguments: { cwd: f.cwd, runId, outcome: 'completed', evidence: { tests: [{ runner: 'fixture', outcome: 'passed' }] } } });
    const rejected = await checkpoint();
    assert.equal((rejected.structuredContent as Record<string, unknown>)?.reason, 'task_verification_incomplete');
    assert.equal(new LedgerStore(f.db).readRun(runId)!.status, 'active');
    const service = new AgentGatewayService(f.db);
    const close = { runId, idempotencyKey: 'close-required', request: { apiVersion: '1', status: 'completed' } };
    assert.throws(() => service.closeRun(close), /verification is incomplete/u);
    f.record('linux-x64', 1);
    assert.deepEqual(stop(), {});
    assert.notEqual((await checkpoint()).isError, true);
  } finally { await client.close(); await server.close(); f.close(); }
});

test('Agent close accepts only satisfied checks and rejects wrong-run execution evidence atomically', async () => {
  const f = await fixture();
  try {
    f.define([checks[0]!]);
    const other = await prepareAgentTask(f.db, { cwd: f.cwd, requestId: 'other-run', task: 'Inspect another task', capabilities,
      skillDiscoveryMode: 'off', profileHints: { taskType: 'analysis', target: 'fixture', expected: 'inspect only' } });
    const foreign = recordTaskEvidence(f.db, { cwd: f.cwd, runId: other.run.runId, requestId: 'foreign-evidence',
      expectedRevision: taskAssuranceReport(f.db, other.run.runId).revision!, deliveryId: other.context?.deliveryId ?? null,
      target: 'linux-x64', stateDigest: repositoryStateDigest(f.cwd), execution: 'other run', outcome: 'passed', exitCode: 0 });
    const before = taskAssuranceReport(f.db, f.runId).revision;
    assert.throws(() => recordTaskVerification(f.db, { ...f.input(), contractVersion: 1, checkId: 'linux-x64', target: 'linux-x64',
      source: { kind: 'local', evidenceId: foreign.evidenceId } }), /target/u);
    assert.equal(taskAssuranceReport(f.db, f.runId).revision, before);
    f.record('linux-x64', 1);
    const close = { runId: f.runId, idempotencyKey: 'verified-close', request: { apiVersion: '1', status: 'completed' } };
    const service = new AgentGatewayService(f.db);
    assert.equal(service.closeRun(close).runStatus, 'completed');
    assert.equal(service.closeRun(close).runStatus, 'completed');
  } finally { f.close(); }
});

test('legacy execution inserts remain compatible but cannot certify an unknown target', async () => {
  const f = await fixture();
  try {
    f.define([checks[0]!]);
    // The pre-upgrade MCP uses this positional insert. Migration must preserve it.
    f.db.prepare('INSERT INTO task_execution_evidence VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .run('legacy-execution', f.runId, f.prepared.context?.deliveryId ?? null, f.cwd, f.cwd, 'legacy',
        repositoryStateDigest(f.cwd), 'passed', 0, 'model_reported', new Date().toISOString());
    assert.throws(() => recordTaskVerification(f.db, { ...f.input(), contractVersion: 1, checkId: 'linux-x64', target: 'linux-x64',
      source: { kind: 'local', evidenceId: 'legacy-execution' } }), /target/u);
    assert.equal(taskAssuranceReport(f.db, f.runId).completionReady, false);
  } finally { f.close(); }
});

test('refresh reasons survive MCP, skill reads preserve revision, and recovery does not trip policy denial', async () => {
  const f = await fixture();
  const server = createKiokukoMcpServer({ databasePath: f.databasePath, cwd: () => f.cwd });
  const client = new Client({ name: 'refresh-diagnostics', version: '1' });
  const [ct, st] = InMemoryTransport.createLinkedPair(); await server.connect(st); await client.connect(ct);
  const call = (name: string, args: Record<string, unknown>) => client.callTool({ name, arguments: args });
  try {
    const args = { ...f.input(), capabilities, changedPaths: ['source.ts'] };
    const skill = { ...f.hook, tool_name: 'mcp__kiokuko__task_inspect', tool_use_id: 'skill', tool_input: { cwd: f.cwd, operation: 'skill' } };
    handleCodexHook(f.db, { ...skill, hook_event_name: 'PreToolUse' });
    const read = await call('task_inspect', skill.tool_input);
    handleCodexHook(f.db, { ...skill, hook_event_name: 'PostToolUse', tool_response: read });
    assert.equal(taskAssuranceReport(f.db, f.runId).revision, args.expectedRevision);
    const first = await call('task_memory_refresh', args); assert.notEqual(first.isError, true);
    assert.deepEqual((await call('task_memory_refresh', args)).structuredContent, JSON.parse(JSON.stringify(first.structuredContent)));
    const reused = await call('task_memory_refresh', { ...args, errorSignatures: ['new error'] });
    assert.equal((reused.structuredContent as Record<string, unknown>)?.reason, 'request_id_reused');
    const stale = await call('task_memory_refresh', { ...args, requestId: 'stale' });
    assert.equal((stale.structuredContent as Record<string, unknown>)?.reason, 'assurance_revision_changed');
    assert.equal((stale.structuredContent as Record<string, unknown>)?.recoverable, true);
    assert.equal((stale.structuredContent as Record<string, unknown>)?.maxRecoveryAttempts, 1);
    assert.equal((stale.structuredContent as Record<string, unknown>)?.retryable, false);
    const event = { ...f.hook, hook_event_name: 'PostToolUse', tool_name: 'mcp__kiokuko__task_memory_refresh', tool_use_id: 'refresh', tool_input: args, tool_response: stale };
    handleCodexHook(f.db, event);
    const status = (await call('task_memory_status', { cwd: f.cwd, runId: f.runId })).structuredContent as Record<string, unknown>;
    assert.notEqual((await call('task_memory_refresh', { ...args, requestId: 'resynchronized', expectedRevision: status.revision })).isError, true);
    assert.equal(f.db.prepare('SELECT stop_notified FROM codex_hook_requests').get<{ stop_notified: number }>()!.stop_notified, 0);
    for (const [patch, reason] of [[{ capabilities: [] }, 'capability_catalog_mismatch'], [{ maxContextChars: 9000 }, 'context_budget_mismatch']] as const) {
      const rejected = await call('task_memory_refresh', { ...args, ...f.input(), ...patch });
      assert.equal((rejected.structuredContent as Record<string, unknown>)?.reason, reason);
      assert.equal((rejected.structuredContent as Record<string, unknown>)?.recoverable, false);
    }
    const otherRoot = path.join(f.base, 'other-repository');
    execFileSync('git', ['init', '-q', otherRoot]);
    const beforeRejection = taskAssuranceReport(f.db, f.runId).revision;
    const wrongRoot = await call('task_memory_refresh', { ...args, ...f.input(), cwd: otherRoot });
    assert.equal((wrongRoot.structuredContent as Record<string, unknown>).reason, 'repository_mismatch');
    assert.equal('currentRevision' in (wrongRoot.structuredContent as object), false);
    assert.equal(taskAssuranceReport(f.db, f.runId).revision, beforeRejection);
    new LedgerStore(f.db).updateRunStatus(f.runId, 'failed');
    const ended = await call('task_memory_refresh', { ...args, requestId: 'after-end' });
    assert.equal((ended.structuredContent as Record<string, unknown>).reason, 'run_not_active');
    const blocked = handleCodexHook(f.db, { ...f.hook, hook_event_name: 'PreToolUse', tool_name: 'mcp__kiokuko__task_memory_status', tool_use_id: 'wrong-run', tool_input: { runId: 'other-run' } }) as any;
    assert.equal(blocked.hookSpecificOutput.permissionDecision, 'deny');
    const retry = handleCodexHook(f.db, { ...skill, hook_event_name: 'PreToolUse' }) as any;
    assert.equal(retry.hookSpecificOutput.permissionDecision, 'deny');
  } finally { await client.close(); await server.close(); f.close(); }
});

test('refresh losing a concurrent update returns typed revisions without committing a delivery or receipt', async () => {
  const f = await fixture();
  const second = openConnection(f.databasePath);
  try {
    const input = { ...f.input(), capabilities, changedPaths: ['source.ts'] };
    const count = () => f.db.prepare('SELECT COUNT(*) n FROM context_deliveries WHERE run_id=?').get<{ n: number }>(f.runId)!.n;
    const before = count();
    let interleaved = false;
    const wrapped = new Proxy(f.db, { get(db, key) {
      if (key === 'exec') return (sql: string) => {
        if (sql === 'BEGIN IMMEDIATE' && !interleaved) {
          interleaved = true;
          defineTaskVerification(second, { cwd: f.cwd, runId: f.runId, expectedRevision: input.expectedRevision, requestId: 'concurrent-definition', reason: 'Concurrent contract change', checks: [{id: 'race', target: 'local', expected: 'Pass', method: 'fixture'}] });
        }
        return db.exec(sql);
      };
      const value = Reflect.get(db, key);
      return typeof value === 'function' ? value.bind(db) : value;
    } });
    await assert.rejects(refreshTaskMemory(wrapped, input), error => error instanceof TaskStateConflict
      && error.reason === 'assurance_revision_changed' && error.details.currentRevision === input.expectedRevision + 1);
    assert.equal(interleaved, true);
    assert.equal(count(), before);
    assert.equal(f.db.prepare('SELECT COUNT(*) n FROM task_assurance_requests WHERE run_id=? AND request_id=?')
      .get<{ n: number }>(f.runId, input.requestId)!.n, 0);
  } finally { second.close(); f.close(); }
});
