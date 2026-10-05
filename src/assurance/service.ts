import { INTEGRATION_CONTRACT } from '../setup/standard-skills.js';
import { saveDecision, currentDecision, inheritDecisions, verificationDefinitionHash } from './decisions.js';
import { taskVerificationReport, type TaskVerificationReport } from './verification-state.js';
import { TaskStateConflict } from './conflicts.js';
import { realpathSync } from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import type { SqliteDatabase, SqliteRow } from '../db/adapter.js';
import { withImmediateTransaction } from '../db/transaction.js';
import { KiokukoError } from '../errors.js';
import { LedgerStore } from '../ledger/store.js';
import { readContextBrokerRunState } from '../context/broker.js';
import type { ContextDeliveryView } from '../context/delivery.js';
import { hasActionableMemorySelection, memoryReasoningRequired } from '../akinator/capabilities.js';
import { canonicalContentHash } from '../serialization/validate.js';
import { sanitizeJson } from '../security/sanitize.js';
import { memoryReviewSchema, executionEvidenceSchema, parseAssurance } from './contracts.js';
import { repositoryStateDigest } from './snapshot.js';

export interface AssuranceState extends SqliteRow {
  run_id: string; revision: number; delivery_id: string | null; repository_root: string | null; retrieval_status: string; observed_changes: number;
}
export function assuranceState(db: SqliteDatabase, runId: string): AssuranceState | undefined {
  return db.prepare('SELECT * FROM task_assurance WHERE run_id = ?').get<AssuranceState>(runId);
}
export function enrollAssurance(db: SqliteDatabase, runId: string, now: string): void {
  db.prepare('INSERT INTO task_assurance(run_id, updated_at, verification_version) VALUES (?, ?, 1)').run(runId, now);
}
export function bindAssuranceDelivery(db: SqliteDatabase, delivery: ContextDeliveryView): void {
  const state = assuranceState(db, delivery.runId);
  if (!state || state.delivery_id === delivery.deliveryId) return;
  if (state.repository_root) inheritDecisions(db,delivery.runId,delivery.deliveryId,state.repository_root);
  db.prepare("UPDATE task_assurance SET delivery_id = ?, revision = revision + 1, retrieval_status = ?, updated_at = ? WHERE run_id = ?")
    .run(delivery.deliveryId, delivery.items.length ? 'delivered' : 'no_match', new Date().toISOString(), delivery.runId);
}
export function bindAssuranceRoot(db: SqliteDatabase, runId: string, root: string, retrievalStatus?: string): void {
  const state = assuranceState(db, runId);
  if (!state) return;
  const canonical = realpathSync(root);
  if (state.repository_root && state.repository_root !== canonical) throw new TaskStateConflict('repository_mismatch');
  db.prepare('UPDATE task_assurance SET repository_root = ?, retrieval_status = COALESCE(?, retrieval_status) WHERE run_id = ?')
    .run(canonical, retrievalStatus ?? null, runId);
}
export function assertAssuranceCwd(db: SqliteDatabase, runId: string, cwd: string): AssuranceState {
  const run = new LedgerStore(db).readRun(runId);
  if (!run || run.status !== 'active') throw new TaskStateConflict('run_not_active');
  const state = assuranceState(db, runId);
  if (!state) throw new TaskStateConflict('assurance_unavailable');
  const canonical = realpathSync(cwd);
  let root = state.repository_root;
  if (!root) {
    const rows = db.prepare('SELECT canonical_root FROM repository_locations l JOIN repositories r ON r.repository_id = l.repository_id WHERE r.workspace = ?')
      .all<{ canonical_root: string }>(run.workspace);
    root = rows.find(row => canonical === row.canonical_root || canonical.startsWith(row.canonical_root + path.sep))?.canonical_root ?? null;
  }
  if (!root || (canonical !== root && !canonical.startsWith(root + path.sep))) throw new TaskStateConflict('repository_mismatch');
  return { ...state, repository_root: root };
}
export function assuranceMutation<T extends { runId: string; requestId: string; expectedRevision: number; cwd: string }, R extends object>(
  db: SqliteDatabase, input: T, effect: (state: AssuranceState) => R, advanceRevision = true,
): R & { revision: number } {
  return withImmediateTransaction(db, () => {
    const digest = canonicalContentHash(input);
    const prior = db.prepare('SELECT request_digest, response_json FROM task_assurance_requests WHERE run_id = ? AND request_id = ?')
      .get<{ request_digest: string; response_json: string }>(input.runId, input.requestId);
    if (prior) {
      if (prior.request_digest !== digest) throw new TaskStateConflict('request_id_reused');
      return JSON.parse(prior.response_json) as R & { revision: number };
    }
    const state = assertAssuranceCwd(db, input.runId, input.cwd);
    if (state.revision !== input.expectedRevision) throw new TaskStateConflict('assurance_revision_changed', { expectedRevision: input.expectedRevision, currentRevision: state.revision });
    bindAssuranceRoot(db, input.runId, state.repository_root!);
    const response = { ...effect(state), revision: state.revision + Number(advanceRevision) };
    db.prepare('UPDATE task_assurance SET revision = ?, updated_at = ? WHERE run_id = ?')
      .run(response.revision, new Date().toISOString(), input.runId);
    db.prepare('INSERT INTO task_assurance_requests VALUES (?, ?, ?, ?)').run(input.runId, input.requestId, digest, JSON.stringify(response));
    return response;
  });
}
function assertCurrentDelivery(state: AssuranceState, deliveryId: string | null): void {
  if (state.delivery_id !== deliveryId) throw new KiokukoError('CONFLICT', 'Task delivery changed; review the current delivery');
}
function safeText(value: string): string {
  return sanitizeJson(value).value as string;
}
export function reviewTaskMemory(db: SqliteDatabase, raw: unknown) {
  const input = parseAssurance(memoryReviewSchema, raw);
  return assuranceMutation(db, input, state => {
    assertCurrentDelivery(state, input.deliveryId);
    if (input.dependencies && canonicalContentHash(sanitizeJson(input.dependencies).value) !== canonicalContentHash(input.dependencies)) throw new KiokukoError('SECURITY_REJECTION', 'Decision dependencies contain private or secret-like content');
    const entry = db.prepare(`SELECT e.current_revision FROM context_delivery_entries d JOIN entries e ON e.id = d.entry_id
      WHERE d.delivery_id = ? AND d.entry_id = ? AND d.entry_revision = ?`).get<{ current_revision: number }>(input.deliveryId, input.entryId, input.entryRevision);
    if (!entry || entry.current_revision !== input.entryRevision) throw new KiokukoError('CONFLICT', 'Memory revision changed or was not delivered');
    const inherited = currentDecision(db,input.runId,input.deliveryId,input.entryId,input.entryRevision,state.repository_root!);
    for (const evidenceId of input.evidenceIds) {
      const evidence = db.prepare('SELECT run_id, delivery_id FROM task_execution_evidence WHERE evidence_id = ?').get<{ run_id: string; delivery_id: string | null }>(evidenceId);
      if (!evidence || evidence.run_id !== input.runId || (evidence.delivery_id !== input.deliveryId && !(inherited?.review.evidenceIds.includes(evidenceId)))) throw new KiokukoError('CONFLICT', 'Evidence belongs to another run or delivery');
    }
    db.prepare(`INSERT INTO task_memory_reviews VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(run_id, delivery_id, entry_id, entry_revision) DO UPDATE SET decision=excluded.decision, basis=excluded.basis,
      invariant_text=excluded.invariant_text, counterexample=excluded.counterexample, verification=excluded.verification,
      evidence_ids_json=excluded.evidence_ids_json, created_at=excluded.created_at`)
      .run(input.runId, input.deliveryId, input.entryId, input.entryRevision, input.decision, safeText(input.basis),
        safeText(input.invariant ?? ''), safeText(input.counterexample ?? ''), safeText(input.verification ?? ''), JSON.stringify(input.evidenceIds), new Date().toISOString());
    const decisionId = saveDecision(db,input,state.repository_root!,{ decision: input.decision, evidenceIds: input.evidenceIds, dependencies: input.dependencies });
    return { recorded: true, decisionId, provenance: 'model_reported', untrusted: true };
  });
}
/** Only the local hook adapter calls with client_observed. Public APIs always use model_reported. */
export function recordTaskEvidence(db: SqliteDatabase, raw: unknown, provenance: 'model_reported' | 'client_observed' = 'model_reported', observed?: { executionDigest: string; onRecorded: (evidenceId: string) => void }) {
  const input = parseAssurance(executionEvidenceSchema, raw);
  return assuranceMutation(db, { ...input, provenance }, state => {
    assertCurrentDelivery(state, input.deliveryId);
    if (repositoryStateDigest(state.repository_root!) !== input.stateDigest) throw new KiokukoError('CONFLICT', 'Validation target changed');
    const evidenceId = insertTaskEvidence(db, { runId: input.runId, deliveryId: input.deliveryId, root: state.repository_root!, cwd: input.cwd,
      executionDigest: observed?.executionDigest ?? canonicalContentHash(input.execution), stateDigest: input.stateDigest,
      outcome: input.outcome, exitCode: input.exitCode, provenance, target: input.target });
    observed?.onRecorded(evidenceId);
    db.prepare('UPDATE task_assurance SET observation_sequence=observation_sequence+1 WHERE run_id=?').run(input.runId);
    return { evidenceId, provenance, outcome: input.outcome };
  }, false);
}
/** Insert only; callers own the transaction, authorization and revision transition. */
export function insertTaskEvidence(db: SqliteDatabase, input: { runId: string; deliveryId: string | null; root: string; cwd: string;
  executionDigest: string; stateDigest: string; outcome: 'passed' | 'failed' | 'skipped' | 'unknown'; exitCode: number | null;
  provenance: 'model_reported' | 'client_observed'; target?: string }): string {
  const evidenceId = randomUUID();
  db.prepare('INSERT INTO task_execution_evidence VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
    .run(evidenceId, input.runId, input.deliveryId, input.root, realpathSync(input.cwd), input.executionDigest, input.stateDigest,
      input.outcome, input.exitCode, input.provenance, new Date().toISOString());
  db.prepare('INSERT INTO task_execution_targets VALUES (?, ?)').run(evidenceId, input.target ?? `${process.platform}-${process.arch}`);
  return evidenceId;
}
export interface MemoryAssuranceReport {
  contract?: typeof INTEGRATION_CONTRACT; invalidated?: Array<{entryId:string;reason:string}>;
  observationSequence?: number; decisions?: Array<{entryId:string;decisionId:string;sourceDeliveryId:string}>;
  mode: 'legacy_unobserved' | 'tracked'; revision: number | null; retrieval: string;
  pending: string[]; stale: string[]; missingVerification: string[]; observed: boolean; complete: boolean;
}
/** Execution may start after decisions; passing evidence is required only for completion. */
export function memoryReviewNextAction(report: MemoryAssuranceReport): 'refresh_memory' | 'review_memory_application' | 'proceed' {
  if (report.stale.length) return 'refresh_memory';
  return report.pending.length ? 'review_memory_application' : 'proceed';
}
function memoryAssuranceReport(db: SqliteDatabase, runId: string, verifyState = true): MemoryAssuranceReport {
  const state = assuranceState(db, runId);
  const report: MemoryAssuranceReport = { mode: state ? 'tracked' : 'legacy_unobserved', revision: state?.revision ?? null,
    contract: INTEGRATION_CONTRACT, observationSequence: Number(state?.observation_sequence ?? 0), retrieval: state?.retrieval_status ?? 'unobserved', pending: [], stale: [], missingVerification: [], observed: false, complete: true };
  if (!state) return report;
  const profile = readContextBrokerRunState(db, runId).taskProfile;
  if (!memoryReasoningRequired(profile, 'actionable')) return report;
  if (state.retrieval_status === 'pending') { report.pending.push('memory_retrieval'); report.complete = false; return report; }
  if (!state.delivery_id) return report; // Capability withholding preserves repository-only work.
  const delivery = db.prepare('SELECT run_id FROM context_deliveries WHERE delivery_id = ?').get<{ run_id: string }>(state.delivery_id);
  if (!delivery || delivery.run_id !== runId) throw new KiokukoError('INTEGRITY_ERROR', 'Assurance delivery is missing or belongs to another run');
  const items = db.prepare('SELECT entry_id, entry_revision, selection_reason_json FROM context_delivery_entries WHERE delivery_id = ?')
    .all<{ entry_id: string; entry_revision: number; selection_reason_json: string }>(state.delivery_id);
  let digest: string | null = null;
  let adoptedCount = 0;
  let allObserved = true;
  const codeChange = profile.taskType === 'build' || profile.taskType === 'debug' || state.observed_changes === 1;
  for (const item of items) {
    const actionable = hasActionableMemorySelection([{ selectionReasons: JSON.parse(item.selection_reason_json) as string[] }]);
    const explicitlyReviewed = db.prepare('SELECT 1 FROM task_memory_decisions WHERE run_id=? AND entry_id=? AND entry_revision=? LIMIT 1').get(runId,item.entry_id,item.entry_revision);
    if (!actionable && !explicitlyReviewed) continue;
    const current = db.prepare('SELECT current_revision FROM entries WHERE id = ?').get<{ current_revision: number }>(item.entry_id);
    if (!current || current.current_revision !== item.entry_revision) { report.stale.push(item.entry_id); continue; }
    if (state.repository_root && !digest) digest = repositoryStateDigest(state.repository_root);
    const independent = state.repository_root ? currentDecision(db,runId,state.delivery_id,item.entry_id,item.entry_revision,state.repository_root,digest ?? undefined) : null;
    const review = independent ? { decision: independent.review.decision, evidence_ids_json: JSON.stringify(independent.review.evidenceIds) } : undefined;
    if (independent) (report.decisions ??= []).push({entryId:item.entry_id,decisionId:independent.record.decision_id,sourceDeliveryId:independent.record.source_delivery_id});
    if (!review) { report.pending.push(item.entry_id); (report.invalidated ??= []).push({entryId:item.entry_id,reason:explicitlyReviewed ? 'decision_context_changed' : 'decision_required'}); continue; }
    if (review.decision !== 'adopted' || !codeChange || JSON.parse(item.selection_reason_json).includes('general_communication_preference')) continue;
    adoptedCount += 1;
    if (!verifyState) continue;
    if (!digest && state.repository_root) digest = repositoryStateDigest(state.repository_root);
    const ids = JSON.parse(review.evidence_ids_json) as string[];
    const evidence = ids.map(id => db.prepare('SELECT * FROM task_execution_evidence WHERE evidence_id = ?').get<SqliteRow>(id));
    const valid = evidence.length > 0 && independent?.review.verificationDefinitionHash === verificationDefinitionHash(db, runId) && evidence.every(e => e && e.run_id === runId && (e.delivery_id === state.delivery_id || independent?.review.evidenceIds.includes(String(e.evidence_id)))
      && e.repository_root === state.repository_root && e.state_digest === digest && e.outcome === 'passed' && e.exit_code === 0);
    if (!valid) report.missingVerification.push(item.entry_id);
    if (!valid || evidence.some(e => e?.provenance !== 'client_observed')) allObserved = false;
  }
  report.complete = report.pending.length + report.stale.length + report.missingVerification.length === 0;
  report.observed = verifyState && adoptedCount > 0 && allObserved && report.complete;
  return report;
}
export interface AssuranceReport extends MemoryAssuranceReport {
  verification: TaskVerificationReport;
  completionReady: boolean | null;
}
/** complete remains memory-only; callers must use completionReady for the task. */
export function taskAssuranceReport(db: SqliteDatabase, runId: string, verifyState = true): AssuranceReport {
  const memory = memoryAssuranceReport(db, runId, verifyState);
  const verification = taskVerificationReport(db, runId, verifyState);
  return { ...memory, verification, completionReady: verification.mode === 'legacy_unobserved' ? null : memory.complete && verification.ready };
}
export function assertAssuranceCompletion(db: SqliteDatabase, runId: string, outcome: string): void {
  if (outcome !== 'completed') return;
  const report = taskAssuranceReport(db, runId);
  if (!report.complete) throw new KiokukoError('CONFLICT', 'Memory review or regression verification is incomplete', { assurance: report });
  if (report.completionReady === false) throw new TaskStateConflict('task_verification_incomplete');
}
