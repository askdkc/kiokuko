import type { SqliteDatabase } from '../db/adapter.js';
import { KiokukoError } from '../errors.js';
import { withImmediateTransaction } from '../db/transaction.js';
import { recordEntryInTransaction, validateNewEntryInput, type EntryRecord } from './entries.js';
import {
  ensureGlobalWorkspace,
  GLOBAL_WORKSPACE,
  resolveProjectWorkspace,
  resolveProjectWorkspaceReadOnly,
  type ResolvedProjectWorkspace,
} from './workspaces.js';
import { canonicalJson, type EntryKind } from '../serialization/validate.js';
import { buildStructuredScope, hasExplicitApplicability, type Applicability, type MemoryClass, type MemorySignals, type RetrievalScope } from './structured-memory.js';
import { retrieveFederatedMemory, type FederatedScope, type FederatedRecallResult } from './federated-retrieval.js';
import { analyzePortability } from './portability.js';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { isProxy } from 'node:util/types';
import { LedgerStore } from '../ledger/store.js';
import { checkpointEligibility } from '../ledger/checkpoint-eligibility.js';
import type { RunStatus } from '../ledger/types.js';
import { findSecret } from './secrets.js';
import { assertContextFeedbackRecordable, recordContextFeedbackInTransaction } from '../context/feedback.js';
import { readContextDelivery } from '../context/delivery.js';
import { recordKnowledgePathsInTransaction } from '../akinator/knowledge-path.js';
import type { ProjectFingerprint } from '../repository/project-fingerprint.js';

const GIT_PROVENANCE_TIMEOUT_MS = 5_000;
const GIT_PROVENANCE_MAX_BUFFER = 64 * 1024;

interface GitProvenanceExecOptions {
  cwd: string;
  encoding: 'utf8';
  stdio: ['ignore', 'pipe', 'pipe'];
  timeout: number;
  maxBuffer: number;
  env: NodeJS.ProcessEnv;
}

type GitProvenanceExecutor = (
  executable: string,
  args: string[],
  options: GitProvenanceExecOptions,
) => string;

const executeGitProvenance: GitProvenanceExecutor = (executable, args, options) => execFileSync(executable, args, options);

function processFailureText(error: unknown, field: 'stderr' | 'stdout'): string | undefined {
  if (typeof error !== 'object' || error === null) return undefined;
  const value = (error as Record<string, unknown>)[field];
  if (typeof value === 'string') return value;
  return Buffer.isBuffer(value) ? value.toString('utf8') : undefined;
}

function expectedMissingGitCommit(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) return false;
  const failure = error as Record<string, unknown>;
  if (failure.status !== 128 || failure.signal !== null) return false;
  const stderr = processFailureText(error, 'stderr')?.replaceAll('\r\n', '\n').trimEnd();
  return stderr === 'fatal: Needed a single revision'
    || stderr === 'fatal: not a git repository (or any of the parent directories): .git';
}

/** Resolve immutable checkpoint provenance without treating Git failures as an absent commit. */
export function resolveCheckpointSourceCommit(
  repositoryRoot: string,
  execute: GitProvenanceExecutor = executeGitProvenance,
): string | null {
  let output: string;
  try {
    output = execute('git', ['rev-parse', '--verify', 'HEAD^{commit}'], {
      cwd: repositoryRoot,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: GIT_PROVENANCE_TIMEOUT_MS,
      maxBuffer: GIT_PROVENANCE_MAX_BUFFER,
      env: { ...process.env, LC_ALL: 'C', LANG: 'C' },
    });
  } catch (error) {
    if (expectedMissingGitCommit(error)) return null;
    throw new KiokukoError('SERVICE_UNAVAILABLE', 'Git checkpoint provenance could not be resolved');
  }
  const commit = output.replace(/(?:\r\n|\n)$/u, '');
  if (commit !== output && output !== `${commit}\n` && output !== `${commit}\r\n`) {
    throw new KiokukoError('INTEGRITY_ERROR', 'Git checkpoint provenance is invalid');
  }
  if (!/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/u.test(commit)) {
    throw new KiokukoError('INTEGRITY_ERROR', 'Git checkpoint provenance is invalid');
  }
  return commit;
}

