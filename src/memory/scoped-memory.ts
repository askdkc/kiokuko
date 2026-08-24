import type { SqliteDatabase } from '../db/adapter.js';
import { KiokukoError } from '../errors.js';
import { withImmediateTransaction } from '../db/transaction.js';
import { recordEntryInTransaction, type EntryRecord } from './entries.js';
import { ensureGlobalWorkspace, GLOBAL_WORKSPACE, resolveProjectWorkspace, type ResolvedProjectWorkspace } from './workspaces.js';
import type { EntryKind } from '../serialization/validate.js';
import { buildStructuredScope, hasExplicitApplicability, type Applicability, type MemoryClass, type MemorySignals, type RetrievalScope } from './structured-memory.js';
import { retrieveFederatedMemory, type FederatedScope, type FederatedRecallResult } from './federated-retrieval.js';
import { analyzePortability } from './portability.js';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { LedgerStore } from '../ledger/store.js';
import { findSecret } from './secrets.js';
import { canonicalJson } from '../serialization/validate.js';
import { recordContextFeedbackInTransaction } from '../context/feedback.js';
import { recordKnowledgePathsInTransaction } from '../akinator/knowledge-path.js';

export type MemoryScope = FederatedScope;

export interface ScopedRecallInput {
  query: string;
  cwd?: string;
  project?: ResolvedProjectWorkspace;
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
  } catch {
    throw new KiokukoError('VALIDATION_ERROR', 'Evidence is invalid');
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
    ...(input.scope === undefined ? {} : { scope: input.scope }),
    ...(input.limit === undefined ? {} : { limit: input.limit }),
    ...(input.maxChars === undefined ? {} : { maxChars: input.maxChars }),
    ...(input.readOnly === undefined ? {} : { readOnly: input.readOnly }),
  });
}

