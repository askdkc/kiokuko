import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { prepareAgentTask } from '../../src/akinator/agent-task.js';
import { initializeDatabase } from '../../src/commands/init.js';
import { openConnection } from '../../src/db/connection.js';
import { decideAdapterContinuation, renderStopHookDecision } from '../../src/enno-oduno/adapters.js';
import { answerEnno, finishEnno, reportEnnoWork, submitEnnoPlan } from '../../src/enno-oduno/service.js';

const capabilities = [
  { kind: 'skill', name: 'kiokuko-soul', description: 'Routes work to every applicable Kiokuko Skill.' },
  { kind: 'skill', name: 'kiokuko-single-purpose-functions', description: 'Focused code contracts and tests.' },
  { kind: 'skill', name: 'kiokuko-ui-design-soul', description: 'UI interaction and accessibility guidance.' },
];

async function fixture() {
  const root = await mkdtemp(path.join(tmpdir(), 'kiokuko-enno-repo-'));
  execFileSync('git', ['init', '-q', root]);
  const databaseDirectory = await mkdtemp(path.join(tmpdir(), 'kiokuko-enno-db-'));
  const databasePath = path.join(databaseDirectory, 'kiokuko.sqlite3');
  await initializeDatabase({ databasePath });
  return { root, databasePath, database: openConnection(databasePath) };
}

function verifier(root: string, id: string) {
  return { id, kind: 'test' as const, executable: process.execPath, args: ['--eval', 'process.exit(0)'], cwd: root, timeoutMs: 5000 };
}

async function plannedExecution(
  database: ReturnType<typeof openConnection>,
  root: string,
  requestId: string,
  finalVerifier: ReturnType<typeof verifier>,
  options: {
    maxAttempts?: number;
    focusedVerifiers?: ReturnType<typeof verifier>[];
    client?: 'codex' | 'claude' | 'opencode';
    clientIdentity?: 'bound' | 'kind_only' | 'omitted';
  } = {},
) {
  const client = options.client ?? 'codex';
  const sessionId = `${client}-${requestId}`;
  const clientIdentity = options.clientIdentity ?? 'bound';
  const prepared = await prepareAgentTask(database, {
    requestId, cwd: root, task: 'Repair the add function',
    profileHints: { taskType: 'debug', target: 'src/add.js', expected: 'tests pass', constraints: null },
    capabilities,
    ...(clientIdentity === 'omitted' ? {} : {
      client: { kind: client, ...(clientIdentity === 'bound' ? { sessionId } : {}) },
    }),
    skillDiscoveryMode: 'off',
  });
  const repositoryRoot = prepared.project.repositoryRoot;
  const identity = { runId: prepared.run.runId, workspace: prepared.project.workspace, orchestrationId: prepared.intake.sessionId };
  const response = await submitEnnoPlan(database, {
    ...identity, expectedRevision: 1, idempotencyKey: `plan-${requestId}`,
    scope: ['src/add.js'], exclusions: [], acceptanceCriteria: [{ id: 'tests', description: 'tests pass' }],
    workPlan: { objective: 'Repair add', units: [{
      id: 'repair', objective: 'Repair add', scope: ['src/add.js'], dependencies: [], skillNames: [],
      expertRefs: [{ id: 'code.verification.v1', reason: 'Repair the reported regression with matching evidence' }],
      acceptanceCriteria: ['tests pass'], focusedVerifiers: (options.focusedVerifiers ?? []).map((item) => ({ ...item, cwd: repositoryRoot })),
    }] },
    skillRequirements: [], finalVerifiers: [{ ...finalVerifier, cwd: repositoryRoot }], maxAttempts: options.maxAttempts ?? 5,
    provenance: {
      scope: 'explicit_user', exclusions: 'explicit_user', acceptanceCriteria: 'explicit_user',
      workPlan: 'explicit_user', skillSet: 'explicit_user', finalVerifiers: 'explicit_user', maxAttempts: 'explicit_user',
    },
    capabilities,
  });
  assert.equal(response.ennoOduno.status, 'goki_executing');
  return { identity, repositoryRoot, hostSessionId: sessionId, prepared };
}

