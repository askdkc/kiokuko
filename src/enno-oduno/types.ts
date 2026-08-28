import type { SkillDiscoverySummary } from '../skills/types.js';

export const ENNO_STATUSES = [
  'intake',
  'zenki_planning',
  'needs_confirmation',
  'goki_executing',
  'enno_verifying',
  'completed',
  'blocked',
  'cancelled',
] as const;
export type EnnoStatus = (typeof ENNO_STATUSES)[number];

export const ENNO_ROLES = ['enno-oduno', 'zenki', 'goki'] as const;
export type EnnoRole = (typeof ENNO_ROLES)[number];

export const ENNO_CLIENT_KINDS = ['codex', 'claude', 'opencode'] as const;
export type EnnoClientKind = (typeof ENNO_CLIENT_KINDS)[number];

export const ENNO_NEXT_ACTIONS = [
  'answer_intake',
  'submit_plan',
  'ask_user_confirmation',
  'execute_work_unit',
  'run_final_verification',
  'report_blocker',
  'complete',
] as const;
export type EnnoNextAction = (typeof ENNO_NEXT_ACTIONS)[number];

export const ENNO_APPLICABLE_TASK_TYPES = ['build', 'debug', 'review', 'devops'] as const;
export const ENNO_DEFAULT_MAX_ATTEMPTS = 8;
export const ENNO_MIN_ATTEMPTS = 1;
export const ENNO_MAX_ATTEMPTS = 20;
export const ENNO_MAX_TOTAL_SKILL_QUERIES = 3;
export const ENNO_MAX_EXTERNAL_SKILLS = 2;

export type SkillPurpose = 'planning' | 'implementation' | 'ui' | 'testing' | 'review' | 'operations';
export type ContractProvenance = 'explicit_user' | 'repository_evidence' | 'inferred';
export const ENNO_PROVENANCE_KEYS = [
  'scope',
  'exclusions',
  'acceptanceCriteria',
  'workPlan',
  'skillSet',
  'finalVerifiers',
  'maxAttempts',
] as const;
export type EnnoProvenanceKey = (typeof ENNO_PROVENANCE_KEYS)[number];

export interface AcceptanceCriterion {
  id: string;
  description: string;
}

export interface VerifierSpec {
  id: string;
  kind: 'test' | 'typecheck' | 'build' | 'lint' | 'custom';
  executable: string;
  args: string[];
  cwd: string;
  timeoutMs: number;
}

export interface ExpertRef {
  id: string;
  reason: string;
}

export interface WorkUnit {
  id: string;
  objective: string;
  scope: string[];
  dependencies: string[];
  skillNames: string[];
  expertRefs: ExpertRef[];
  acceptanceCriteria: string[];
  focusedVerifiers: VerifierSpec[];
}

export interface WorkPlan {
  objective: string;
  units: WorkUnit[];
}

export interface SkillSetEntry {
  name: string;
  purposes: SkillPurpose[];
  required: boolean;
  availability: 'local' | 'imported_fresh' | 'external_reference' | 'unavailable';
  referenceId: string | null;
}

export interface SkillSetSnapshot {
  entries: SkillSetEntry[];
  intakeDiscovery: SkillDiscoverySummary;
  zenkiDiscovery: SkillDiscoverySummary;
}

export interface EnnoOdunoContract {
  revision: number;
  scope: string[];
  exclusions: string[];
  acceptanceCriteria: AcceptanceCriterion[];
  workPlan: WorkPlan;
  skillSet: SkillSetSnapshot;
  finalVerifiers: VerifierSpec[];
  maxAttempts: number;
  provenance: Record<EnnoProvenanceKey, ContractProvenance>;
}

export interface EnnoRequestHandoff {
  sourceRole: 'enno-oduno';
  taskType: (typeof ENNO_APPLICABLE_TASK_TYPES)[number];
  objective: string;
  target: string | null;
  expected: string | null;
  constraints: string[];
  verification: string[];
  stopConditions: string[];
}

export interface EnnoHarnessDirective {
  kind: EnnoClientKind | null;
  version: string | null;
  continuation: 'stop_hook' | 'session_idle_plugin' | 'unidentified';
  instructions: string[];
}

export interface RoleDirective {
  protocolVersion: 1;
  runId: string;
  contractRevision: number | null;
  role: EnnoRole;
  harness: EnnoHarnessDirective;
  handoff: EnnoRequestHandoff | null;
  objective: string;
  requiredSkills: string[];
  workUnit: WorkUnit | null;
  stopConditions: string[];
  reportSchema: Record<string, unknown>;
}

export interface EnnoOdunoState {
  applicable: boolean;
  status: EnnoStatus;
  orchestrationId: string | null;
  clientBinding: {
    status: 'pending' | 'bound';
    clientKind: EnnoClientKind | null;
    clientVersion: string | null;
    identified: boolean;
  } | null;
  contractRevision: number | null;
  currentRole: EnnoRole | null;
  directive: RoleDirective | null;
  nextAction: EnnoNextAction;
}

export type WorkUnitStatus = 'pending' | 'in_progress' | 'completed' | 'failed' | 'blocked';

export interface StoredWorkUnit {
  workUnit: WorkUnit;
  status: WorkUnitStatus;
  attemptCount: number;
  result: WorkReportResult | null;
}

export interface WorkReportResult {
  outcome: 'completed' | 'failed' | 'blocked';
  summary: string;
  mutated: boolean;
  changedPaths: string[];
}

export interface EnnoFinalReview {
  decision: 'accept' | 'replan';
  summary: string;
}

export type VerifierRunStatus = 'started' | 'passed' | 'failed' | 'timeout' | 'spawn_failed';

export interface VerifierRunResult {
  verifier: VerifierSpec;
  status: Exclude<VerifierRunStatus, 'started'>;
  exitCode: number | null;
  signal: string | null;
  durationMs: number;
  stdoutPreview: string;
  stderrPreview: string;
  stdoutDigest: string;
  stderrDigest: string;
}

export interface EnnoRunSnapshot {
  runId: string;
  workspace: string;
  orchestrationId: string;
  clientKind: EnnoClientKind | null;
  clientVersion: string | null;
  clientSessionId: string | null;
  repositoryRoot: string;
  taskType: (typeof ENNO_APPLICABLE_TASK_TYPES)[number];
  status: EnnoStatus;
  revision: number;
  confirmationState: 'not_required' | 'pending' | 'approved' | 'revision_requested' | 'cancelled';
  attempts: number;
  mutationRevision: number;
  contract: EnnoOdunoContract;
  handoff: EnnoRequestHandoff;
  workUnits: StoredWorkUnit[];
  blocker: string | null;
}
