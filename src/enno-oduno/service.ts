import { createHash } from 'node:crypto';
import type { SqliteDatabase } from '../db/adapter.js';
import { withImmediateTransaction } from '../db/transaction.js';
import { KiokukoError } from '../errors.js';
import { assertCapabilityCatalogBinding } from '../akinator/capability-binding.js';
import { normalizeCapabilityCatalog } from '../akinator/capabilities.js';
import { getAkinatorContextService } from '../akinator/service.js';
import type { AkinatorQuestion, AkinatorReasoning, TaskProfile } from '../akinator/types.js';
import {
  claimAgentTaskSkillDiscoveryAttempt,
  completeAgentTaskSkillDiscoveryAttempt,
  failAgentTaskSkillDiscoveryAttempt,
  readAgentTaskSkillDiscoveryAttempt,
} from '../akinator/skill-discovery-attempt.js';
import {
  captureProjectManifestSnapshot,
  resolveProjectFingerprint,
} from '../repository/project-fingerprint.js';
import { discoverSkills } from '../skills/discovery-service.js';
import { SkillProviderError } from '../skills/providers/schema.js';
import type { DiscoverSkillsInput, SkillDiscoverySummary } from '../skills/types.js';
import { canonicalContentHash, canonicalJson } from '../serialization/validate.js';
import { sanitizeJson } from '../security/sanitize.js';
import { LedgerStore } from '../ledger/store.js';
import { directiveForIntake, directiveForRun } from './directives.js';
import { advisoryDirectiveForSnapshot, advisoryInputDigest, advisoryPhaseForStatus, normalizeAdvisoryContributions } from './advisory.js';
import {
  createAdvisoryRoundInTransaction,
  ensureAdvisoryRoundConsumedInTransaction,
  readAdvisoryRound,
  readSubmittedAdvisoryRound,
} from './advisory-store.js';
import { assertWorkPlanExpertCoverage } from './experts.js';
import { buildEnnoRequestHandoff } from './handoff.js';
import { identifyEnnoClientKind } from './harness.js';
import {
  ennoAnswerSchema,
  finishSchema,
  idealSubmissionSchema,
  meditationSubmissionSchema,
  planSubmissionSchema,
  workReportSchema,
  assertContractVerifierCwds,
  parseEnnoAnswer,
  parseAdviceSubmission,
  parseFinishRequest,
  parseIdealSubmission,
  parseMeditationSubmission,
  parseOdunoIdeal,
  parseOdunoMeditation,
  parsePlanSubmission,
  parseVerificationPrepare,
  parseWorkReport,
} from './schemas.js';
import {
  completeRequiredSkillList,
  createSkillSetEntries,
  orderedUniqueSkillNames,
  unavailableRequiredSkills,
} from './skills.js';
import {
  appendEnnoEventInTransaction,
  completeOperationInTransaction,
  createEnnoDraft,
  finishVerifierRunsInTransaction,
  readEnnoSnapshot,
  readFreshFinalVerifierResults,
  readOperationReceipt,
  replaceWorkUnitsInTransaction,
  setWorkUnitStatusInTransaction,
  startOperationInTransaction,
  startVerifierRunsInTransaction,
  terminalizeLedgerRunInTransaction,
  updateContractInTransaction,
  type EnnoIdentity,
  type OperationIdentity,
} from './store.js';
import {
  ENNO_APPLICABLE_TASK_TYPES,
  ENNO_MAX_EXTERNAL_SKILLS,
  ENNO_MAX_TOTAL_SKILL_QUERIES,
  ENNO_PROVENANCE_KEYS,
  type EnnoOdunoContract,
  type EnnoNextAction,
  type EnnoOdunoState,
  type EnnoRunSnapshot,
  type AdvisoryContext,
  type AdvisoryDisposition,
  type AdvisoryPhase,
  type AdvisoryContribution,
  type StoredAdvisoryRound,
  type OdunoIdeal,
  type OdunoMeditation,
  type VerifierSpec,
  type VerifierRunResult,
} from './types.js';
import { runVerifiers, type VerifierDependencies } from './verifier.js';
import { planStartRecoveryError } from './plan-recovery.js';
import type * as z from 'zod/v4';
import {
  STANDARD_FUNCTION_SKILL_NAME,
  STANDARD_SOUL_SKILL_NAME,
  STANDARD_UI_SKILL_NAME,
} from '../setup/standard-skills.js';

type PlanSubmission = z.infer<typeof planSubmissionSchema>;
type IdealSubmission = z.infer<typeof idealSubmissionSchema>;
type EnnoAnswer = z.infer<typeof ennoAnswerSchema>;
type WorkReport = z.infer<typeof workReportSchema>;
type FinishRequest = z.infer<typeof finishSchema>;
type MeditationSubmission = z.infer<typeof meditationSubmissionSchema>;

export interface EnnoOperationResponse {
  ennoOduno: EnnoOdunoState;
  verifierResults?: VerifierRunResult[];
  advisoryRound?: StoredAdvisoryRound;
}

export interface EnnoServiceDependencies extends VerifierDependencies {
  discoverSkills?: typeof discoverSkills;
  fetchImpl?: typeof fetch;
}

interface PreparedTaskShape {
  project: { repositoryRoot: string; repositoryId: string; workspace: string };
  intake: {
    sessionId: string;
    status: 'needs_answer' | 'ready' | 'exhausted';
    profile: TaskProfile;
    question: AkinatorQuestion | null;
    reasoning: AkinatorReasoning;
  };
  run: { runId: string; status: 'intake' | 'active' };
  skillDiscovery: SkillDiscoverySummary;
}

function stateForSnapshot(snapshot: EnnoRunSnapshot): EnnoOdunoState {
  let nextAction: EnnoNextAction;
  if (snapshot.status === 'intake') nextAction = 'answer_intake';
  else if (snapshot.status === 'oduno_ideal') nextAction = 'submit_ideal';
  else if (snapshot.status === 'zenki_planning') nextAction = 'submit_plan';
  else if (snapshot.status === 'needs_confirmation') nextAction = 'ask_user_confirmation';
  else if (snapshot.status === 'goki_executing') nextAction = 'execute_work_unit';
  else if (snapshot.status === 'enno_verifying') nextAction = snapshot.finalEvidenceReady ? 'submit_final_review' : 'run_final_verification';
  else if (snapshot.status === 'oduno_meditation') nextAction = 'submit_meditation';
  else if (snapshot.status === 'blocked') nextAction = 'report_blocker';
  else nextAction = 'complete';
  const directive = directiveForRun(snapshot);
  return {
    applicable: true,
    status: snapshot.status,
    orchestrationId: snapshot.orchestrationId,
    clientBinding: {
      status: snapshot.clientSessionId === null ? 'pending' : 'bound',
      clientKind: snapshot.clientKind,
      clientVersion: snapshot.clientVersion,
      identified: snapshot.clientKind !== null,
    },
    contractRevision: snapshot.revision,
    ideal: snapshot.ideal,
    meditation: snapshot.meditation,
    currentRole: directive?.role ?? null,
    directive,
    nextAction,
  };
}

function intakeEnnoState(input: {
  runId: string;
  orchestrationId: string;
  clientKind: EnnoRunSnapshot['clientKind'];
  clientVersion: string | null;
  clientSessionId: string | null;
  question: AkinatorQuestion | null;
}): EnnoOdunoState {
  const directive = directiveForIntake(input);
  return {
    applicable: true,
    status: 'intake',
    orchestrationId: input.orchestrationId,
    clientBinding: {
      status: input.clientSessionId === null ? 'pending' : 'bound',
      clientKind: input.clientKind,
      clientVersion: input.clientVersion,
      identified: input.clientKind !== null,
    },
    contractRevision: null,
    ideal: null,
    meditation: null,
    currentRole: 'enno-oduno',
    directive,
    nextAction: 'answer_intake',
  };
}

