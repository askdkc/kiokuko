import { canonicalContentHash, canonicalJson } from '../serialization/validate.js';
import { findSecret, findSecretInValue } from '../memory/secrets.js';
import { KiokukoError } from '../errors.js';
import {
  ADVISORY_FAILURE_CODES,
  ADVISORY_MAX_ROUND_BYTES,
  ADVISORY_MAX_SLOT_BYTES,
  ADVISORY_OUTCOMES,
  ADVISORY_PHASES,
  ADVISORY_POLICY_VERSION,
  ADVISORY_SLOT_DEFINITIONS,
  type AdvisoryContext,
  type AdvisoryContribution,
  type AdvisoryFanoutDirective,
  type AdvisoryPhase,
  type AdvisorySlotId,
  type EnnoRunSnapshot,
} from './types.js';

const phaseSlots = (phase: AdvisoryPhase) => ADVISORY_SLOT_DEFINITIONS.filter((slot) => slot.phase === phase);
const secretArgument = /(?:^|\s)--?(?:api[-_]?key|access[-_]?token|refresh[-_]?token|client[-_]?secret|password|passwd|secret)(?:=|\s+)\S+/iu;

export function advisorySlotDefinitions(phase: AdvisoryPhase): AdvisoryFanoutDirective['slots'] {
  return phaseSlots(phase).map((slot) => ({
    slotId: slot.slotId,
    rank: slot.rank,
    role: slot.role,
    instructions: `Act only as the ${slot.role}. Read-only isolation must be provided and verified by the parent host. Return a structured contribution for slot ${slot.slotId}; do not edit files, call Kiokuko tools, or claim independent execution guarantees.`,
  }));
}

export function advisoryInputDigest(input: {
  phase: AdvisoryPhase;
  contractRevision: number;
  mutationRevision: number;
  allowlistedContext: AdvisoryContext;
}): string {
  return canonicalContentHash({
    version: 1,
    phase: input.phase,
    contractRevision: input.contractRevision,
    mutationRevision: input.mutationRevision,
    slotDefinitions: advisorySlotDefinitions(input.phase),
    advisoryPolicyVersion: ADVISORY_POLICY_VERSION,
    allowlistedContext: input.allowlistedContext,
  });
}

export function advisoryPhaseForStatus(status: EnnoRunSnapshot['status']): AdvisoryPhase | null {
  if (status === 'oduno_ideal') return 'ideal';
  if (status === 'zenki_planning') return 'planning';
  if (status === 'enno_verifying') return 'final_review';
  return null;
}

function advisoryContextForSnapshot(snapshot: EnnoRunSnapshot, phase: AdvisoryPhase): AdvisoryContext {
  const objective = phase === 'ideal'
    ? snapshot.handoff.objective
    : phase === 'planning'
      ? snapshot.ideal?.objective ?? snapshot.handoff.objective
      : snapshot.contract.workPlan.objective;
  const reference = phase === 'final_review'
    ? `Review the completed WorkPlan against its final verifiers: ${snapshot.contract.finalVerifiers.map((verifier) => verifier.id).join(', ')}`
    : snapshot.handoff.objective;
  return {
    objective,
    scope: [...snapshot.contract.scope],
    constraints: [...snapshot.handoff.constraints],
    acceptanceCriteria: snapshot.contract.acceptanceCriteria.map((criterion) => criterion.description),
    reference,
  };
}

export function advisoryDirectiveForSnapshot(snapshot: EnnoRunSnapshot): AdvisoryFanoutDirective | undefined {
  const phase = advisoryPhaseForStatus(snapshot.status);
  if (phase === null) return undefined;
  return {
    protocolVersion: 1,
    phase,
    policyVersion: ADVISORY_POLICY_VERSION,
    readOnlyRequired: true,
    hostMustVerifyIsolation: true,
    context: advisoryContextForSnapshot(snapshot, phase),
    slots: advisorySlotDefinitions(phase),
  };
}

function unsafeText(value: unknown): boolean {
  if (typeof value !== 'string') return false;
  return findSecret(value) !== undefined || secretArgument.test(value);
}

function contributionContainsSecret(contribution: AdvisoryContribution): boolean {
  return findSecretInValue(contribution) !== undefined
    || unsafeText(canonicalJson(contribution));
}

function unsafeContribution(slotId: AdvisorySlotId): AdvisoryContribution {
  return { slotId, outcome: 'failed', reasonCode: 'unsafe_output' };
}

function canonicalByteLength(value: unknown): number {
  return Buffer.byteLength(canonicalJson(value), 'utf8');
}

export function normalizeAdvisoryContributions(
  phase: AdvisoryPhase,
  rawContributions: readonly AdvisoryContribution[],
): AdvisoryContribution[] {
  const slots = phaseSlots(phase);
  const expected = new Set(slots.map((slot) => slot.slotId));
  if (rawContributions.length !== slots.length) {
    throw new KiokukoError('VALIDATION_ERROR', 'An advisory round requires exactly three slot contributions');
  }
  const bySlot = new Map<AdvisorySlotId, AdvisoryContribution>();
  for (const contribution of rawContributions) {
    if (!expected.has(contribution.slotId) || bySlot.has(contribution.slotId)) {
      throw new KiokukoError('VALIDATION_ERROR', 'Advisory slots must be exactly the fixed slots for the phase');
    }
    if (!ADVISORY_OUTCOMES.includes(contribution.outcome)) {
      throw new KiokukoError('VALIDATION_ERROR', 'Advisory outcome is invalid');
    }
    if (contribution.outcome === 'completed' && contributionContainsSecret(contribution)) {
      bySlot.set(contribution.slotId, unsafeContribution(contribution.slotId));
      continue;
    }
    if (contribution.outcome !== 'completed'
      && (!contribution.reasonCode || !ADVISORY_FAILURE_CODES.includes(contribution.reasonCode))) {
      throw new KiokukoError('VALIDATION_ERROR', 'Advisory failures require a fixed reason code');
    }
    bySlot.set(contribution.slotId, { ...contribution });
  }
  if (bySlot.size !== slots.length) {
    throw new KiokukoError('VALIDATION_ERROR', 'Advisory slots are missing or duplicated');
  }
  const normalized = slots.map((slot) => bySlot.get(slot.slotId)!);
  if (normalized.some((contribution) => canonicalByteLength(contribution) > ADVISORY_MAX_SLOT_BYTES)) {
    throw new KiokukoError('VALIDATION_ERROR', 'An advisory contribution exceeds the 16 KiB slot limit');
  }
  if (canonicalByteLength(normalized) > ADVISORY_MAX_ROUND_BYTES) {
    throw new KiokukoError('VALIDATION_ERROR', 'The advisory round exceeds the 48 KiB aggregate limit');
  }
  return normalized;
}

export function advisoryRoundAggregate(contributions: readonly AdvisoryContribution[]): {
  contributions: AdvisoryContribution[];
  degraded: boolean;
} {
  return {
    contributions: contributions.map((contribution) => ({
      ...contribution,
      ...(contribution.recommendations === undefined ? {} : { recommendations: [...contribution.recommendations] }),
      ...(contribution.risks === undefined ? {} : { risks: [...contribution.risks] }),
      ...(contribution.evidence === undefined ? {} : { evidence: contribution.evidence.map((evidence) => ({ ...evidence })) }),
    })),
    degraded: contributions.every((contribution) => contribution.outcome !== 'completed'),
  };
}
