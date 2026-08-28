import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { prepareAgentTask } from '../../src/akinator/agent-task.js';
import { initializeDatabase } from '../../src/commands/init.js';
import { openConnection } from '../../src/db/connection.js';
import { advisoryInputDigest } from '../../src/enno-oduno/advisory.js';
import { submitEnnoAdvice, submitOdunoIdeal } from '../../src/enno-oduno/service.js';
import { ADVISORY_SLOT_DEFINITIONS } from '../../src/enno-oduno/types.js';

const capabilities = [
  { kind: 'skill', name: 'kiokuko-soul', description: 'Routes work.' },
  { kind: 'skill', name: 'kiokuko-single-purpose-functions', description: 'Code contracts.' },
];

async function fixture() {
  const root = await mkdtemp(path.join(tmpdir(), 'kiokuko-advisory-repo-'));
  execFileSync('git', ['init', '-q', root]);
  const databaseDirectory = await mkdtemp(path.join(tmpdir(), 'kiokuko-advisory-db-'));
  const databasePath = path.join(databaseDirectory, 'data.sqlite3');
  await initializeDatabase({ databasePath });
  const database = openConnection(databasePath);
  const prepared = await prepareAgentTask(database, {
    requestId: 'advisory-request',
    cwd: root,
    task: 'Repair the add function',
    profileHints: { taskType: 'debug', target: 'src/add.ts', expected: 'tests pass', constraints: null },
    capabilities,
    client: { kind: 'codex', sessionId: 'codex-advisory' },
    skillDiscoveryMode: 'off',
  });
  return { root, database, prepared };
}

function identity(prepared: Awaited<ReturnType<typeof prepareAgentTask>>) {
  return {
    runId: prepared.run.runId,
    workspace: prepared.project.workspace,
    orchestrationId: prepared.intake.sessionId,
  };
}

function completed(slotId: string, summary = `Completed ${slotId}`) {
  return { slotId, outcome: 'completed' as const, summary, recommendations: [`Recommendation from ${slotId}`], risks: [], evidence: [] };
}

function unavailable(slotId: string) {
  return { slotId, outcome: 'unavailable' as const, reasonCode: 'host_read_only_unavailable' as const };
}

test('advisory directives are host-mediated and omit every Enno identity from advisor input', async () => {
  const { database, prepared } = await fixture();
  try {
    const directive = prepared.ennoOduno.directive?.advisoryRound;
    assert.ok(directive);
    assert.equal(directive.phase, 'ideal');
    assert.equal(directive.readOnlyRequired, true);
    assert.equal(directive.hostMustVerifyIsolation, true);
    assert.deepEqual(directive.slots.map((slot) => slot.slotId), [
      'constraint_guardian', 'skill_trust_analyst', 'success_signal_critic',
    ]);
    const serialized = JSON.stringify(directive);
    for (const forbidden of [prepared.run.runId, prepared.project.workspace, prepared.intake.sessionId, 'idempotencyKey', 'contractRevision', 'mutationRevision']) {
      assert.equal(serialized.includes(forbidden), false, `advisor input leaked ${forbidden}`);
    }
  } finally {
    database.close();
  }
});

test('advice submission sorts fixed slots, persists mutation revision zero, and exact-replays', async () => {
  const { database, prepared } = await fixture();
  try {
    const id = identity(prepared);
    const context = prepared.ennoOduno.directive!.advisoryRound!.context;
    const input = {
      ...id,
      expectedRevision: 1,
      mutationRevision: 0,
      idempotencyKey: 'advice-first',
      phase: 'ideal' as const,
      allowlistedContext: context,
      contributions: [completed('success_signal_critic'), completed('constraint_guardian'), completed('skill_trust_analyst')],
    };
    const first = submitEnnoAdvice(database, input);
    assert.equal(first.ennoOduno.status, 'oduno_ideal');
    assert.equal(first.advisoryRound?.degraded, false);
    assert.equal(first.advisoryRound?.source, 'host_reported');
    assert.deepEqual(first.advisoryRound?.contributions.map((item) => item.slotId), [
      'constraint_guardian', 'skill_trust_analyst', 'success_signal_critic',
    ]);
    const storedRound = database.prepare('SELECT mutation_revision AS mutationRevision, source FROM enno_advisory_rounds').get<{ mutationRevision: number; source: string }>();
    assert.equal(storedRound?.mutationRevision, 0);
    assert.equal(storedRound?.source, 'host_reported');
    const replay = submitEnnoAdvice(database, input);
    assert.deepEqual(replay, first);
    assert.throws(() => submitEnnoAdvice(database, { ...input, contributions: [completed('constraint_guardian', 'changed'), completed('skill_trust_analyst'), completed('success_signal_critic')] }), /idempotency/u);
  } finally {
    database.close();
  }
});