export function inapplicableEnnoState(): EnnoOdunoState {
  return {
    applicable: false,
    status: 'intake',
    orchestrationId: null,
    clientBinding: null,
    contractRevision: null,
    ideal: null,
    meditation: null,
    currentRole: null,
    directive: null,
    nextAction: 'complete',
  };
}

export function ennoStateForPreparedTask(
  database: SqliteDatabase,
  prepared: PreparedTaskShape,
  client: { kind: string; version?: string; sessionId?: string } | undefined,
): EnnoOdunoState {
  const taskType = prepared.intake.profile.taskType;
  const clientKind = identifyEnnoClientKind(client?.kind);
  const clientVersion = clientKind === null ? null : client?.version ?? null;
  const clientSessionId = clientKind === null ? null : client?.sessionId ?? null;
  if (prepared.intake.status === 'needs_answer' && taskType === null) {
    return intakeEnnoState({
      runId: prepared.run.runId,
      orchestrationId: prepared.intake.sessionId,
      clientKind,
      clientVersion,
      clientSessionId,
      question: prepared.intake.question,
    });
  }
  if (taskType === null || !ENNO_APPLICABLE_TASK_TYPES.includes(taskType as (typeof ENNO_APPLICABLE_TASK_TYPES)[number])) {
    return inapplicableEnnoState();
  }
  if (prepared.intake.status === 'needs_answer') {
    return intakeEnnoState({
      runId: prepared.run.runId,
      orchestrationId: prepared.intake.sessionId,
      clientKind,
      clientVersion,
      clientSessionId,
      question: prepared.intake.question,
    });
  }
  const handoff = buildEnnoRequestHandoff(prepared.intake.profile, prepared.intake.reasoning);
  const snapshot = createEnnoDraft(database, {
    runId: prepared.run.runId,
    workspace: prepared.project.workspace,
    orchestrationId: prepared.intake.sessionId,
    repositoryRoot: prepared.project.repositoryRoot,
    taskType: taskType as (typeof ENNO_APPLICABLE_TASK_TYPES)[number],
    taskTarget: prepared.intake.profile.target,
    taskExpected: prepared.intake.profile.expected,
    handoff,
    skillDiscovery: prepared.skillDiscovery,
    ...(clientKind === null ? {} : { initialClientKind: clientKind }),
    ...(clientVersion === null ? {} : { initialClientVersion: clientVersion }),
    ...(clientSessionId === null ? {} : { initialClientSessionId: clientSessionId }),
  });
  return stateForSnapshot(snapshot);
}

function operationIdentity(
  operation: OperationIdentity['operation'],
  idempotencyKey: string,
  input: unknown,
): OperationIdentity {
  return {
    operation,
    idempotencyKey,
    requestDigest: canonicalContentHash({ version: 1, operation, input }),
  };
}

function advisoryContextForSubmission(snapshot: EnnoRunSnapshot, phase: AdvisoryPhase): AdvisoryContext {
  const directive = advisoryDirectiveForSnapshot(snapshot);
  if (directive === undefined || directive.phase !== phase) {
    throw new KiokukoError('CONFLICT', 'Advisory round is not valid for the current Enno phase');
  }
  return directive.context;
}

function assertAdvisoryRoundInput(
  snapshot: EnnoRunSnapshot,
  phase: AdvisoryPhase,
  mutationRevision: number,
  context: AdvisoryContext,
  inputDigest: string,
): void {
  if (snapshot.mutationRevision !== mutationRevision) {
    throw new KiokukoError('CONFLICT', 'Enno mutation revision changed');
  }
  const expectedContext = advisoryContextForSubmission(snapshot, phase);
  if (canonicalJson(expectedContext) !== canonicalJson(context)) {
    throw new KiokukoError('CONFLICT', 'Advisory context does not match the current Enno phase');
  }
  const expectedDigest = advisoryInputDigest({
    phase,
    contractRevision: snapshot.revision,
    mutationRevision,
    allowlistedContext: context,
  });
  if (expectedDigest !== inputDigest) {
    throw new KiokukoError('CONFLICT', 'Advisory round digest does not match the current contract');
  }
}

function requireAdvisoryRound(
  database: SqliteDatabase,
  snapshot: EnnoRunSnapshot,
  phase: AdvisoryPhase,
  mutationRevision: number,
  context: AdvisoryContext,
  inputDigest: string,
): void {
  assertAdvisoryRoundInput(snapshot, phase, mutationRevision, context, inputDigest);
  const round = readAdvisoryRound(database, {
    runId: snapshot.runId,
    contractRevision: snapshot.revision,
    mutationRevision,
    phase,
    inputDigest,
  });
  if (round === undefined) throw new KiokukoError('CONFLICT', 'Required advisory round was not submitted');
}

function assertDispositionCoversRound(round: StoredAdvisoryRound, dispositions: readonly AdvisoryDisposition[]): void {
  const expected = new Set(round.contributions.map((contribution) => contribution.slotId));
  const covered = new Set<AdvisoryDisposition['slotId']>();
  for (const disposition of dispositions) {
    if (!expected.has(disposition.slotId)) {
      throw new KiokukoError('VALIDATION_ERROR', 'advisoryDisposition references a slot outside the advisory round');
    }
    if (covered.has(disposition.slotId)) {
      throw new KiokukoError('VALIDATION_ERROR', 'advisoryDisposition must provide at most one entry per slot');
    }
    covered.add(disposition.slotId);
  }
  for (const slotId of expected) {
    if (!covered.has(slotId)) {
      throw new KiokukoError('VALIDATION_ERROR', 'advisoryDisposition must cover every slot in the advisory round');
    }
  }
}

function consumeAdvisoryRoundIfPresent(
  database: SqliteDatabase,
  snapshot: EnnoRunSnapshot,
  phase: AdvisoryPhase,
  mutationRevision: number,
  context: AdvisoryContext | undefined,
  inputDigest: string | undefined,
  disposition: readonly AdvisoryDisposition[] | undefined,
): StoredAdvisoryRound | undefined {
  if (inputDigest === undefined) {
    const submitted = readSubmittedAdvisoryRound(database, {
      runId: snapshot.runId,
      contractRevision: snapshot.revision,
      mutationRevision,
      phase,
    });
    if (submitted !== undefined) {
      throw new KiokukoError('CONFLICT', 'Advisory round was submitted; pass its advisory digest and disposition before advancing the phase');
    }
    return undefined;
  }
  if (context === undefined) {
    throw new KiokukoError('CONFLICT', 'Advisory round is not valid for the current Enno phase');
  }
  assertAdvisoryRoundInput(snapshot, phase, mutationRevision, context, inputDigest);
  const dispositions = disposition ?? [];
  if (dispositions.length === 0) {
    throw new KiokukoError('VALIDATION_ERROR', 'advisoryDisposition is required when consuming an advisory round');
  }
  const round = ensureAdvisoryRoundConsumedInTransaction(database, {
    runId: snapshot.runId,
    contractRevision: snapshot.revision,
    mutationRevision,
    phase,
    inputDigest,
  });
  assertDispositionCoversRound(round, dispositions);
  appendEnnoEventInTransaction(database, snapshot.runId, 'enno.advice_disposition', 'enno-oduno', 'recorded', {
    phase,
    contractRevision: snapshot.revision,
    mutationRevision,
    inputDigest,
    dispositions: dispositions.map((entry) => ({ slotId: entry.slotId, disposition: entry.disposition, rationale: entry.rationale })),
  });
  return round;
}

