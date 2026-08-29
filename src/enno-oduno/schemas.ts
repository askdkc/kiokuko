import path from 'node:path';
import * as z from 'zod/v4';
import { KiokukoError } from '../errors.js';
import {
  STANDARD_FUNCTION_EXPERT_IDS,
  STANDARD_FUNCTION_SKILL_NAME,
  STANDARD_SOUL_SKILL_NAME,
  STANDARD_UI_EXPERT_IDS,
  STANDARD_UI_SKILL_NAME,
} from '../setup/standard-skills.js';
import {
  ADVISORY_FAILURE_CODES,
  ADVISORY_OUTCOMES,
  ADVISORY_PHASES,
  ADVISORY_SLOT_DEFINITIONS,
  ENNO_MAX_ATTEMPTS,
  ENNO_MIN_ATTEMPTS,
  ENNO_PROVENANCE_KEYS,
  type EnnoOdunoContract,
  type EnnoRequestHandoff,
  type OdunoIdeal,
  type OdunoMeditation,
  type VerifierSpec,
  type WorkPlan,
  type WorkReportResult,
} from './types.js';

const canonicalText = (maximum: number) => z.string().min(1).max(maximum).refine(
  (value) => value.trim() === value && !/[\p{Cc}\p{Cf}]/u.test(value),
  'Value must be bounded canonical text',
);
const identifier = canonicalText(256).refine((value) => value !== '.' && value !== '..' && !/[\\/]/u.test(value));
const boundedPath = canonicalText(4_096).refine((value) => !value.includes('\0'));
const repositoryRelativePath = boundedPath.refine(
  (value) => !path.posix.isAbsolute(value)
    && !path.win32.isAbsolute(value)
    && !value.split(/[\\/]/u).includes('..'),
  'Path must be repository-relative without parent traversal',
);

export const verifierSpecSchema = z.object({
  id: identifier,
  kind: z.enum(['test', 'typecheck', 'build', 'lint', 'custom']),
  executable: canonicalText(1_024).refine((value) => !/\s/u.test(value), 'Executable must be one program, not a shell command'),
  args: z.array(z.string().max(16_384).refine((value) => !value.includes('\0'))).max(128),
  cwd: boundedPath,
  timeoutMs: z.number().int().min(100).max(300_000),
}).strict();

const standardExpertIds = [...STANDARD_FUNCTION_EXPERT_IDS, ...STANDARD_UI_EXPERT_IDS] as const;

export const expertRefSchema = z.object({
  id: z.enum(standardExpertIds),
  reason: canonicalText(500),
}).strict();

export const workUnitSchema = z.object({
  id: identifier,
  objective: canonicalText(16_384),
  scope: z.array(boundedPath).min(1).max(256),
  dependencies: z.array(identifier).max(128),
  skillNames: z.array(canonicalText(300)).max(64),
  expertRefs: z.array(expertRefSchema).max(3).default([]),
  acceptanceCriteria: z.array(canonicalText(8_192)).min(1).max(128),
  focusedVerifiers: z.array(verifierSpecSchema).max(32),
}).strict().superRefine((unit, context) => {
  const ids = unit.expertRefs.map((reference) => reference.id);
  if (new Set(ids).size !== ids.length) {
    context.addIssue({ code: 'custom', message: 'WorkUnit expertRefs must be unique', path: ['expertRefs'] });
  }
});

export const workPlanSchema = z.object({
  objective: canonicalText(16_384),
  units: z.array(workUnitSchema).min(1).max(128),
}).strict().superRefine((plan, context) => {
  const ids = new Set(plan.units.map((unit) => unit.id));
  if (ids.size !== plan.units.length) {
    context.addIssue({ code: 'custom', message: 'WorkUnit IDs must be unique' });
  }
  for (const unit of plan.units) {
    if (unit.dependencies.includes(unit.id) || unit.dependencies.some((dependency) => !ids.has(dependency))) {
      context.addIssue({ code: 'custom', message: `WorkUnit ${unit.id} has an invalid dependency` });
    }
  }
  const dependencies = new Map(plan.units.map((unit) => [unit.id, unit.dependencies]));
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const hasCycle = (id: string): boolean => {
    if (visiting.has(id)) return true;
    if (visited.has(id)) return false;
    visiting.add(id);
    for (const dependency of dependencies.get(id) ?? []) {
      if (hasCycle(dependency)) return true;
    }
    visiting.delete(id);
    visited.add(id);
    return false;
  };
  if (plan.units.some((unit) => hasCycle(unit.id))) {
    context.addIssue({ code: 'custom', message: 'WorkUnit dependencies must be acyclic' });
  }
});

