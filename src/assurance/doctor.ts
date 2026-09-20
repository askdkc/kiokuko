import { readFileSync } from 'node:fs';
import type { SqliteDatabase } from '../db/adapter.js';
import { codexAssuranceConfigured } from '../setup/codex-hooks.js';
import { taskAssuranceReport } from './service.js';
export function assuranceDoctor(db: SqliteDatabase, hooksPath?: string) {
  let configured: boolean | 'unchecked' = 'unchecked';
  if (hooksPath) {
    try { configured = codexAssuranceConfigured(readFileSync(hooksPath, 'utf8')); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') return { ok: false, count: 1, detail: 'configuration=invalid; runtime=unconfirmed' };
      configured = false;
    }
  }
  const observed = db.prepare('SELECT COUNT(*) AS count FROM codex_hook_requests').get<{ count: number }>()!.count;
  const active = db.prepare("SELECT a.run_id FROM task_assurance a JOIN ledger_runs r ON r.run_id=a.run_id WHERE r.status='active' ORDER BY a.updated_at DESC LIMIT 21")
    .all<{ run_id: string }>();
  let pending = 0; let stale = 0; let verification = 0; let errors = 0;
  const retrieval: Record<string, number> = {};
  for (const row of active.slice(0, 20)) {
    try {
      const report = taskAssuranceReport(db, row.run_id);
      pending += report.pending.length; stale += report.stale.length; verification += report.missingVerification.length;
      retrieval[report.retrieval] = (retrieval[report.retrieval] ?? 0) + 1;
    } catch { errors += 1; }
  }
  return { ok: errors === 0, count: pending + stale + verification + errors,
    detail: `configuration=${configured}; historicalHookRequests=${observed}; currentClient=unconfirmed; pending=${pending}; stale=${stale}; missingVerification=${verification}; inspectionErrors=${errors}; sampled=${active.length > 20}; retrieval=${JSON.stringify(retrieval)}` };
}