test('task_prepare returns the Enno handoff to harness-specific Zenki before one hook binds the host session', async () => {
  const { root, database } = await fixture();
  try {
    const planned = await plannedExecution(database, root, 'pending-client-binding', verifier(root, 'pass'), {
      client: 'opencode',
      clientIdentity: 'kind_only',
    });
    assert.equal(planned.prepared.ennoOduno.status, 'zenki_planning');
    assert.equal(planned.prepared.ennoOduno.orchestrationId, planned.prepared.intake.sessionId);
    assert.deepEqual(planned.prepared.ennoOduno.clientBinding, {
      status: 'pending',
      clientKind: 'opencode',
      clientVersion: null,
      identified: true,
    });
    assert.equal(planned.prepared.ennoOduno.directive?.role, 'zenki');
    assert.equal(planned.prepared.ennoOduno.directive?.handoff?.sourceRole, 'enno-oduno');
    assert.equal(planned.prepared.ennoOduno.directive?.handoff?.taskType, 'debug');
    assert.match(planned.prepared.ennoOduno.directive?.handoff?.objective ?? '', /src\/add\.js/u);
    assert.match(planned.prepared.ennoOduno.directive?.handoff?.objective ?? '', /tests pass/u);
    assert.equal(planned.prepared.ennoOduno.directive?.harness.kind, 'opencode');
    assert.equal(planned.prepared.ennoOduno.directive?.harness.continuation, 'session_idle_plugin');
    assert.deepEqual(planned.prepared.ennoOduno.directive?.requiredSkills, ['kiokuko-soul', 'kiokuko-single-purpose-functions']);
    assert.match(planned.prepared.ennoOduno.directive?.objective ?? '', /one cohesive externally observable function or use-case contract/iu);
    assert.match(planned.prepared.ennoOduno.directive?.objective ?? '', /focused runnable test target/iu);

    const claimed = decideAdapterContinuation(database, 'opencode', {
      sessionId: planned.hostSessionId,
      cwd: root,
    });
    assert.equal(claimed.continue, true);
    assert.equal(claimed.directive?.role, 'goki');
    assert.deepEqual(claimed.directive?.requiredSkills, ['kiokuko-soul', 'kiokuko-single-purpose-functions']);
    assert.deepEqual(claimed.directive?.workUnit?.skillNames, ['kiokuko-soul', 'kiokuko-single-purpose-functions']);
    assert.deepEqual(claimed.directive?.workUnit?.expertRefs, [{
      id: 'code.verification.v1',
      reason: 'Repair the reported regression with matching evidence',
    }]);
    const binding = database.prepare(`
      SELECT client_kind AS clientKind, client_session_id AS clientSessionId
      FROM enno_contracts WHERE run_id = ?
    `).get<{ clientKind: string; clientSessionId: string }>(planned.identity.runId);
    assert.deepEqual(binding === undefined ? undefined : { ...binding }, {
      clientKind: 'opencode',
      clientSessionId: planned.hostSessionId,
    });
    assert.equal(database.prepare(`
      SELECT COUNT(*) AS count FROM ledger_events
      WHERE run_id = ? AND event_type = 'enno.client_bound'
    `).get<{ count: number }>(planned.identity.runId)?.count, 1);

    assert.equal(decideAdapterContinuation(database, 'opencode', {
      sessionId: 'different-opencode-session',
      cwd: root,
    }).continue, false);
    assert.throws(() => database.prepare(`
      UPDATE enno_contracts SET client_session_id = 'different-opencode-session' WHERE run_id = ?
    `).run(planned.identity.runId), /immutable/u);
  } finally {
    database.close();
  }
});

test('hook refuses ambiguous pending runs instead of selecting the latest repository run', async () => {
  const { root, database } = await fixture();
  try {
    const first = await plannedExecution(database, root, 'pending-first', verifier(root, 'first'), {
      clientIdentity: 'kind_only',
    });
    const second = await plannedExecution(database, root, 'pending-second', verifier(root, 'second'), {
      clientIdentity: 'kind_only',
    });
    const decision = decideAdapterContinuation(database, 'codex', {
      session_id: 'ambiguous-codex-session',
      cwd: root,
    });
    assert.equal(decision.continue, false);
    assert.match(decision.warning ?? '', /without guessing/u);
    const bindings = database.prepare(`
      SELECT run_id AS runId, client_session_id AS clientSessionId
      FROM enno_contracts WHERE run_id IN (?, ?) ORDER BY run_id
    `).all<{ runId: string; clientSessionId: string | null }>(first.identity.runId, second.identity.runId)
      .map((row) => ({ ...row }));
    assert.deepEqual(bindings, [
      { runId: [first.identity.runId, second.identity.runId].sort()[0], clientSessionId: null },
      { runId: [first.identity.runId, second.identity.runId].sort()[1], clientSessionId: null },
    ]);
  } finally {
    database.close();
  }
});

test('a client-kind hint narrows delayed hook binding without making the host session mandatory', async () => {
  const { root, database } = await fixture();
  try {
    const planned = await plannedExecution(database, root, 'pending-codex-kind', verifier(root, 'pass'), {
      client: 'codex',
      clientIdentity: 'kind_only',
    });
    assert.deepEqual(planned.prepared.ennoOduno.clientBinding, {
      status: 'pending',
      clientKind: 'codex',
      clientVersion: null,
      identified: true,
    });

    const wrongClient = decideAdapterContinuation(database, 'claude', {
      session_id: 'claude-cannot-claim-codex',
      cwd: root,
    });
    assert.equal(wrongClient.continue, false);
    assert.equal(database.prepare(`
      SELECT client_session_id AS clientSessionId FROM enno_contracts WHERE run_id = ?
    `).get<{ clientSessionId: string | null }>(planned.identity.runId)?.clientSessionId, null);

    const owner = decideAdapterContinuation(database, 'codex', {
      session_id: planned.hostSessionId,
      cwd: root,
    });
    assert.equal(owner.continue, true);
    assert.equal(owner.directive?.role, 'goki');
  } finally {
    database.close();
  }
});

