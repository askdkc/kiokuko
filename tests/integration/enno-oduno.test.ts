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
import { canonicalJson } from '../../src/serialization/validate.js';
import {
  answerEnno,
  finishEnno,
  reportEnnoWork,
  submitEnnoPlan,
  submitOdunoIdeal,
  submitOdunoMeditation,
} from '../../src/enno-oduno/service.js';
import { readEnnoSnapshot } from '../../src/enno-oduno/store.js';
import { discoverSkills } from '../../src/skills/discovery-service.js';

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

function submitPreparedIdeal(
  database: ReturnType<typeof openConnection>,
  prepared: Awaited<ReturnType<typeof prepareAgentTask>>,
  idempotencyKey: string,
) {
  return submitOdunoIdeal(database, {
    runId: prepared.run.runId,
    workspace: prepared.project.workspace,
    orchestrationId: prepared.intake.sessionId,
    expectedRevision: 1,
    idempotencyKey,
    ideal: {
      objective: `Reach the optimal verified outcome for ${prepared.intake.profile.target ?? 'the requested task'}`,
      principles: ['Realize the task handoff while preserving every explicit constraint'],
      skillContributions: prepared.skillDiscovery.selected.map((skill) => ({
        skillName: skill.name,
        contribution: `Use ${skill.name} as reference-only guidance when shaping the optimal outcome`,
      })),
      successSignals: [prepared.intake.profile.expected ?? 'Every acceptance criterion is verified'],
    },
  });
}

function submitMeditation(
  database: ReturnType<typeof openConnection>,
  identity: { runId: string; workspace: string; orchestrationId: string },
  expectedRevision: number,
  idempotencyKey: string,
  deletionCandidates: Array<{
    kind: 'test' | 'function';
    path: string;
    name: string;
    reason: string;
    evidence: string[];
  }> = [],
) {
  return submitOdunoMeditation(database, {
    ...identity,
    expectedRevision,
    idempotencyKey,
    meditation: {
      summary: 'Inspected the realized ideal for obsolete tests and functions without mutating the repository',
      inspectedPaths: ['src/add.js'],
      deletionCandidates,
    },
  });
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
  const idealized = submitPreparedIdeal(database, prepared, `ideal-${requestId}`);
  assert.equal(idealized.ennoOduno.status, 'zenki_planning');
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
  return { identity, repositoryRoot, hostSessionId: sessionId, prepared, idealized };
}