export type MemoryScope = FederatedScope;

export interface ScopedRecallInput {
  query: string;
  cwd?: string;
  project?: ResolvedProjectWorkspace;
  fingerprint?: ProjectFingerprint;
  scope?: MemoryScope;
  limit?: number;
  maxChars?: number;
  readOnly?: boolean;
}

export type ScopedRecallResult = FederatedRecallResult;

export interface CheckpointMemory {
  kind: EntryKind;
  title: string;
  body: string;
  summary?: string;
  scope?: 'project' | 'global';
  retrievalScope?: RetrievalScope;
  tags?: string[];
  confidence?: number;
  memoryClass?: MemoryClass;
  applicability?: Applicability;
  signals?: MemorySignals;
  portableReason?: string;
}

export interface ScopedCheckpointInput {
  cwd?: string;
  memories: CheckpointMemory[];
  runId?: string;
  deliveryId?: string;
  outcome?: 'completed' | 'failed' | 'cancelled' | 'interrupted';
  feedback?: unknown[];
  evidence?: unknown;
}

export interface ScopedCheckpointResult {
  project: ResolvedProjectWorkspace | null;
  entries: Array<Pick<EntryRecord, 'id' | 'workspace' | 'kind' | 'status' | 'title' | 'revision'>>;
  run?: { runId: string; status: string; feedbackCount: number; evidenceCount: number; reasoningPaths: number; qualifiedReasoningPaths: number };
}

const CHECKPOINT_MEMORY_FIELDS = new Set([
  'kind', 'title', 'body', 'summary', 'scope', 'retrievalScope', 'tags', 'confidence',
  'memoryClass', 'applicability', 'signals', 'portableReason',
]);
const CHECKPOINT_FEEDBACK_FIELDS = new Set(['entryId', 'entryRevision', 'verdict', 'comment']);
const CHECKPOINT_OUTCOMES = new Set(['completed', 'failed', 'cancelled', 'interrupted']);

function assertCheckpointEligible(status: RunStatus): void {
  const eligibility = checkpointEligibility(status);
  if (eligibility.allowed) return;
  throw new KiokukoError('CONFLICT', 'Checkpoint run is not active', {
    checkpointEligibility: eligibility,
    runStatus: status,
  });
}

function checkpointObject(
  value: unknown,
  allowed: ReadonlySet<string>,
  message: string,
): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value) || isProxy(value)) {
    throw new KiokukoError('VALIDATION_ERROR', message);
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new KiokukoError('VALIDATION_ERROR', message);
  }
  const result: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
  const descriptors = Object.getOwnPropertyDescriptors(value);
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== 'string' || !allowed.has(key)) {
      throw new KiokukoError('VALIDATION_ERROR', message);
    }
    const descriptor = descriptors[key];
    if (descriptor === undefined || !('value' in descriptor) || descriptor.enumerable !== true) {
      throw new KiokukoError('VALIDATION_ERROR', message);
    }
    result[key] = descriptor.value;
  }
  return result;
}

function sameProject(
  left: ResolvedProjectWorkspace | undefined,
  right: ResolvedProjectWorkspace | undefined,
): boolean {
  if (left === undefined || right === undefined) return left === right;
  return left.repositoryRoot === right.repositoryRoot
    && left.repositoryId === right.repositoryId
    && left.workspace === right.workspace;
}