const draftWorkPlanSchema = z.object({
  objective: canonicalText(16_384),
  units: z.array(workUnitSchema).length(0),
}).strict();

const contractProvenanceSchema = z.object(Object.fromEntries(
  ENNO_PROVENANCE_KEYS.map((key) => [key, z.enum(['explicit_user', 'repository_evidence', 'inferred'])]),
) as Record<(typeof ENNO_PROVENANCE_KEYS)[number], z.ZodEnum<{
  explicit_user: 'explicit_user';
  repository_evidence: 'repository_evidence';
  inferred: 'inferred';
}>>).strict();

export const acceptanceCriterionSchema = z.object({
  id: identifier,
  description: canonicalText(8_192),
}).strict();

export const skillRequirementSchema = z.object({
  name: canonicalText(300),
  purposes: z.array(z.enum(['planning', 'implementation', 'ui', 'testing', 'review', 'operations'])).min(1).max(6),
  required: z.boolean(),
}).strict();

const skillDiscoverySummarySchema = z.object({
  attempted: z.boolean(),
  mode: z.enum(['off', 'official', 'community']),
  requirements: z.array(canonicalText(300)).max(64),
  queries: z.array(canonicalText(500)).max(3),
  cacheHits: z.number().int().min(0),
  candidates: z.number().int().min(0),
  selected: z.array(z.object({
    skillId: canonicalText(1_000),
    name: canonicalText(500),
    source: canonicalText(201),
    officialStatus: z.enum(['curated', 'catalog-verified', 'owner-verified', 'registry-only', 'unknown']),
    imported: z.boolean(),
    updated: z.boolean(),
  }).strict()).max(2),
  failures: z.array(z.object({
    stage: z.enum(['search', 'source', 'validation', 'persistence']),
    code: canonicalText(200),
  }).strict()).max(128),
}).strict();

const skillSetEntrySchema = z.object({
  name: canonicalText(300),
  purposes: z.array(z.enum(['planning', 'implementation', 'ui', 'testing', 'review', 'operations'])).min(1).max(6),
  required: z.boolean(),
  availability: z.enum(['local', 'imported_fresh', 'external_reference', 'unavailable']),
  referenceId: canonicalText(1_000).nullable(),
}).strict();

const orchestrationIdSchema = canonicalText(256)
  .describe('Exact ennoOduno.orchestrationId returned by task_prepare or task_answer; this is not a host client session ID');

const advisorySlotIds = ADVISORY_SLOT_DEFINITIONS.map((slot) => slot.slotId) as [string, ...string[]];
const advisoryContextSchema = z.object({
  objective: canonicalText(16_384),
  scope: z.array(repositoryRelativePath).max(256),
  constraints: z.array(canonicalText(8_192)).max(32),
  acceptanceCriteria: z.array(canonicalText(8_192)).max(128),
  reference: canonicalText(16_384),
}).strict();

const advisoryEvidenceSchema = z.object({
  path: repositoryRelativePath,
  statement: canonicalText(8_192),
}).strict();

const advisoryContributionSchema = z.union([
  z.object({
    slotId: z.enum(advisorySlotIds),
    outcome: z.literal('completed'),
    summary: canonicalText(8_192),
    recommendations: z.array(canonicalText(8_192)).max(32).default([]),
    risks: z.array(canonicalText(8_192)).max(32).default([]),
    evidence: z.array(advisoryEvidenceSchema).max(32).default([]),
  }).strict(),
  z.object({
    slotId: z.enum(advisorySlotIds),
    outcome: z.enum(ADVISORY_OUTCOMES.filter((outcome) => outcome !== 'completed') as ['failed', 'timeout', 'unavailable']),
    reasonCode: z.enum(ADVISORY_FAILURE_CODES),
  }).strict(),
]);