export async function checkpointScopedMemory(database: SqliteDatabase, input: ScopedCheckpointInput): Promise<ScopedCheckpointResult> {
  if (input.memories.length === 0 && input.runId === undefined) throw new KiokukoError('VALIDATION_ERROR', 'A checkpoint requires a run or at least one memory');
  if (input.memories.length > 20) throw new KiokukoError('VALIDATION_ERROR', 'At most 20 memories may be checkpointed at once');
  ensureGlobalWorkspace(database);
  const needsProject = input.memories.some((memory) => (memory.scope ?? 'project') === 'project');
  const project = await resolveProjectWorkspace(database, input.cwd);
  if (needsProject && !project) {
    throw new KiokukoError('NOT_FOUND', 'No Git repository or .kiokuko.json binding was found for project-scoped memory; use scope "global" only for cross-project preferences or lessons');
  }
  const evidence = boundedEvidence(input.evidence);
  if (input.runId === undefined && (input.feedback?.length ?? 0) > 0) {
    throw new KiokukoError('VALIDATION_ERROR', 'Checkpoint feedback requires runId');
  }
  const hasEvidence = evidence.changedPaths.length > 0 || evidence.errorSignatures.length > 0 || evidence.commands.length > 0 || evidence.tests.length > 0 || evidence.verification !== undefined;
  if (input.runId === undefined && hasEvidence) {
    throw new KiokukoError('VALIDATION_ERROR', 'Checkpoint evidence requires runId');
  }
  if (input.memories.length === 0 && input.feedback?.length === 0 && evidence.changedPaths.length === 0 && evidence.errorSignatures.length === 0 && evidence.commands.length === 0 && evidence.tests.length === 0 && evidence.verification === undefined) {
    throw new KiokukoError('VALIDATION_ERROR', 'An empty checkpoint is not allowed');
  }
  const run = input.runId === undefined ? undefined : new LedgerStore(database).readRun(input.runId);
  if (input.runId !== undefined && (!run || (project !== undefined && run.workspace !== project.workspace))) {
    throw new KiokukoError('NOT_FOUND', 'Checkpoint run was not found');
  }
  if (run && !['active'].includes(run.status)) throw new KiokukoError('CONFLICT', 'Checkpoint run is not active');

  const sourceCommit = project === undefined ? null : (() => {
    try {
      return execFileSync('git', ['rev-parse', 'HEAD'], { cwd: project.repositoryRoot, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim() || null;
    } catch {
      return null;
    }
  })();
  const records = withImmediateTransaction(database, () => {
    const now = new Date().toISOString();
    const store = run === undefined ? undefined : new LedgerStore(database, { workspace: run.workspace });
    const evidenceEvents = [
      ...evidence.changedPaths.map((path) => ({ eventId: randomUUID(), eventType: 'file.changed' as const, actor: 'kiokuko-mcp', occurredAt: now, payload: { path } })),
      ...evidence.errorSignatures.map((signature) => ({ eventId: randomUUID(), eventType: 'error.recorded' as const, actor: 'kiokuko-mcp', occurredAt: now, payload: { signature } })),
      ...evidence.commands.map((command) => ({ eventId: randomUUID(), eventType: 'command.completed' as const, actor: 'kiokuko-mcp', occurredAt: now, outcome: command.outcome, payload: { executable: command.executable, ...(command.classification === undefined ? {} : { classification: command.classification }), ...(command.exitCode === undefined ? {} : { exitCode: command.exitCode }), ...(command.digest === undefined ? {} : { digest: command.digest }) } })),
      ...evidence.tests.map((test) => ({ eventId: randomUUID(), eventType: 'test.completed' as const, actor: 'kiokuko-mcp', occurredAt: now, outcome: test.outcome, payload: { runner: test.runner, ...(test.target === undefined ? {} : { target: test.target }), ...(test.digest === undefined ? {} : { digest: test.digest }) } })),
      ...(evidence.verification === undefined ? [] : [{ eventId: randomUUID(), eventType: 'verification.recorded' as const, actor: 'kiokuko-mcp' as const, occurredAt: now, outcome: evidence.verification.outcome, payload: { outcome: evidence.verification.outcome } }]),
    ];
    const evidenceAck = run === undefined || evidenceEvents.length === 0 ? { eventIds: [] as string[] } : store!.appendBatchInTransaction(run.runId, { events: evidenceEvents });
    const evidenceRows: Array<{ kind: 'command' | 'test' | 'file' | 'artifact'; locator: string; eventId: string | null; summary: string; digest?: string }> = [
      ...evidence.changedPaths.map((locator, index) => ({ kind: 'file' as const, locator, eventId: evidenceAck.eventIds[index] ?? null, summary: 'changed relative path' })),
      ...evidence.errorSignatures.map((locator, index) => ({ kind: 'artifact' as const, locator, eventId: evidenceAck.eventIds[evidence.changedPaths.length + index] ?? null, summary: 'sanitized error signature' })),
      ...evidence.commands.map((command, index) => ({ kind: 'command' as const, locator: command.executable, eventId: evidenceAck.eventIds[evidence.changedPaths.length + evidence.errorSignatures.length + index] ?? null, summary: command.classification ?? command.outcome, ...(command.digest === undefined ? {} : { digest: command.digest }) })),
      ...evidence.tests.map((test, index) => ({ kind: 'test' as const, locator: test.runner, eventId: evidenceAck.eventIds[evidence.changedPaths.length + evidence.errorSignatures.length + evidence.commands.length + index] ?? null, summary: test.target ?? test.outcome, ...(test.digest === undefined ? {} : { digest: test.digest }) })),
      ...(evidence.verification === undefined ? [] : [{ kind: 'artifact' as const, locator: 'verification', eventId: evidenceAck.eventIds.at(-1) ?? null, summary: evidence.verification.outcome }]),
    ];
    const evidenceIds = evidenceRows.map(() => randomUUID());
    if (run !== undefined) {
      for (let index = 0; index < evidenceRows.length; index += 1) {
        const row = evidenceRows[index]!;
        database.prepare('INSERT INTO ledger_evidence (evidence_id, run_id, event_id, kind, locator, digest_algorithm, digest, byte_size, summary, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, NULL, ?, ?)').run(
          evidenceIds[index]!, run.runId, row.eventId, row.kind, row.locator, row.digest === undefined ? null : 'sha256', row.digest ?? null, row.summary, now,
        );
      }
    }
    const saved = input.memories.map((memory) => {
      const targetScope = memory.scope ?? 'project';
      const workspace = targetScope === 'global' ? GLOBAL_WORKSPACE : project!.workspace;
      const baseScope = buildStructuredScope({
        visibility: targetScope,
        ...(targetScope === 'project' && project !== undefined ? { repositoryId: project.repositoryId } : {}),
        ...(memory.memoryClass === undefined ? {} : { memoryClass: memory.memoryClass }),
        ...(memory.applicability === undefined ? {} : { applicability: memory.applicability }),
        ...(memory.signals === undefined ? {} : { signals: memory.signals }),
        ...((memory.portableReason === undefined && targetScope === 'global' && memory.kind === 'preference')
          ? { portableReason: 'preferences are portable across projects' }
          : memory.portableReason === undefined ? {} : { portableReason: memory.portableReason }),
      });
      const autoEcosystem = targetScope === 'project'
        && memory.retrievalScope === undefined
        && hasExplicitApplicability(baseScope)
        && project !== undefined
        && analyzePortability({ workspace: project.workspace, title: memory.title, summary: memory.summary ?? null, body: memory.body, tags: memory.tags ?? [], scope: baseScope, provenance: {} }).portable;
      const scope = buildStructuredScope({
        visibility: targetScope,
        ...(memory.retrievalScope !== undefined ? { retrievalScope: memory.retrievalScope } : autoEcosystem ? { retrievalScope: 'ecosystem' as const } : {}),
        ...(targetScope === 'project' && project !== undefined ? { repositoryId: project.repositoryId } : {}),
        ...(memory.memoryClass === undefined ? {} : { memoryClass: memory.memoryClass }),
        ...(memory.applicability === undefined ? {} : { applicability: memory.applicability }),
        ...(memory.signals === undefined ? {} : { signals: memory.signals }),
        ...((memory.portableReason === undefined && targetScope === 'global' && memory.kind === 'preference')
          ? { portableReason: 'preferences are portable across projects' }
          : memory.portableReason === undefined ? {} : { portableReason: memory.portableReason }),
      });
      const provenance = {
        type: 'agent_checkpoint',
        reference: 'mcp',
        ...(project === undefined ? {} : { sourceRepositoryId: project.repositoryId, sourceWorkspace: project.workspace }),
        ...(sourceCommit === null ? {} : { sourceCommit }),
        ...(run === undefined ? {} : { runId: run.runId }),
        ...(input.deliveryId === undefined ? {} : { deliveryId: input.deliveryId }),
        ...(evidenceIds.length === 0 ? {} : { evidenceIds }),
        ...(evidence.changedPaths.length === 0 ? {} : { sourcePaths: evidence.changedPaths }),
        clientKind: 'mcp',
        timestamp: now,
      };
      return recordEntryInTransaction(database, {
        workspace,
        kind: memory.kind,
        status: 'candidate',
        title: memory.title,
        body: memory.body,
        ...(memory.summary === undefined ? {} : { summary: memory.summary }),
        scope,
        provenance,
        trustLevel: 'untrusted',
        confidence: memory.confidence ?? 0.7,
        tags: [...new Set([...(memory.tags ?? []), 'agent-checkpoint'])],
        createdBy: 'kiokuko-mcp',
        actor: 'kiokuko-mcp',
      });
    });
    const memoryEvents = saved.map((entry) => ({ eventId: randomUUID(), eventType: 'memory.proposed' as const, actor: 'kiokuko-mcp', occurredAt: now, payload: { entryId: entry.id, revision: entry.revision } }));
    const memoryAck = run === undefined || memoryEvents.length === 0 ? { eventIds: [] as string[] } : store!.appendBatchInTransaction(run.runId, { events: memoryEvents });
    const eventId = evidenceAck.eventIds[0] ?? memoryAck.eventIds[0] ?? null;
    if (run !== undefined) {
      for (const entry of saved) {
        database.prepare('INSERT INTO ledger_memory_links (link_id, run_id, event_id, delivery_id, entry_id, created_at) VALUES (?, ?, ?, ?, ?, ?)').run(randomUUID(), run.runId, eventId, input.deliveryId ?? null, entry.id, now);
      }
      for (let index = 0; index < (input.feedback ?? []).length; index += 1) {
        const feedback = input.feedback![index];
        if (input.deliveryId === undefined || typeof feedback !== 'object' || feedback === null || Array.isArray(feedback)) throw new KiokukoError('VALIDATION_ERROR', 'Checkpoint feedback requires deliveryId');
        const value = feedback as Record<string, unknown>;
        if (Object.keys(value).some((field) => !['entryId', 'entryRevision', 'verdict', 'comment'].includes(field))) throw new KiokukoError('VALIDATION_ERROR', 'Checkpoint feedback is invalid');
        if (typeof value.entryRevision !== 'number' || !Number.isSafeInteger(value.entryRevision) || value.entryRevision < 1) throw new KiokukoError('VALIDATION_ERROR', 'Checkpoint feedback requires a positive entryRevision');
        recordContextFeedbackInTransaction(database, {
          workspace: run.workspace,
          deliveryId: input.deliveryId,
          entryId: value.entryId,
          entryRevision: value.entryRevision,
          verdict: value.verdict,
          comment: value.comment ?? null,
          feedbackId: randomUUID(),
          runId: run.runId,
          actor: 'kiokuko-mcp',
          idempotencyKey: `checkpoint-feedback-${index}`,
          createdAt: now,
        });
      }
      const paths = recordKnowledgePathsInTransaction(database, {
        runId: run.runId,
        workspace: run.workspace,
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
      const updated = new LedgerStore(database).updateRunStatusInTransaction(run.runId, input.outcome ?? 'completed', now);
      return {
        saved,
        run: {
          runId: updated.runId,
          status: updated.status,
          feedbackCount: input.feedback?.length ?? 0,
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
