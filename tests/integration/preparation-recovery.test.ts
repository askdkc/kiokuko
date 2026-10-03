import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createKiokukoMcpServer } from '../../src/mcp/server.js';
import { recordEntry } from '../../src/memory/entries.js';
import { recordContextDelivery } from '../../src/context/delivery.js';
import { getAkinatorStateService } from '../../src/akinator/service.js';
import { assuranceState, taskAssuranceReport, reviewTaskMemory } from '../../src/assurance/service.js';
import { handleCodexHook } from '../../src/assurance/codex-hooks.js';
import { createTaskAssuranceRoute } from '../../src/server/routes/task-assurance.js';
import { createHash } from 'node:crypto';
import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, rm, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { initializeDatabase } from '../../src/commands/init.js';
import { openConnection } from '../../src/db/connection.js';
import { prepareAgentTask, answerAgentTask, bindSkillDiscoveryRequest, bindTaskContextRequest, skillDiscoveryRequestIdentity } from '../../src/akinator/agent-task.js';
import { recoverTaskPreparation } from '../../src/akinator/preparation-recovery.js';
import { capabilityCatalogSchema } from '../../src/akinator/capability-contract.js';
import { resolveProjectWorkspace } from '../../src/memory/workspaces.js';
import { captureProjectManifestSnapshot, bindProjectManifestSnapshot } from '../../src/repository/project-fingerprint.js';
import { AgentGatewayService } from '../../src/gateway/agent-service.js';
import { canonicalContentHash } from '../../src/serialization/validate.js';
import { enrollAssurance, bindAssuranceRoot } from '../../src/assurance/service.js';
import { LedgerStore } from '../../src/ledger/store.js';
const caps = [{ kind: 'skill', name: 'kiokuko-soul' }, { kind: 'skill', name: 'memory-reasoning' }];
async function fixture(intake = false, options: {
  previousCapabilities?: unknown;
} = { previousCapabilities: ['kiokuko-soul'] }) {
  const { previousCapabilities } = options;
  const dir = await mkdtemp(path.join(tmpdir(), 'kiokuko-recovery-test-'));
  const root = path.join(dir, 'repo');
  await mkdir(root);
  execFileSync('git', ['init', '-q', root]);
  const databasePath = path.join(dir, 'test.sqlite3');
  await initializeDatabase({ databasePath });
  const db = openConnection(databasePath);
  const project = (await resolveProjectWorkspace(db, root))!;
  const requestId = 'legacy-request';
  const opened = new AgentGatewayService(db).openRun({ idempotencyKey: `mcp-task-prepare-${canonicalContentHash({ version: 1, requestId })}`, request: { apiVersion: '1', workspace: project.workspace, client: { kind: 'test' }, captureProfile: 'minimal', coverage: { run: 'unavailable', tool: 'unavailable', command: 'unavailable', file: 'unavailable', approval: 'unavailable' }, task: { title: 'Repair capability preparation', query: 'Repair capability preparation', profileHints: { taskType: 'debug', target: intake ? null : 'capability preparation', expected: 'tests pass', constraints: null } }, ...(previousCapabilities === undefined ? {} : {capabilities: previousCapabilities}), metadata: bindTaskContextRequest(bindSkillDiscoveryRequest(bindProjectManifestSnapshot({ source: 'mcp' }, project, captureProjectManifestSnapshot(project)), skillDiscoveryRequestIdentity('off', previousCapabilities)), 12000, undefined, 'off') } });
  enrollAssurance(db, opened.runId, new Date().toISOString());
  bindAssuranceRoot(db, opened.runId, root, 'pending');
  const input = { cwd: root, runId: opened.runId, requestId, operationId: 'recover-once', expectedRevision: 0, soulRead: true as const, previousCapabilities, capabilities: caps };
  return { db, root, input, databasePath, project, close: async () => { db.close(); await rm(dir, { recursive: true, force: true }); } };
}
test('preflight rejects without creating runs and permits correction under the same request ID', async () => {
  const f = await fixture();
  try {
    const count = () => f.db.prepare('SELECT COUNT(*) AS n FROM ledger_runs').get<{
      n: number;
    }>()!.n;
    for (const invalid of [undefined, ['kiokuko-soul'], [{ name: 'kiokuko-soul' }], [{ kind: 'skill', name: 'kiokuko-soul', source: 'fetched' }], [], [{ kind: 'skill', name: ' kiokuko-soul' }], [{ kind: 'skill', name: 'x'.repeat(301) }], Array.from({ length: 32001 }, () => ({ kind: 'skill', name: 'kiokuko-soul' }))]) {
      await assert.rejects(prepareAgentTask(f.db, { requestId: 'retry', cwd: f.root, task: 'Repair capability preparation', capabilities: invalid, skillDiscoveryMode: 'off' }), e => { assert.equal((e as any).details.runCreated, false); return true; });
      assert.equal(count(), 1);
      assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM context_deliveries').get<{
        n: number;
      }>()!.n, 0);
      assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM agent_task_skill_discovery_attempts').get<{
        n: number;
      }>()!.n, 0);
      assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM gateway_idempotency').get<{
        n: number;
      }>()!.n, 1);
    }
    const prepared = await prepareAgentTask(f.db, { requestId: 'retry', cwd: f.root, task: 'Repair capability preparation', capabilities: caps, skillDiscoveryMode: 'off' });
    assert.ok(prepared.run.runId);
    assert.equal(count(), 2);
  }
  finally {
    await f.close();
  }
});
for (const intake of [false, true])
  test(`recovery is idempotent and preserves answered intake (${intake})`, async () => {
    const previous = process.env.KIOKUKO_SKILL_DISCOVERY;
    process.env.KIOKUKO_SKILL_DISCOVERY = 'off';
    const f = await fixture(intake);
    try {
      const result = await recoverTaskPreparation(f.db, f.input);
      assert.equal(result.recoveredFromRunId, f.input.runId);
      assert.equal(new LedgerStore(f.db).readRun(f.input.runId)!.status, 'failed');
      assert.equal(result.intake.profile.taskType, 'debug');
      assert.equal(result.intake.profile.expected, 'tests pass');
      assert.equal(result.run.status, intake ? 'intake' : 'active');
      const replay = await recoverTaskPreparation(f.db, f.input);
      assert.equal(replay.run.runId, result.run.runId);
      await assert.rejects(recoverTaskPreparation(f.db, { ...f.input, operationId: 'other' }), /conflicts/);
      assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM ledger_runs').get<{
        n: number;
      }>()!.n, 2);
    }
    finally {
      await f.close();
      if (previous === undefined)
        delete process.env.KIOKUKO_SKILL_DISCOVERY;
      else
        process.env.KIOKUKO_SKILL_DISCOVERY = previous;
    }
  });
