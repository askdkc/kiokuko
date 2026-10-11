import type { SqliteDatabase } from '../db/adapter.js';
import { withImmediateTransaction } from '../db/transaction.js';
import { KiokukoError } from '../errors.js';

const DAY = 86_400_000;
const MAX_RUNS = 50;
const MAX_DETAILS = 5000;

/** Operator-owned opt-in; no runtime may choose a retention period implicitly. */
export function configureDiagnosticRetention(db: SqliteDatabase, days: number | null): void {
  if (days !== null && (!Number.isSafeInteger(days) || days < 1 || days > 36500)) throw new KiokukoError('VALIDATION_ERROR', 'Retention days must be 1–36500, or disabled');
  withImmediateTransaction(db, () => {
    db.prepare('UPDATE diagnostic_retention_settings SET retention_days=?,last_maintenance_at=NULL WHERE singleton=1').run(days);
  });
}

const referenceSources = `SELECT response_json AS value FROM task_assurance_requests
 UNION ALL SELECT review_json FROM task_memory_decisions
 UNION ALL SELECT evidence_ids_json FROM task_memory_reviews
 UNION ALL SELECT source_json FROM task_verification_results
 UNION ALL SELECT response_json FROM gateway_idempotency
 UNION ALL SELECT provenance_json FROM entry_revisions
 UNION ALL SELECT payload_json FROM ledger_events WHERE run_id IN
   (SELECT run_id FROM ledger_runs WHERE status IN ('active','intake'))`;

/** Build one indexed projection instead of rescanning every receipt for every evidence row. */
function prepareProtectedReferences(db: SqliteDatabase): boolean {
  const budget = db.prepare(`SELECT COUNT(*) n, COALESCE(SUM(length(CAST(value AS BLOB))),0) bytes
    FROM (${referenceSources} LIMIT 50001)`).get<{ n: number; bytes: number }>()!;
  if (budget.n > 50000 || budget.bytes > 32 * 1024 * 1024) return false;
  const references = db.prepare(`SELECT DISTINCT j.value FROM (${referenceSources}) s, json_tree(s.value) j
    WHERE j.type='text' LIMIT 200001`).all<{ value: string }>();
  if (references.length > 200000) return false;
  db.exec('CREATE TEMP TABLE IF NOT EXISTS diagnostic_protected_refs(value TEXT PRIMARY KEY); DELETE FROM diagnostic_protected_refs');
  const insert = db.prepare('INSERT INTO diagnostic_protected_refs VALUES(?)');
  for (const reference of references) insert.run(reference.value);
  return true;
}

const protectedEvidence = 'NOT EXISTS(SELECT 1 FROM diagnostic_protected_refs p WHERE p.value=e.evidence_id)';

/** Read-only preview; also used inside the maintenance writer transaction. */
export function diagnosticRetentionReport(db: SqliteDatabase, options: { now?: string; days?: number | null } = {}) {
  const now = options.now ?? new Date().toISOString();
  if (!Number.isFinite(Date.parse(now))) throw new KiokukoError('VALIDATION_ERROR', 'Invalid retention time');
  const setting = db.prepare('SELECT retention_days,last_maintenance_at FROM diagnostic_retention_settings WHERE singleton=1')
    .get<{ retention_days: number | null; last_maintenance_at: string | null }>()!;
  const days = options.days === undefined ? setting.retention_days : options.days;
  if (days !== null && (!Number.isSafeInteger(days) || days < 1 || days > 36500)) throw new KiokukoError('VALIDATION_ERROR', 'Invalid retention days');
  const cutoff = days === null ? null : new Date(Date.parse(now) - days * DAY).toISOString();
  const eligibleRuns = cutoff === null ? [] : db.prepare(`SELECT r.run_id FROM ledger_runs r
    WHERE r.status IN ('completed','failed','cancelled','interrupted') AND r.ended_at < ?
    AND NOT EXISTS(SELECT 1 FROM diagnostic_run_summaries s WHERE s.run_id=r.run_id)
    ORDER BY r.ended_at,r.run_id LIMIT ?`).all<{ run_id: string }>(cutoff, MAX_RUNS).map(row => row.run_id);
  const reusablePages = Number(db.prepare('PRAGMA freelist_count').get()!.freelist_count);
  const pageSize = Number(db.prepare('PRAGMA page_size').get()!.page_size);
  return { retentionDays: days, cutoff, eligibleRuns, lastMaintenanceAt: setting.last_maintenance_at,
    expiredRunCount: Number(db.prepare('SELECT COUNT(*) n FROM diagnostic_run_summaries').get()!.n),
    reusablePages, reusableBytes: reusablePages * pageSize, diskBytesReclaimed: 0,
    detailPolicy: 'Expired diagnostic detail is unavailable. Memories, revisions, feedback, source provenance and replay receipts are retained. Referenced evidence and provenance event chains remain available. SQLite free pages are reusable; no full vacuum is performed.' };
}

