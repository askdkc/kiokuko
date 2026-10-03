import * as z from 'zod/v4';
import { createHash, randomUUID } from 'node:crypto';
import type { SqliteDatabase } from '../db/adapter.js';
import { withImmediateTransaction } from '../db/transaction.js';
import { KiokukoError } from '../errors.js';
import { LedgerStore } from '../ledger/store.js';
import { AgentGatewayService } from '../gateway/agent-service.js';
import { canonicalContentHash } from '../serialization/validate.js';
import { resolveProjectWorkspaceReadOnly } from '../memory/workspaces.js';
import { canonicalDirectory } from '../repository/detect-root.js';
import {
  captureProjectManifestSnapshot, bindProjectManifestSnapshot, assertProjectManifestSnapshotBinding,
} from '../repository/project-fingerprint.js';
import { assuranceState, enrollAssurance, bindAssuranceRoot } from '../assurance/service.js';
import { getAkinatorStateService } from './service.js';
import { resolveCapabilities, hasBlockingRequiredCapability } from './capabilities.js';
import { capabilityCatalogDigest, assertCapabilityCatalogBinding } from './capability-binding.js';
import { assertPreparationCapabilities, capabilityCatalogSchema } from './capability-contract.js';
import {
  readTaskContextRequestBinding, bindTaskContextRequest, bindSkillDiscoveryRequest,
  skillDiscoveryRequestIdentity, assertSkillDiscoveryRequestBinding, finalizeAgentTask,
} from './agent-task.js';
import { readSkillDiscoveryConfig } from '../skills/config.js';

const id = z.string().min(1).max(256).refine(value => value.trim() === value && !/\p{Cc}/u.test(value));
export const preparationRecoverySchema = z.object({
  cwd: z.string().min(1).max(4096),
  runId: id,
  requestId: id,
  operationId: id,
  expectedRevision: z.number().int().min(0),
  soulRead: z.literal(true),
  previousCapabilities: z.array(z.unknown()).optional(),
  capabilities: capabilityCatalogSchema,
}).strict();
type RecoveryInput = z.infer<typeof preparationRecoverySchema>;
interface Receipt {
  [key: string]: string;
  predecessor_run_id: string;
  successor_run_id: string;
  request_digest: string;
  operation_hash: string;
  logical_request_hash: string;
}
function conflict(message: string): never { throw new KiokukoError('CONFLICT', message); }

/** Establish the immutable predecessor identity without retrieving its memories. */
async function readPredecessor(db: SqliteDatabase, input: RecoveryInput) {
  const root = canonicalDirectory(input.cwd);
  const project = await resolveProjectWorkspaceReadOnly(db, root);
  if (!project) conflict('Recovery project is not registered');
  const old = new LedgerStore(db).readRun(input.runId);
  if (!old || old.workspace !== project.workspace
    || assuranceState(db, old.runId)?.repository_root !== project.repositoryRoot) {
    conflict('Recovery repository differs from predecessor');
  }
  assertCapabilityCatalogBinding(old.metadata, input.previousCapabilities);
  const openingKey = `mcp-task-prepare-${canonicalContentHash({ version: 1, requestId: input.requestId })}`;
  const opening = db.prepare("SELECT response_json FROM gateway_idempotency WHERE scope='agent.run.open' AND key_hash=?")
    .get<{ response_json: string }>(createHash('sha256').update(openingKey).digest('hex'));
  if (!opening || JSON.parse(opening.response_json).runId !== old.runId) {
    conflict('Logical request does not identify predecessor');
  }
  const session = db.prepare('SELECT session_id FROM run_intakes WHERE run_id=?')
    .get<{ session_id: string }>(old.runId);
  if (!session) conflict('Predecessor intake is unavailable');
  const intake = await getAkinatorStateService(db, { workspace: old.workspace, sessionId: session.session_id });
  const capabilities = resolveCapabilities({
    task: intake.session.task, profile: intake.session.profile, recommendedTags: intake.recommendedTags,
    capabilities: input.previousCapabilities, memoryUse: 'none',
  });
  if (!hasBlockingRequiredCapability(capabilities)) conflict('Predecessor is not capability blocked');
  const binding = readTaskContextRequestBinding(old.metadata);
  if (!binding) conflict('Predecessor retrieval binding is unavailable');
  return { root, project, old, intake, binding };
}
type Predecessor = Awaited<ReturnType<typeof readPredecessor>>;

/** Check safety again under the write lock, including work admitted by client hooks. */
function assertUnexecutedPredecessor(db: SqliteDatabase, input: RecoveryInput, old: Predecessor['old']): void {
  const current = new LedgerStore(db).readRun(old.runId)!;
  const state = assuranceState(db, old.runId);
  if (!['active', 'intake'].includes(current.status) || state?.revision !== input.expectedRevision
    || current.lastSequence !== old.lastSequence) conflict('Predecessor state changed');
  const executed = db.prepare(`SELECT 1 FROM ledger_events WHERE run_id=? AND event_type NOT IN
    ('intake.started','intake.answered','intake.ready','intake.exhausted','run.started') LIMIT 1`).get(old.runId);
  const evidence = db.prepare('SELECT 1 FROM task_execution_evidence WHERE run_id=? LIMIT 1').get(old.runId);
  const hook = db.prepare('SELECT 1 FROM codex_hook_tools WHERE run_id=? LIMIT 1').get(old.runId);
  const running = db.prepare("SELECT 1 FROM agent_task_skill_discovery_attempts WHERE run_id=? AND state='started' LIMIT 1")
    .get(old.runId);
  if (executed || evidence || hook || running) conflict('Predecessor has execution or in-flight work');
}