for (const scenario of ['revision', 'catalog', 'identity', 'execution', 'capture', 'terminal', 'discovery', 'repository', 'rollback'])
  test(`recovery rejects ${scenario} without partial successor`, async () => {
    const f = await fixture();
    try {
      let input = { ...f.input };
      if (scenario === 'revision')
        input.expectedRevision = 999;
      if (scenario === 'catalog')
        input.previousCapabilities = [];
      if (scenario === 'identity')
        input.requestId = 'other';
      if (scenario === 'execution')
        new LedgerStore(f.db).appendBatch(f.input.runId, { events: [{ eventId: 'executed', eventType: 'step.started', actor: 'test', payload: {} }] });
      if (scenario === 'capture')
        new LedgerStore(f.db).appendBatch(f.input.runId, { events: [{ eventId: 'captured', eventType: 'memory.proposed', actor: 'test', payload: {} }] });
      if (scenario === 'terminal')
        new LedgerStore(f.db).updateRunStatus(f.input.runId, 'failed');
      if (scenario === 'repository') {
        const other = path.join(f.root, 'other');
        await mkdir(other);
        execFileSync('git', ['init', '-q', other]);
        input.cwd = other;
      }
      if (scenario === 'discovery')
        f.db.prepare("INSERT INTO agent_task_skill_discovery_attempts (run_id,request_digest,reserved_query_count,reserved_selection_count,consumed_query_count,consumed_selection_count,state,started_at) VALUES (?, ?,1,1,0,0,'started',?)").run(f.input.runId, 'a'.repeat(64), new Date().toISOString());
      if (scenario === 'rollback')
        f.db.exec("CREATE TRIGGER reject_receipt BEFORE INSERT ON task_preparation_recoveries BEGIN SELECT RAISE(ABORT,'receipt failure'); END");
      await assert.rejects(recoverTaskPreparation(f.db, input));
      assert.equal(new LedgerStore(f.db).readRun(f.input.runId)!.status, scenario === 'terminal' ? 'failed' : 'active');
      assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM ledger_runs').get<{
        n: number;
      }>()!.n, 1);
    }
    finally {
      await f.close();
    }
  });
