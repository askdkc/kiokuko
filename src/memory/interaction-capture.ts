import { closeSync, constants, fstatSync, openSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { parseProjectConfigText } from '../config/project-config.js';
import { readContextRunRetrievalState } from '../context/run-state.js';
import type { SqliteDatabase } from '../db/adapter.js';
import { withImmediateTransaction } from '../db/transaction.js';
import { KiokukoError } from '../errors.js';
import { LedgerStore } from '../ledger/store.js';
import { canonicalDirectory, detectRepositoryRoot } from '../repository/detect-root.js';
import { executeIdempotentInTransaction } from '../server/idempotency.js';
import { isCuratorManagedGlobalMemory } from './curator-trust.js';
import { readEntry, recordEntryInTransaction, validateNewEntryInput, type EntryRecord } from './entries.js';
import { findInteractionDuplicate } from './interaction-fingerprint.js';
import { memoryCaptureInputSchema, type interactionMemorySchema } from './interaction-contract.js';
import { GENERAL_COMMUNICATION_TAG, INTERACTION_SOURCE } from './interaction-subjects.js';
import { supersedeEntryInTransaction } from './lifecycle.js';
import { observeLessonInTransaction, type LessonReinforcement } from './lesson-reinforcement.js';
import { findSecretInValue } from './secrets.js';
import { buildStructuredScope, validateApplicability, validateSignals } from './structured-memory.js';
import { ensureGlobalWorkspace, GLOBAL_WORKSPACE, resolveProjectWorkspaceReadOnly, type ResolvedProjectWorkspace } from './workspaces.js';
import type * as z from 'zod/v4';

type Memory = z.output<typeof interactionMemorySchema>;
type Receipt = { entryId: string; revision: number; workspace: string; outcome: 'created' | 'duplicate' | 'corrected' | 'reinforced';
  reinforcement?: LessonReinforcement & { promoted: boolean } };
export interface CaptureOptions { cwd: string; clientKind: string; enabled?: boolean; signal?: AbortSignal; }

/** Recheck the location and binding under the writer lock without registering anything. */
function assertCaptureProject(database: SqliteDatabase, cwd: string, project: ResolvedProjectWorkspace): void {
  const root = detectRepositoryRoot({ cwd: canonicalDirectory(cwd) });
  if (root.root !== project.repositoryRoot) throw new KiokukoError('CONFLICT', 'Capture project location changed');
  const row = database.prepare(`SELECT r.repository_id, r.workspace FROM repository_locations l
    JOIN repositories r ON r.repository_id = l.repository_id WHERE l.canonical_root = ?`)
    .get<{ repository_id: string; workspace: string }>(root.root);
  if (row?.repository_id !== project.repositoryId || row.workspace !== project.workspace) {
    throw new KiokukoError('CONFLICT', 'Capture project binding changed');
  }
  if (root.source === 'binding') {
    const descriptor = openSync(path.join(root.root, '.kiokuko.json'), constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const stat = fstatSync(descriptor);
      if (!stat.isFile() || stat.size > 64 * 1024) throw new KiokukoError('VALIDATION_ERROR', 'Invalid project binding');
      const binding = parseProjectConfigText(readFileSync(descriptor, 'utf8'));
      if (binding.repositoryId !== project.repositoryId || binding.workspace !== project.workspace) {
        throw new KiokukoError('CONFLICT', 'Capture project binding changed');
      }
    } finally { closeSync(descriptor); }
  }
}

function prepareMemory(memory: Memory, project: ResolvedProjectWorkspace | undefined, runId: string | undefined, clientKind: string, now: string) {
  const scope = buildStructuredScope({ visibility: memory.scope,
    retrievalScope: memory.retrievalScope ?? (memory.scope === 'global' ? 'global' : 'project-only'),
    ...(memory.scope === 'project' ? { repositoryId: project!.repositoryId } : {}),
    ...(memory.kind === 'preference' ? { memoryClass: 'preference' as const } : memory.memoryClass === undefined ? {} : { memoryClass: memory.memoryClass }),
    ...(memory.applicability === undefined ? {} : { applicability: validateApplicability(memory.applicability) }),
    ...(memory.signals === undefined ? {} : { signals: validateSignals(memory.signals) }),
    ...(memory.portableReason === undefined ? {} : { portableReason: memory.portableReason }),
  });
  return validateNewEntryInput({
    workspace: memory.scope === 'global' ? GLOBAL_WORKSPACE : project!.workspace,
    kind: memory.kind, title: memory.title.normalize('NFKC'), body: memory.body.normalize('NFKC'),
    ...(memory.summary === undefined ? {} : { summary: memory.summary.normalize('NFKC') }),
    scope, tags: [...(memory.tags ?? []), ...(memory.subjects ?? []).map((subject) => `subject:${subject}`),
      ...(memory.generalCommunication ? [GENERAL_COMMUNICATION_TAG] : [])],
    provenance: { type: INTERACTION_SOURCE, reference: memory.basis, clientKind, timestamp: now,
      ...(runId === undefined ? {} : { runId }),
      ...(project === undefined ? {} : { sourceRepositoryId: project.repositoryId, sourceWorkspace: project.workspace }) },
    status: 'candidate', trustLevel: 'untrusted', confidence: 0.7,
    createdBy: 'kiokuko-mcp', actor: 'kiokuko-mcp',
  }).record;
}

function assertReplacement(database: SqliteDatabase, memory: Memory, workspace: string): EntryRecord | undefined {
  if (memory.replaces === undefined) return undefined;
  const entry = readEntry(database, { workspace, entryId: memory.replaces.entryId });
  const managed = database.prepare('SELECT 1 FROM external_skill_entries WHERE entry_id = ? LIMIT 1').get(entry.id);
  if (entry.revision !== memory.replaces.expectedRevision || entry.status === 'superseded'
    || managed !== undefined || isCuratorManagedGlobalMemory(entry)) {
    throw new KiokukoError('CONFLICT', 'Correction target is stale or managed');
  }
  return entry;
}

/** A paraphrased observation may reference a known lesson, but never overwrite it. */
function reinforcementTarget(database: SqliteDatabase, memory: Memory, workspace: string): EntryRecord | undefined {
  if (memory.reinforces === undefined) return undefined;
  const entry = readEntry(database, { workspace, entryId: memory.reinforces.entryId });
  const managed = database.prepare('SELECT 1 FROM external_skill_entries WHERE entry_id = ? LIMIT 1').get(entry.id);
  if (entry.revision !== memory.reinforces.expectedRevision) {
    throw new KiokukoError('CONFLICT', 'Reinforcement revision changed', { condition: 'reinforcement_revision_changed' });
  }
  if (entry.status === 'superseded'
    || entry.kind !== 'lesson' || entry.scope.visibility !== 'project' || managed !== undefined
    || ![INTERACTION_SOURCE, 'agent_checkpoint'].includes(String(entry.provenance.type))) {
    throw new KiokukoError('CONFLICT', 'Reinforcement target is stale, managed, or not a captured project lesson',
      { condition: 'invalid_reinforcement_target' });
  }
  return entry;
}

/** A non-terminal atomic capture. The caller's model supplies claims, never trust. */
export async function captureInteractionMemory(database: SqliteDatabase, raw: unknown, options: CaptureOptions) {
  const parsed = memoryCaptureInputSchema.safeParse(raw);
  if (!parsed.success) throw new KiokukoError('VALIDATION_ERROR', 'Interaction capture input is invalid');
  const input = parsed.data;
  if (findSecretInValue(input)) throw new KiokukoError('SECURITY_REJECTION', 'Interaction content resembles a secret');
  if (!(options.enabled ?? process.env.KIOKUKO_INTERACTION_MEMORY !== 'off')) return { enabled: false, items: [] };
  if (options.signal?.aborted) throw options.signal.reason;
  const cwd = input.cwd ?? options.cwd;
  // Standalone global capture never inspects or registers a project.
  const project = input.runId === undefined ? undefined : await resolveProjectWorkspaceReadOnly(database, cwd);
  if (input.runId !== undefined && project === undefined) throw new KiokukoError('NOT_FOUND', 'Capture run requires its project');
  const now = new Date().toISOString();
  const records = input.memories.map((memory) => prepareMemory(memory, project, input.runId, options.clientKind, now));
  const scope = 'memory.capture';
  return withImmediateTransaction(database, () => {
    if (options.signal?.aborted) throw options.signal.reason;
    if (project !== undefined) assertCaptureProject(database, cwd, project);
    // Bind the normalized payload, actual transport identity and resolved project, not volatile timestamps.
    const receipts = executeIdempotentInTransaction<Receipt[]>(database, { scope, key: input.operationId,
      request: JSON.parse(JSON.stringify({ ...input, clientKind: options.clientKind, project: project ?? null })) }, () => {
      if (input.runId !== undefined) {
        const state = readContextRunRetrievalState(database, input.runId);
        if (state.run.workspace !== project!.workspace || state.run.status !== 'active' || state.intakeStatus === 'active') {
          throw new KiokukoError('CONFLICT', 'Capture requires an active run with completed intake');
        }
        if (state.run.client.kind !== options.clientKind) throw new KiokukoError('CONFLICT', 'Capture client differs from the task client');
      }
      ensureGlobalWorkspace(database, now);
      const replacements = input.memories.map((memory, index) => assertReplacement(database, memory, records[index]!.workspace));
      const targeted = replacements.filter((entry) => entry !== undefined).map((entry) => entry.id);
      if (new Set(targeted).size !== targeted.length) throw new KiokukoError('VALIDATION_ERROR', 'A batch cannot correct one memory twice');
      return records.map((record, index): Receipt => {
        const old = replacements[index];
        const reinforced = reinforcementTarget(database, input.memories[index]!, record.workspace);
        const duplicate = reinforced ?? findInteractionDuplicate(database, record);
        const saved = duplicate ?? recordEntryInTransaction(database, record, { now });
        if (old !== undefined && old.id !== saved.id) {
          supersedeEntryInTransaction(database, { workspace: old.workspace, oldEntryId: old.id,
            replacementEntryId: saved.id, expectedRevision: old.revision, actor: 'kiokuko-mcp', now });
        }
        const receipt: Receipt = { entryId: saved.id, revision: saved.revision, workspace: saved.workspace,
          outcome: old !== undefined && old.id !== saved.id ? 'corrected' : reinforced !== undefined ? 'reinforced' : duplicate === undefined ? 'created' : 'duplicate' };
        if (input.runId !== undefined && input.memories[index]!.basis === 'observed_result'
          && saved.kind === 'lesson' && saved.workspace === project!.workspace) {
          receipt.reinforcement = observeLessonInTransaction(database, saved, input.runId, now);
        }
        if (input.runId !== undefined) {
          new LedgerStore(database).appendBatchInTransaction(input.runId, { events: [{ eventType: 'memory.proposed', actor: 'kiokuko-mcp',
            payload: { entryId: saved.id, revision: saved.revision, scope: saved.workspace, outcome: receipt.outcome } }] });
        }
        return receipt;
      });
    });
    // Receipts contain no body. A retry after purge acknowledges the operation without recreating it.
    const items = receipts.map((receipt) => {
      const current = database.prepare('SELECT current_revision, status FROM entries WHERE id = ? AND workspace = ?')
        .get<{ current_revision: number; status: string }>(receipt.entryId, receipt.workspace);
      const availability = current === undefined ? 'unavailable' : current.status === 'superseded' ? 'superseded'
        : current.current_revision !== receipt.revision ? 'changed' : 'current';
      return { ...receipt, availability };
    });
    return { enabled: true, items };
  });
}