/** Bounded daily lifecycle maintenance. Reads and ChatGPT recall never call this. */
export function maintainDiagnosticRetention(db: SqliteDatabase, options: { now?: string; force?: boolean } = {}) {
  return withImmediateTransaction(db, () => {
    const report = diagnosticRetentionReport(db, options);
    const now = options.now ?? new Date().toISOString();
    const compactedRuns: string[] = [];
    const deferredRuns: string[] = [];
    if (report.retentionDays === null || !options.force && report.lastMaintenanceAt !== null
      && Date.parse(now) - Date.parse(report.lastMaintenanceAt) < DAY) return { ...report, compactedRuns, deferredRuns };
    if (report.eligibleRuns.length > 0 && !prepareProtectedReferences(db)) {
      db.prepare('UPDATE diagnostic_retention_settings SET last_maintenance_at=? WHERE singleton=1').run(now);
      return { ...report, compactedRuns, deferredRuns: report.eligibleRuns, deferredReason: 'reference_scan_budget_exceeded' };
    }
    for (const runId of report.eligibleRuns) {
      const count = (table: string) => Number(db.prepare(`SELECT COUNT(*) n FROM ${table} WHERE run_id=?`).get(runId)!.n);
      const evidenceCount = count('task_execution_evidence');
      const callCount = count('codex_hook_tools');
      const eventCount = count('ledger_events');
      if (evidenceCount + callCount + eventCount > MAX_DETAILS) { deferredRuns.push(runId); continue; }
      // Keep complete chains when any event is provenance/evidence. Never sever a linked source.
      const preserveEvents = !!db.prepare(`SELECT 1 FROM ledger_memory_links WHERE event_id IN (SELECT event_id FROM ledger_events WHERE run_id=?)
        UNION ALL SELECT 1 FROM ledger_evidence WHERE run_id=? OR event_id IN (SELECT event_id FROM ledger_events WHERE run_id=?)
        UNION ALL SELECT 1 FROM ledger_purge_audit WHERE event_id IN (SELECT event_id FROM ledger_events WHERE run_id=?)
        UNION ALL SELECT 1 FROM diagnostic_protected_refs WHERE value IN (SELECT event_id FROM ledger_events WHERE run_id=?) LIMIT 1`).get(runId,runId,runId,runId,runId);
      const evidenceSummary = db.prepare('SELECT outcome,provenance,COUNT(*) count FROM task_execution_evidence WHERE run_id=? GROUP BY outcome,provenance').all(runId);
      const lastEvent = db.prepare('SELECT event_hash FROM ledger_events WHERE run_id=? ORDER BY sequence DESC LIMIT 1').get(runId);
      const summary = { evidenceCount, callCount, eventCount, evidenceSummary, lastEventHash: lastEvent?.event_hash ?? null, eventsExpired: !preserveEvents && eventCount > 0 };
      db.prepare('INSERT INTO diagnostic_run_summaries VALUES(?,?,?)').run(runId,now,JSON.stringify(summary));
      db.prepare(`INSERT INTO codex_hook_receipts SELECT identity_digest,call_id,input_digest,completion_state FROM codex_hook_tools WHERE run_id=?`).run(runId);
      db.prepare('DELETE FROM codex_hook_tools WHERE run_id=?').run(runId);
      db.prepare(`DELETE FROM task_execution_targets WHERE evidence_id IN (SELECT e.evidence_id FROM task_execution_evidence e WHERE e.run_id=? AND ${protectedEvidence})`).run(runId);
      db.prepare(`DELETE FROM task_execution_evidence AS e WHERE e.run_id=? AND ${protectedEvidence}`).run(runId);
      if (!preserveEvents) db.prepare('DELETE FROM ledger_events WHERE run_id=?').run(runId);
      compactedRuns.push(runId);
    }
    db.prepare('DELETE FROM codex_hook_observations WHERE rowid IN (SELECT rowid FROM codex_hook_observations WHERE observed_at < ? LIMIT 1000)').run(report.cutoff);
    db.prepare('UPDATE diagnostic_retention_settings SET last_maintenance_at=? WHERE singleton=1').run(now);
    return { ...diagnosticRetentionReport(db, options), compactedRuns, deferredRuns };
  });
}
