import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  identifyEnnoClientKind,
  resolveTaskPrepareClient,
} from '../../src/enno-oduno/harness.js';
import { generateRoleDirective, parseRoleJson } from '../../src/enno-oduno/role-runner.js';
import { runVerifier } from '../../src/enno-oduno/verifier.js';
import { assertWorkPlanExpertCoverage } from '../../src/enno-oduno/experts.js';
import {
  completeRequiredSkillList,
  orderedUniqueSkillNames,
  unavailableRequiredSkills,
} from '../../src/enno-oduno/skills.js';
import { parsePlanSubmission } from '../../src/enno-oduno/schemas.js';
import type { EnnoRequestHandoff } from '../../src/enno-oduno/types.js';

function requestHandoff(taskType: EnnoRequestHandoff['taskType']): EnnoRequestHandoff {
  return {
    sourceRole: 'enno-oduno',
    taskType,
    objective: taskType === 'debug' ? 'Repair the add function' : 'Build the requested change',
    target: 'src/add.js',
    expected: 'Tests pass',
    constraints: ['Keep the public API'],
    verification: ['Run the focused and final test verifiers'],
    stopConditions: ['Stop if the requested scope is unsafe'],
  };
}

test('role scripts reject revision conflicts and generate only the role owning the state', () => {
  const contract = {
    revision: 2,
    scope: ['src/add.js'],
    exclusions: [],
    acceptanceCriteria: [{ id: 'tests', description: 'Tests pass' }],
    workPlan: {
      objective: 'Fix add',
      units: [{
        id: 'fix-add', objective: 'Fix add', scope: ['src/add.js'], dependencies: [],
        skillNames: ['kiokuko-single-purpose-functions'], acceptanceCriteria: ['Tests pass'], focusedVerifiers: [],
      }],
    },
    skillSet: {
      entries: [{
        name: 'kiokuko-single-purpose-functions', purposes: ['implementation'], required: true,
        availability: 'local', referenceId: null,
      }],
      intakeDiscovery: { attempted: false, mode: 'off', requirements: [], queries: [], cacheHits: 0, candidates: 0, selected: [], failures: [] },
      zenkiDiscovery: { attempted: false, mode: 'off', requirements: [], queries: [], cacheHits: 0, candidates: 0, selected: [], failures: [] },
    },
    finalVerifiers: [{ id: 'test', kind: 'test', executable: process.execPath, args: ['--eval', 'process.exit(0)'], cwd: process.cwd(), timeoutMs: 1000 }],
    maxAttempts: 8,
    provenance: {
      scope: 'explicit_user', exclusions: 'explicit_user', acceptanceCriteria: 'explicit_user',
      workPlan: 'explicit_user', skillSet: 'explicit_user', finalVerifiers: 'explicit_user', maxAttempts: 'explicit_user',
    },
  };
  const input = {
    runId: 'run-1', taskType: 'debug', status: 'goki_executing', contractRevision: 2,
    clientKind: 'codex', clientVersion: '1.0.0',
    contract, handoff: requestHandoff('debug'),
    workUnits: [{ workUnit: contract.workPlan.units[0], status: 'in_progress', attemptCount: 0, result: null }],
  };
  const directive = generateRoleDirective('goki', input);
  assert.equal(directive.role, 'goki');
  assert.equal(directive.workUnit?.id, 'fix-add');
  assert.equal(directive.handoff?.sourceRole, 'enno-oduno');
  assert.equal(directive.harness.kind, 'codex');
  assert.equal(directive.harness.continuation, 'stop_hook');
  assert.match(directive.objective, /^Orchestrate the approved WorkUnit:/u);
  assert.deepEqual(directive.requiredSkills, [
    'kiokuko-soul',
    'kiokuko-single-purpose-functions',
  ]);
  assert.throws(() => generateRoleDirective('zenki', input), /does not own/iu);
  assert.throws(() => generateRoleDirective('goki', { ...input, contractRevision: 1 }), /revision mismatch/iu);
  const review = generateRoleDirective('enno-oduno', {
    ...input,
    status: 'enno_verifying',
    workUnits: [{ ...input.workUnits[0], status: 'completed' }],
  });
  assert.match(review.objective, /Review the completed Goki work/u);
  assert.deepEqual(review.requiredSkills, [
    'kiokuko-soul',
    'kiokuko-enno-oduno',
    'kiokuko-single-purpose-functions',
  ]);
  assert.ok(review.harness.instructions.some((instruction) => /Read and apply kiokuko-soul first, then kiokuko-enno-oduno/u.test(instruction)));
  assert.deepEqual(review.reportSchema.required, ['runId', 'expectedRevision', 'review']);
  assert.throws(() => parseRoleJson(Buffer.from('{"x":1,"x":2}')), /strict JSON/iu);
});