test('catalog schema exposes strict typed items', () => { assert.equal(capabilityCatalogSchema.safeParse(caps).success, true); assert.equal(capabilityCatalogSchema.safeParse(['kiokuko-soul']).success, false); });
test('HTTP recovery and Codex hook bind only the durable successor and permit execution afterward', async () => {
  const previous = process.env.KIOKUKO_SKILL_DISCOVERY;
  process.env.KIOKUKO_SKILL_DISCOVERY = 'off';
  const f = await fixture();
  try {
    const common = { session_id: 'client', turn_id: 'turn', cwd: f.root };
    handleCodexHook(f.db, { ...common, hook_event_name: 'UserPromptSubmit' });
    const request = f.db.prepare('SELECT request_id FROM codex_hook_requests').get<{
      request_id: string;
    }>()!.request_id;
    const key = `mcp-task-prepare-${canonicalContentHash({ version: 1, requestId: request })}`;
    f.db.prepare('UPDATE gateway_idempotency SET key_hash=? WHERE scope=?').run(createHash('sha256').update(key).digest('hex'), 'agent.run.open');
    handleCodexHook(f.db, { ...common, hook_event_name: 'PostToolUse', tool_name: 'mcp__kiokuko__task_prepare', tool_use_id: 'prepare', tool_input: { requestId: request }, tool_response: { structuredContent: { run: { runId: f.input.runId }, nextAction: 'required_capability_unavailable' } } });
    const input = { ...f.input, requestId: request };
    const { runId, operationId, ...body } = input;
    const route = createTaskAssuranceRoute({ database: f.db, enqueueWrite: async (op) => op() });
    const server = createKiokukoMcpServer({ databasePath: f.databasePath, cwd: () => f.root });
    const client = new Client({ name: 'recovery-parity', version: '1' });
    const [ct, st] = InMemoryTransport.createLinkedPair();
    await server.connect(st);
    await client.connect(ct);
    let mcpResult;
    try {
      mcpResult = await client.callTool({ name: 'task_prepare_recover', arguments: input });
      assert.notEqual(mcpResult.isError, true);
    }
    finally {
      await client.close();
      await server.close();
    }
    const response = await route({ method: 'POST', url: new URL(`http://localhost/api/v1/agent/runs/${runId}/prepare-recovery`), headers: { 'idempotency-key': operationId }, body }) as any;
    assert.ok(response.data.run.runId);
    assert.equal(response.data.run.runId, (mcpResult.structuredContent as any).run.runId);
    assert.equal(response.data.nextAction, (mcpResult.structuredContent as any).nextAction);
    const event = { ...common, hook_event_name: 'PostToolUse', tool_name: 'mcp__kiokuko__task_prepare_recover', tool_use_id: 'recover', tool_input: input, tool_response: { structuredContent: response.data } };
    assert.throws(() => handleCodexHook(f.db, { ...event, tool_response: { structuredContent: { ...response.data, run: { runId: runId } } } }), /durable client binding/);
    handleCodexHook(f.db, event);
    handleCodexHook(f.db, event);
    assert.equal(f.db.prepare('SELECT state FROM codex_hook_requests').get<{
      state: string;
    }>()!.state, 'bound');
    const admitted = handleCodexHook(f.db, { ...common, hook_event_name: 'PreToolUse', tool_name: 'exec_command', tool_use_id: 'work', tool_input: { cmd: 'true' } });
    assert.notEqual((admitted as any).hookSpecificOutput?.permissionDecision, 'deny');
    const replay = await route({ method: 'POST', url: new URL(`http://localhost/api/v1/agent/runs/${runId}/prepare-recovery`), headers: { 'idempotency-key': operationId }, body }) as any;
    assert.equal(replay.data.run.runId, response.data.run.runId);
  }
  finally {
    await f.close();
    if (previous === undefined)
      delete process.env.KIOKUKO_SKILL_DISCOVERY;
    else
      process.env.KIOKUKO_SKILL_DISCOVERY = previous;
  }
});
async function legacyDelivery(f: Awaited<ReturnType<typeof fixture>>) {
  const entry = recordEntry(f.db, {
    workspace: f.project.workspace, kind: 'decision', title: 'capability preparation',
    body: 'Repair capability preparation using strict catalogs and a successor run.', confidence: 0.8,
  });
  const sessionId = f.db.prepare('SELECT session_id FROM run_intakes WHERE run_id=?')
    .get<{
    session_id: string;
  }>(f.input.runId)!.session_id;
  const intake = await getAkinatorStateService(f.db, { workspace: f.project.workspace, sessionId });
  const old = new LedgerStore(f.db).readRun(f.input.runId)!;
  const delivery = recordContextDelivery(f.db, {
    workspace: f.project.workspace, deliveryId: 'legacy-delivery', runId: old.runId,
    throughSequence: old.lastSequence, intakeSessionId: sessionId,
    taskProfileHash: canonicalContentHash(intake.session.profile), queryHash: 'b'.repeat(64),
    policyVersion: 'context-ranking-v1+recommendations.v1', charBudget: 12000, charCount: 100,
    truncated: false, createdAt: new Date().toISOString(),
    items: [{ entryId: entry.id, entryRevision: entry.revision, rank: 1,
        scoreComponents: { status: 0, trust: 0, confidence: 0, taskAffinity: 0, recommendedTags: 0,
          pathOverlap: 0, errorSignature: 0, feedback: 0, recency: 0, contradiction: 0 },
        selectionReasons: ['candidate'],
      }],
  });
  reviewTaskMemory(f.db, {
    cwd: f.root, runId: old.runId, requestId: 'legacy-review',
    expectedRevision: assuranceState(f.db, old.runId)!.revision,
    deliveryId: delivery.deliveryId, entryId: entry.id, entryRevision: entry.revision,
    decision: 'inapplicable', basis: 'Historical review only; successor must review its own delivery.',
  });
  f.input.expectedRevision = assuranceState(f.db, old.runId)!.revision;
  return entry;
}
test('legacy delivery and reviews remain history and the successor requires fresh review', async () => {
  const previous = process.env.KIOKUKO_SKILL_DISCOVERY;
  process.env.KIOKUKO_SKILL_DISCOVERY = 'off';
  const f = await fixture();
  try {
    const entry = await legacyDelivery(f);
    const result = await recoverTaskPreparation(f.db, f.input);
    assert.notEqual(result.context!.deliveryId, 'legacy-delivery');
    assert.equal(result.nextAction, 'review_memory_application');
    assert.ok(taskAssuranceReport(f.db, result.run.runId).pending.includes(entry.id));
    assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM task_memory_reviews WHERE run_id=?')
      .get<{
      n: number;
    }>(f.input.runId)!.n, 1);
    assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM task_memory_reviews WHERE run_id=?')
      .get<{
      n: number;
    }>(result.run.runId)!.n, 0);
    assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM context_deliveries WHERE run_id=?')
      .get<{
      n: number;
    }>(f.input.runId)!.n, 1);
  }
  finally {
    await f.close();
    if (previous === undefined)
      delete process.env.KIOKUKO_SKILL_DISCOVERY;
    else
      process.env.KIOKUKO_SKILL_DISCOVERY = previous;
  }
});
test('recovery preserves real answers, question budget and user-answer provenance', async () => {
  const previous = process.env.KIOKUKO_SKILL_DISCOVERY;
  process.env.KIOKUKO_SKILL_DISCOVERY = 'off';
  const f = await fixture(true);
  try {
    new AgentGatewayService(f.db).answerIntake({
      runId: f.input.runId, idempotencyKey: 'legacy-answer',
      request: { apiVersion: '1', questionId: 'target', value: 'capability preparation',
        capabilities: f.input.previousCapabilities },
    });
    const result = await recoverTaskPreparation(f.db, f.input);
    assert.equal(result.intake.question, null);
    assert.equal(result.intake.sessionId === f.db.prepare('SELECT session_id FROM run_intakes WHERE run_id=?')
      .get<{
      session_id: string;
    }>(f.input.runId)!.session_id, false);
    const session = await getAkinatorStateService(f.db, {
      workspace: f.project.workspace, sessionId: result.intake.sessionId,
    });
    assert.equal(session.session.questionCount, 1);
    assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM akinator_answers WHERE session_id=?')
      .get<{
      n: number;
    }>(session.session.id)!.n, 1);
    const link = f.db.prepare('SELECT profile_sources_json FROM run_intakes WHERE run_id=?')
      .get<{
      profile_sources_json: string;
    }>(result.run.runId)!;
    assert.equal(JSON.parse(link.profile_sources_json).target, 'user_answer');
  }
  finally {
    await f.close();
    if (previous === undefined)
      delete process.env.KIOKUKO_SKILL_DISCOVERY;
    else
      process.env.KIOKUKO_SKILL_DISCOVERY = previous;
  }
});
test('concurrent recovery and retrieval failure never create another successor', async () => {
  const previous = process.env.KIOKUKO_SKILL_DISCOVERY;
  process.env.KIOKUKO_SKILL_DISCOVERY = 'off';
  const f = await fixture();
  try {
    f.db.exec("CREATE TRIGGER reject_delivery BEFORE INSERT ON context_deliveries BEGIN SELECT RAISE(ABORT,'retrieval persistence failure'); END");
    await assert.rejects(recoverTaskPreparation(f.db, f.input));
    const receipt = f.db.prepare('SELECT successor_run_id FROM task_preparation_recoveries')
      .get<{
      successor_run_id: string;
    }>()!;
    assert.ok(receipt);
    assert.equal(assuranceState(f.db, receipt.successor_run_id)!.repository_root, f.project.repositoryRoot);
    f.db.exec('DROP TRIGGER reject_delivery');
    const [first, replay] = await Promise.all([
      recoverTaskPreparation(f.db, f.input), recoverTaskPreparation(f.db, f.input),
    ]);
    assert.equal(first.run.runId, receipt.successor_run_id);
    assert.equal(replay.run.runId, receipt.successor_run_id);
    assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM ledger_runs').get<{
      n: number;
    }>()!.n, 2);
    new LedgerStore(f.db).updateRunStatus(receipt.successor_run_id, 'failed');
    await assert.rejects(recoverTaskPreparation(f.db, f.input), /terminal/);
    assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM ledger_runs').get<{
      n: number;
    }>()!.n, 2);
  }
  finally {
    await f.close();
    if (previous === undefined)
      delete process.env.KIOKUKO_SKILL_DISCOVERY;
    else
      process.env.KIOKUKO_SKILL_DISCOVERY = previous;
  }
});
for (const previousCapabilities of [undefined, [{ kind: 'skill', name: 'memory-reasoning' }]]) {
  test(`recovery verifies an omitted or soul-missing legacy catalog (${previousCapabilities === undefined ? 'omitted' : 'missing'})`, async () => {
    const previous = process.env.KIOKUKO_SKILL_DISCOVERY;
    process.env.KIOKUKO_SKILL_DISCOVERY = 'off';
    const f = await fixture(false, { previousCapabilities });
    try {
      const result = await recoverTaskPreparation(f.db, f.input);
      assert.equal(result.nextAction, 'proceed');
    }
    finally {
      await f.close();
      if (previous === undefined)
        delete process.env.KIOKUKO_SKILL_DISCOVERY;
      else
        process.env.KIOKUKO_SKILL_DISCOVERY = previous;
    }
  });
}
test('recovered client still waits for intake and fresh memory reviews before ordinary tools', async () => {
  const previous = process.env.KIOKUKO_SKILL_DISCOVERY;
  process.env.KIOKUKO_SKILL_DISCOVERY = 'off';
  const f = await fixture(true);
  try {
    const entry = recordEntry(f.db, { workspace: f.project.workspace, kind: 'decision',
      title: 'capability preparation', body: 'Use strict catalogs and successor recovery for capability preparation.', confidence: 0.8 });
    const common = { session_id: 'gated-client', turn_id: 'turn', cwd: f.root };
    handleCodexHook(f.db, { ...common, hook_event_name: 'UserPromptSubmit' });
    const requestId = f.db.prepare('SELECT request_id FROM codex_hook_requests').get<{
      request_id: string;
    }>()!.request_id;
    const key = `mcp-task-prepare-${canonicalContentHash({ version: 1, requestId })}`;
    f.db.prepare('UPDATE gateway_idempotency SET key_hash=? WHERE scope=?')
      .run(createHash('sha256').update(key).digest('hex'), 'agent.run.open');
    handleCodexHook(f.db, { ...common, hook_event_name: 'PostToolUse', tool_name: 'mcp__kiokuko__task_prepare',
      tool_use_id: 'prepare', tool_input: { requestId },
      tool_response: { structuredContent: { run: { runId: f.input.runId }, nextAction: 'required_capability_unavailable' } } });
    const input = { ...f.input, requestId };
    const result = await recoverTaskPreparation(f.db, input);
    const recoverEvent = { ...common, hook_event_name: 'PostToolUse', tool_name: 'mcp__kiokuko__task_prepare_recover',
      tool_use_id: 'recover', tool_input: input, tool_response: { structuredContent: result } };
    handleCodexHook(f.db, recoverEvent);
    const ordinary = { ...common, hook_event_name: 'PreToolUse', tool_name: 'exec_command',
      tool_use_id: 'work', tool_input: { cmd: 'true' } };
    const answer = { cwd: f.root, runId: result.run.runId, sessionId: result.intake.sessionId,
      questionId: 'target' as const, value: 'capability preparation', maxContextChars: 12000, capabilities: caps, skillDiscoveryMode: 'off' as const };
    const ready = await answerAgentTask(f.db, answer);
    handleCodexHook(f.db, { ...common, hook_event_name: 'PostToolUse', tool_name: 'mcp__kiokuko__task_answer',
      tool_use_id: 'answer', tool_input: answer, tool_response: { structuredContent: ready } });
    assert.equal(ready.nextAction, 'review_memory_application');
    assert.deepEqual(taskAssuranceReport(f.db, ready.run.runId).pending, [entry.id]);
    reviewTaskMemory(f.db, { cwd: f.root, runId: ready.run.runId, requestId: 'fresh-review',
      expectedRevision: assuranceState(f.db, ready.run.runId)!.revision,
      deliveryId: ready.context!.deliveryId!, entryId: entry.id, entryRevision: entry.revision,
      decision: 'inapplicable', basis: 'Review this delivery independently of predecessor history.' });
    assert.notEqual((handleCodexHook(f.db, ordinary) as any).hookSpecificOutput?.permissionDecision, 'deny');
  }
  finally {
    await f.close();
    if (previous === undefined)
      delete process.env.KIOKUKO_SKILL_DISCOVERY;
    else
      process.env.KIOKUKO_SKILL_DISCOVERY = previous;
  }
});