test('Goki cannot start or report work before Zenki submits a plan', async () => {
  const { root, database } = await fixture();
  try {
    const prepared = await prepareAgentTask(database, {
      requestId: 'goki-before-plan',
      cwd: root,
      task: 'Repair the add function',
      profileHints: { taskType: 'debug', target: 'src/add.js', expected: 'tests pass', constraints: null },
      capabilities,
      client: { kind: 'codex', sessionId: 'codex-before-plan' },
      skillDiscoveryMode: 'off',
    });
    assert.equal(prepared.ennoOduno.status, 'zenki_planning');
    assert.equal(prepared.ennoOduno.currentRole, 'zenki');
    const planningContinuation = decideAdapterContinuation(database, 'codex', {
      session_id: 'codex-before-plan',
      cwd: root,
    });
    assert.equal(planningContinuation.continue, true);
    assert.equal(planningContinuation.directive?.role, 'zenki');

    await assert.rejects(reportEnnoWork(database, {
      runId: prepared.run.runId,
      workspace: prepared.project.workspace,
      orchestrationId: prepared.intake.sessionId,
      expectedRevision: 1,
      idempotencyKey: 'illegal-goki-report',
      workUnitId: 'not-planned',
      result: {
        outcome: 'completed',
        summary: 'This work must not be accepted',
        mutated: false,
        changedPaths: [],
      },
    }), /not in the required state/iu);

    assert.equal(database.prepare(`
      SELECT COUNT(*) AS count FROM ledger_events
      WHERE run_id = ? AND event_type LIKE 'goki.%'
    `).get<{ count: number }>(prepared.run.runId)?.count, 0);
  } finally {
    database.close();
  }
});

test('Zenki cannot submit a code WorkUnit without a selected expert fragment', async () => {
  const { root, database } = await fixture();
  try {
    const prepared = await prepareAgentTask(database, {
      requestId: 'missing-code-expert', cwd: root, task: 'Build a module',
      profileHints: { taskType: 'build', target: 'src/module.js', expected: 'tests pass', constraints: null },
      capabilities, client: { kind: 'codex', sessionId: 'codex-missing-expert' }, skillDiscoveryMode: 'off',
    });
    await assert.rejects(submitEnnoPlan(database, {
      runId: prepared.run.runId,
      workspace: prepared.project.workspace,
      orchestrationId: prepared.intake.sessionId,
      expectedRevision: 1,
      idempotencyKey: 'missing-expert-plan',
      scope: ['src/module.js'], exclusions: [],
      acceptanceCriteria: [{ id: 'tests', description: 'tests pass' }],
      workPlan: { objective: 'Build the module', units: [{
        id: 'module', objective: 'Build the module', scope: ['src/module.js'], dependencies: [],
        skillNames: [], acceptanceCriteria: ['tests pass'], focusedVerifiers: [],
      }] },
      skillRequirements: [],
      finalVerifiers: [verifier(prepared.project.repositoryRoot, 'missing-expert-final')],
      maxAttempts: 3,
      provenance: {
        scope: 'explicit_user', exclusions: 'explicit_user', acceptanceCriteria: 'explicit_user',
        workPlan: 'explicit_user', skillSet: 'explicit_user', finalVerifiers: 'explicit_user', maxAttempts: 'explicit_user',
      },
      capabilities,
    }), /must select a code expert fragment/iu);
    assert.equal(database.prepare('SELECT revision FROM enno_contracts WHERE run_id = ?')
      .get<{ revision: number }>(prepared.run.runId)?.revision, 1);
    assert.equal(database.prepare("SELECT COUNT(*) AS count FROM ledger_events WHERE run_id = ? AND event_type = 'zenki.plan_created'")
      .get<{ count: number }>(prepared.run.runId)?.count, 0);
  } finally {
    database.close();
  }
});