/** Recover only an unexecuted capability-blocked task; retain its immutable history. */
export async function recoverTaskPreparation(db: SqliteDatabase, raw: unknown, signal?: AbortSignal) {
  const parsed = preparationRecoverySchema.safeParse(raw);
  if (!parsed.success) throw new KiokukoError('VALIDATION_ERROR', 'Invalid preparation recovery input');
  const input = parsed.data;
  assertPreparationCapabilities(input.capabilities);
  signal?.throwIfAborted();
  const { root, project, old, intake, binding } = await readPredecessor(db, input);
  const requestDigest = canonicalContentHash({
    ...input, cwd: root, previousCapabilities: capabilityCatalogDigest(input.previousCapabilities),
    capabilities: capabilityCatalogDigest(input.capabilities),
  });
  const operationHash = canonicalContentHash(input.operationId);
  const logicalHash = canonicalContentHash(input.requestId);
  const manifestSnapshot = captureProjectManifestSnapshot(project);
  const discovery = skillDiscoveryRequestIdentity(readSkillDiscoveryConfig().mode, input.capabilities);
  const successor = withImmediateTransaction(db, () => {
    signal?.throwIfAborted();
    const operation = db.prepare('SELECT predecessor_run_id FROM task_preparation_recoveries WHERE operation_hash=?')
      .get<{ predecessor_run_id: string }>(operationHash);
    if (operation && operation.predecessor_run_id !== old.runId) conflict('Recovery operation belongs to another predecessor');
    const prior = db.prepare('SELECT * FROM task_preparation_recoveries WHERE predecessor_run_id=?')
      .get<Receipt>(old.runId);
    if (prior) {
      if (prior.request_digest !== requestDigest || prior.operation_hash !== operationHash
        || prior.logical_request_hash !== logicalHash) conflict('Recovery operation conflicts');
      return prior.successor_run_id;
    }
    assertUnexecutedPredecessor(db, input, old);
    const newRunId = randomUUID();
    const gateway = new AgentGatewayService(db, { runIdFactory: () => newRunId });
    gateway.openRunInTransaction({
      idempotencyKey: `recovery-${canonicalContentHash({ predecessor: old.runId, operationHash })}`,
      request: {
        apiVersion: '1', workspace: old.workspace, client: old.client,
        captureProfile: old.captureProfile, coverage: old.coverage,
        task: { title: old.title ?? intake.session.task, query: intake.session.task, profileHints: intake.session.profile },
        capabilities: input.capabilities,
        metadata: bindTaskContextRequest(bindSkillDiscoveryRequest(
          bindProjectManifestSnapshot({ source: 'mcp' }, project, manifestSnapshot), discovery,
        ), binding.maxContextChars, binding.temporal, binding.relatedMode),
      },
    }, { predecessorRunId: old.runId });
    const now = new Date().toISOString();
    enrollAssurance(db, newRunId, now);
    bindAssuranceRoot(db, newRunId, project.repositoryRoot, 'pending');
    const store = new LedgerStore(db);
    store.appendBatchInTransaction(old.runId, { events: [{
      eventId: randomUUID(), eventType: 'run.closed', actor: 'kiokuko', occurredAt: now,
      payload: { status: 'failed', reason: 'capability_preparation_recovered', successorRunId: newRunId },
    }] });
    store.updateRunStatusInTransaction(old.runId, 'failed', now);
    db.prepare(`INSERT INTO task_preparation_recoveries
      (predecessor_run_id,successor_run_id,request_digest,operation_hash,logical_request_hash,
       old_catalog_digest,new_catalog_digest,created_at) VALUES (?,?,?,?,?,?,?,?)`)
      .run(old.runId, newRunId, requestDigest, operationHash, logicalHash,
        capabilityCatalogDigest(input.previousCapabilities), capabilityCatalogDigest(input.capabilities), now);
    return newRunId;
  });
  const newRun = new LedgerStore(db).readRun(successor)!;
  if (!['active', 'intake'].includes(newRun.status)) conflict('Recovered successor is terminal');
  assertProjectManifestSnapshotBinding(newRun.metadata, project, manifestSnapshot);
  assertSkillDiscoveryRequestBinding(newRun.metadata, discovery);
  const session = db.prepare('SELECT session_id FROM run_intakes WHERE run_id=?')
    .get<{ session_id: string }>(successor)!;
  const context = await getAkinatorStateService(db, { workspace: old.workspace, sessionId: session.session_id });
  const prepared = await finalizeAgentTask({
    database: db, project,
    executionContext: {
      canonicalCwd: root, repositoryRoot: project.repositoryRoot,
      cwdIsRepositoryRoot: root === project.repositoryRoot, pathPolicy: 'canonical_absolute_under_repository_root',
    },
    manifestSnapshot, context, runId: successor, capabilities: input.capabilities,
    maxContextChars: binding.maxContextChars,
    ...(binding.temporal === undefined ? {} : { temporal: binding.temporal }),
    relatedMode: binding.relatedMode, discoveryMode: discovery.mode,
    ...(signal === undefined ? {} : { signal }),
  });
  return { ...prepared, recoveredFromRunId: old.runId };
}
