import { TaskStateConflict } from './conflicts.js';
import { indexingSources, createIndexWork,assertIndexingRunReady } from '../memory/index-service.js';
import { scopedMemoryUseSignal } from '../context/scoped-memory-use.js';
import path from 'node:path';
import type { SqliteDatabase } from '../db/adapter.js';
import { LedgerStore } from '../ledger/store.js';
import { KiokukoError } from '../errors.js';
import { assertCapabilityCatalogBinding } from '../akinator/capability-binding.js';
import { deriveMemoryPolicy, resolveCapabilities, hasBlockingRequiredCapability } from '../akinator/capabilities.js';
import { readContextBrokerRunState } from '../context/broker.js';
import { queryScopedContextGated } from '../context/scoped-broker.js';
import { readTaskContextRequestBinding } from '../akinator/agent-task.js';
import { resolveProjectWorkspaceReadOnly } from '../memory/workspaces.js';
import { canonicalContentHash } from '../serialization/validate.js';
import { memoryRefreshSchema, parseAssurance } from './contracts.js';
import { assertAssuranceCwd, assuranceState, bindAssuranceRoot, taskAssuranceReport, memoryReviewNextAction } from './service.js';

export async function refreshTaskMemory(db: SqliteDatabase, raw: unknown, signal?: AbortSignal) {
  signal?.throwIfAborted();
  const input = parseAssurance(memoryRefreshSchema, raw);
  const run = new LedgerStore(db).readRun(input.runId);
  if (!run) throw new KiokukoError('NOT_FOUND', 'Task run not found');
  assertCapabilityCatalogBinding(run.metadata, input.capabilities);
  const project = await resolveProjectWorkspaceReadOnly(db, input.cwd);
  if (!project || project.workspace !== run.workspace) throw new TaskStateConflict('repository_mismatch');
  for (const file of input.changedPaths) if (path.isAbsolute(file) || file.split(/[\\/]/).includes('..')) {
    throw new KiokukoError('VALIDATION_ERROR', 'Refresh paths must stay within the repository');
  }
  const digest = canonicalContentHash(input);
  const prior = db.prepare('SELECT request_digest, response_json FROM task_assurance_requests WHERE run_id = ? AND request_id = ?')
    .get<{ request_digest: string; response_json: string }>(input.runId, input.requestId);
  if (prior) {
    if (prior.request_digest !== digest) throw new TaskStateConflict('request_id_reused');
    return JSON.parse(prior.response_json) as Record<string, unknown>;
  }
  const state = assertAssuranceCwd(db, input.runId, input.cwd);
  if (state.revision !== input.expectedRevision) throw new TaskStateConflict('assurance_revision_changed', { expectedRevision: input.expectedRevision, currentRevision: state.revision });
  const retrievalBinding = readTaskContextRequestBinding(run.metadata);
  const boundBudget = retrievalBinding?.maxContextChars;
  if (input.maxContextChars !== undefined && typeof boundBudget === 'number' && input.maxContextChars !== boundBudget) throw new TaskStateConflict('context_budget_mismatch');
  const budget = input.maxContextChars ?? (typeof boundBudget === 'number' ? boundBudget : undefined);
  const current = readContextBrokerRunState(db, input.runId);
  const resolution = resolveCapabilities({ task: run.title ?? current.taskProfile.target ?? "task", profile: current.taskProfile, recommendedTags: current.recommendedTags, capabilities: input.capabilities, memoryUse: 'none' });
  if (hasBlockingRequiredCapability(resolution)) throw new TaskStateConflict('required_capability_unavailable');
  // Rank outside the write transaction; recheck the revision in the broker's atomic persistence gate.
  if(input.indexing)assertIndexingRunReady(db,input.runId);
  const indexing = input.indexing ? indexingSources(db, run.workspace, input.indexing.stage, input.indexing.cursor) : undefined;
  let response: Record<string, unknown> = {};
  await queryScopedContextGated(db, {
    ...(indexing === undefined ? {} : { indexingSourceIds: indexing.map(e => e.id) }),
    project, task: run.title ?? current.taskProfile.target ?? "task", taskProfile: current.taskProfile, runId: input.runId,
    recommendedTags: current.recommendedTags, changedPaths: input.changedPaths, errorSignatures: input.errorSignatures,
    ...(retrievalBinding?.temporal === undefined ? {} : { temporal: retrievalBinding.temporal }),
    relatedMode: retrievalBinding?.relatedMode ?? 'off',
    ...(budget === undefined ? {} : { characterBudget: budget }),
  }, candidate => {
    const memoryUse = scopedMemoryUseSignal(db, run.workspace, candidate);
    const policy = deriveMemoryPolicy(current.taskProfile, memoryUse, input.capabilities);
    return { persist: !policy.contextWithheld, value: policy, assertBeforePersist: () => {
      signal?.throwIfAborted();
      if (scopedMemoryUseSignal(db, run.workspace, candidate) !== memoryUse) throw new TaskStateConflict('retrieval_state_changed');
      const latest = assertAssuranceCwd(db, input.runId, input.cwd);
      if (latest.revision !== input.expectedRevision) throw new TaskStateConflict('assurance_revision_changed', { expectedRevision: input.expectedRevision, currentRevision: latest.revision });
    } };
  }, {}, (context, policy) => {
    const after = assuranceState(db, input.runId)!;
    if (after.revision === input.expectedRevision) db.prepare('UPDATE task_assurance SET revision=revision+1 WHERE run_id=?').run(input.runId);
    bindAssuranceRoot(db, input.runId, project.repositoryRoot, policy.contextWithheld ? 'capability_withheld' : context?.retrieval?.status);
    const indexWork = input.indexing && context?.deliveryId && !policy.contextWithheld ? createIndexWork(db, {
      runId: input.runId,
      deliveryId: context.deliveryId,
      workspace: run.workspace,
      stage: input.indexing.stage,
      sourceIds: context.items.map(item => item.entryId),
      remainingCharacters: Math.max(0, (budget ?? 8000) - context.items.reduce((sum, item) =>
        sum + Array.from(item.title + (item.summary ?? '') + item.bodyPreview).length, 0)),
    }) : undefined;
    const indexResult = indexWork ? {
      ...indexWork,
      nextCursor: indexing?.at(-1)?.id ?? input.indexing?.cursor,
      unprocessed: (indexing ?? []).filter(entry => !context?.items.some(item => item.entryId === entry.id))
        .map(entry => ({ entryId: entry.id, reason: 'context_budget_or_capability' })),
    } : undefined;
    const assurance = taskAssuranceReport(db, input.runId, false);
    response = { ...(indexResult ? { indexing: indexResult } : {}), context, memoryPolicy: policy, assurance, nextAction: memoryReviewNextAction(assurance) };
    db.prepare('INSERT INTO task_assurance_requests VALUES (?, ?, ?, ?)').run(input.runId, input.requestId, digest, JSON.stringify(response));
  });
  return response;
}