export function submitEnnoAdvice(
  database: SqliteDatabase,
  rawInput: unknown,
): EnnoOperationResponse {
  const input = parseAdviceSubmission(rawInput);
  const operation = operationIdentity('advice_submit', input.idempotencyKey, input);
  const replay = readOperationReceipt<EnnoOperationResponse>(database, input.runId, operation);
  if (replay !== undefined) return replay;
  const before = readEnnoSnapshot(database, identity(input));
  const expectedPhase = advisoryPhaseForStatus(before.status);
  if (expectedPhase !== input.phase) throw new KiokukoError('CONFLICT', 'Advisory phase does not match the current Enno state');
  const context = input.allowlistedContext as AdvisoryContext;
  const inputDigest = advisoryInputDigest({
    phase: input.phase,
    contractRevision: before.revision,
    mutationRevision: input.mutationRevision,
    allowlistedContext: context,
  });
  return withImmediateTransaction(database, () => {
    const replayed = readOperationReceipt<EnnoOperationResponse>(database, input.runId, operation);
    if (replayed !== undefined) return replayed;
    const current = readEnnoSnapshot(database, identity(input));
    assertExpected(current, input.expectedRevision, [
      input.phase === 'ideal' ? 'oduno_ideal' : input.phase === 'planning' ? 'zenki_planning' : 'enno_verifying',
    ]);
    assertAdvisoryRoundInput(current, input.phase, input.mutationRevision, context, inputDigest);
    startOperationInTransaction(database, input.runId, operation);
    const existing = readAdvisoryRound(database, {
      runId: input.runId,
      contractRevision: current.revision,
      mutationRevision: input.mutationRevision,
      phase: input.phase,
      inputDigest,
    });
    let round: StoredAdvisoryRound;
    if (existing !== undefined) {
      const incoming = normalizeAdvisoryContributions(input.phase, input.contributions as AdvisoryContribution[]);
      if (canonicalJson(existing.contributions) !== canonicalJson(incoming)) {
        throw new KiokukoError('CONFLICT', 'Advisory round was already submitted with different contributions');
      }
      round = existing;
    } else {
      round = createAdvisoryRoundInTransaction(database, {
        runId: input.runId,
        contractRevision: current.revision,
        mutationRevision: input.mutationRevision,
        phase: input.phase,
        inputDigest,
        contributions: input.contributions as AdvisoryContribution[],
      });
    }
    appendEnnoEventInTransaction(database, input.runId, 'enno.advice_submitted', 'enno-oduno', 'aggregated', {
      phase: input.phase,
      contractRevision: current.revision,
      mutationRevision: input.mutationRevision,
      inputDigest,
      degraded: round.degraded,
    });
    const response: EnnoOperationResponse = { ennoOduno: stateForSnapshot(current), advisoryRound: round };
    completeOperationInTransaction(database, input.runId, operation, response);
    return response;
  });
}

function identity(input: { runId: string; workspace: string; orchestrationId: string }): EnnoIdentity {
  return {
    runId: input.runId,
    workspace: input.workspace,
    orchestrationId: input.orchestrationId,
  };
}

function assertExpected(snapshot: EnnoRunSnapshot, expectedRevision: number, statuses: readonly EnnoRunSnapshot['status'][]): void {
  if (snapshot.revision !== expectedRevision) throw new KiokukoError('CONFLICT', 'Enno contract revision changed');
  if (!statuses.includes(snapshot.status)) throw new KiokukoError('CONFLICT', 'Enno run is not in the required state');
}

function firstReadyUnit(snapshot: EnnoRunSnapshot): EnnoRunSnapshot['workUnits'][number] | undefined {
  const completed = new Set(snapshot.workUnits.filter((unit) => unit.status === 'completed').map((unit) => unit.workUnit.id));
  return snapshot.workUnits.find((unit) => unit.status === 'pending'
    && unit.workUnit.dependencies.every((dependency) => completed.has(dependency)));
}

function startFirstReadyUnit(database: SqliteDatabase, snapshot: EnnoRunSnapshot): void {
  const next = firstReadyUnit(snapshot);
  if (next === undefined) {
    if (snapshot.workUnits.every((unit) => unit.status === 'completed')) return;
    throw new KiokukoError('CONFLICT', 'Enno WorkPlan dependencies cannot advance');
  }
  setWorkUnitStatusInTransaction(database, {
    runId: snapshot.runId,
    contractRevision: snapshot.revision,
    workUnitId: next.workUnit.id,
    from: 'pending',
    to: 'in_progress',
  });
  appendEnnoEventInTransaction(database, snapshot.runId, 'goki.work_started', 'goki', 'started', {
    workUnitId: next.workUnit.id,
    contractRevision: snapshot.revision,
  });
}

function requiresConfirmation(provenance: EnnoOdunoContract['provenance']): boolean {
  return ENNO_PROVENANCE_KEYS.some((key) => provenance[key] !== 'explicit_user');
}

interface RunTaskContext {
  project: DiscoverSkillsInput['project'];
  fingerprint: DiscoverSkillsInput['fingerprint'];
  task: string;
  profile: TaskProfile;
  recommendedTags: string[];
}

async function readRunTaskContext(database: SqliteDatabase, snapshot: EnnoRunSnapshot): Promise<RunTaskContext> {
  const row = database.prepare(`
    SELECT r.repository_id AS repositoryId, ri.session_id AS sessionId
    FROM repositories AS r
    JOIN repository_locations AS l ON l.repository_id = r.repository_id
    JOIN run_intakes AS ri ON ri.run_id = ?
    WHERE r.workspace = ? AND l.canonical_root = ?
    LIMIT 1
  `).get<{ repositoryId: string; sessionId: string }>(snapshot.runId, snapshot.workspace, snapshot.repositoryRoot);
  if (row === undefined) throw new KiokukoError('CONFLICT', 'Enno repository or intake binding changed');
  const context = await getAkinatorContextService(database, {
    workspace: snapshot.workspace,
    sessionId: row.sessionId,
  });
  const project = {
    workspace: snapshot.workspace,
    repositoryRoot: snapshot.repositoryRoot,
    repositoryId: row.repositoryId,
    source: 'location' as const,
  };
  const manifest = captureProjectManifestSnapshot(project);
  return {
    project,
    fingerprint: resolveProjectFingerprint(database, project, manifest),
    task: context.session.task,
    profile: context.session.profile,
    recommendedTags: context.recommendedTags,
  };
}

function emptyDiscovery(mode: SkillDiscoverySummary['mode']): SkillDiscoverySummary {
  return { attempted: false, mode, requirements: [], queries: [], cacheHits: 0, candidates: 0, selected: [], failures: [] };
}

function legacyOptionalDiscoverySummary(
  mode: SkillDiscoverySummary['mode'],
  error: unknown,
): SkillDiscoverySummary | undefined {
  if (!(error instanceof SkillProviderError) || error.code !== 'registry_invalid_response') return undefined;
  return {
    ...emptyDiscovery(mode),
    failures: [{ stage: 'search', code: error.code }],
  };
}