test('task_prepare derives the Oduno ideal before handing the request to harness-specific Zenki', async () => {
  const { root, database } = await fixture();
  try {
    const planned = await plannedExecution(database, root, 'pending-client-binding', verifier(root, 'pass'), {
      client: 'opencode',
      clientIdentity: 'kind_only',
    });
    assert.equal(planned.prepared.ennoOduno.status, 'oduno_ideal');
    assert.equal(planned.prepared.ennoOduno.orchestrationId, planned.prepared.intake.sessionId);
    assert.deepEqual(planned.prepared.ennoOduno.clientBinding, {
      status: 'pending',
      clientKind: 'opencode',
      clientVersion: null,
      identified: true,
    });
    assert.equal(planned.prepared.ennoOduno.directive?.role, 'enno-oduno');
    assert.equal(planned.prepared.ennoOduno.directive?.handoff?.sourceRole, 'enno-oduno');
    assert.equal(planned.prepared.ennoOduno.directive?.handoff?.taskType, 'debug');
    assert.match(planned.prepared.ennoOduno.directive?.handoff?.objective ?? '', /src\/add\.js/u);
    assert.match(planned.prepared.ennoOduno.directive?.handoff?.objective ?? '', /tests pass/u);
    assert.equal(planned.prepared.ennoOduno.directive?.harness.kind, 'opencode');
    assert.equal(planned.prepared.ennoOduno.directive?.harness.continuation, 'session_idle_plugin');
    assert.equal(planned.prepared.ennoOduno.nextAction, 'submit_ideal');
    assert.match(planned.prepared.ennoOduno.directive?.objective ?? '', /optimal goal/iu);
    assert.equal(planned.idealized.ennoOduno.status, 'zenki_planning');
    assert.equal(planned.idealized.ennoOduno.directive?.role, 'zenki');
    assert.deepEqual(planned.prepared.ennoOduno.directive?.requiredSkills, [
      'kiokuko-soul',
      'kiokuko-enno-oduno',
    ]);
    assert.match(planned.idealized.ennoOduno.directive?.objective ?? '', /one cohesive externally observable function or use-case contract/iu);
    assert.match(planned.idealized.ennoOduno.directive?.objective ?? '', /focused runnable test target/iu);

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

test('Goki cannot start before Oduno derives the ideal and Zenki submits a plan', async () => {
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
    assert.equal(prepared.ennoOduno.status, 'oduno_ideal');
    assert.equal(prepared.ennoOduno.currentRole, 'enno-oduno');
    const planningContinuation = decideAdapterContinuation(database, 'codex', {
      session_id: 'codex-before-plan',
      cwd: root,
    });
    assert.equal(planningContinuation.continue, true);
    assert.equal(planningContinuation.directive?.role, 'enno-oduno');

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

    const idealized = submitPreparedIdeal(database, prepared, 'before-plan-ideal');
    assert.equal(idealized.ennoOduno.status, 'zenki_planning');
    assert.equal(idealized.ennoOduno.currentRole, 'zenki');
    assert.equal(decideAdapterContinuation(database, 'codex', {
      session_id: 'codex-before-plan',
      cwd: root,
    }).directive?.role, 'zenki');

    assert.equal(database.prepare(`
      SELECT COUNT(*) AS count FROM ledger_events
      WHERE run_id = ? AND event_type LIKE 'goki.%'
    `).get<{ count: number }>(prepared.run.runId)?.count, 0);
  } finally {
    database.close();
  }
});

test('persisted WorkUnits validate the complete dependency graph during read-back', async () => {
  const { root, database } = await fixture();
  try {
    const prepared = await prepareAgentTask(database, {
      requestId: 'stored-work-unit-dependencies', cwd: root, task: 'Build a dependent module pair',
      profileHints: { taskType: 'debug', target: 'src/prepare.js', expected: 'tests pass', constraints: null },
      capabilities, client: { kind: 'codex', sessionId: 'codex-stored-dependencies' }, skillDiscoveryMode: 'off',
    });
    const identity = {
      runId: prepared.run.runId,
      workspace: prepared.project.workspace,
      orchestrationId: prepared.intake.sessionId,
    };
    submitPreparedIdeal(database, prepared, 'stored-dependencies-ideal');
    const planned = await submitEnnoPlan(database, {
      ...identity,
      expectedRevision: 1,
      idempotencyKey: 'stored-dependencies-plan',
      scope: ['src/prepare.js', 'src/finalize.js'],
      exclusions: [],
      acceptanceCriteria: [{ id: 'tests', description: 'tests pass' }],
      workPlan: {
        objective: 'Build the dependent module pair',
        units: [
          {
            id: 'prepare', objective: 'Prepare the shared module', scope: ['src/prepare.js'], dependencies: [], skillNames: [],
            expertRefs: [{ id: 'code.domain.v1', reason: 'Keep the prerequisite module contract deterministic' }],
            acceptanceCriteria: ['tests pass'], focusedVerifiers: [],
          },
          {
            id: 'finalize', objective: 'Finalize the dependent module', scope: ['src/finalize.js'], dependencies: ['prepare'], skillNames: [],
            expertRefs: [{ id: 'code.verification.v1', reason: 'Verify the dependent module after its prerequisite completes' }],
            acceptanceCriteria: ['tests pass'], focusedVerifiers: [],
          },
        ],
      },
      skillRequirements: [],
      finalVerifiers: [verifier(prepared.project.repositoryRoot, 'stored-dependencies-final')],
      maxAttempts: 3,
      provenance: {
        scope: 'explicit_user', exclusions: 'explicit_user', acceptanceCriteria: 'explicit_user',
        workPlan: 'explicit_user', skillSet: 'explicit_user', finalVerifiers: 'explicit_user', maxAttempts: 'explicit_user',
      },
      capabilities,
    });
    assert.equal(planned.ennoOduno.status, 'goki_executing');
    const snapshot = readEnnoSnapshot(database, identity);
    assert.deepEqual(snapshot.workUnits.map((unit) => ({
      id: unit.workUnit.id,
      dependencies: unit.workUnit.dependencies,
      status: unit.status,
    })), [
      { id: 'prepare', dependencies: [], status: 'in_progress' },
      { id: 'finalize', dependencies: ['prepare'], status: 'pending' },
    ]);
  } finally {
    database.close();
  }
});

test('Zenki discovery uses a new plan digest and only the remaining run budget after replanning', async () => {
  const { root, database } = await fixture();
  try {
    await writeFile(path.join(root, 'package.json'), JSON.stringify({ dependencies: { svelte: '^5.0.0' } }));
    const discoveryCapabilities = [
      ...capabilities,
      { kind: 'skill', name: 'memory-reasoning' },
      { kind: 'skill', name: 'svelte' },
    ];
    const prepared = await prepareAgentTask(database, {
      requestId: 'zenki-discovery-budget', cwd: root, task: 'Repair a Svelte component',
      profileHints: { taskType: 'debug', target: 'src/component.ts', expected: 'tests pass', constraints: null },
      capabilities: discoveryCapabilities, client: { kind: 'codex', sessionId: 'codex-zenki-discovery-budget' },
      skillDiscoveryMode: 'official',
    });
    const identity = {
      runId: prepared.run.runId,
      workspace: prepared.project.workspace,
      orchestrationId: prepared.intake.sessionId,
    };
    submitPreparedIdeal(database, prepared, 'zenki-discovery-budget-ideal');
    const calls: Array<{ maxQueries: number | undefined; maxSelectedSkills: number | undefined; task: string }> = [];
    const discover = async (_database: Parameters<typeof discoverSkills>[0], input: Parameters<typeof discoverSkills>[1]) => {
      calls.push({ maxQueries: input.maxQueries, maxSelectedSkills: input.maxSelectedSkills, task: input.task });
      return {
        attempted: true,
        mode: input.mode,
        requirements: ['svelte'],
        queries: calls.length === 1 ? ['svelte'] : ['svelte', 'svelte debug'],
        cacheHits: 0,
        candidates: 0,
        selected: [],
        failures: [],
      };
    };
    const planInput = (expectedRevision: number, idempotencyKey: string, objective: string) => ({
      ...identity,
      expectedRevision,
      idempotencyKey,
      scope: ['src/component.ts'],
      exclusions: [],
      acceptanceCriteria: [{ id: 'tests', description: 'tests pass' }],
      workPlan: { objective, units: [{
        id: 'repair', objective: 'Repair the Svelte component', scope: ['src/component.ts'], dependencies: [], skillNames: [],
        expertRefs: [{ id: 'code.verification.v1', reason: 'Verify each replanned component repair with focused evidence' }],
        acceptanceCriteria: ['tests pass'], focusedVerifiers: [],
      }] },
      skillRequirements: [],
      finalVerifiers: [verifier(prepared.project.repositoryRoot, 'zenki-discovery-final')],
      maxAttempts: 5,
      provenance: {
        scope: 'explicit_user', exclusions: 'explicit_user', acceptanceCriteria: 'explicit_user',
        workPlan: 'explicit_user', skillSet: 'explicit_user', finalVerifiers: 'explicit_user', maxAttempts: 'explicit_user',
      },
      capabilities: discoveryCapabilities,
    });

    const firstPlan = await submitEnnoPlan(database, planInput(1, 'zenki-discovery-plan-1', 'Repair the first component plan'), {
      discoverSkills: discover,
    });
    assert.equal(firstPlan.ennoOduno.status, 'goki_executing');
    assert.deepEqual(calls[0], {
      maxQueries: 3,
      maxSelectedSkills: 2,
      task: 'Repair a Svelte component\nRepair the first component plan',
    });
    await reportEnnoWork(database, {
      ...identity,
      expectedRevision: 2,
      idempotencyKey: 'zenki-discovery-work-1',
      workUnitId: 'repair',
      result: { outcome: 'completed', summary: 'Initial component repair', mutated: false, changedPaths: [] },
    });
    const replanning = await finishEnno(database, {
      ...identity,
      expectedRevision: 2,
      idempotencyKey: 'zenki-discovery-replan-review',
      review: { decision: 'replan', summary: 'Use a narrower component plan' },
    });
    assert.equal(replanning.ennoOduno.status, 'zenki_planning');
    assert.equal(replanning.ennoOduno.contractRevision, 3);

    const secondPlan = await submitEnnoPlan(database, planInput(3, 'zenki-discovery-plan-2', 'Repair the narrower component plan'), {
      discoverSkills: discover,
    });
    assert.equal(secondPlan.ennoOduno.status, 'goki_executing');
    assert.deepEqual(calls.map((call) => ({ maxQueries: call.maxQueries, maxSelectedSkills: call.maxSelectedSkills })), [
      { maxQueries: 3, maxSelectedSkills: 2 },
      { maxQueries: 2, maxSelectedSkills: 2 },
    ]);
    const attempts = database.prepare(`
      SELECT phase, request_digest AS requestDigest,
             reserved_query_count AS reservedQueries, consumed_query_count AS consumedQueries,
             reserved_selection_count AS reservedSelections, consumed_selection_count AS consumedSelections
      FROM agent_task_skill_discovery_attempts WHERE run_id = ? ORDER BY rowid
    `).all<{ phase: string; requestDigest: string; reservedQueries: number; consumedQueries: number; reservedSelections: number; consumedSelections: number }>(identity.runId)
      .map((row) => ({ ...row }));
    assert.equal(attempts.length, 3);
    const zenkiAttempts = attempts.filter((attempt) => attempt.phase === 'zenki');
    assert.equal(zenkiAttempts.length, 2);
    assert.notEqual(zenkiAttempts[0]?.requestDigest, zenkiAttempts[1]?.requestDigest);
    assert.deepEqual(zenkiAttempts.map(({ phase: _phase, requestDigest: _digest, ...budget }) => budget), [
      { reservedQueries: 3, consumedQueries: 1, reservedSelections: 2, consumedSelections: 0 },
      { reservedQueries: 2, consumedQueries: 2, reservedSelections: 2, consumedSelections: 0 },
    ]);
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
    submitPreparedIdeal(database, prepared, 'missing-expert-ideal');
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

test('Oduno ideal requires one contribution for every Akinator-discovered Skill before Zenki starts', async () => {
  const { root, database } = await fixture();
  try {
    const prepared = await prepareAgentTask(database, {
      requestId: 'ideal-skill-coverage', cwd: root, task: 'Repair the add function with discovered guidance',
      profileHints: { taskType: 'debug', target: 'src/add.js', expected: 'tests pass', constraints: null },
      capabilities, client: { kind: 'codex', sessionId: 'codex-ideal-coverage' }, skillDiscoveryMode: 'off',
    });
    const discovered = {
      ...prepared.skillDiscovery,
      attempted: true,
      selected: [{
        skillId: 'external-skill-1',
        name: 'external-debug-reference',
        source: 'official-catalog',
        officialStatus: 'catalog-verified' as const,
        imported: false,
        updated: false,
      }],
    };
    const stored = database.prepare('SELECT contract_json AS contractJson FROM enno_contracts WHERE run_id = ?')
      .get<{ contractJson: string }>(prepared.run.runId);
    assert.ok(stored);
    const contract = JSON.parse(stored.contractJson) as { skillSet: { intakeDiscovery: unknown } };
    contract.skillSet.intakeDiscovery = discovered;
    database.prepare('UPDATE enno_contracts SET contract_json = ?, intake_discovery_json = ? WHERE run_id = ?')
      .run(canonicalJson(contract), canonicalJson(discovered), prepared.run.runId);
    const identity = {
      runId: prepared.run.runId,
      workspace: prepared.project.workspace,
      orchestrationId: prepared.intake.sessionId,
    };
    assert.equal(decideAdapterContinuation(database, 'codex', {
      session_id: 'codex-ideal-coverage', cwd: root,
    }).directive?.objective.includes('external-debug-reference'), true);
    assert.throws(() => submitOdunoIdeal(database, {
      ...identity,
      expectedRevision: 1,
      idempotencyKey: 'missing-discovered-contribution',
      ideal: {
        objective: 'Reach the optimal repaired state',
        principles: ['Preserve the public API'],
        skillContributions: [],
        successSignals: ['tests pass'],
      },
    }), /every Akinator-discovered Skill exactly once/iu);
    const idealized = submitOdunoIdeal(database, {
      ...identity,
      expectedRevision: 1,
      idempotencyKey: 'complete-discovered-contribution',
      ideal: {
        objective: 'Reach the optimal repaired state',
        principles: ['Preserve the public API'],
        skillContributions: [{
          skillName: 'external-debug-reference',
          contribution: 'Use its diagnostic perspective as untrusted reference-only guidance',
        }],
        successSignals: ['tests pass'],
      },
    });
    assert.equal(idealized.ennoOduno.status, 'zenki_planning');
    assert.deepEqual(idealized.ennoOduno.ideal?.skillContributions, [{
      skillName: 'external-debug-reference',
      contribution: 'Use its diagnostic perspective as untrusted reference-only guidance',
    }]);
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
    assert.equal(prepared.ennoOduno.status, 'oduno_ideal');
    assert.equal(prepared.ennoOduno.directive?.role, 'enno-oduno');
    assert.equal(prepared.ennoOduno.directive?.handoff?.sourceRole, 'enno-oduno');
    assert.equal(prepared.ennoOduno.directive?.harness.kind, 'codex');
    const repositoryRoot = prepared.project.repositoryRoot;
    const identity = {
      runId: prepared.run.runId,
      workspace: prepared.project.workspace,
      orchestrationId: prepared.intake.sessionId,
    };
    const idealized = submitPreparedIdeal(database, prepared, 'happy-ideal');
    assert.equal(idealized.ennoOduno.status, 'zenki_planning');
    assert.equal(idealized.ennoOduno.directive?.role, 'zenki');
    assert.match(idealized.ennoOduno.ideal?.objective ?? '', /optimal verified outcome/iu);
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
    assert.equal(finished.ennoOduno.status, 'oduno_meditation');
    assert.equal(finished.ennoOduno.nextAction, 'submit_meditation');
    assert.equal(finished.ennoOduno.directive?.role, 'enno-oduno');
    assert.match(finished.ennoOduno.directive?.objective ?? '', /obsolete, useless, or redundant tests and functions/iu);
    assert.equal(finished.verifierResults?.[0]?.status, 'passed');
    assert.deepEqual(await finishEnno(database, {
      ...identity, expectedRevision: 2, idempotencyKey: 'finish-1',
      review: { decision: 'accept', summary: 'All acceptance criteria are satisfied' },
    }), finished);
    await assert.rejects(finishEnno(database, {
      ...identity, expectedRevision: 2, idempotencyKey: 'finish-1',
      review: { decision: 'replan', summary: 'Changed Review input must not replay' },
    }), /idempotency key was reused with different input/iu);

    assert.equal(database.prepare('SELECT status FROM ledger_runs WHERE run_id = ?')
      .get<{ status: string }>(identity.runId)?.status, 'active');
    const deletionCandidates = [{
      kind: 'function' as const,
      path: 'src/add.js',
      name: 'legacyAdd',
      reason: 'The verified implementation supersedes this unused compatibility helper',
      evidence: ['No approved WorkUnit or verifier depends on legacyAdd'],
    }];
    const meditated = submitMeditation(database, identity, 2, 'meditation-1', deletionCandidates);
    assert.equal(meditated.ennoOduno.status, 'completed');
    assert.deepEqual(meditated.ennoOduno.meditation?.deletionCandidates, deletionCandidates);
    assert.deepEqual(submitMeditation(database, identity, 2, 'meditation-1', deletionCandidates), meditated);
    assert.equal(database.prepare('SELECT status FROM ledger_runs WHERE run_id = ?')
      .get<{ status: string }>(identity.runId)?.status, 'completed');

    const events = database.prepare(`
      SELECT event_type AS eventType FROM ledger_events
      WHERE run_id = ? AND (
        event_type LIKE 'enno.%' OR event_type LIKE 'oduno.%'
        OR event_type LIKE 'zenki.%' OR event_type LIKE 'goki.%'
      )
      ORDER BY sequence
    `).all<{ eventType: string }>(identity.runId).map((row) => row.eventType);
    assert.deepEqual(events, [
      'enno.started',
      'oduno.ideal_derived',
      'zenki.plan_created',
      'enno.plan_confirmed',
      'goki.work_started',
      'goki.work_completed',
      'enno.review_started',
      'enno.verification_started',
      'enno.verification_passed',
      'enno.review_accepted',
      'oduno.meditation_completed',
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

function confirmationProjectionPlanInput(
  identity: { runId: string; workspace: string; orchestrationId: string },
  repositoryRoot: string,
  idempotencyKey: string,
  objective: string,
  provenance: Record<'scope' | 'exclusions' | 'acceptanceCriteria' | 'workPlan' | 'skillSet' | 'finalVerifiers' | 'maxAttempts', 'explicit_user' | 'repository_evidence' | 'inferred'>,
) {
  return {
    ...identity, expectedRevision: 1, idempotencyKey,
    scope: ['src/add.js'], exclusions: [],
    acceptanceCriteria: [{ id: 'tests', description: 'node --test passes' }],
    workPlan: { objective, units: [{
      id: 'repair-add', objective: 'Repair the add implementation', scope: ['src/add.js'], dependencies: [],
      skillNames: ['kiokuko-single-purpose-functions'],
      expertRefs: [{ id: 'code.verification.v1', reason: 'Prove the add regression with focused tests' }],
      acceptanceCriteria: ['node --test passes'],
      focusedVerifiers: [verifier(repositoryRoot, 'focused-test')],
    }] },
    skillRequirements: [],
    finalVerifiers: [verifier(repositoryRoot, 'final-test')], maxAttempts: 5,
    provenance,
    capabilities,
  };
}

test('a needs_confirmation plan presents a complete user-facing confirmation projection', async () => {
  const { root, database } = await fixture();
  try {
    const prepared = await prepareAgentTask(database, {
      requestId: 'confirmation-projection', cwd: root, task: 'Repair the add function',
      profileHints: { taskType: 'debug', target: 'src/add.js', expected: 'tests pass', constraints: null },
      capabilities, client: { kind: 'codex', sessionId: 'codex-confirmation' }, skillDiscoveryMode: 'off',
    });
    const repositoryRoot = prepared.project.repositoryRoot;
    const identity = { runId: prepared.run.runId, workspace: prepared.project.workspace, orchestrationId: prepared.intake.sessionId };
    submitPreparedIdeal(database, prepared, 'projection-ideal');
    const plan = await submitEnnoPlan(database, confirmationProjectionPlanInput(
      identity, repositoryRoot, 'projection-plan-1', 'Repair add behind the confirmation',
      {
        scope: 'explicit_user', exclusions: 'explicit_user', acceptanceCriteria: 'explicit_user',
        workPlan: 'inferred', skillSet: 'repository_evidence', finalVerifiers: 'explicit_user', maxAttempts: 'inferred',
      },
    ));
    assert.equal(plan.ennoOduno.status, 'needs_confirmation');
    assert.equal(plan.ennoOduno.nextAction, 'ask_user_confirmation');
    assert.match(plan.ennoOduno.directive?.objective ?? '', /Return every item in userFacingConfirmation to the user in the user's language/iu);
    assert.deepEqual(plan.ennoOduno.directive?.reportSchema.required, ['runId', 'expectedRevision', 'idempotencyKey', 'action']);
    const projection = plan.ennoOduno.directive?.userFacingConfirmation;
    assert.ok(projection !== undefined);
    assert.equal(projection.presentationVersion, 1);
    assert.deepEqual(projection.actions, ['approve', 'revise', 'cancel']);
    assert.deepEqual(projection.summary, { basis: 'proposal', text: 'Repair add behind the confirmation' });
    assert.deepEqual(projection.scope, { basis: 'user', paths: ['src/add.js'] });
    assert.deepEqual(projection.exclusions, { basis: 'user', paths: [] });
    assert.deepEqual(projection.completion, { basis: 'user', items: ['node --test passes'] });
    assert.equal(projection.workItems.length, 1);
    assert.equal(projection.workItems[0]?.number, 1);
    assert.equal(projection.workItems[0]?.summary, 'Repair the add implementation');
    assert.deepEqual(projection.workItems[0]?.dependsOn, []);
    assert.deepEqual(projection.workItems[0]?.expertise, [{
      area: 'Regression prevention and verification design', basis: 'proposal', reason: 'Prove the add regression with focused tests',
    }]);
    assert.deepEqual(projection.workItems[0]?.checks, [{
      category: 'test', executable: process.execPath, arguments: ['--eval', 'process.exit(0)'], directory: '.', timeoutMs: 5000,
    }]);
    assert.deepEqual(projection.finalChecks.checks[0]?.directory, '.');
    assert.deepEqual(projection.attemptLimit, { basis: 'proposal', maxAttempts: 5 });
    assert.equal(projection.skills.every((skill) => skill.referenceOnly === false), true);
    const rendered = JSON.stringify(projection);
    for (const forbidden of [
      'repair-add', 'focused-test', 'final-test', 'code.verification.v1',
      'WorkUnit', 'workPlan', 'expertRefs', 'focusedVerifiers', 'finalVerifiers',
      'workUnitId', 'skillNames', 'acceptanceCriteria', 'provenance',
    ]) {
      assert.equal(rendered.includes(forbidden), false, `projection leaked internal token: ${forbidden}`);
    }

    const replay = await submitEnnoPlan(database, confirmationProjectionPlanInput(
      identity, repositoryRoot, 'projection-plan-1', 'Repair add behind the confirmation',
      {
        scope: 'explicit_user', exclusions: 'explicit_user', acceptanceCriteria: 'explicit_user',
        workPlan: 'inferred', skillSet: 'repository_evidence', finalVerifiers: 'explicit_user', maxAttempts: 'inferred',
      },
    ));
    assert.deepEqual(replay, plan);

    const stale = answerEnno(database, {
      ...identity, expectedRevision: 2, idempotencyKey: 'projection-stale-approve', action: 'approve',
    });
    assert.throws(() => answerEnno(database, {
      ...identity, expectedRevision: 99, idempotencyKey: 'projection-older-approve', action: 'approve',
    }), /revision changed/iu);
    assert.equal(stale.ennoOduno.status, 'goki_executing');
    assert.equal('userFacingConfirmation' in (stale.ennoOduno.directive ?? {}), false);
  } finally {
    database.close();
  }
});

test('revise returns to Zenki for a fresh projection and cancel terminates without one', async () => {
  const { root, database } = await fixture();
  try {
    const prepared = await prepareAgentTask(database, {
      requestId: 'confirmation-revise-cancel', cwd: root, task: 'Repair the add function',
      profileHints: { taskType: 'debug', target: 'src/add.js', expected: 'tests pass', constraints: null },
      capabilities, client: { kind: 'codex', sessionId: 'codex-revision' }, skillDiscoveryMode: 'off',
    });
    const repositoryRoot = prepared.project.repositoryRoot;
    const identity = { runId: prepared.run.runId, workspace: prepared.project.workspace, orchestrationId: prepared.intake.sessionId };
    submitPreparedIdeal(database, prepared, 'revision-ideal');
    const provenance = {
      scope: 'explicit_user', exclusions: 'explicit_user', acceptanceCriteria: 'explicit_user',
      workPlan: 'inferred', skillSet: 'repository_evidence', finalVerifiers: 'explicit_user', maxAttempts: 'inferred',
    } as const;
    await submitEnnoPlan(database, confirmationProjectionPlanInput(
      identity, repositoryRoot, 'revision-plan-1', 'Repair add behind the confirmation', provenance,
    ));
    const revised = answerEnno(database, {
      ...identity, expectedRevision: 2, idempotencyKey: 'revision-revise', action: 'revise',
      requestedChanges: 'Narrow the plan to the add regression only',
    });
    assert.equal(revised.ennoOduno.status, 'zenki_planning');
    assert.equal(revised.ennoOduno.contractRevision, 3);
    assert.equal('userFacingConfirmation' in (revised.ennoOduno.directive ?? {}), false);
    const replanned = await submitEnnoPlan(database, {
      ...confirmationProjectionPlanInput(identity, repositoryRoot, 'revision-plan-2', 'Repair add with a narrower scope', provenance),
      expectedRevision: 3,
    });
    assert.equal(replanned.ennoOduno.status, 'needs_confirmation');
    assert.equal(replanned.ennoOduno.contractRevision, 4);
    assert.equal(replanned.ennoOduno.directive?.userFacingConfirmation?.summary.text, 'Repair add with a narrower scope');
    const cancelled = answerEnno(database, {
      ...identity, expectedRevision: 4, idempotencyKey: 'revision-cancel', action: 'cancel',
    });
    assert.equal(cancelled.ennoOduno.status, 'cancelled');
    assert.equal(cancelled.ennoOduno.directive, null);
  } finally {
    database.close();
  }
});

test('an all-explicit plan skips confirmation and carries no projection', async () => {
  const { root, database } = await fixture();
  try {
    const prepared = await prepareAgentTask(database, {
      requestId: 'explicit-skips-confirmation', cwd: root, task: 'Repair the add function',
      profileHints: { taskType: 'debug', target: 'src/add.js', expected: 'tests pass', constraints: null },
      capabilities, client: { kind: 'codex', sessionId: 'codex-explicit' }, skillDiscoveryMode: 'off',
    });
    const repositoryRoot = prepared.project.repositoryRoot;
    const identity = { runId: prepared.run.runId, workspace: prepared.project.workspace, orchestrationId: prepared.intake.sessionId };
    submitPreparedIdeal(database, prepared, 'explicit-ideal');
    const plan = await submitEnnoPlan(database, confirmationProjectionPlanInput(
      identity, repositoryRoot, 'explicit-plan-1', 'Repair add without confirmation',
      {
        scope: 'explicit_user', exclusions: 'explicit_user', acceptanceCriteria: 'explicit_user',
        workPlan: 'explicit_user', skillSet: 'explicit_user', finalVerifiers: 'explicit_user', maxAttempts: 'explicit_user',
      },
    ));
    assert.equal(plan.ennoOduno.status, 'goki_executing');
    assert.equal('userFacingConfirmation' in (plan.ennoOduno.directive ?? {}), false);
  } finally {
    database.close();
  }
});

test('a pre-migration active run without an Oduno ideal keeps its legacy completion path', async () => {
  const { root, database } = await fixture();
  try {
    const prepared = await prepareAgentTask(database, {
      requestId: 'legacy-active-run', cwd: root, task: 'Repair a legacy active run',
      profileHints: { taskType: 'debug', target: 'src/add.js', expected: 'tests pass', constraints: null },
      capabilities, client: { kind: 'codex', sessionId: 'codex-legacy-active' }, skillDiscoveryMode: 'off',
    });
    database.prepare('UPDATE enno_contracts SET phase = NULL WHERE run_id = ?').run(prepared.run.runId);
    const identity = {
      runId: prepared.run.runId,
      workspace: prepared.project.workspace,
      orchestrationId: prepared.intake.sessionId,
    };
    const planned = await submitEnnoPlan(database, {
      ...identity, expectedRevision: 1, idempotencyKey: 'legacy-plan',
      scope: ['src/add.js'], exclusions: [], acceptanceCriteria: [{ id: 'tests', description: 'tests pass' }],
      workPlan: { objective: 'Repair the legacy run', units: [{
        id: 'repair', objective: 'Repair add', scope: ['src/add.js'], dependencies: [], skillNames: [],
        expertRefs: [{ id: 'code.verification.v1', reason: 'Verify the legacy repair through its matching test' }],
        acceptanceCriteria: ['tests pass'], focusedVerifiers: [],
      }] },
      skillRequirements: [], finalVerifiers: [verifier(prepared.project.repositoryRoot, 'legacy-final')], maxAttempts: 3,
      provenance: {
        scope: 'explicit_user', exclusions: 'explicit_user', acceptanceCriteria: 'explicit_user',
        workPlan: 'explicit_user', skillSet: 'explicit_user', finalVerifiers: 'explicit_user', maxAttempts: 'explicit_user',
      },
      capabilities,
    });
    assert.equal(planned.ennoOduno.status, 'goki_executing');
    await reportEnnoWork(database, {
      ...identity, expectedRevision: 2, idempotencyKey: 'legacy-work', workUnitId: 'repair',
      result: { outcome: 'completed', summary: 'Repaired legacy run', mutated: true, changedPaths: ['src/add.js'] },
    });
    const finished = await finishEnno(database, {
      ...identity, expectedRevision: 2, idempotencyKey: 'legacy-finish',
      review: { decision: 'accept', summary: 'Legacy run meets its contract' },
    });
    assert.equal(finished.ennoOduno.status, 'completed');
    assert.equal(finished.ennoOduno.ideal, null);
    assert.equal(finished.ennoOduno.meditation, null);
    assert.equal(database.prepare('SELECT status FROM ledger_runs WHERE run_id = ?')
      .get<{ status: string }>(identity.runId)?.status, 'completed');
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
    submitPreparedIdeal(database, prepared, 'code-ui-ideal');
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
    submitPreparedIdeal(database, prepared, 'missing-soul-ideal');
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
    assert.equal(passed.ennoOduno.status, 'oduno_meditation');
    const completed = submitMeditation(database, identity, 4, 'fresh-meditation');
    assert.equal(completed.ennoOduno.status, 'completed');
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