export const adviceSubmissionSchema = z.object({
  runId: identifier,
  workspace: canonicalText(256),
  orchestrationId: orchestrationIdSchema,
  expectedRevision: z.number().int().min(1),
  mutationRevision: z.number().int().min(0),
  idempotencyKey: identifier,
  phase: z.enum(ADVISORY_PHASES),
  allowlistedContext: advisoryContextSchema,
  contributions: z.array(advisoryContributionSchema).length(3),
}).strict();

const advisoryRoundDigestSchema = z.string().regex(/^[0-9a-f]{64}$/u);

export const ennoContractSchema = z.object({
  revision: z.number().int().min(1),
  scope: z.array(boundedPath).max(256),
  exclusions: z.array(boundedPath).max(256),
  acceptanceCriteria: z.array(acceptanceCriterionSchema).max(128),
  workPlan: z.union([workPlanSchema, draftWorkPlanSchema]),
  skillSet: z.object({
    entries: z.array(skillSetEntrySchema).max(64),
    intakeDiscovery: skillDiscoverySummarySchema,
    zenkiDiscovery: skillDiscoverySummarySchema,
  }).strict(),
  finalVerifiers: z.array(verifierSpecSchema).max(32),
  maxAttempts: z.number().int().min(ENNO_MIN_ATTEMPTS).max(ENNO_MAX_ATTEMPTS),
  provenance: contractProvenanceSchema,
}).strict();

export const ennoRequestHandoffSchema = z.object({
  sourceRole: z.literal('enno-oduno'),
  taskType: z.enum(['build', 'debug', 'review', 'devops']),
  objective: canonicalText(16_384),
  target: canonicalText(4_096).nullable(),
  expected: canonicalText(8_192).nullable(),
  constraints: z.array(canonicalText(8_192)).max(16),
  verification: z.array(canonicalText(8_192)).max(16),
  stopConditions: z.array(canonicalText(8_192)).max(16),
}).strict();

export const odunoIdealSchema = z.object({
  objective: canonicalText(16_384),
  principles: z.array(canonicalText(8_192)).min(1).max(32),
  skillContributions: z.array(z.object({
    skillName: canonicalText(500),
    contribution: canonicalText(8_192),
  }).strict()).max(2),
  successSignals: z.array(canonicalText(8_192)).min(1).max(32),
}).strict().superRefine((ideal, context) => {
  const names = ideal.skillContributions.map((item) => item.skillName);
  if (new Set(names).size !== names.length) {
    context.addIssue({ code: 'custom', message: 'Oduno ideal Skill contributions must be unique', path: ['skillContributions'] });
  }
});

export const odunoMeditationSchema = z.object({
  summary: canonicalText(16_384),
  inspectedPaths: z.array(repositoryRelativePath).min(1).max(256),
  deletionCandidates: z.array(z.object({
    kind: z.enum(['test', 'function']),
    path: repositoryRelativePath,
    name: canonicalText(1_000),
    reason: canonicalText(8_192),
    evidence: z.array(canonicalText(8_192)).min(1).max(16),
  }).strict()).max(128),
}).strict().superRefine((meditation, context) => {
  if (new Set(meditation.inspectedPaths).size !== meditation.inspectedPaths.length) {
    context.addIssue({ code: 'custom', message: 'Oduno meditation inspected paths must be unique', path: ['inspectedPaths'] });
  }
  const inspected = new Set(meditation.inspectedPaths);
  const candidateKeys = new Set<string>();
  for (const [index, candidate] of meditation.deletionCandidates.entries()) {
    if (!inspected.has(candidate.path)) {
      context.addIssue({ code: 'custom', message: 'Deletion candidate path must be inspected', path: ['deletionCandidates', index, 'path'] });
    }
    const key = `${candidate.kind}\0${candidate.path}\0${candidate.name}`;
    if (candidateKeys.has(key)) {
      context.addIssue({ code: 'custom', message: 'Oduno meditation deletion candidates must be unique', path: ['deletionCandidates', index] });
    }
    candidateKeys.add(key);
  }
});