async function discoverZenkiSkills(
  database: SqliteDatabase,
  snapshot: EnnoRunSnapshot,
  plan: PlanSubmission,
  dependencies: EnnoServiceDependencies,
): Promise<SkillDiscoverySummary> {
  const intake = snapshot.contract.skillSet.intakeDiscovery;
  if (intake.mode === 'off') return emptyDiscovery(intake.mode);
  const context = await readRunTaskContext(database, snapshot);
  const attempt = {
    runId: snapshot.runId,
    phase: 'zenki' as const,
    mode: intake.mode,
    requestDigest: canonicalContentHash({
      version: 2,
      runId: snapshot.runId,
      revision: snapshot.revision,
      mode: intake.mode,
      workPlan: plan.workPlan,
      capabilities: plan.capabilities ?? null,
      skillRequirements: plan.skillRequirements,
    }),
  };
  let replay: ReturnType<typeof readAgentTaskSkillDiscoveryAttempt>;
  try {
    replay = readAgentTaskSkillDiscoveryAttempt(database, attempt);
  } catch (error) {
    const legacySummary = legacyOptionalDiscoverySummary(intake.mode, error);
    if (legacySummary === undefined) throw error;
    return legacySummary;
  }
  if (replay !== undefined) return replay.summary;
  const claimed = claimAgentTaskSkillDiscoveryAttempt(database, attempt, {
    queryBudget: ENNO_MAX_TOTAL_SKILL_QUERIES,
    selectionBudget: ENNO_MAX_EXTERNAL_SKILLS,
  });
  if (claimed.kind === 'replay') return claimed.summary;
  if (claimed.queryBudget === 0 || claimed.selectionBudget === 0) {
    return completeAgentTaskSkillDiscoveryAttempt(database, attempt, emptyDiscovery(intake.mode), () => {
      assertExpected(readEnnoSnapshot(database, identity(plan)), plan.expectedRevision, ['zenki_planning']);
    });
  }
  try {
    const summary = await (dependencies.discoverSkills ?? discoverSkills)(database, {
      ...context,
      task: `${context.task}\n${plan.workPlan.objective}`,
      capabilities: plan.capabilities,
      mode: intake.mode,
      maxQueries: claimed.queryBudget as 1 | 2 | 3,
      maxSelectedSkills: claimed.selectionBudget as 1 | 2,
      ...(dependencies.fetchImpl === undefined ? {} : { fetchImpl: dependencies.fetchImpl }),
    }, {
      ...(dependencies.fetchImpl === undefined ? {} : { fetchImpl: dependencies.fetchImpl }),
      assertBeforePersist: () => assertExpected(readEnnoSnapshot(database, identity(plan)), plan.expectedRevision, ['zenki_planning']),
    });
    return completeAgentTaskSkillDiscoveryAttempt(database, attempt, summary, () => {
      assertExpected(readEnnoSnapshot(database, identity(plan)), plan.expectedRevision, ['zenki_planning']);
    });
  } catch (error) {
    failAgentTaskSkillDiscoveryAttempt(database, attempt, error);
  }
}

function planChangesCode(plan: PlanSubmission, taskType: EnnoRunSnapshot['taskType']): boolean {
  return taskType !== 'review'
    || plan.skillRequirements.some((skill) => skill.purposes.includes('implementation'))
    || plan.workPlan.units.some((unit) => unit.skillNames.includes('kiokuko-single-purpose-functions'));
}

function planHasUi(plan: PlanSubmission): boolean {
  return plan.skillRequirements.some((skill) => skill.purposes.includes('ui'))
    || plan.workPlan.units.some((unit) => unit.skillNames.includes('kiokuko-ui-design-soul'));
}

function assertIdealSkillCoverage(snapshot: EnnoRunSnapshot, ideal: IdealSubmission['ideal']): void {
  const expected = snapshot.contract.skillSet.intakeDiscovery.selected.map((skill) => skill.name);
  if (new Set(expected).size !== expected.length) {
    throw new KiokukoError('INTEGRITY_ERROR', 'Akinator-discovered Skill identities are inconsistent');
  }
  const actual = ideal.skillContributions.map((contribution) => contribution.skillName);
  if (actual.length !== expected.length || expected.some((name) => !actual.includes(name))) {
    throw new KiokukoError('VALIDATION_ERROR', 'Oduno ideal must account for every Akinator-discovered Skill exactly once');
  }
}

function assertPlanCapabilityCatalog(
  database: SqliteDatabase,
  input: Pick<PlanSubmission, 'runId' | 'workspace' | 'capabilities'>,
): void {
  if (input.capabilities === undefined) {
    throw planStartRecoveryError('environment_information_missing');
  }
  const run = new LedgerStore(database).readRun(input.runId, input.workspace);
  if (run === undefined) throw new KiokukoError('INTEGRITY_ERROR', 'Enno ledger run disappeared during plan validation');
  try {
    assertCapabilityCatalogBinding(run.metadata, input.capabilities);
  } catch (error) {
    if (error instanceof KiokukoError && error.code === 'CONFLICT') {
      throw planStartRecoveryError('environment_changed');
    }
    throw error;
  }
}

function endedBeforeWorkBecausePlanCatalogWasLost(
  database: SqliteDatabase,
  snapshot: EnnoRunSnapshot,
  capabilities: PlanSubmission['capabilities'],
): boolean {
  if (capabilities === undefined
    || snapshot.status !== 'blocked'
    || snapshot.blocker?.startsWith('Required Skills unavailable:') !== true
    || snapshot.workUnits.length === 0
    || snapshot.workUnits.some((unit) => unit.status !== 'pending')) return false;
  const soulEntry = snapshot.contract.skillSet.entries.find((entry) => (
    entry.name.normalize('NFKC').toLowerCase() === STANDARD_SOUL_SKILL_NAME
  ));
  if (soulEntry?.required !== true || soulEntry.availability !== 'unavailable') return false;
  const catalog = normalizeCapabilityCatalog(capabilities);
  if (!catalog.skills.some((skill) => skill.name.normalize('NFKC').toLowerCase() === STANDARD_SOUL_SKILL_NAME)) {
    return false;
  }
  const run = new LedgerStore(database).readRun(snapshot.runId, snapshot.workspace);
  if (run === undefined) return false;
  try {
    assertCapabilityCatalogBinding(run.metadata, capabilities);
    return true;
  } catch (error) {
    if (error instanceof KiokukoError && error.code === 'CONFLICT') return false;
    throw error;
  }
}

function sanitizedIdeal(ideal: IdealSubmission['ideal'], repositoryRoot: string): OdunoIdeal {
  return parseOdunoIdeal(sanitizeJson(ideal, { workspace: repositoryRoot }).value);
}

export function submitOdunoIdeal(
  database: SqliteDatabase,
  rawInput: unknown,
): EnnoOperationResponse {
  const input = parseIdealSubmission(rawInput);
  const operation = operationIdentity('ideal_submit', input.idempotencyKey, input);
  const replay = readOperationReceipt<EnnoOperationResponse>(database, input.runId, operation);
  if (replay !== undefined) return replay;
  const before = readEnnoSnapshot(database, identity(input));
  assertExpected(before, input.expectedRevision, ['oduno_ideal']);
  if (input.advisoryRoundDigest !== undefined) {
    requireAdvisoryRound(database, before, 'ideal', before.mutationRevision, advisoryContextForSubmission(before, 'ideal'), input.advisoryRoundDigest);
  }
  const ideal = sanitizedIdeal(input.ideal, before.repositoryRoot);
  assertIdealSkillCoverage(before, ideal);
  return withImmediateTransaction(database, () => {
    const replayed = readOperationReceipt<EnnoOperationResponse>(database, input.runId, operation);
    if (replayed !== undefined) return replayed;
    const current = readEnnoSnapshot(database, identity(input));
    assertExpected(current, input.expectedRevision, ['oduno_ideal']);
    assertIdealSkillCoverage(current, ideal);
    startOperationInTransaction(database, input.runId, operation);
    const advisoryRound = consumeAdvisoryRoundIfPresent(
      database,
      current,
      'ideal',
      current.mutationRevision,
      advisoryContextForSubmission(current, 'ideal'),
      input.advisoryRoundDigest,
      input.advisoryDisposition as AdvisoryDisposition[] | undefined,
    );
    updateContractInTransaction(database, current, {
      contract: current.contract,
      status: 'zenki_planning',
      confirmationState: current.confirmationState,
      ideal,
    });
    appendEnnoEventInTransaction(database, input.runId, 'oduno.ideal_derived', 'enno-oduno', 'derived', {
      contractRevision: current.revision,
      discoveredSkillCount: ideal.skillContributions.length,
      principleCount: ideal.principles.length,
      successSignalCount: ideal.successSignals.length,
    });
    const response: EnnoOperationResponse = {
      ennoOduno: stateForSnapshot(readEnnoSnapshot(database, identity(input))),
      ...(advisoryRound === undefined ? {} : { advisoryRound }),
    };
    completeOperationInTransaction(database, input.runId, operation, response);
    return response;
  });
}