test('fake agent completes the Enno-Zenki-Goki loop in ledger order with fresh verifier evidence', async () => {
  const { root, database } = await fixture();
  try {
    const prepared = await prepareAgentTask(database, {
      requestId: 'enno-happy-path', cwd: root, task: 'Fix the incorrect add function and make tests pass',
      profileHints: { taskType: 'debug', target: 'src/add.js', expected: 'node --test passes', constraints: 'Do not change the API' },
      capabilities, client: { kind: 'codex', sessionId: 'codex-session-1' }, skillDiscoveryMode: 'off',
    });
    assert.equal(prepared.ennoOduno.status, 'zenki_planning');
    assert.equal(prepared.ennoOduno.directive?.role, 'zenki');
    assert.equal(prepared.ennoOduno.directive?.handoff?.sourceRole, 'enno-oduno');
    assert.equal(prepared.ennoOduno.directive?.harness.kind, 'codex');
    const repositoryRoot = prepared.project.repositoryRoot;
    const identity = {
      runId: prepared.run.runId,
      workspace: prepared.project.workspace,
      orchestrationId: prepared.intake.sessionId,
    };
    const plan = await submitEnnoPlan(database, {
      ...identity, expectedRevision: 1, idempotencyKey: 'plan-1',
      scope: ['src/add.js', 'test/add.test.js'], exclusions: ['package-lock.json'],
      acceptanceCriteria: [{ id: 'tests', description: 'node --test passes' }],
      workPlan: { objective: 'Repair add and test it', units: [{
        id: 'repair-add', objective: 'Repair the add implementation', scope: ['src/add.js'], dependencies: [],
        skillNames: ['kiokuko-single-purpose-functions'], acceptanceCriteria: ['node --test passes'],
        expertRefs: [{ id: 'code.verification.v1', reason: 'Prove the add regression through the focused test pipeline' }],
        focusedVerifiers: [verifier(repositoryRoot, 'focused-test')],
      }] },
      skillRequirements: [{ name: 'kiokuko-single-purpose-functions', purposes: ['implementation', 'testing'], required: true }],
      finalVerifiers: [verifier(repositoryRoot, 'final-test')], maxAttempts: 3,
      provenance: {
        scope: 'explicit_user', exclusions: 'explicit_user', acceptanceCriteria: 'repository_evidence',
        workPlan: 'repository_evidence', skillSet: 'repository_evidence', finalVerifiers: 'repository_evidence', maxAttempts: 'explicit_user',
      },
      capabilities,
    });
    assert.equal(plan.ennoOduno.status, 'needs_confirmation');
    assert.deepEqual(plan.ennoOduno.directive?.requiredSkills, [
      'kiokuko-soul',
      'kiokuko-enno-oduno',
      'kiokuko-single-purpose-functions',
    ]);
    assert.deepEqual(renderStopHookDecision(decideAdapterContinuation(database, 'codex', {
      session_id: 'codex-session-1', cwd: root,
    })), {});

    const approved = answerEnno(database, {
      ...identity, expectedRevision: 2, idempotencyKey: 'approve-1', action: 'approve',
    });
    assert.equal(approved.ennoOduno.status, 'goki_executing');
    const hook = decideAdapterContinuation(database, 'codex', { session_id: 'codex-session-1', cwd: root });
    assert.equal(hook.continue, true);
    assert.equal(hook.directive?.role, 'goki');
    assert.deepEqual(hook.directive?.requiredSkills, ['kiokuko-soul', 'kiokuko-single-purpose-functions']);

    const worked = await reportEnnoWork(database, {
      ...identity, expectedRevision: 2, idempotencyKey: 'work-1', workUnitId: 'repair-add',
      result: { outcome: 'completed', summary: 'Fixed add and added coverage', mutated: true, changedPaths: ['src/add.js'] },
    });
    assert.equal(worked.ennoOduno.status, 'enno_verifying');
    assert.deepEqual(worked.ennoOduno.directive?.requiredSkills, [
      'kiokuko-soul',
      'kiokuko-enno-oduno',
      'kiokuko-single-purpose-functions',
    ]);
    assert.equal(worked.verifierResults?.[0]?.status, 'passed');

    const finished = await finishEnno(database, {
      ...identity, expectedRevision: 2, idempotencyKey: 'finish-1',
      review: { decision: 'accept', summary: 'All acceptance criteria are satisfied' },
    });
    assert.equal(finished.ennoOduno.status, 'completed');
    assert.equal(finished.verifierResults?.[0]?.status, 'passed');
    assert.deepEqual(await finishEnno(database, {
      ...identity, expectedRevision: 2, idempotencyKey: 'finish-1',
      review: { decision: 'accept', summary: 'All acceptance criteria are satisfied' },
    }), finished);
    await assert.rejects(finishEnno(database, {
      ...identity, expectedRevision: 2, idempotencyKey: 'finish-1',
      review: { decision: 'replan', summary: 'Changed Review input must not replay' },
    }), /idempotency key was reused with different input/iu);

    const events = database.prepare(`
      SELECT event_type AS eventType FROM ledger_events
      WHERE run_id = ? AND (event_type LIKE 'enno.%' OR event_type LIKE 'zenki.%' OR event_type LIKE 'goki.%')
      ORDER BY sequence
    `).all<{ eventType: string }>(identity.runId).map((row) => row.eventType);
    assert.deepEqual(events, [
      'enno.started',
      'zenki.plan_created',
      'enno.plan_confirmed',
      'goki.work_started',
      'goki.work_completed',
      'enno.review_started',
      'enno.verification_started',
      'enno.verification_passed',
      'enno.review_accepted',
      'enno.completed',
    ]);
    const evidence = database.prepare(`
      SELECT contract_revision AS revision, mutation_revision AS mutationRevision, status
      FROM enno_verifier_runs WHERE run_id = ? ORDER BY started_at
    `).all<{ revision: number; mutationRevision: number; status: string }>(identity.runId);
    assert.deepEqual(evidence.map((item) => item.status), ['passed', 'passed']);
    assert.deepEqual(evidence.map((item) => item.revision), [2, 2]);
    assert.deepEqual(evidence.map((item) => item.mutationRevision), [1, 1]);
  } finally {
    database.close();
  }
});