export const idealSubmissionSchema = z.object({
  runId: identifier,
  workspace: canonicalText(256),
  orchestrationId: orchestrationIdSchema,
  expectedRevision: z.number().int().min(1),
  idempotencyKey: identifier,
  advisoryRoundDigest: advisoryRoundDigestSchema.optional(),
  ideal: odunoIdealSchema,
}).strict();

export const planSubmissionSchema = z.object({
  runId: identifier,
  workspace: canonicalText(256),
  orchestrationId: orchestrationIdSchema,
  expectedRevision: z.number().int().min(1),
  idempotencyKey: identifier,
  advisoryRoundDigest: advisoryRoundDigestSchema.optional(),
  scope: z.array(boundedPath).min(1).max(256),
  exclusions: z.array(boundedPath).max(256),
  acceptanceCriteria: z.array(acceptanceCriterionSchema).min(1).max(128),
  workPlan: workPlanSchema,
  skillRequirements: z.array(skillRequirementSchema).max(64),
  finalVerifiers: z.array(verifierSpecSchema).min(1).max(32),
  maxAttempts: z.number().int().min(ENNO_MIN_ATTEMPTS).max(ENNO_MAX_ATTEMPTS).default(8),
  provenance: contractProvenanceSchema,
  capabilities: z.array(z.unknown()).optional().describe(
    'Complete current client capability descriptors. The field remains transport-optional only so omission can return a safe user-facing recovery choice before any plan effect.',
  ),
}).strict().superRefine((submission, context) => {
  const requirements = new Set(submission.skillRequirements.map((requirement) => requirement.name.normalize('NFKC').toLowerCase()));
  const standardSkills = new Set([
    STANDARD_SOUL_SKILL_NAME,
    STANDARD_FUNCTION_SKILL_NAME,
    STANDARD_UI_SKILL_NAME,
  ]);
  for (const unit of submission.workPlan.units) {
    for (const skillName of unit.skillNames) {
      const normalized = skillName.normalize('NFKC').toLowerCase();
      if (!requirements.has(normalized) && !standardSkills.has(normalized)) {
        context.addIssue({
          code: 'custom',
          message: `WorkUnit ${unit.id} uses an undeclared Skill`,
          path: ['workPlan', 'units'],
        });
      }
    }
  }
});

export const ennoAnswerSchema = z.object({
  runId: identifier,
  workspace: canonicalText(256),
  orchestrationId: orchestrationIdSchema,
  expectedRevision: z.number().int().min(1),
  idempotencyKey: identifier,
  action: z.enum(['approve', 'revise', 'cancel']),
  requestedChanges: canonicalText(16_384).optional(),
}).strict().superRefine((value, context) => {
  if (value.action === 'revise' && value.requestedChanges === undefined) {
    context.addIssue({ code: 'custom', message: 'requestedChanges is required when revising' });
  }
  if (value.action !== 'revise' && value.requestedChanges !== undefined) {
    context.addIssue({ code: 'custom', message: 'requestedChanges is only valid when revising' });
  }
});

export const workReportSchema = z.object({
  runId: identifier,
  workspace: canonicalText(256),
  orchestrationId: orchestrationIdSchema,
  expectedRevision: z.number().int().min(1),
  idempotencyKey: identifier,
  workUnitId: identifier,
  result: z.object({
    outcome: z.enum(['completed', 'failed', 'blocked']),
    summary: canonicalText(16_384),
    mutated: z.boolean(),
    changedPaths: z.array(boundedPath).max(256),
  }).strict(),
}).strict();

export const finishSchema = z.object({
  runId: identifier,
  workspace: canonicalText(256),
  orchestrationId: orchestrationIdSchema,
  expectedRevision: z.number().int().min(1),
  idempotencyKey: identifier,
  advisoryRoundDigest: advisoryRoundDigestSchema.optional(),
  review: z.object({
    decision: z.enum(['accept', 'replan']),
    summary: canonicalText(16_384),
  }).strict(),
}).strict();