export async function submitEnnoPlan(
  database: SqliteDatabase,
  rawInput: unknown,
  dependencies: EnnoServiceDependencies = {},
): Promise<EnnoOperationResponse> {
  const input = parsePlanSubmission(rawInput);
  const current = readEnnoSnapshot(database, identity(input));
  if (endedBeforeWorkBecausePlanCatalogWasLost(database, current, input.capabilities)) {
    throw planStartRecoveryError('previous_attempt_ended');
  }
  const operation = operationIdentity('plan_submit', input.idempotencyKey, input);
  const replay = readOperationReceipt<EnnoOperationResponse>(database, input.runId, operation);
  if (replay !== undefined) return replay;
  const before = current;
  assertExpected(before, input.expectedRevision, ['zenki_planning']);
  assertPlanCapabilityCatalog(database, input);
  if (input.advisoryRoundDigest !== undefined) {
    requireAdvisoryRound(database, before, 'planning', before.mutationRevision, advisoryContextForSubmission(before, 'planning'), input.advisoryRoundDigest);
  }
  const includesCodeChanges = planChangesCode(input, before.taskType);
  const includesUiWork = planHasUi(input);
  assertWorkPlanExpertCoverage(input.workPlan, { includesCodeChanges, includesUiWork });
  assertContractVerifierCwds(before.repositoryRoot, {
    workPlan: input.workPlan,
    finalVerifiers: input.finalVerifiers,
  });
  const zenkiDiscovery = await discoverZenkiSkills(database, before, input, dependencies);
  const requirements = completeRequiredSkillList({
    requested: input.skillRequirements,
    includesCodeChanges,
    includesUiWork,
  });
  const entries = createSkillSetEntries(database, {
    requirements,
    capabilities: input.capabilities,
    discoveries: [before.contract.skillSet.intakeDiscovery, zenkiDiscovery],
  });
  const unavailable = unavailableRequiredSkills(entries);
  const mandatoryWorkSkills = [
    STANDARD_SOUL_SKILL_NAME,
    ...(includesCodeChanges ? [STANDARD_FUNCTION_SKILL_NAME] : []),
    ...(includesUiWork ? [STANDARD_UI_SKILL_NAME] : []),
  ];
  const nextRevision = input.expectedRevision + 1;
  const contract = {
    revision: nextRevision,
    scope: [...input.scope],
    exclusions: [...input.exclusions],
    acceptanceCriteria: input.acceptanceCriteria.map((item) => ({ ...item })),
    workPlan: {
      objective: input.workPlan.objective,
      units: input.workPlan.units.map((unit) => ({
        ...unit,
        scope: [...unit.scope],
        dependencies: [...unit.dependencies],
        skillNames: orderedUniqueSkillNames(mandatoryWorkSkills, unit.skillNames),
        expertRefs: unit.expertRefs.map((reference) => ({ ...reference })),
        acceptanceCriteria: [...unit.acceptanceCriteria],
        focusedVerifiers: unit.focusedVerifiers.map((verifier) => ({ ...verifier, args: [...verifier.args] })),
      })),
    },
    skillSet: {
      entries,
      intakeDiscovery: before.contract.skillSet.intakeDiscovery,
      zenkiDiscovery,
    },
    finalVerifiers: input.finalVerifiers.map((verifier) => ({ ...verifier, args: [...verifier.args] })),
    maxAttempts: input.maxAttempts,
    provenance: { ...input.provenance },
  };
  assertContractVerifierCwds(before.repositoryRoot, contract);
  const needsConfirmation = requiresConfirmation(contract.provenance);
  return withImmediateTransaction(database, () => {
    const replayed = readOperationReceipt<EnnoOperationResponse>(database, input.runId, operation);
    if (replayed !== undefined) return replayed;
    const current = readEnnoSnapshot(database, identity(input));
    assertExpected(current, input.expectedRevision, ['zenki_planning']);
    startOperationInTransaction(database, input.runId, operation);
    const advisoryRound = consumeAdvisoryRoundIfPresent(
      database,
      current,
      'planning',
      current.mutationRevision,
      advisoryContextForSubmission(current, 'planning'),
      input.advisoryRoundDigest,
      input.advisoryDisposition as AdvisoryDisposition[] | undefined,
    );
    const status = unavailable.length > 0
      ? 'blocked' as const
      : needsConfirmation ? 'needs_confirmation' as const : 'goki_executing' as const;
    const blocker = unavailable.length === 0
      ? null
      : `Required Skills unavailable: ${unavailable.map((skill) => skill.name).join(', ')}`;
    updateContractInTransaction(database, current, {
      contract,
      status,
      confirmationState: needsConfirmation ? 'pending' : 'not_required',
      blocker,
      planDigest: canonicalContentHash(contract.workPlan),
    });
    replaceWorkUnitsInTransaction(database, input.runId, nextRevision, contract.workPlan);
    appendEnnoEventInTransaction(database, input.runId, 'zenki.plan_created', 'zenki', 'created', {
      contractRevision: nextRevision,
      workUnitIds: contract.workPlan.units.map((unit) => unit.id),
    });
    let updated = readEnnoSnapshot(database, identity(input));
    if (status === 'blocked') {
      appendEnnoEventInTransaction(database, input.runId, 'enno.blocked', 'enno-oduno', 'blocked', {
        reason: blocker,
        contractRevision: nextRevision,
      });
      terminalizeLedgerRunInTransaction(database, input.runId, 'failed');
    } else if (status === 'goki_executing') {
      appendEnnoEventInTransaction(database, input.runId, 'enno.plan_confirmed', 'enno-oduno', 'not_required', {
        contractRevision: nextRevision,
      });
      startFirstReadyUnit(database, updated);
      updated = readEnnoSnapshot(database, identity(input));
    }
    const response: EnnoOperationResponse = {
      ennoOduno: stateForSnapshot(updated),
      ...(advisoryRound === undefined ? {} : { advisoryRound }),
    };
    completeOperationInTransaction(database, input.runId, operation, response);
    return response;
  });
}

