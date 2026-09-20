import { scopedMemoryUseSignal } from '../context/scoped-memory-use.js';
import path from 'node:path';
import type { SqliteDatabase } from '../db/adapter.js';
import { LedgerStore } from '../ledger/store.js';
import { KiokukoError } from '../errors.js';
import { assertCapabilityCatalogBinding } from '../akinator/capability-binding.js';
import { deriveMemoryPolicy, resolveCapabilities, hasBlockingRequiredCapability } from '../akinator/capabilities.js';
import { readContextBrokerRunState } from '../context/broker.js';
import { queryScopedContextGated } from '../context/scoped-broker.js';
import { resolveProjectWorkspaceReadOnly } from '../memory/workspaces.js';
import { canonicalContentHash } from '../serialization/validate.js';
import { memoryRefreshSchema, parseAssurance } from './contracts.js';
import { assertAssuranceCwd, assuranceState, bindAssuranceRoot, taskAssuranceReport } from './service.js';

export async function refreshTaskMemory(db: SqliteDatabase, raw: unknown, signal?: AbortSignal) {
  signal?.throwIfAborted();
  const input = parseAssurance(memoryRefreshSchema, raw);
  const run = new LedgerStore(db).readRun(input.runId);
  if (!run) throw new KiokukoError('NOT_FOUND', 'Task run not found');
  assertCapabilityCatalogBinding(run.metadata, input.capabilities);
  const project = await resolveProjectWorkspaceReadOnly(db, input.cwd);
  if (!project || project.workspace !== run.workspace) throw new KiokukoError('CONFLICT', 'Refresh repository differs from run');
  for (const file of input.changedPaths) if (path.isAbsolute(file) || file.split(/[\\/]/).includes('..')) {
    throw new KiokukoError('VALIDATION_ERROR', 'Refresh paths must stay within the repository');
  }
  const digest = canonicalContentHash(input);
  const prior = db.prepare('SELECT request_digest, response_json FROM task_assurance_requests WHERE run_id = ? AND request_id = ?')
    .get<{ request_digest: string; response_json: string }>(input.runId, input.requestId);
  if (prior) {
    if (prior.request_digest !== digest) throw new KiokukoError('CONFLICT', 'Refresh request identity conflicts');
    return JSON.parse(prior.response_json) as Record<string, unknown>;
  }
  const state = assertAssuranceCwd(db, input.runId, input.cwd);
  if (state.revision !== input.expectedRevision) throw new KiokukoError('CONFLICT', 'Refresh revision changed');
  const bound = run.metadata.kiokukoAgentTaskContextBinding;
  const boundBudget = bound && typeof bound === 'object' && !Array.isArray(bound) ? bound.maxContextChars : undefined;
  if (input.maxContextChars !== undefined && typeof boundBudget === 'number' && input.maxContextChars !== boundBudget) throw new KiokukoError('CONFLICT', 'Refresh context budget differs from the prepared run');
  const budget = input.maxContextChars ?? (typeof boundBudget === 'number' ? boundBudget : undefined);
  const current = readContextBrokerRunState(db, input.runId);
  const resolution = resolveCapabilities({ task: run.title ?? current.taskProfile.target ?? "task", profile: current.taskProfile, recommendedTags: current.recommendedTags, capabilities: input.capabilities, memoryUse: 'none' });
  if (hasBlockingRequiredCapability(resolution)) throw new KiokukoError('CONFLICT', 'Required capability unavailable');
  // Rank outside the write transaction; recheck the revision in the broker's atomic persistence gate.
  let response: Record<string, unknown> = {};
  await queryScopedContextGated(db, {
    project, task: run.title ?? current.taskProfile.target ?? "task", taskProfile: current.taskProfile, runId: input.runId,
    recommendedTags: current.recommendedTags, changedPaths: input.changedPaths, errorSignatures: input.errorSignatures,
    ...(budget === undefined ? {} : { characterBudget: budget }),
  }, candidate => {
    const memoryUse = scopedMemoryUseSignal(db, run.workspace, candidate);
    const policy = deriveMemoryPolicy(current.taskProfile, memoryUse, input.capabilities);
    return { persist: !policy.contextWithheld, value: policy, assertBeforePersist: () => {
      signal?.throwIfAborted();
      if (scopedMemoryUseSignal(db, run.workspace, candidate) !== memoryUse) throw new KiokukoError('CONFLICT', 'Memory capability decision changed during refresh');
      if (assuranceState(db, input.runId)?.revision !== input.expectedRevision) throw new KiokukoError('CONFLICT', 'Refresh lost a concurrent update');
    } };
  }, {}, (context, policy) => {
    const after = assuranceState(db, input.runId)!;
    if (after.revision === input.expectedRevision) db.prepare('UPDATE task_assurance SET revision=revision+1 WHERE run_id=?').run(input.runId);
    bindAssuranceRoot(db, input.runId, project.repositoryRoot, policy.contextWithheld ? 'capability_withheld' : context?.retrieval?.status);
    response = { context, memoryPolicy: policy, assurance: taskAssuranceReport(db, input.runId, false) };
    db.prepare('INSERT INTO task_assurance_requests VALUES (?, ?, ?, ?)').run(input.runId, input.requestId, digest, JSON.stringify(response));
  });
  return response;
}