export const meditationSubmissionSchema = z.object({
  runId: identifier,
  workspace: canonicalText(256),
  orchestrationId: orchestrationIdSchema,
  expectedRevision: z.number().int().min(1),
  idempotencyKey: identifier,
  meditation: odunoMeditationSchema,
}).strict();

function parseBoundary<T>(schema: z.ZodType<T>, input: unknown, message: string): T {
  const parsed = schema.safeParse(input);
  if (!parsed.success) throw new KiokukoError('VALIDATION_ERROR', message);
  return parsed.data;
}

export function parseWorkPlan(input: unknown): WorkPlan {
  return parseBoundary(workPlanSchema, input, 'Enno WorkPlan is invalid');
}

export function parseEnnoContract(input: unknown): EnnoOdunoContract {
  return parseBoundary(ennoContractSchema, input, 'Stored Enno contract is invalid');
}

export function parseEnnoRequestHandoff(input: unknown): EnnoRequestHandoff {
  return parseBoundary(ennoRequestHandoffSchema, input, 'Stored Enno request handoff is invalid');
}

export function parseOdunoIdeal(input: unknown): OdunoIdeal {
  return parseBoundary(odunoIdealSchema, input, 'Stored Oduno ideal is invalid');
}

export function parseOdunoMeditation(input: unknown): OdunoMeditation {
  return parseBoundary(odunoMeditationSchema, input, 'Stored Oduno meditation is invalid');
}

export function parseVerifierSpec(input: unknown): VerifierSpec {
  return parseBoundary(verifierSpecSchema, input, 'Enno verifier is invalid');
}

export function parseWorkReportResult(input: unknown): WorkReportResult {
  return parseBoundary(workReportSchema.shape.result, input, 'Enno work report is invalid');
}

export function parsePlanSubmission(input: unknown): z.infer<typeof planSubmissionSchema> {
  return parseBoundary(planSubmissionSchema, input, 'Enno plan submission is invalid');
}

export function parseAdviceSubmission(input: unknown): z.infer<typeof adviceSubmissionSchema> {
  return parseBoundary(adviceSubmissionSchema, input, 'Enno advisory submission is invalid');
}

export function parseIdealSubmission(input: unknown): z.infer<typeof idealSubmissionSchema> {
  return parseBoundary(idealSubmissionSchema, input, 'Oduno ideal submission is invalid');
}

export function parseEnnoAnswer(input: unknown): z.infer<typeof ennoAnswerSchema> {
  return parseBoundary(ennoAnswerSchema, input, 'Enno answer is invalid');
}

export function parseWorkReport(input: unknown): z.infer<typeof workReportSchema> {
  return parseBoundary(workReportSchema, input, 'Enno work report is invalid');
}

export function parseFinishRequest(input: unknown): z.infer<typeof finishSchema> {
  return parseBoundary(finishSchema, input, 'Enno finish request is invalid');
}

export function parseMeditationSubmission(input: unknown): z.infer<typeof meditationSubmissionSchema> {
  return parseBoundary(meditationSubmissionSchema, input, 'Oduno meditation submission is invalid');
}

export function assertVerifierCwd(repositoryRoot: string, verifier: VerifierSpec): void {
  if (!path.isAbsolute(verifier.cwd)) throw new KiokukoError('VALIDATION_ERROR', 'Verifier cwd must be absolute');
  const relative = path.relative(repositoryRoot, verifier.cwd);
  if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new KiokukoError('SECURITY_REJECTION', 'Verifier cwd must stay inside the canonical repository root');
  }
}

export function assertContractVerifierCwds(repositoryRoot: string, contract: Pick<EnnoOdunoContract, 'workPlan' | 'finalVerifiers'>): void {
  for (const verifier of contract.finalVerifiers) assertVerifierCwd(repositoryRoot, verifier);
  for (const unit of contract.workPlan.units) {
    for (const verifier of unit.focusedVerifiers) assertVerifierCwd(repositoryRoot, verifier);
  }
}