test('Zenki directive binds Akinator, repository, local capability, and reference-only Skill context', () => {
  const discovery = { attempted: false, mode: 'off', requirements: [], queries: [], cacheHits: 0, candidates: 0, selected: [], failures: [] };
  const directive = generateRoleDirective('zenki', {
    runId: 'planning', taskType: 'build', status: 'zenki_planning', contractRevision: 1,
    clientKind: 'opencode', clientVersion: '0.13.0',
    contract: {
      revision: 1, scope: ['src/App.tsx'], exclusions: [], acceptanceCriteria: [],
      workPlan: { objective: 'Plan the UI', units: [] },
      skillSet: { entries: [], intakeDiscovery: discovery, zenkiDiscovery: discovery },
      finalVerifiers: [], maxAttempts: 8,
      provenance: {
        scope: 'inferred', exclusions: 'inferred', acceptanceCriteria: 'inferred', workPlan: 'inferred',
        skillSet: 'inferred', finalVerifiers: 'inferred', maxAttempts: 'inferred',
      },
    },
    handoff: requestHandoff('build'),
    workUnits: [],
    akinatorProfile: { taskType: 'build', target: 'React settings panel', expected: 'Accessible tests pass', constraints: 'Keep the API' },
    repositoryFingerprint: { languages: ['TypeScript'], frameworks: [{ name: 'React', version: '19' }], databases: [], runtimes: ['Node.js'], tools: ['Vitest'] },
    capabilityCatalog: [{ kind: 'skill', name: 'kiokuko-ui-design-soul' }],
    discoveredSkills: [{ name: 'external-react-reference', source: 'official-catalog' }],
  });
  assert.match(directive.objective, /React settings panel/u);
  assert.match(directive.objective, /React@19/u);
  assert.match(directive.objective, /kiokuko-ui-design-soul/u);
  assert.match(directive.objective, /external-react-reference/u);
  assert.match(directive.objective, /reference-only/u);
  assert.match(directive.objective, /compact kiokuko-single-purpose-functions index/iu);
  assert.match(directive.objective, /one cohesive externally observable function or use-case contract/iu);
  assert.match(directive.objective, /focused runnable test target/iu);
  assert.match(directive.objective, /without meaningless micro-functions/iu);
  assert.match(directive.objective, /one to three versioned expertRefs/iu);
  assert.deepEqual(directive.requiredSkills, [
    'kiokuko-soul',
    'kiokuko-single-purpose-functions',
  ]);
  assert.ok(directive.harness.instructions.some((instruction) => /read and apply kiokuko-soul first/iu.test(instruction)));
  assert.ok(directive.stopConditions.some((condition) => /one cohesive function or use-case contract/iu.test(condition)));
  assert.equal(directive.handoff?.sourceRole, 'enno-oduno');
  assert.equal(directive.harness.kind, 'opencode');
  assert.equal(directive.harness.continuation, 'session_idle_plugin');
});

test('work plans reject multi-unit dependency cycles', () => {
  const contract = {
    objective: 'Reject a deadlocked plan',
    units: [
      { id: 'a', objective: 'A', scope: ['a.ts'], dependencies: ['b'], skillNames: [], acceptanceCriteria: ['A done'], focusedVerifiers: [] },
      { id: 'b', objective: 'B', scope: ['b.ts'], dependencies: ['a'], skillNames: [], acceptanceCriteria: ['B done'], focusedVerifiers: [] },
    ],
  };
  assert.throws(() => generateRoleDirective('zenki', {
    runId: 'cycle', taskType: 'build', status: 'zenki_planning', contractRevision: 1,
    contract: {
      revision: 1, scope: [], exclusions: [], acceptanceCriteria: [], workPlan: contract,
      skillSet: {
        entries: [],
        intakeDiscovery: { attempted: false, mode: 'off', requirements: [], queries: [], cacheHits: 0, candidates: 0, selected: [], failures: [] },
        zenkiDiscovery: { attempted: false, mode: 'off', requirements: [], queries: [], cacheHits: 0, candidates: 0, selected: [], failures: [] },
      },
      finalVerifiers: [], maxAttempts: 8,
      provenance: {
        scope: 'inferred', exclusions: 'inferred', acceptanceCriteria: 'inferred', workPlan: 'inferred',
        skillSet: 'inferred', finalVerifiers: 'inferred', maxAttempts: 'inferred',
      },
    },
    handoff: requestHandoff('build'),
    workUnits: [],
  }), /input is invalid/iu);
});