export function answerEnno(
  database: SqliteDatabase,
  rawInput: unknown,
): EnnoOperationResponse {
  const input = parseEnnoAnswer(rawInput);
  const operation = operationIdentity('answer', input.idempotencyKey, input);
  const replay = readOperationReceipt<EnnoOperationResponse>(database, input.runId, operation);
  if (replay !== undefined) return replay;
  return withImmediateTransaction(database, () => {
    const current = readEnnoSnapshot(database, identity(input));
    assertExpected(
      current,
      input.expectedRevision,
      input.action === 'cancel' ? ['needs_confirmation', 'zenki_planning'] : ['needs_confirmation'],
    );
    startOperationInTransaction(database, input.runId, operation);
    let next: EnnoRunSnapshot;
    if (input.action === 'approve') {
      updateContractInTransaction(database, current, {
        contract: current.contract,
        status: 'goki_executing',
        confirmationState: 'approved',
      });
      appendEnnoEventInTransaction(database, input.runId, 'enno.plan_confirmed', 'enno-oduno', 'approved', {
        contractRevision: current.revision,
      });
      next = readEnnoSnapshot(database, identity(input));
      startFirstReadyUnit(database, next);
      next = readEnnoSnapshot(database, identity(input));
    } else if (input.action === 'revise') {
      const revisedContract = {
        ...current.contract,
        revision: current.revision + 1,
      };
      updateContractInTransaction(database, current, {
        contract: revisedContract,
        status: 'zenki_planning',
        confirmationState: 'revision_requested',
        blocker: input.requestedChanges ?? null,
      });
      next = readEnnoSnapshot(database, identity(input));
    } else {
      updateContractInTransaction(database, current, {
        contract: current.contract,
        status: 'cancelled',
        confirmationState: 'cancelled',
      });
      appendEnnoEventInTransaction(database, input.runId, 'enno.cancelled', 'enno-oduno', 'cancelled', {
        contractRevision: current.revision,
      });
      terminalizeLedgerRunInTransaction(database, input.runId, 'cancelled');
      next = readEnnoSnapshot(database, identity(input));
    }
    const response = { ennoOduno: stateForSnapshot(next) };
    completeOperationInTransaction(database, input.runId, operation, response);
    return response;
  });
}

function sanitizedVerifierResults(results: VerifierRunResult[], repositoryRoot: string): VerifierRunResult[] {
  return results.map((result) => {
    const sanitized = sanitizeJson({
      stdoutPreview: result.stdoutPreview,
      stderrPreview: result.stderrPreview,
    }, { workspace: repositoryRoot }).value as { stdoutPreview: string; stderrPreview: string };
    return {
      ...result,
      stdoutPreview: sanitized.stdoutPreview,
      stderrPreview: sanitized.stderrPreview,
    };
  });
}

function spawnFailedVerifierResults(verifiers: readonly VerifierSpec[]): VerifierRunResult[] {
  const emptyDigest = createHash('sha256').digest('hex');
  return verifiers.map((verifier) => ({
    verifier: { ...verifier, args: [...verifier.args] },
    status: 'spawn_failed',
    exitCode: null,
    signal: null,
    durationMs: 0,
    stdoutPreview: '',
    stderrPreview: '',
    stdoutDigest: emptyDigest,
    stderrDigest: emptyDigest,
  }));
}

function finalReviewFeedback(
  revision: number,
  reviewSummary: string,
  results: readonly VerifierRunResult[],
): string {
  const failed = results.filter((result) => result.status !== 'passed');
  const evidence = failed.length === 0
    ? 'all final verifiers passed'
    : failed.map((result) => {
      const exit = result.exitCode === null ? '' : `,exit=${result.exitCode}`;
      return `${result.verifier.id}=${result.status}${exit}`;
    }).join('; ');
  return `Enno-Oduno review rejected contract revision ${revision}: ${reviewSummary}. Verifier evidence: ${evidence}. Zenki must revise the WorkPlan; Goki must not resume the rejected plan.`
    .slice(0, 16_384);
}

function sanitizedReviewSummary(summary: string, repositoryRoot: string): string {
  return (sanitizeJson({ summary }, { workspace: repositoryRoot }).value as { summary: string }).summary;
}

function blockedForAttemptLimit(database: SqliteDatabase, snapshot: EnnoRunSnapshot, operation: OperationIdentity): EnnoOperationResponse {
  startOperationInTransaction(database, snapshot.runId, operation);
  updateContractInTransaction(database, snapshot, {
    contract: snapshot.contract,
    status: 'blocked',
    confirmationState: snapshot.confirmationState,
    blocker: 'Enno attempt limit reached',
  });
  appendEnnoEventInTransaction(database, snapshot.runId, 'enno.blocked', 'enno-oduno', 'blocked', {
    reason: 'attempt_limit',
    attempts: snapshot.attempts,
  });
  terminalizeLedgerRunInTransaction(database, snapshot.runId, 'failed');
  const response = { ennoOduno: stateForSnapshot(readEnnoSnapshot(database, {
    runId: snapshot.runId,
    workspace: snapshot.workspace,
    orchestrationId: snapshot.orchestrationId,
  })) };
  completeOperationInTransaction(database, snapshot.runId, operation, response);
  return response;
}