test('secret-shaped advisor output is persisted only as unsafe_output and unavailable slots remain auditable', async () => {
  const { database, prepared } = await fixture();
  try {
    const id = identity(prepared);
    const context = prepared.ennoOduno.directive!.advisoryRound!.context;
    const result = submitEnnoAdvice(database, {
      ...id,
      expectedRevision: 1,
      mutationRevision: 0,
      idempotencyKey: 'advice-unsafe',
      phase: 'ideal',
      allowlistedContext: context,
      contributions: [
        { ...completed('constraint_guardian'), recommendations: ['Run --api-key value'] },
        unavailable('skill_trust_analyst'),
        unavailable('success_signal_critic'),
      ],
    });
    assert.deepEqual(result.advisoryRound?.contributions, [
      { slotId: 'constraint_guardian', outcome: 'failed', reasonCode: 'unsafe_output' },
      { slotId: 'skill_trust_analyst', outcome: 'unavailable', reasonCode: 'host_read_only_unavailable' },
      { slotId: 'success_signal_critic', outcome: 'unavailable', reasonCode: 'host_read_only_unavailable' },
    ]);
    assert.equal(result.advisoryRound?.degraded, true);
    assert.equal(database.prepare('SELECT contribution_json FROM enno_advisory_contributions WHERE slot_id = ?').get<{ contribution_json: string }>('constraint_guardian')?.contribution_json.includes('--api-key'), false);
  } finally {
    database.close();
  }
});

test('advice round digest binds the allowlisted context and is consumed by the existing ideal submit', async () => {
  const { database, prepared } = await fixture();
  try {
    const id = identity(prepared);
    const context = prepared.ennoOduno.directive!.advisoryRound!.context;
    const digest = advisoryInputDigest({ phase: 'ideal', contractRevision: 1, mutationRevision: 0, allowlistedContext: context });
    submitEnnoAdvice(database, {
      ...id,
      expectedRevision: 1,
      mutationRevision: 0,
      idempotencyKey: 'advice-consume',
      phase: 'ideal',
      allowlistedContext: context,
      contributions: ADVISORY_SLOT_DEFINITIONS.filter((slot) => slot.phase === 'ideal').map((slot) => completed(slot.slotId)),
    });
    const ideal = submitOdunoIdeal(database, {
      ...id,
      expectedRevision: 1,
      idempotencyKey: 'ideal-after-advice',
      advisoryRoundDigest: digest,
      ideal: {
        objective: 'Reach the verified repair outcome',
        principles: ['Preserve the request constraints'],
        skillContributions: prepared.skillDiscovery.selected.map((skill) => ({ skillName: skill.name, contribution: `Use ${skill.name} as reference-only guidance` })),
        successSignals: ['tests pass'],
      },
    });
    assert.equal(ideal.ennoOduno.status, 'zenki_planning');
    assert.equal(database.prepare("SELECT state FROM enno_advisory_rounds WHERE phase = 'ideal'").get<{ state: string }>()?.state, 'consumed');
  } finally {
    database.close();
  }
});

test('advice rejects control-bearing and oversized structured text at the boundary', async () => {
  const { database, prepared } = await fixture();
  try {
    const id = identity(prepared);
    const context = prepared.ennoOduno.directive!.advisoryRound!.context;
    const base = {
      ...id,
      expectedRevision: 1,
      mutationRevision: 0,
      idempotencyKey: 'advice-boundary',
      phase: 'ideal' as const,
      allowlistedContext: context,
      contributions: [completed('constraint_guardian'), completed('skill_trust_analyst'), completed('success_signal_critic')],
    };
    assert.throws(() => submitEnnoAdvice(database, { ...base, contributions: [{ ...completed('constraint_guardian'), summary: 'bad\nvalue' }, base.contributions[1], base.contributions[2]] }), /invalid/u);
    assert.throws(() => submitEnnoAdvice(database, { ...base, contributions: [{ ...completed('constraint_guardian'), summary: 'あ'.repeat(20_000) }, base.contributions[1], base.contributions[2]] }), /invalid/u);
  } finally {
    database.close();
  }
});