test('WorkUnits select a bounded versioned expert mixture for their actual routes', () => {
  const workPlan = {
    objective: 'Build an accessible save flow',
    units: [{
      id: 'save', objective: 'Implement save', scope: ['src/Save.tsx'], dependencies: [],
      skillNames: ['kiokuko-single-purpose-functions', 'kiokuko-ui-design-soul'],
      expertRefs: [
        { id: 'code.effects.v1', reason: 'Persist the settings atomically' },
        { id: 'ui.async.v1', reason: 'Expose processing, failure, and retry' },
      ],
      acceptanceCriteria: ['Save is recoverable'], focusedVerifiers: [],
    }],
  };
  assert.doesNotThrow(() => assertWorkPlanExpertCoverage(workPlan, {
    includesCodeChanges: true,
    includesUiWork: true,
  }));
  assert.throws(() => assertWorkPlanExpertCoverage({
    ...workPlan,
    units: workPlan.units.map((unit) => ({
      ...unit,
      expertRefs: [{ id: 'ui.async.v1', reason: 'Only the UI risk was selected' }],
    })),
  }, { includesCodeChanges: true, includesUiWork: true }), /must select a code expert fragment/iu);
  assert.throws(() => assertWorkPlanExpertCoverage({
    ...workPlan,
    units: workPlan.units.map((unit) => ({
      ...unit,
      expertRefs: [{ id: 'code.effects.v1', reason: 'Only the code risk was selected' }],
    })),
  }, { includesCodeChanges: true, includesUiWork: true }), /must select a UI expert fragment/iu);
});

test('WorkUnit expertRefs reject unknown, duplicate, or oversized mixtures', () => {
  const base = {
    runId: 'run', workspace: 'workspace', orchestrationId: 'session', expectedRevision: 1, idempotencyKey: 'plan',
    scope: ['src/a.ts'], exclusions: [], acceptanceCriteria: [{ id: 'done', description: 'Done' }],
    skillRequirements: [], finalVerifiers: [{
      id: 'test', kind: 'test', executable: process.execPath, args: [], cwd: process.cwd(), timeoutMs: 1000,
    }], maxAttempts: 8,
    provenance: {
      scope: 'explicit_user', exclusions: 'explicit_user', acceptanceCriteria: 'explicit_user',
      workPlan: 'explicit_user', skillSet: 'explicit_user', finalVerifiers: 'explicit_user', maxAttempts: 'explicit_user',
    },
  };
  const submission = (expertRefs: { id: string; reason: string }[]) => ({
    ...base,
    workPlan: { objective: 'Build', units: [{
      id: 'build', objective: 'Build', scope: ['src/a.ts'], dependencies: [], skillNames: [],
      expertRefs, acceptanceCriteria: ['Done'], focusedVerifiers: [],
    }] },
  });
  assert.throws(() => parsePlanSubmission(submission([
    { id: 'code.unknown.v1', reason: 'Not registered' },
  ])), /plan submission is invalid/iu);
  assert.throws(() => parsePlanSubmission(submission([
    { id: 'code.domain.v1', reason: 'First' },
    { id: 'code.domain.v1', reason: 'Duplicate' },
  ])), /plan submission is invalid/iu);
  assert.throws(() => parsePlanSubmission(submission([
    { id: 'code.boundary.v1', reason: 'One' },
    { id: 'code.domain.v1', reason: 'Two' },
    { id: 'code.effects.v1', reason: 'Three' },
    { id: 'code.protocol.v1', reason: 'Four is too many' },
  ])), /plan submission is invalid/iu);
});

test('Enno identifies supported MCP harnesses and rejects contradictory explicit identity', () => {
  assert.equal(identifyEnnoClientKind('codex-mcp-client'), 'codex');
  assert.equal(identifyEnnoClientKind('claude-ai'), 'claude');
  assert.equal(identifyEnnoClientKind('opencode'), 'opencode');
  assert.equal(identifyEnnoClientKind('unrelated-client'), null);

  assert.deepEqual(resolveTaskPrepareClient(undefined, {
    name: 'codex-mcp-client',
    version: '1.2.3',
  }), {
    kind: 'codex',
    version: '1.2.3',
  });
  assert.throws(() => resolveTaskPrepareClient({ kind: 'claude' }, {
    name: 'codex-mcp-client',
    version: '1.2.3',
  }), /conflicts with the MCP client/iu);
});

