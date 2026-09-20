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
  db.prepare('INSERT INTO task_assurance(run_id, updated_at) VALUES (?, ?)').run(runId, now);
}
export function bindAssuranceDelivery(db: SqliteDatabase, delivery: ContextDeliveryView): void {
  const state = assuranceState(db, delivery.runId);
  if (!state || state.delivery_id === delivery.deliveryId) return;
  db.prepare("UPDATE task_assurance SET delivery_id = ?, revision = revision + 1, retrieval_status = ?, updated_at = ? WHERE run_id = ?")
    .run(delivery.deliveryId, delivery.items.length ? 'delivered' : 'no_match', new Date().toISOString(), delivery.runId);
}
export function bindAssuranceRoot(db: SqliteDatabase, runId: string, root: string, retrievalStatus?: string): void {
  const state = assuranceState(db, runId);
  if (!state) return;
  const canonical = realpathSync(root);
  if (state.repository_root && state.repository_root !== canonical) throw new KiokukoError('CONFLICT', 'Run repository root changed');
  db.prepare('UPDATE task_assurance SET repository_root = ?, retrieval_status = COALESCE(?, retrieval_status) WHERE run_id = ?')
    .run(canonical, retrievalStatus ?? null, runId);
}
export function assertAssuranceCwd(db: SqliteDatabase, runId: string, cwd: string): AssuranceState {
  const run = new LedgerStore(db).readRun(runId);
  if (!run || run.status !== 'active') throw new KiokukoError('CONFLICT', 'Task assurance requires an active run');
  const state = assuranceState(db, runId);
  if (!state) throw new KiokukoError('CONFLICT', 'Historical run has no assurance contract');
  const canonical = realpathSync(cwd);
  let root = state.repository_root;
  if (!root) {
    const rows = db.prepare('SELECT canonical_root FROM repository_locations l JOIN repositories r ON r.repository_id = l.repository_id WHERE r.workspace = ?')
      .all<{ canonical_root: string }>(run.workspace);
    root = rows.find(row => canonical === row.canonical_root || canonical.startsWith(row.canonical_root + path.sep))?.canonical_root ?? null;
  }
  if (!root || (canonical !== root && !canonical.startsWith(root + path.sep))) throw new KiokukoError('CONFLICT', 'Evidence belongs to another repository');
  bindAssuranceRoot(db, runId, root);
  return { ...state, repository_root: root };
}
export function assuranceMutation<T extends { runId: string; requestId: string; expectedRevision: number; cwd: string }, R extends object>(
  db: SqliteDatabase, input: T, effect: (state: AssuranceState) => R,
): R & { revision: number } {
  return withImmediateTransaction(db, () => {
    const digest = canonicalContentHash(input);
    const prior = db.prepare('SELECT request_digest, response_json FROM task_assurance_requests WHERE run_id = ? AND request_id = ?')
      .get<{ request_digest: string; response_json: string }>(input.runId, input.requestId);
    if (prior) {
      if (prior.request_digest !== digest) throw new KiokukoError('CONFLICT', 'Assurance request identity was reused with different content');
      return JSON.parse(prior.response_json) as R & { revision: number };
    }
    const state = assertAssuranceCwd(db, input.runId, input.cwd);
    if (state.revision !== input.expectedRevision) throw new KiokukoError('CONFLICT', 'Task assurance revision changed');
    const response = { ...effect(state), revision: state.revision + 1 };
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
    const entry = db.prepare(`SELECT e.current_revision FROM context_delivery_entries d JOIN entries e ON e.id = d.entry_id
      WHERE d.delivery_id = ? AND d.entry_id = ? AND d.entry_revision = ?`).get<{ current_revision: number }>(input.deliveryId, input.entryId, input.entryRevision);
    if (!entry || entry.current_revision !== input.entryRevision) throw new KiokukoError('CONFLICT', 'Memory revision changed or was not delivered');
    for (const evidenceId of input.evidenceIds) {
      const evidence = db.prepare('SELECT run_id, delivery_id FROM task_execution_evidence WHERE evidence_id = ?').get<{ run_id: string; delivery_id: string | null }>(evidenceId);
      if (!evidence || evidence.run_id !== input.runId || evidence.delivery_id !== input.deliveryId) throw new KiokukoError('CONFLICT', 'Evidence belongs to another run or delivery');
    }
    db.prepare(`INSERT INTO task_memory_reviews VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(run_id, delivery_id, entry_id, entry_revision) DO UPDATE SET decision=excluded.decision, basis=excluded.basis,
      invariant_text=excluded.invariant_text, counterexample=excluded.counterexample, verification=excluded.verification,
      evidence_ids_json=excluded.evidence_ids_json, created_at=excluded.created_at`)
      .run(input.runId, input.deliveryId, input.entryId, input.entryRevision, input.decision, safeText(input.basis),
        safeText(input.invariant ?? ''), safeText(input.counterexample ?? ''), safeText(input.verification ?? ''), JSON.stringify(input.evidenceIds), new Date().toISOString());
    return { recorded: true, provenance: 'model_reported', untrusted: true };
  });
}
/** Only the local hook adapter calls with client_observed. Public APIs always use model_reported. */
export function recordTaskEvidence(db: SqliteDatabase, raw: unknown, provenance: 'model_reported' | 'client_observed' = 'model_reported', observed?: { executionDigest: string; onRecorded: (evidenceId: string) => void }) {
  const input = parseAssurance(executionEvidenceSchema, raw);
  return assuranceMutation(db, { ...input, provenance }, state => {
    assertCurrentDelivery(state, input.deliveryId);
    if (repositoryStateDigest(state.repository_root!) !== input.stateDigest) throw new KiokukoError('CONFLICT', 'Validation target changed');
    const evidenceId = randomUUID();
    db.prepare('INSERT INTO task_execution_evidence VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .run(evidenceId, input.runId, input.deliveryId, state.repository_root!, realpathSync(input.cwd), observed?.executionDigest ?? canonicalContentHash(input.execution), input.stateDigest,
        input.outcome, input.exitCode, provenance, new Date().toISOString());
    observed?.onRecorded(evidenceId);
    return { evidenceId, provenance, outcome: input.outcome };
  });
}
export interface AssuranceReport {
  mode: 'legacy_unobserved' | 'tracked'; revision: number | null; retrieval: string;
  pending: string[]; stale: string[]; missingVerification: string[]; observed: boolean; complete: boolean;
}
export function taskAssuranceReport(db: SqliteDatabase, runId: string, verifyState = true): AssuranceReport {
  const state = assuranceState(db, runId);
  const report: AssuranceReport = { mode: state ? 'tracked' : 'legacy_unobserved', revision: state?.revision ?? null,
    retrieval: state?.retrieval_status ?? 'unobserved', pending: [], stale: [], missingVerification: [], observed: false, complete: true };
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
    if (!hasActionableMemorySelection([{ selectionReasons: JSON.parse(item.selection_reason_json) as string[] }])) continue;
    const current = db.prepare('SELECT current_revision FROM entries WHERE id = ?').get<{ current_revision: number }>(item.entry_id);
    if (!current || current.current_revision !== item.entry_revision) { report.stale.push(item.entry_id); continue; }
    const review = db.prepare('SELECT decision, evidence_ids_json FROM task_memory_reviews WHERE run_id = ? AND delivery_id = ? AND entry_id = ? AND entry_revision = ?')
      .get<{ decision: string; evidence_ids_json: string }>(runId, state.delivery_id, item.entry_id, item.entry_revision);
    if (!review) { report.pending.push(item.entry_id); continue; }
    if (review.decision !== 'adopted' || !codeChange) continue;
    adoptedCount += 1;
    if (!verifyState) continue;
    if (!digest && state.repository_root) digest = repositoryStateDigest(state.repository_root);
    const ids = JSON.parse(review.evidence_ids_json) as string[];
    const evidence = ids.map(id => db.prepare('SELECT * FROM task_execution_evidence WHERE evidence_id = ?').get<SqliteRow>(id));
    const valid = evidence.length > 0 && evidence.every(e => e && e.run_id === runId && e.delivery_id === state.delivery_id
      && e.repository_root === state.repository_root && e.state_digest === digest && e.outcome === 'passed' && e.exit_code === 0);
    if (!valid) report.missingVerification.push(item.entry_id);
    if (!valid || evidence.some(e => e?.provenance !== 'client_observed')) allObserved = false;
  }
  report.complete = report.pending.length + report.stale.length + report.missingVerification.length === 0;
  report.observed = verifyState && adoptedCount > 0 && allObserved && report.complete;
  return report;
}
export function assertAssuranceCompletion(db: SqliteDatabase, runId: string, outcome: string): void {
  if (outcome !== 'completed') return;
  const report = taskAssuranceReport(db, runId);
  if (!report.complete) throw new KiokukoError('CONFLICT', 'Memory review or regression verification is incomplete', { assurance: report });
}