test('a recovered intake denial cannot be reopened by a forged proceed or delayed answer', async () => {
  const f = await fixture(true);
  try {
    const common = { session_id: 'stopped-recovery', turn_id: 'turn', cwd: f.root };
    handleCodexHook(f.db, { ...common, hook_event_name: 'UserPromptSubmit' });
    const requestId = f.db.prepare('SELECT request_id FROM codex_hook_requests').get<{ request_id: string }>()!.request_id;
    const key = `mcp-task-prepare-${canonicalContentHash({ version: 1, requestId })}`;
    f.db.prepare('UPDATE gateway_idempotency SET key_hash=? WHERE scope=?')
      .run(createHash('sha256').update(key).digest('hex'), 'agent.run.open');
    handleCodexHook(f.db, { ...common, hook_event_name: 'PostToolUse', tool_name: 'mcp__kiokuko__task_prepare',
      tool_use_id: 'prepare', tool_input: { requestId },
      tool_response: { structuredContent: { run: { runId: f.input.runId }, nextAction: 'required_capability_unavailable' } } });
    const input = { ...f.input, requestId };
    const result = await recoverTaskPreparation(f.db, input);
    const recover = { ...common, hook_event_name: 'PostToolUse', tool_name: 'mcp__kiokuko__task_prepare_recover',
      tool_use_id: 'recover', tool_input: input, tool_response: { structuredContent: result } };
    handleCodexHook(f.db, recover);
    // Even a misleading model-facing response cannot admit an intake run.
    handleCodexHook(f.db, { ...recover, tool_response: { structuredContent: { ...result, nextAction: 'proceed' } } });
    const ordinary = { ...common, hook_event_name: 'PreToolUse', tool_name: 'exec_command', tool_use_id: 'work', tool_input: { cmd: 'true' } };
    assert.equal((handleCodexHook(f.db, ordinary) as any).hookSpecificOutput.permissionDecision, 'deny');
    assert.equal(new LedgerStore(f.db).readRun(result.run.runId)!.status, 'failed');
    assert.equal((handleCodexHook(f.db, recover) as any).continue, false);
    assert.equal((handleCodexHook(f.db, { ...recover, tool_name: 'mcp__kiokuko__task_answer' }) as any).continue, false);
    assert.equal((handleCodexHook(f.db, { ...ordinary, tool_name: 'mcp__kiokuko__task_prepare_recover', tool_input: input }) as any).hookSpecificOutput.permissionDecision, 'deny');
  } finally { await f.close(); }
});