test('code plus UI work carries SOUL first through Goki and the four-Skill Enno review', async () => {
  const { root, database } = await fixture();
  try {
    const prepared = await prepareAgentTask(database, {
      requestId: 'enno-code-ui-skills', cwd: root, task: 'Build an accessible settings panel',
      profileHints: { taskType: 'build', target: 'src/Settings.tsx', expected: 'UI tests pass', constraints: null },
      capabilities, client: { kind: 'codex', sessionId: 'codex-code-ui' }, skillDiscoveryMode: 'off',
    });
    const identity = {
      runId: prepared.run.runId,
      workspace: prepared.project.workspace,
      orchestrationId: prepared.intake.sessionId,
    };
    const plan = await submitEnnoPlan(database, {
      ...identity, expectedRevision: 1, idempotencyKey: 'code-ui-plan',
      scope: ['src/Settings.tsx'], exclusions: [], acceptanceCriteria: [{ id: 'ui-tests', description: 'UI tests pass' }],
      workPlan: { objective: 'Build the accessible settings panel', units: [{
        id: 'settings-ui', objective: 'Implement the settings panel', scope: ['src/Settings.tsx'], dependencies: [],
        skillNames: ['kiokuko-ui-design-soul', 'kiokuko-soul'], acceptanceCriteria: ['UI tests pass'], focusedVerifiers: [],
        expertRefs: [
          { id: 'code.domain.v1', reason: 'Keep settings state transitions deterministic' },
          { id: 'ui.accessibility.v1', reason: 'The panel must support accessible labels, focus, and keyboard use' },
        ],
      }] },
      skillRequirements: [{ name: 'kiokuko-ui-design-soul', purposes: ['ui', 'implementation', 'testing'], required: true }],
      finalVerifiers: [verifier(prepared.project.repositoryRoot, 'code-ui-final')], maxAttempts: 3,
      provenance: {
        scope: 'explicit_user', exclusions: 'explicit_user', acceptanceCriteria: 'explicit_user',
        workPlan: 'explicit_user', skillSet: 'explicit_user', finalVerifiers: 'explicit_user', maxAttempts: 'explicit_user',
      },
      capabilities,
    });
    assert.equal(plan.ennoOduno.status, 'goki_executing');
    assert.deepEqual(plan.ennoOduno.directive?.requiredSkills, [
      'kiokuko-soul',
      'kiokuko-single-purpose-functions',
      'kiokuko-ui-design-soul',
    ]);
    assert.deepEqual(plan.ennoOduno.directive?.workUnit?.skillNames, [
      'kiokuko-soul',
      'kiokuko-single-purpose-functions',
      'kiokuko-ui-design-soul',
    ]);
    assert.deepEqual(plan.ennoOduno.directive?.workUnit?.expertRefs.map((reference) => reference.id), [
      'code.domain.v1',
      'ui.accessibility.v1',
    ]);

    const reviewed = await reportEnnoWork(database, {
      ...identity, expectedRevision: 2, idempotencyKey: 'code-ui-work', workUnitId: 'settings-ui',
      result: { outcome: 'completed', summary: 'Implemented the accessible settings panel', mutated: true, changedPaths: ['src/Settings.tsx'] },
    });
    assert.equal(reviewed.ennoOduno.status, 'enno_verifying');
    assert.deepEqual(reviewed.ennoOduno.directive?.requiredSkills, [
      'kiokuko-soul',
      'kiokuko-enno-oduno',
      'kiokuko-single-purpose-functions',
      'kiokuko-ui-design-soul',
    ]);
  } finally {
    database.close();
  }
});

test('an Enno plan blocks when the exact local kiokuko-soul capability is absent', async () => {
  const { root, database } = await fixture();
  try {
    const capabilitiesWithoutSoul = [
      { kind: 'skill', name: 'kiokuko_soul', description: 'A non-canonical alias must not satisfy the master contract.' },
      ...capabilities.filter((capability) => capability.name !== 'kiokuko-soul'),
    ];
    const prepared = await prepareAgentTask(database, {
      requestId: 'enno-missing-soul', cwd: root, task: 'Repair the add function',
      profileHints: { taskType: 'debug', target: 'src/add.js', expected: 'tests pass', constraints: null },
      capabilities: capabilitiesWithoutSoul,
      client: { kind: 'codex', sessionId: 'codex-missing-soul' }, skillDiscoveryMode: 'off',
    });
    assert.equal(prepared.nextAction, 'required_capability_unavailable');
    const blocked = await submitEnnoPlan(database, {
      runId: prepared.run.runId, workspace: prepared.project.workspace, orchestrationId: prepared.intake.sessionId,
      expectedRevision: 1, idempotencyKey: 'missing-soul-plan', scope: ['src/add.js'], exclusions: [],
      acceptanceCriteria: [{ id: 'tests', description: 'tests pass' }],
      workPlan: { objective: 'Repair add', units: [{
        id: 'repair', objective: 'Repair add', scope: ['src/add.js'], dependencies: [], skillNames: [],
        expertRefs: [{ id: 'code.verification.v1', reason: 'Verify the repair while testing the missing required Skill gate' }],
        acceptanceCriteria: ['tests pass'], focusedVerifiers: [],
      }] },
      skillRequirements: [], finalVerifiers: [verifier(prepared.project.repositoryRoot, 'missing-soul-final')], maxAttempts: 3,
      provenance: {
        scope: 'explicit_user', exclusions: 'explicit_user', acceptanceCriteria: 'explicit_user',
        workPlan: 'explicit_user', skillSet: 'explicit_user', finalVerifiers: 'explicit_user', maxAttempts: 'explicit_user',
      },
      capabilities: capabilitiesWithoutSoul,
    });
    assert.equal(blocked.ennoOduno.status, 'blocked');
    assert.equal(blocked.ennoOduno.nextAction, 'report_blocker');
    assert.match(database.prepare('SELECT blocker FROM enno_contracts WHERE run_id = ?')
      .get<{ blocker: string }>(prepared.run.runId)?.blocker ?? '', /Required Skills unavailable: kiokuko-soul/u);
    assert.equal(database.prepare('SELECT status FROM ledger_runs WHERE run_id = ?')
      .get<{ status: string }>(prepared.run.runId)?.status, 'failed');
  } finally {
    database.close();
  }
});