function boundedEvidence(raw: unknown): {
  changedPaths: string[];
  errorSignatures: string[];
  commands: Array<{ executable: string; classification?: string; exitCode?: number; outcome: string; digest?: string }>;
  tests: Array<{ runner: string; target?: string; outcome: string; digest?: string }>;
  verification?: { outcome: string };
} {
  if (raw === undefined) return { changedPaths: [], errorSignatures: [], commands: [], tests: [] };
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) throw new KiokukoError('VALIDATION_ERROR', 'Evidence is invalid');
  let canonicalEvidence: string;
  try {
    canonicalEvidence = canonicalJson(raw);
  } catch (error) {
    if (error instanceof RangeError || (error instanceof KiokukoError && error.code === 'VALIDATION_ERROR')) {
      throw new KiokukoError('VALIDATION_ERROR', 'Evidence is invalid');
    }
    throw error;
  }
  if (findSecret(canonicalEvidence)) throw new KiokukoError('SECURITY_REJECTION', 'Evidence resembles a secret and was not stored');
  const value = raw as Record<string, unknown>;
  if (Object.keys(value).some((field) => !['changedPaths', 'errorSignatures', 'commands', 'tests', 'verification'].includes(field))) throw new KiokukoError('VALIDATION_ERROR', 'Evidence is invalid');
  const strings = (value: unknown, max: number): string[] => {
    if (value === undefined) return [];
    if (!Array.isArray(value) || value.length > max || value.some((item) => typeof item !== 'string' || item.length === 0 || item.length > 500 || /[\u0000-\u001f\u007f]/u.test(item))) throw new KiokukoError('VALIDATION_ERROR', 'Evidence is invalid');
    return [...new Set(value)];
  };
  const changedPaths = strings(value.changedPaths, 200).map((item) => {
    if (item.startsWith('/') || /^[A-Za-z]:[\\/]/u.test(item) || item.split(/[\\/]/u).includes('..')) throw new KiokukoError('VALIDATION_ERROR', 'Evidence path is invalid');
    return item.replaceAll('\\', '/');
  });
  const errorSignatures = strings(value.errorSignatures, 200);
  const normalizeItems = (items: unknown, kind: 'command' | 'test'): Array<Record<string, unknown>> => {
    if (items === undefined) return [];
    if (!Array.isArray(items) || items.length > 100) throw new KiokukoError('VALIDATION_ERROR', 'Evidence is invalid');
    return items.map((item) => {
      if (typeof item !== 'object' || item === null || Array.isArray(item)) throw new KiokukoError('VALIDATION_ERROR', 'Evidence is invalid');
      const record = item as Record<string, unknown>;
      const allowedFields = kind === 'command' ? ['executable', 'classification', 'exitCode', 'outcome', 'digest'] : ['runner', 'target', 'outcome', 'digest'];
      if (Object.keys(record).some((field) => !allowedFields.includes(field))) throw new KiokukoError('VALIDATION_ERROR', 'Evidence is invalid');
      const required = kind === 'command' ? 'executable' : 'runner';
      if (typeof record[required] !== 'string' || record[required].length === 0 || record[required].length > 200) throw new KiokukoError('VALIDATION_ERROR', 'Evidence is invalid');
      if (typeof record.outcome !== 'string' || !['passed', 'failed', 'unknown'].includes(record.outcome)) throw new KiokukoError('VALIDATION_ERROR', 'Evidence is invalid');
      const result: Record<string, unknown> = { [required]: record[required], outcome: record.outcome };
      for (const field of kind === 'command' ? ['classification', 'digest'] : ['target', 'digest']) {
        if (record[field] !== undefined) {
          if (typeof record[field] !== 'string' || record[field].length === 0 || record[field].length > 500) throw new KiokukoError('VALIDATION_ERROR', 'Evidence is invalid');
          result[field] = record[field];
        }
      }
      if (kind === 'command' && record.exitCode !== undefined) {
        const exitCode = record.exitCode;
        if (typeof exitCode !== 'number' || !Number.isSafeInteger(exitCode) || exitCode < 0) throw new KiokukoError('VALIDATION_ERROR', 'Evidence is invalid');
        result.exitCode = exitCode;
      }
      return result;
    });
  };
  const verification = value.verification === undefined ? undefined : (() => {
    if (typeof value.verification !== 'object' || value.verification === null || Array.isArray(value.verification)) throw new KiokukoError('VALIDATION_ERROR', 'Evidence is invalid');
    const verificationValue = value.verification as Record<string, unknown>;
    if (Object.keys(verificationValue).some((field) => field !== 'outcome')) throw new KiokukoError('VALIDATION_ERROR', 'Evidence is invalid');
    const outcome = verificationValue.outcome;
    if (typeof outcome !== 'string' || !['fresh', 'stale', 'failed', 'unknown'].includes(outcome)) throw new KiokukoError('VALIDATION_ERROR', 'Evidence is invalid');
    return { outcome };
  })();
  const commands = normalizeItems(value.commands, 'command') as Array<{ executable: string; classification?: string; exitCode?: number; outcome: string; digest?: string }>;
  const tests = normalizeItems(value.tests, 'test') as Array<{ runner: string; target?: string; outcome: string; digest?: string }>;
  return { changedPaths, errorSignatures, commands, tests, ...(verification === undefined ? {} : { verification }) };
}