export async function reportEnnoWork(
  database: SqliteDatabase,
  rawInput: unknown,
  dependencies: EnnoServiceDependencies = {},
): Promise<EnnoOperationResponse> {
  const input = parseWorkReport(rawInput);
  const operation = operationIdentity('work_report', input.idempotencyKey, input);
  const replay = readOperationReceipt<EnnoOperationResponse>(database, input.runId, operation);
  if (replay !== undefined) return replay;
  const before = readEnnoSnapshot(database, identity(input));
  assertExpected(before, input.expectedRevision, ['goki_executing']);
  const unit = before.workUnits.find((candidate) => candidate.workUnit.id === input.workUnitId);
  if (unit === undefined || unit.status !== 'in_progress') throw new KiokukoError('CONFLICT', 'Reported Enno WorkUnit is not active');
  if (before.attempts >= before.contract.maxAttempts) {
    return withImmediateTransaction(database, () => blockedForAttemptLimit(database, readEnnoSnapshot(database, identity(input)), operation));
  }
  if (input.result.outcome !== 'completed') {
    return withImmediateTransaction(database, () => {
      const current = readEnnoSnapshot(database, identity(input));
      assertExpected(current, input.expectedRevision, ['goki_executing']);
      startOperationInTransaction(database, input.runId, operation);
      const currentUnit = current.workUnits.find((candidate) => candidate.workUnit.id === input.workUnitId)!;
      const attempts = current.attempts + 1;
      const mustBlock = input.result.outcome === 'blocked' || attempts >= current.contract.maxAttempts;
      setWorkUnitStatusInTransaction(database, {
        runId: input.runId,
        contractRevision: current.revision,
        workUnitId: input.workUnitId,
        from: 'in_progress',
        to: mustBlock ? 'blocked' : 'in_progress',
        attemptCount: currentUnit.attemptCount + 1,
        result: input.result,
      });
      updateContractInTransaction(database, current, {
        contract: current.contract,
        status: mustBlock ? 'blocked' : 'goki_executing',
        confirmationState: current.confirmationState,
        attempts,
        blocker: mustBlock ? input.result.summary : null,
      });
      appendEnnoEventInTransaction(database, input.runId, 'goki.work_failed', 'goki', input.result.outcome, {
        workUnitId: input.workUnitId,
        attempt: attempts,
      });
      if (mustBlock) {
        appendEnnoEventInTransaction(database, input.runId, 'enno.blocked', 'enno-oduno', 'blocked', {
          reason: input.result.summary,
        });
        terminalizeLedgerRunInTransaction(database, input.runId, 'failed');
      }
      const response = { ennoOduno: stateForSnapshot(readEnnoSnapshot(database, identity(input))) };
      completeOperationInTransaction(database, input.runId, operation, response);
      return response;
    });
  }

  let verifierRunIds: string[] = [];
  withImmediateTransaction(database, () => {
    const current = readEnnoSnapshot(database, identity(input));
    assertExpected(current, input.expectedRevision, ['goki_executing']);
    startOperationInTransaction(database, input.runId, operation);
    const currentUnit = current.workUnits.find((candidate) => candidate.workUnit.id === input.workUnitId);
    if (currentUnit === undefined || currentUnit.status !== 'in_progress') {
      throw new KiokukoError('CONFLICT', 'Reported Enno WorkUnit changed concurrently');
    }
    verifierRunIds = startVerifierRunsInTransaction(database, {
      runId: input.runId,
      workUnitId: input.workUnitId,
      revision: current.revision,
      mutationRevision: current.mutationRevision + (input.result.mutated ? 1 : 0),
      verifiers: currentUnit.workUnit.focusedVerifiers,
    });
  });
  let rawResults: VerifierRunResult[];
  try {
    rawResults = await runVerifiers(unit.workUnit.focusedVerifiers, before.repositoryRoot, dependencies);
  } catch {
    rawResults = spawnFailedVerifierResults(unit.workUnit.focusedVerifiers);
  }
  const results = sanitizedVerifierResults(rawResults, before.repositoryRoot);
  return withImmediateTransaction(database, () => {
    const current = readEnnoSnapshot(database, identity(input));
    assertExpected(current, input.expectedRevision, ['goki_executing']);
    finishVerifierRunsInTransaction(database, verifierRunIds, results);
    const passed = results.every((result) => result.status === 'passed');
    const unsafe = results.some((result) => result.status === 'spawn_failed');
    const attempts = current.attempts + 1;
    const mustBlock = unsafe || (!passed && attempts >= current.contract.maxAttempts);
    const currentUnit = current.workUnits.find((candidate) => candidate.workUnit.id === input.workUnitId)!;
    setWorkUnitStatusInTransaction(database, {
      runId: input.runId,
      contractRevision: current.revision,
      workUnitId: input.workUnitId,
      from: 'in_progress',
      to: passed ? 'completed' : mustBlock ? 'blocked' : 'in_progress',
      attemptCount: currentUnit.attemptCount + 1,
      result: input.result,
    });
    updateContractInTransaction(database, current, {
      contract: current.contract,
      status: mustBlock ? 'blocked' : 'goki_executing',
      confirmationState: current.confirmationState,
      attempts,
      mutationRevision: current.mutationRevision + (input.result.mutated ? 1 : 0),
      blocker: mustBlock
        ? unsafe ? 'Focused verifier could not be started safely' : 'Focused verification failed at the attempt limit'
        : null,
    });
    appendEnnoEventInTransaction(database, input.runId, passed ? 'goki.work_completed' : 'goki.work_failed', 'goki', passed ? 'completed' : 'verification_failed', {
      workUnitId: input.workUnitId,
      mutated: input.result.mutated,
      changedPaths: input.result.changedPaths,
    });
    let next = readEnnoSnapshot(database, identity(input));
    if (mustBlock) {
      appendEnnoEventInTransaction(database, input.runId, 'enno.blocked', 'enno-oduno', 'blocked', {
        reason: unsafe ? 'spawn_failed' : 'focused_verification_failed',
      });
      terminalizeLedgerRunInTransaction(database, input.runId, 'failed');
    } else if (passed) {
      if (next.workUnits.every((candidate) => candidate.status === 'completed')) {
        updateContractInTransaction(database, next, {
          contract: next.contract,
          status: 'enno_verifying',
          confirmationState: next.confirmationState,
        });
      } else {
        startFirstReadyUnit(database, next);
      }
      next = readEnnoSnapshot(database, identity(input));
    }
    const response = { ennoOduno: stateForSnapshot(next), verifierResults: results };
    completeOperationInTransaction(database, input.runId, operation, response);
    return response;
  });
}

export async function prepareEnnoVerification(
  database: SqliteDatabase,
  rawInput: unknown,
  dependencies: EnnoServiceDependencies = {},
): Promise<EnnoOperationResponse> {
  const input = parseVerificationPrepare(rawInput);
  const operation = operationIdentity('verify_prepare', input.idempotencyKey, input);
  const replay = readOperationReceipt<EnnoOperationResponse>(database, input.runId, operation);
  if (replay !== undefined) return replay;
  const before = readEnnoSnapshot(database, identity(input));
  assertExpected(before, input.expectedRevision, ['enno_verifying']);
  if (before.attempts >= before.contract.maxAttempts) {
    return withImmediateTransaction(database, () => blockedForAttemptLimit(database, readEnnoSnapshot(database, identity(input)), operation));
  }
  let verifierRunIds: string[] = [];
  let cachedResults: VerifierRunResult[] | undefined;
  withImmediateTransaction(database, () => {
    const current = readEnnoSnapshot(database, identity(input));
    assertExpected(current, input.expectedRevision, ['enno_verifying']);
    startOperationInTransaction(database, input.runId, operation);
    cachedResults = readFreshFinalVerifierResults(database, {
      runId: input.runId,
      revision: current.revision,
      mutationRevision: current.mutationRevision,
      verifiers: current.contract.finalVerifiers,
    });
    if (cachedResults === undefined) {
      verifierRunIds = startVerifierRunsInTransaction(database, {
        runId: input.runId,
        workUnitId: null,
        revision: current.revision,
        mutationRevision: current.mutationRevision,
        verifiers: current.contract.finalVerifiers,
      });
    }
    appendEnnoEventInTransaction(database, input.runId, 'enno.verification_started', 'enno-oduno', cachedResults === undefined ? 'started' : 'reused', {
      contractRevision: current.revision,
      mutationRevision: current.mutationRevision,
      verifierIds: current.contract.finalVerifiers.map((verifier) => verifier.id),
    });
  });
  let results: VerifierRunResult[];
  if (cachedResults !== undefined) {
    results = cachedResults;
  } else {
    try {
      results = sanitizedVerifierResults(
        await runVerifiers(before.contract.finalVerifiers, before.repositoryRoot, dependencies),
        before.repositoryRoot,
      );
    } catch {
      results = spawnFailedVerifierResults(before.contract.finalVerifiers);
    }
  }
  return withImmediateTransaction(database, () => {
    const current = readEnnoSnapshot(database, identity(input));
    assertExpected(current, input.expectedRevision, ['enno_verifying']);
    if (verifierRunIds.length > 0) finishVerifierRunsInTransaction(database, verifierRunIds, results);
    const response: EnnoOperationResponse = {
      ennoOduno: stateForSnapshot(readEnnoSnapshot(database, identity(input))),
      verifierResults: results,
    };
    completeOperationInTransaction(database, input.runId, operation, response);
    return response;
  });
}