test('run, workspace, and orchestration bindings reject cross-run progress without latest-run fallback', async () => {
  const { root, database } = await fixture();
  try {
    const prepared = await prepareAgentTask(database, {
      requestId: 'enno-session-binding', cwd: root, task: 'Build a small module',
      profileHints: { taskType: 'build', target: 'src/module.js', expected: 'tests pass', constraints: null },
      capabilities, client: { kind: 'claude', sessionId: 'claude-owner' }, skillDiscoveryMode: 'off',
    });
    const identity = { runId: prepared.run.runId, workspace: prepared.project.workspace, orchestrationId: 'not-owner' };
    await assert.rejects(submitEnnoPlan(database, {
      ...identity, expectedRevision: 1, idempotencyKey: 'wrong-owner', scope: ['src/module.js'], exclusions: [],
      acceptanceCriteria: [{ id: 'test', description: 'tests pass' }],
      workPlan: { objective: 'Build module', units: [{
        id: 'build', objective: 'Build module', scope: ['src/module.js'], dependencies: [], skillNames: [],
        expertRefs: [{ id: 'code.domain.v1', reason: 'Implement the module as deterministic domain behavior' }],
        acceptanceCriteria: ['tests pass'], focusedVerifiers: [],
      }] }, skillRequirements: [], finalVerifiers: [verifier(root, 'test')], maxAttempts: 2,
      provenance: {
        scope: 'explicit_user', exclusions: 'explicit_user', acceptanceCriteria: 'explicit_user',
        workPlan: 'explicit_user', skillSet: 'explicit_user', finalVerifiers: 'explicit_user', maxAttempts: 'explicit_user',
      }, capabilities,
    }), /does not own/u);
    assert.equal(decideAdapterContinuation(database, 'claude', { session_id: 'another-session', cwd: root }).continue, false);
    assert.equal(decideAdapterContinuation(database, 'codex', { session_id: 'claude-owner', cwd: root }).continue, false);
  } finally {
    database.close();
  }
});