test('mandatory SOUL assignment is deterministic and does not duplicate requirements', () => {
  const requirements = completeRequiredSkillList({
    requested: [
      { name: 'kiokuko-soul', purposes: ['review'], required: false },
      { name: 'kiokuko-single-purpose-functions', purposes: ['testing'], required: false },
    ],
    includesCodeChanges: true,
    includesUiWork: true,
  });
  assert.deepEqual(requirements.map((item) => item.name), [
    'kiokuko-soul',
    'kiokuko-single-purpose-functions',
    'kiokuko-ui-design-soul',
  ]);
  assert.equal(requirements[0]?.required, true);
  assert.deepEqual(orderedUniqueSkillNames(
    ['kiokuko-soul', 'kiokuko-single-purpose-functions'],
    ['kiokuko_soul', 'external-review'],
  ), ['kiokuko-soul', 'kiokuko-single-purpose-functions', 'external-review']);
});

test('reference-only Skills cannot satisfy a required executable Skill contract', () => {
  assert.deepEqual(unavailableRequiredSkills([
    { name: 'local', purposes: ['implementation'], required: true, availability: 'local', referenceId: null },
    { name: 'fresh', purposes: ['testing'], required: true, availability: 'imported_fresh', referenceId: 'skill-2' },
    { name: 'reference', purposes: ['implementation'], required: true, availability: 'external_reference', referenceId: 'skill-1' },
    { name: 'optional', purposes: ['review'], required: false, availability: 'unavailable', referenceId: null },
  ]).map((entry) => entry.name), ['reference']);
});

test('a WorkUnit cannot smuggle an undeclared Skill into the role directive', () => {
  assert.throws(() => parsePlanSubmission({
    runId: 'run', workspace: 'workspace', orchestrationId: 'session', expectedRevision: 1, idempotencyKey: 'plan',
    scope: ['src/a.ts'], exclusions: [], acceptanceCriteria: [{ id: 'done', description: 'Done' }],
    workPlan: { objective: 'Build', units: [{
      id: 'build', objective: 'Build', scope: ['src/a.ts'], dependencies: [], skillNames: ['undeclared'],
      acceptanceCriteria: ['Done'], focusedVerifiers: [],
    }] },
    skillRequirements: [], finalVerifiers: [{
      id: 'test', kind: 'test', executable: process.execPath, args: [], cwd: process.cwd(), timeoutMs: 1000,
    }], maxAttempts: 8,
    provenance: {
      scope: 'explicit_user', exclusions: 'explicit_user', acceptanceCriteria: 'explicit_user',
      workPlan: 'explicit_user', skillSet: 'explicit_user', finalVerifiers: 'explicit_user', maxAttempts: 'explicit_user',
    },
  }), /plan submission is invalid/iu);
});

test('verifier uses shell false semantics, bounds output, and rejects repository escapes', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'kiokuko-enno-verifier-'));
  const passed = await runVerifier({
    id: 'pass', kind: 'test', executable: process.execPath,
    args: ['--eval', 'process.stdout.write("x".repeat(20000))'], cwd: root, timeoutMs: 5000,
  }, root);
  assert.equal(passed.status, 'passed');
  assert.ok(Buffer.byteLength(passed.stdoutPreview) <= 8192);
  assert.match(passed.stdoutDigest, /^[0-9a-f]{64}$/u);
  await assert.rejects(runVerifier({
    id: 'escape', kind: 'custom', executable: process.execPath, args: [], cwd: path.dirname(root), timeoutMs: 1000,
  }, root), /inside the canonical repository root/iu);
  await assert.rejects(runVerifier({
    id: 'shell', kind: 'custom', executable: 'node --eval', args: [], cwd: root, timeoutMs: 1000,
  }, root), /verifier is invalid/iu);
  const timeout = await runVerifier({
    id: 'timeout', kind: 'test', executable: process.execPath,
    args: ['--eval', 'setTimeout(() => {}, 10000)'], cwd: root, timeoutMs: 100,
  }, root);
  assert.equal(timeout.status, 'timeout');
});