export async function finishEnno(
  database: SqliteDatabase,
  rawInput: unknown,
  dependencies: EnnoServiceDependencies = {},
): Promise<EnnoOperationResponse> {
  const input = parseFinishRequest(rawInput);
  const operation = operationIdentity('finish', input.idempotencyKey, input);
  const replay = readOperationReceipt<EnnoOperationResponse>(database, input.runId, operation);
  if (replay !== undefined) return replay;
  const before = readEnnoSnapshot(database, identity(input));
  assertExpected(before, input.expectedRevision, ['enno_verifying']);
  if (input.advisoryRoundDigest !== undefined) {
    requireAdvisoryRound(database, before, 'final_review', before.mutationRevision, advisoryContextForSubmission(before, 'final_review'), input.advisoryRoundDigest);
  }
  const reviewSummary = sanitizedReviewSummary(input.review.summary, before.repositoryRoot);
  if (before.attempts >= before.contract.maxAttempts) {
    return withImmediateTransaction(database, () => blockedForAttemptLimit(database, readEnnoSnapshot(database, identity(input)), operation));
  }
  let advisoryRound: StoredAdvisoryRound | undefined;
  let results: VerifierRunResult[];
  withImmediateTransaction(database, () => {
    const current = readEnnoSnapshot(database, identity(input));
    assertExpected(current, input.expectedRevision, ['enno_verifying']);
    advisoryRound = consumeAdvisoryRoundIfPresent(
      database,
      current,
      'final_review',
      current.mutationRevision,
      input.advisoryRoundDigest === undefined ? undefined : advisoryContextForSubmission(current, 'final_review'),
      input.advisoryRoundDigest,
      input.advisoryDisposition as AdvisoryDisposition[] | undefined,
    );
    const fresh = readFreshFinalVerifierResults(database, {
      runId: input.runId,
      revision: current.revision,
      mutationRevision: current.mutationRevision,
      verifiers: current.contract.finalVerifiers,
    });
    if (fresh === undefined) {
      throw new KiokukoError('CONFLICT', 'Final verification evidence is not prepared; call enno_verify_prepare first');
    }
    results = fresh;
    startOperationInTransaction(database, input.runId, operation);
    appendEnnoEventInTransaction(database, input.runId, 'enno.review_started', 'enno-oduno', 'started', {
      contractRevision: current.revision,
      mutationRevision: current.mutationRevision,
      requestedDecision: input.review.decision,
    });
    appendEnnoEventInTransaction(database, input.runId, 'enno.verification_started', 'enno-oduno', 'reused', {
      contractRevision: current.revision,
      mutationRevision: current.mutationRevision,
      verifierIds: current.contract.finalVerifiers.map((verifier) => verifier.id),
    });
  });
  return withImmediateTransaction(database, () => {
    const current = readEnnoSnapshot(database, identity(input));
    assertExpected(current, input.expectedRevision, ['enno_verifying']);
    const passed = results.length > 0 && results.every((result) => result.status === 'passed');
    const unsafe = results.some((result) => result.status === 'spawn_failed');
    const attempts = current.attempts + 1;
    const accepted = passed && input.review.decision === 'accept';
    const completesLegacyRun = accepted && current.ideal === null;
    const mustBlock = unsafe || (!accepted && attempts >= current.contract.maxAttempts);
    const reviewFeedback = accepted || mustBlock
      ? null
      : finalReviewFeedback(current.revision, reviewSummary, results);
    const nextContract = reviewFeedback === null
      ? current.contract
      : { ...current.contract, revision: current.revision + 1 };
    const blockedReason = unsafe
      ? 'Final verifier could not be started safely'
      : input.review.decision === 'replan' && passed
        ? 'Enno review requested replanning at the attempt limit'
        : 'Final verification reached the attempt limit';
    updateContractInTransaction(database, current, {
      contract: nextContract,
      status: accepted
        ? completesLegacyRun ? 'completed' : 'oduno_meditation'
        : mustBlock ? 'blocked' : 'zenki_planning',
      confirmationState: reviewFeedback === null ? current.confirmationState : 'revision_requested',
      attempts,
      blocker: mustBlock ? blockedReason : reviewFeedback,
    });
    appendEnnoEventInTransaction(database, input.runId, passed ? 'enno.verification_passed' : 'enno.verification_failed', 'enno-oduno', passed ? 'passed' : 'failed', {
      contractRevision: current.revision,
      mutationRevision: current.mutationRevision,
      statuses: results.map((result) => ({ verifierId: result.verifier.id, status: result.status })),
    });
    let next = readEnnoSnapshot(database, identity(input));
    if (accepted) {
      appendEnnoEventInTransaction(database, input.runId, 'enno.review_accepted', 'enno-oduno', 'accepted', {
        contractRevision: current.revision,
        mutationRevision: current.mutationRevision,
        summary: reviewSummary,
      });
      if (completesLegacyRun) {
        appendEnnoEventInTransaction(database, input.runId, 'enno.completed', 'enno-oduno', 'completed', {
          contractRevision: current.revision,
          mutationRevision: current.mutationRevision,
          compatibility: 'pre_oduno_ideal_run',
        });
        terminalizeLedgerRunInTransaction(database, input.runId, 'completed');
      }
    } else if (mustBlock) {
      appendEnnoEventInTransaction(database, input.runId, 'enno.blocked', 'enno-oduno', 'blocked', {
        reason: unsafe ? 'spawn_failed' : 'attempt_limit',
      });
      terminalizeLedgerRunInTransaction(database, input.runId, 'failed');
    } else {
      appendEnnoEventInTransaction(database, input.runId, 'enno.replan_requested', 'enno-oduno', 'requested', {
        fromContractRevision: current.revision,
        toContractRevision: next.revision,
        reason: reviewFeedback,
      });
      next = readEnnoSnapshot(database, identity(input));
    }
    const response: EnnoOperationResponse = {
      ennoOduno: stateForSnapshot(next),
      verifierResults: results,
      ...(advisoryRound === undefined ? {} : { advisoryRound }),
    };
    completeOperationInTransaction(database, input.runId, operation, response);
    return response;
  });
}

function sanitizedMeditation(
  meditation: MeditationSubmission['meditation'],
  repositoryRoot: string,
): OdunoMeditation {
  return parseOdunoMeditation(sanitizeJson(meditation, { workspace: repositoryRoot }).value);
}

export function submitOdunoMeditation(
  database: SqliteDatabase,
  rawInput: unknown,
): EnnoOperationResponse {
  const input = parseMeditationSubmission(rawInput);
  const operation = operationIdentity('meditation_submit', input.idempotencyKey, input);
  const replay = readOperationReceipt<EnnoOperationResponse>(database, input.runId, operation);
  if (replay !== undefined) return replay;
  const before = readEnnoSnapshot(database, identity(input));
  assertExpected(before, input.expectedRevision, ['oduno_meditation']);
  if (before.ideal === null) throw new KiokukoError('INTEGRITY_ERROR', 'Oduno meditation requires a persisted ideal');
  const meditation = sanitizedMeditation(input.meditation, before.repositoryRoot);
  return withImmediateTransaction(database, () => {
    const replayed = readOperationReceipt<EnnoOperationResponse>(database, input.runId, operation);
    if (replayed !== undefined) return replayed;
    const current = readEnnoSnapshot(database, identity(input));
    assertExpected(current, input.expectedRevision, ['oduno_meditation']);
    if (current.ideal === null) throw new KiokukoError('INTEGRITY_ERROR', 'Oduno meditation requires a persisted ideal');
    startOperationInTransaction(database, input.runId, operation);
    updateContractInTransaction(database, current, {
      contract: current.contract,
      status: 'completed',
      confirmationState: current.confirmationState,
      meditation,
    });
    appendEnnoEventInTransaction(database, input.runId, 'oduno.meditation_completed', 'enno-oduno', 'completed', {
      contractRevision: current.revision,
      mutationRevision: current.mutationRevision,
      inspectedPathCount: meditation.inspectedPaths.length,
      deletionCandidateCount: meditation.deletionCandidates.length,
    });
    appendEnnoEventInTransaction(database, input.runId, 'enno.completed', 'enno-oduno', 'completed', {
      contractRevision: current.revision,
      mutationRevision: current.mutationRevision,
    });
    terminalizeLedgerRunInTransaction(database, input.runId, 'completed');
    const response = { ennoOduno: stateForSnapshot(readEnnoSnapshot(database, identity(input))) };
    completeOperationInTransaction(database, input.runId, operation, response);
    return response;
  });
}