test('failed Enno review returns to Zenki for a revision-bound replan before Goki can resume', async () => {
  const { root, database } = await fixture();
  try {
    const marker = path.join(root, 'verification-ready');
    const conditional = {
      id: 'conditional-final', kind: 'test' as const, executable: process.execPath,
      args: ['--eval', `import('node:fs').then(({existsSync}) => process.exit(existsSync(${JSON.stringify(marker)}) ? 0 : 1))`],
      cwd: root, timeoutMs: 5000,
    };
    const { identity, repositoryRoot } = await plannedExecution(database, root, 'fresh-evidence', conditional);
    await reportEnnoWork(database, {
      ...identity, expectedRevision: 2, idempotencyKey: 'fresh-work-1', workUnitId: 'repair',
      result: { outcome: 'completed', summary: 'Initial repair', mutated: true, changedPaths: ['src/add.js'] },
    });
    const failed = await finishEnno(database, {
      ...identity, expectedRevision: 2, idempotencyKey: 'fresh-finish-1',
      review: { decision: 'accept', summary: 'The implementation appears complete' },
    });
    assert.equal(failed.ennoOduno.status, 'zenki_planning');
    assert.equal(failed.ennoOduno.contractRevision, 3);
    assert.equal(failed.ennoOduno.currentRole, 'zenki');
    assert.equal(failed.ennoOduno.nextAction, 'submit_plan');
    assert.equal(failed.ennoOduno.directive?.workUnit, null);
    assert.ok(failed.ennoOduno.directive?.requiredSkills.includes('kiokuko-single-purpose-functions'));
    assert.match(failed.ennoOduno.directive?.objective ?? '', /review rejected contract revision 2/iu);
    assert.match(failed.ennoOduno.directive?.objective ?? '', /focused runnable test target/iu);
    assert.equal(failed.verifierResults?.[0]?.status, 'failed');

    const planningContinuation = decideAdapterContinuation(database, 'codex', {
      session_id: 'codex-fresh-evidence', cwd: root,
    });
    assert.equal(planningContinuation.continue, true);
    assert.equal(planningContinuation.directive?.role, 'zenki');
    await assert.rejects(reportEnnoWork(database, {
      ...identity, expectedRevision: 3, idempotencyKey: 'illegal-old-plan-resume', workUnitId: 'repair',
      result: { outcome: 'completed', summary: 'Old plan cannot resume', mutated: false, changedPaths: [] },
    }), /not in the required state/iu);

    const replanned = await submitEnnoPlan(database, {
      ...identity, expectedRevision: 3, idempotencyKey: 'fresh-replan',
      scope: ['src/add.js'], exclusions: [], acceptanceCriteria: [{ id: 'tests', description: 'tests pass' }],
      workPlan: { objective: 'Replan repair after Enno review', units: [{
        id: 'repair', objective: 'Repair the final verification failure', scope: ['src/add.js'], dependencies: [], skillNames: [],
        expertRefs: [{ id: 'code.verification.v1', reason: 'Address the failed final verifier with fresh evidence' }],
        acceptanceCriteria: ['tests pass'], focusedVerifiers: [],
      }] },
      skillRequirements: [], finalVerifiers: [{ ...conditional, cwd: repositoryRoot }], maxAttempts: 5,
      provenance: {
        scope: 'explicit_user', exclusions: 'explicit_user', acceptanceCriteria: 'explicit_user',
        workPlan: 'explicit_user', skillSet: 'explicit_user', finalVerifiers: 'explicit_user', maxAttempts: 'explicit_user',
      },
      capabilities,
    });
    assert.equal(replanned.ennoOduno.status, 'goki_executing');
    assert.equal(replanned.ennoOduno.contractRevision, 4);
    assert.equal(replanned.ennoOduno.currentRole, 'goki');

    await writeFile(marker, 'ready\n');
    await reportEnnoWork(database, {
      ...identity, expectedRevision: 4, idempotencyKey: 'fresh-work-2', workUnitId: 'repair',
      result: { outcome: 'completed', summary: 'Repaired final failure', mutated: true, changedPaths: ['src/add.js'] },
    });
    const passed = await finishEnno(database, {
      ...identity, expectedRevision: 4, idempotencyKey: 'fresh-finish-2',
      review: { decision: 'accept', summary: 'The revised plan satisfies every criterion' },
    });
    assert.equal(passed.ennoOduno.status, 'completed');
    const finalRuns = database.prepare(`
      SELECT contract_revision AS contractRevision, mutation_revision AS mutationRevision, status FROM enno_verifier_runs
      WHERE run_id = ? AND work_unit_id IS NULL ORDER BY started_at, verifier_run_id
    `).all<{ contractRevision: number; mutationRevision: number; status: string }>(identity.runId)
      .map((row) => ({ ...row }));
    assert.deepEqual(finalRuns, [
      { contractRevision: 2, mutationRevision: 1, status: 'failed' },
      { contractRevision: 4, mutationRevision: 2, status: 'passed' },
    ]);
    const workHistory = database.prepare(`
      SELECT contract_revision AS contractRevision, work_unit_id AS workUnitId, status
      FROM enno_work_units WHERE run_id = ? ORDER BY contract_revision
    `).all<{ contractRevision: number; workUnitId: string; status: string }>(identity.runId).map((row) => ({ ...row }));
    assert.deepEqual(workHistory, [
      { contractRevision: 2, workUnitId: 'repair', status: 'completed' },
      { contractRevision: 4, workUnitId: 'repair', status: 'completed' },
    ]);
    const loopEvents = database.prepare(`
      SELECT event_type AS eventType FROM ledger_events
      WHERE run_id = ? AND event_type IN (
        'enno.verification_failed', 'enno.replan_requested', 'zenki.plan_created',
        'goki.work_started', 'enno.review_accepted', 'enno.completed'
      ) ORDER BY sequence
    `).all<{ eventType: string }>(identity.runId).map((row) => row.eventType);
    assert.deepEqual(loopEvents, [
      'zenki.plan_created',
      'goki.work_started',
      'enno.verification_failed',
      'enno.replan_requested',
      'zenki.plan_created',
      'goki.work_started',
      'enno.review_accepted',
      'enno.completed',
    ]);
  } finally {
    database.close();
  }
});

test('Enno can reject passing verifier evidence and require Zenki to replan', async () => {
  const { root, database } = await fixture();
  try {
    const { identity } = await plannedExecution(database, root, 'review-rejects-pass', verifier(root, 'pass'));
    await reportEnnoWork(database, {
      ...identity, expectedRevision: 2, idempotencyKey: 'review-reject-work', workUnitId: 'repair',
      result: { outcome: 'completed', summary: 'Implemented the approved unit', mutated: true, changedPaths: ['src/add.js'] },
    });
    const rejected = await finishEnno(database, {
      ...identity, expectedRevision: 2, idempotencyKey: 'review-reject-finish',
      review: { decision: 'replan', summary: 'The public API acceptance criterion is not covered by the plan' },
    });
    assert.equal(rejected.verifierResults?.[0]?.status, 'passed');
    assert.equal(rejected.ennoOduno.status, 'zenki_planning');
    assert.equal(rejected.ennoOduno.contractRevision, 3);
    assert.equal(rejected.ennoOduno.directive?.role, 'zenki');
    assert.match(rejected.ennoOduno.directive?.objective ?? '', /public API acceptance criterion/iu);
    assert.equal(database.prepare(`
      SELECT COUNT(*) AS count FROM ledger_events
      WHERE run_id = ? AND event_type IN ('enno.review_accepted', 'enno.completed')
    `).get<{ count: number }>(identity.runId)?.count, 0);
    assert.deepEqual(database.prepare(`
      SELECT event_type AS eventType FROM ledger_events
      WHERE run_id = ? AND event_type IN ('enno.verification_passed', 'enno.replan_requested')
      ORDER BY sequence
    `).all<{ eventType: string }>(identity.runId).map((row) => row.eventType), [
      'enno.verification_passed',
      'enno.replan_requested',
    ]);
  } finally {
    database.close();
  }
});