test('competing recovery operations admit exactly one successor', async () => {
  const previous = process.env.KIOKUKO_SKILL_DISCOVERY;
  process.env.KIOKUKO_SKILL_DISCOVERY = 'off';
  const f = await fixture();
  try {
    const results = await Promise.allSettled([
      recoverTaskPreparation(f.db, f.input),
      recoverTaskPreparation(f.db, { ...f.input, operationId: 'competing-operation' }),
    ]);
    assert.equal(results.filter(result => result.status === 'fulfilled').length, 1);
    assert.equal(results.filter(result => result.status === 'rejected').length, 1);
    assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM task_preparation_recoveries').get<{ n: number }>()!.n, 1);
    assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM ledger_runs').get<{ n: number }>()!.n, 2);
  } finally {
    await f.close();
    if (previous === undefined) delete process.env.KIOKUKO_SKILL_DISCOVERY;
    else process.env.KIOKUKO_SKILL_DISCOVERY = previous;
  }
});

test('operation identity cannot be reused for another predecessor', async () => {
  const previous = process.env.KIOKUKO_SKILL_DISCOVERY;
  process.env.KIOKUKO_SKILL_DISCOVERY = 'off';
  const f = await fixture();
  try {
    const requestId = 'other-legacy-request';
    const original = new LedgerStore(f.db).readRun(f.input.runId)!;
    const { kiokukoCapabilityCatalogBinding: ignored, ...metadata } = original.metadata;
    const second = new AgentGatewayService(f.db).openRun({
      idempotencyKey: `mcp-task-prepare-${canonicalContentHash({ version: 1, requestId })}`,
      request: { apiVersion: '1', workspace: f.project.workspace, client: { kind: 'test' },
        captureProfile: original.captureProfile, coverage: original.coverage,
        task: { title: 'Repair capability preparation', query: 'Repair capability preparation',
          profileHints: { taskType: 'debug', target: 'capability preparation', expected: 'tests pass' } },
        capabilities: f.input.previousCapabilities, metadata },
    });
    enrollAssurance(f.db, second.runId, new Date().toISOString());
    bindAssuranceRoot(f.db, second.runId, f.root, 'pending');
    await recoverTaskPreparation(f.db, f.input);
    await assert.rejects(recoverTaskPreparation(f.db, { ...f.input, runId: second.runId, requestId }), /another predecessor/);
    assert.equal(new LedgerStore(f.db).readRun(second.runId)!.status, 'active');
    assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM ledger_runs').get<{ n: number }>()!.n, 3);
  } finally {
    await f.close();
    if (previous === undefined) delete process.env.KIOKUKO_SKILL_DISCOVERY;
    else process.env.KIOKUKO_SKILL_DISCOVERY = previous;
  }
});