export async function recallScopedMemory(database: SqliteDatabase, input: ScopedRecallInput): Promise<ScopedRecallResult> {
  return retrieveFederatedMemory(database, {
    query: input.query,
    ...(input.cwd === undefined ? {} : { cwd: input.cwd }),
    ...(input.project === undefined ? {} : { project: input.project }),
    ...(input.fingerprint === undefined ? {} : { fingerprint: input.fingerprint }),
    ...(input.scope === undefined ? {} : { scope: input.scope }),
    ...(input.limit === undefined ? {} : { limit: input.limit }),
    ...(input.maxChars === undefined ? {} : { maxChars: input.maxChars }),
    ...(input.readOnly === undefined ? {} : { readOnly: input.readOnly }),
  });
}

export async function checkpointScopedMemory(database: SqliteDatabase, input: ScopedCheckpointInput): Promise<ScopedCheckpointResult> {
  if (!Array.isArray(input.memories)) throw new KiokukoError('VALIDATION_ERROR', 'Checkpoint memories must be an array');
  if (input.memories.length === 0 && input.runId === undefined) throw new KiokukoError('VALIDATION_ERROR', 'A checkpoint requires a run or at least one memory');
  if (input.memories.length > 20) throw new KiokukoError('VALIDATION_ERROR', 'At most 20 memories may be checkpointed at once');
  const memories = input.memories.map((memory) => checkpointObject(
    memory,
    CHECKPOINT_MEMORY_FIELDS,
    'Checkpoint memory is invalid',
  ) as unknown as CheckpointMemory);
  if (input.feedback !== undefined && (!Array.isArray(input.feedback) || input.feedback.length > 100)) {
    throw new KiokukoError('VALIDATION_ERROR', 'Checkpoint feedback is invalid');
  }
  const feedback = (input.feedback ?? []).map((item) => checkpointObject(
    item,
    CHECKPOINT_FEEDBACK_FIELDS,
    'Checkpoint feedback is invalid',
  ));
  if (input.outcome !== undefined && !CHECKPOINT_OUTCOMES.has(input.outcome)) {
    throw new KiokukoError('VALIDATION_ERROR', 'Checkpoint outcome is invalid');
  }
  if (input.deliveryId !== undefined && input.runId === undefined) {
    throw new KiokukoError('VALIDATION_ERROR', 'Checkpoint deliveryId requires runId');
  }
  if (input.runId === undefined && feedback.length > 0) {
    throw new KiokukoError('VALIDATION_ERROR', 'Checkpoint feedback requires runId');
  }
  if (feedback.length > 0 && input.deliveryId === undefined) {
    throw new KiokukoError('VALIDATION_ERROR', 'Checkpoint feedback requires deliveryId');
  }
  const evidence = boundedEvidence(input.evidence);
  const hasEvidence = evidence.changedPaths.length > 0 || evidence.errorSignatures.length > 0 || evidence.commands.length > 0 || evidence.tests.length > 0 || evidence.verification !== undefined;
  if (input.runId === undefined && hasEvidence) {
    throw new KiokukoError('VALIDATION_ERROR', 'Checkpoint evidence requires runId');
  }
  const run = input.runId === undefined ? undefined : new LedgerStore(database).readRun(input.runId);
  if (input.runId !== undefined && run === undefined) throw new KiokukoError('NOT_FOUND', 'Checkpoint run was not found');
  if (run !== undefined) assertCheckpointEligible(run.status);
  if (input.deliveryId !== undefined) {
    const delivery = readContextDelivery(database, { workspace: run!.workspace, deliveryId: input.deliveryId });
    if (delivery.runId !== run!.runId) throw new KiokukoError('NOT_FOUND', 'Checkpoint delivery was not found for this run');
  }
  if (memories.length === 0 && feedback.length === 0 && !hasEvidence) {
    throw new KiokukoError('VALIDATION_ERROR', 'An empty checkpoint is not allowed');
  }
  const needsProject = memories.some((memory) => (memory.scope ?? 'project') === 'project');
  const plannedProject = await resolveProjectWorkspaceReadOnly(database, input.cwd);
  if (needsProject && !plannedProject) {
    throw new KiokukoError('NOT_FOUND', 'No Git repository or .kiokuko.json binding was found for project-scoped memory; use scope "global" only for cross-project preferences or lessons');
  }
  if (run && plannedProject !== undefined && run.workspace !== plannedProject.workspace) {
    throw new KiokukoError('NOT_FOUND', 'Checkpoint run was not found');
  }
  const sourceCommit = plannedProject === undefined ? null : resolveCheckpointSourceCommit(plannedProject.repositoryRoot);
  const now = new Date().toISOString();
  const evidenceCount = evidence.changedPaths.length
    + evidence.errorSignatures.length
    + evidence.commands.length
    + evidence.tests.length
    + (evidence.verification === undefined ? 0 : 1);
  const evidenceIds = Array.from({ length: evidenceCount }, () => randomUUID());
  const preparedMemories = memories.map((memory) => {
    const targetScope = memory.scope ?? 'project';
    if (targetScope === 'global'
      && memory.retrievalScope !== undefined
      && memory.retrievalScope !== 'global') {
      throw new KiokukoError('VALIDATION_ERROR', 'Global checkpoint memory requires global retrieval scope');
    }
    const workspace = targetScope === 'global' ? GLOBAL_WORKSPACE : plannedProject!.workspace;
    const baseScope = buildStructuredScope({
      visibility: targetScope,
      ...(targetScope === 'global' ? { retrievalScope: 'global' as const } : {}),
      ...(targetScope === 'project' && plannedProject !== undefined ? { repositoryId: plannedProject.repositoryId } : {}),
      ...(memory.memoryClass === undefined ? {} : { memoryClass: memory.memoryClass }),
      ...(memory.applicability === undefined ? {} : { applicability: memory.applicability }),
      ...(memory.signals === undefined ? {} : { signals: memory.signals }),
      ...(memory.portableReason === undefined ? {} : { portableReason: memory.portableReason }),
    });
    const baseRecord = validateNewEntryInput({
      workspace,
      kind: memory.kind,
      status: 'candidate',
      title: memory.title,
      body: memory.body,
      ...(memory.summary === undefined ? {} : { summary: memory.summary }),
      scope: baseScope,
      provenance: {},
      trustLevel: 'untrusted',
      confidence: memory.confidence ?? 0.7,
      tags: [...new Set([...(memory.tags ?? []), 'agent-checkpoint'])],
      createdBy: 'kiokuko-mcp',
      actor: 'kiokuko-mcp',
    }).record;
    const autoEcosystem = targetScope === 'project'
      && memory.retrievalScope === undefined
      && hasExplicitApplicability(baseRecord.scope)
      && plannedProject !== undefined
      && analyzePortability({
        workspace: plannedProject.workspace,
        title: baseRecord.title,
        summary: baseRecord.summary,
        body: baseRecord.body,
        tags: baseRecord.tags,
        scope: baseRecord.scope,
        provenance: {},
      }).portable;
    const scope = buildStructuredScope({
      visibility: targetScope,
      ...(targetScope === 'global'
        ? { retrievalScope: 'global' as const }
        : memory.retrievalScope !== undefined
          ? { retrievalScope: memory.retrievalScope }
          : autoEcosystem
            ? { retrievalScope: 'ecosystem' as const }
            : {}),
      ...(targetScope === 'project' && plannedProject !== undefined ? { repositoryId: plannedProject.repositoryId } : {}),
      ...(memory.memoryClass === undefined ? {} : { memoryClass: memory.memoryClass }),
      ...(memory.applicability === undefined ? {} : { applicability: memory.applicability }),
      ...(memory.signals === undefined ? {} : { signals: memory.signals }),
      ...(memory.portableReason === undefined ? {} : { portableReason: memory.portableReason }),
    });
    const provenance = {
      type: 'agent_checkpoint',
      reference: 'mcp',
      ...(plannedProject === undefined ? {} : { sourceRepositoryId: plannedProject.repositoryId, sourceWorkspace: plannedProject.workspace }),
      ...(sourceCommit === null ? {} : { sourceCommit }),
      ...(run === undefined ? {} : { runId: run.runId }),
      ...(input.deliveryId === undefined ? {} : { deliveryId: input.deliveryId }),
      ...(evidenceIds.length === 0 ? {} : { evidenceIds }),
      ...(evidence.changedPaths.length === 0 ? {} : { sourcePaths: evidence.changedPaths }),
      clientKind: 'mcp',
      timestamp: now,
    };
    return validateNewEntryInput({ ...baseRecord, scope, provenance }).record;
  });
  const preparedFeedback = feedback.map((value, index) => {
    const record = {
      workspace: run!.workspace,
      deliveryId: input.deliveryId!,
      entryId: value.entryId,
      entryRevision: value.entryRevision,
      verdict: value.verdict,
      comment: value.comment ?? null,
      feedbackId: randomUUID(),
      runId: run!.runId,
      actor: 'kiokuko-mcp',
      idempotencyKey: `checkpoint-feedback-${index}`,
      createdAt: now,
    };
    assertContextFeedbackRecordable(database, record);
    return record;
  });

  const project = await resolveProjectWorkspace(database, input.cwd);
  if (!sameProject(plannedProject, project)) {
    throw new KiokukoError('CONFLICT', 'Checkpoint project identity changed after validation');
  }
  const records = withImmediateTransaction(database, () => {
    const transactionRun = run === undefined ? undefined : new LedgerStore(database).readRun(run.runId);
    if (run !== undefined && transactionRun === undefined) throw new KiokukoError('NOT_FOUND', 'Checkpoint run was not found');
    if (transactionRun !== undefined) assertCheckpointEligible(transactionRun.status);
    if (run !== undefined && transactionRun !== undefined && transactionRun.workspace !== run.workspace) {
      throw new KiokukoError('NOT_FOUND', 'Checkpoint run was not found');
    }
    ensureGlobalWorkspace(database, now);
    const store = transactionRun === undefined ? undefined : new LedgerStore(database, { workspace: transactionRun.workspace });
    const evidenceEvents = [
      ...evidence.changedPaths.map((path) => ({ eventId: randomUUID(), eventType: 'file.changed' as const, actor: 'kiokuko-mcp', occurredAt: now, payload: { path } })),
      ...evidence.errorSignatures.map((signature) => ({ eventId: randomUUID(), eventType: 'error.recorded' as const, actor: 'kiokuko-mcp', occurredAt: now, payload: { signature } })),
      ...evidence.commands.map((command) => ({ eventId: randomUUID(), eventType: 'command.completed' as const, actor: 'kiokuko-mcp', occurredAt: now, outcome: command.outcome, payload: { executable: command.executable, ...(command.classification === undefined ? {} : { classification: command.classification }), ...(command.exitCode === undefined ? {} : { exitCode: command.exitCode }), ...(command.digest === undefined ? {} : { digest: command.digest }) } })),
      ...evidence.tests.map((test) => ({ eventId: randomUUID(), eventType: 'test.completed' as const, actor: 'kiokuko-mcp', occurredAt: now, outcome: test.outcome, payload: { runner: test.runner, ...(test.target === undefined ? {} : { target: test.target }), ...(test.digest === undefined ? {} : { digest: test.digest }) } })),
      ...(evidence.verification === undefined ? [] : [{ eventId: randomUUID(), eventType: 'verification.recorded' as const, actor: 'kiokuko-mcp' as const, occurredAt: now, outcome: evidence.verification.outcome, payload: { outcome: evidence.verification.outcome } }]),
    ];
    const evidenceAck = transactionRun === undefined || evidenceEvents.length === 0 ? { eventIds: [] as string[] } : store!.appendBatchInTransaction(transactionRun.runId, { events: evidenceEvents });
    const evidenceRows: Array<{ kind: 'command' | 'test' | 'file' | 'artifact'; locator: string; eventId: string | null; summary: string; digest?: string }> = [
      ...evidence.changedPaths.map((locator, index) => ({ kind: 'file' as const, locator, eventId: evidenceAck.eventIds[index] ?? null, summary: 'changed relative path' })),
      ...evidence.errorSignatures.map((locator, index) => ({ kind: 'artifact' as const, locator, eventId: evidenceAck.eventIds[evidence.changedPaths.length + index] ?? null, summary: 'sanitized error signature' })),
      ...evidence.commands.map((command, index) => ({ kind: 'command' as const, locator: command.executable, eventId: evidenceAck.eventIds[evidence.changedPaths.length + evidence.errorSignatures.length + index] ?? null, summary: command.classification ?? command.outcome, ...(command.digest === undefined ? {} : { digest: command.digest }) })),
      ...evidence.tests.map((test, index) => ({ kind: 'test' as const, locator: test.runner, eventId: evidenceAck.eventIds[evidence.changedPaths.length + evidence.errorSignatures.length + evidence.commands.length + index] ?? null, summary: test.target ?? test.outcome, ...(test.digest === undefined ? {} : { digest: test.digest }) })),
      ...(evidence.verification === undefined ? [] : [{ kind: 'artifact' as const, locator: 'verification', eventId: evidenceAck.eventIds.at(-1) ?? null, summary: evidence.verification.outcome }]),
    ];
    if (evidenceRows.length !== evidenceIds.length) {
      throw new KiokukoError('INTEGRITY_ERROR', 'Checkpoint evidence projection is invalid');
    }
    if (transactionRun !== undefined) {
      for (let index = 0; index < evidenceRows.length; index += 1) {
        const row = evidenceRows[index]!;
        database.prepare('INSERT INTO ledger_evidence (evidence_id, run_id, event_id, kind, locator, digest_algorithm, digest, byte_size, summary, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, NULL, ?, ?)').run(
          evidenceIds[index]!, transactionRun.runId, row.eventId, row.kind, row.locator, row.digest === undefined ? null : 'sha256', row.digest ?? null, row.summary, now,
        );
      }
    }
    const saved = preparedMemories.map((memory) => recordEntryInTransaction(database, memory, { now }));
    const memoryEvents = saved.map((entry) => ({ eventId: randomUUID(), eventType: 'memory.proposed' as const, actor: 'kiokuko-mcp', occurredAt: now, payload: { entryId: entry.id, revision: entry.revision } }));
    const memoryAck = transactionRun === undefined || memoryEvents.length === 0 ? { eventIds: [] as string[] } : store!.appendBatchInTransaction(transactionRun.runId, { events: memoryEvents });
    const eventId = evidenceAck.eventIds[0] ?? memoryAck.eventIds[0] ?? null;
    if (transactionRun !== undefined) {
      for (const entry of saved) {
        database.prepare('INSERT INTO ledger_memory_links (link_id, run_id, event_id, delivery_id, entry_id, created_at) VALUES (?, ?, ?, ?, ?, ?)').run(randomUUID(), transactionRun.runId, eventId, input.deliveryId ?? null, entry.id, now);
      }
      for (const feedbackRecord of preparedFeedback) {
        recordContextFeedbackInTransaction(database, feedbackRecord);
      }
      const paths = recordKnowledgePathsInTransaction(database, {
        runId: transactionRun.runId,
        workspace: transactionRun.workspace,
        entries: saved,
        outcome: input.outcome ?? 'completed',
        verification: {
          fresh: evidence.verification?.outcome === 'fresh',
          passedTests: evidence.tests.filter((test) => test.outcome === 'passed').length,
          passedCommands: evidence.commands.filter((command) => command.outcome === 'passed').length,
          evidenceCount: evidenceRows.length,
        },
        createdAt: now,
      });
      const updated = new LedgerStore(database).updateRunStatusInTransaction(transactionRun.runId, input.outcome ?? 'completed', now);
      return {
        saved,
        run: {
          runId: updated.runId,
          status: updated.status,
          feedbackCount: preparedFeedback.length,
          evidenceCount: evidenceRows.length,
          reasoningPaths: paths.recorded,
          qualifiedReasoningPaths: paths.qualified,
        },
      };
    }
    return { saved, run: undefined };
  });

  return {
    project: project ?? null,
    entries: records.saved.map(({ id, workspace, kind, status, title, revision }) => ({ id, workspace, kind, status, title, revision })),
    ...(records.run === undefined ? {} : { run: records.run }),
  };
}