test('spawn failure and continuation exhaustion fail closed into a durable blocked run', async () => {
  const first = await fixture();
  try {
    const unsafe = { ...verifier(first.root, 'missing'), executable: 'kiokuko-executable-that-does-not-exist' };
    const { identity } = await plannedExecution(first.database, first.root, 'spawn-failure', unsafe);
    await reportEnnoWork(first.database, {
      ...identity, expectedRevision: 2, idempotencyKey: 'spawn-work', workUnitId: 'repair',
      result: { outcome: 'completed', summary: 'Ready to verify', mutated: true, changedPaths: ['src/add.js'] },
    });
    const blocked = await finishEnno(first.database, {
      ...identity, expectedRevision: 2, idempotencyKey: 'spawn-finish',
      review: { decision: 'accept', summary: 'The work is ready for final verification' },
    });
    assert.equal(blocked.ennoOduno.status, 'blocked');
    assert.equal(blocked.verifierResults?.[0]?.status, 'spawn_failed');
    assert.equal(first.database.prepare('SELECT status FROM ledger_runs WHERE run_id = ?').get<{ status: string }>(identity.runId)?.status, 'failed');
  } finally {
    first.database.close();
  }

  const second = await fixture();
  try {
    const planned = await plannedExecution(second.database, second.root, 'continuation-limit', verifier(second.root, 'pass'), { maxAttempts: 1 });
    assert.equal(decideAdapterContinuation(second.database, 'codex', { session_id: planned.hostSessionId, cwd: second.root }).continue, true);
    const exhausted = decideAdapterContinuation(second.database, 'codex', { session_id: planned.hostSessionId, cwd: second.root });
    assert.equal(exhausted.continue, false);
    assert.equal(exhausted.status, 'blocked');
    assert.equal(second.database.prepare('SELECT status FROM enno_contracts WHERE run_id = ?').get<{ status: string }>(planned.identity.runId)?.status, 'blocked');
    assert.equal(second.database.prepare('SELECT status FROM ledger_runs WHERE run_id = ?').get<{ status: string }>(planned.identity.runId)?.status, 'failed');
  } finally {
    second.database.close();
  }
});

test('Claude returns control before its native eighth consecutive Stop block override', async () => {
  const { root, database } = await fixture();
  try {
    const planned = await plannedExecution(database, root, 'claude-stop-limit', verifier(root, 'pass'), {
      client: 'claude',
      maxAttempts: 20,
    });
    for (let count = 0; count < 7; count += 1) {
      assert.equal(decideAdapterContinuation(database, 'claude', {
        session_id: planned.hostSessionId,
        cwd: root,
      }).continue, true);
    }
    const returned = decideAdapterContinuation(database, 'claude', {
      session_id: planned.hostSessionId,
      cwd: root,
    });
    assert.equal(returned.continue, false);
    assert.equal(returned.status, 'blocked');
    assert.equal(database.prepare(`
      SELECT total_count AS totalCount FROM enno_client_continuations
      WHERE run_id = ? AND client_kind = 'claude'
    `).get<{ totalCount: number }>(planned.identity.runId)?.totalCount, 7);
    assert.equal(database.prepare('SELECT status FROM ledger_runs WHERE run_id = ?')
      .get<{ status: string }>(planned.identity.runId)?.status, 'failed');
  } finally {
    database.close();
  }
});

test('focused verifier process can write the same database because no transaction is held while it runs', async () => {
  const { root, databasePath, database } = await fixture();
  try {
    database.exec('CREATE TABLE enno_lock_probe (value TEXT NOT NULL)');
    const probe = {
      id: 'lock-probe', kind: 'test' as const, executable: process.execPath,
      args: ['--eval', `import('node:sqlite').then(({DatabaseSync}) => { const db = new DatabaseSync(${JSON.stringify(databasePath)}); db.exec("INSERT INTO enno_lock_probe VALUES ('ok')"); db.close(); })`],
      cwd: root, timeoutMs: 5000,
    };
    const { identity } = await plannedExecution(database, root, 'no-db-lock', verifier(root, 'final'), { focusedVerifiers: [probe] });
    const reported = await reportEnnoWork(database, {
      ...identity, expectedRevision: 2, idempotencyKey: 'lock-work', workUnitId: 'repair',
      result: { outcome: 'completed', summary: 'Run lock probe', mutated: false, changedPaths: [] },
    });
    assert.equal(reported.verifierResults?.[0]?.status, 'passed');
    assert.equal(database.prepare('SELECT COUNT(*) AS count FROM enno_lock_probe').get<{ count: number }>()?.count, 1);
  } finally {
    database.close();
  }
});
