import { readFileSync } from 'node:fs';
import type { SqliteDatabase } from '../db/adapter.js';
import { codexAssuranceConfigured } from '../setup/codex-hooks.js';
import { taskAssuranceReport } from './service.js';
import { diagnosticError } from '../diagnostics/error.js';

export interface AssuranceDoctorFinding {
  reason: 'task_inspection_failed';
  runId: string;
  repositoryRoot: string | null;
  code: string;
  message: string;
  action: string;
  verification?: 'unverified';
}

export function assuranceDoctor(db: SqliteDatabase, hooksPath?: string, verifyRepositories = false) {
  const findings: AssuranceDoctorFinding[] = [];
  let configured: boolean | 'unchecked' = 'unchecked';
  if (hooksPath) {
    try { configured = codexAssuranceConfigured(readFileSync(hooksPath, 'utf8')); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') return { ok: false, count: 1, detail: 'configuration=invalid; runtime=unconfirmed', findings };
      configured = false;
    }
  }
  const observed = db.prepare('SELECT COUNT(*) AS count FROM codex_hook_requests').get<{ count: number }>()!.count;
  const active = db.prepare("SELECT a.run_id, a.repository_root FROM task_assurance a JOIN ledger_runs r ON r.run_id=a.run_id WHERE r.status='active' ORDER BY a.updated_at DESC, a.run_id LIMIT 21")
    .all<{ run_id: string; repository_root: string | null }>();
  let pending = 0; let stale = 0; let verification = 0; let errors = 0;
  const retrieval: Record<string, number> = {};
  for (const row of active.slice(0, 20)) {
    if (!verifyRepositories) continue;
    try {
      const report = taskAssuranceReport(db, row.run_id);
      pending += report.pending.length; stale += report.stale.length; verification += report.missingVerification.length;
      retrieval[report.retrieval] = (retrieval[report.retrieval] ?? 0) + 1;
    } catch (error) {
      errors += 1;
      const diagnostic = diagnosticError(error);
      findings.push({ reason: 'task_inspection_failed', runId: row.run_id, repositoryRoot: row.repository_root,
        ...diagnostic,
        verification: 'unverified',
        action: diagnostic.code === 'VALIDATION_ERROR' && diagnostic.message === 'Repository snapshot exceeds its byte budget'
          ? 'Live repository verification is unavailable because the 64 MiB inspection budget was exceeded. This does not establish memory corruption or invalidate stored task records. Keep repository files, task records and memory intact; no archive cleanup or identity reset is required to preserve them.'
          : 'Check this task\'s repository files and access, correct the reported inspection error, then rerun kiokuko doctor. Keep task records and memory intact.',
      });
    }
  }
  const lastExecution = db.prepare("SELECT response_shape FROM codex_hook_observations WHERE event_name='PostToolUse' AND tool_name IN ('Bash','exec_command','write_stdin') ORDER BY rowid DESC LIMIT 1").get<{response_shape:string}>();
  const exitMetadata = lastExecution ? JSON.parse(lastExecution.response_shape).exitMetadata ?? 'unconfirmed' : 'unconfirmed';
  const status = errors === 0 ? 'ok' as const : findings.every(finding => finding.code === 'VALIDATION_ERROR' && /^Repository snapshot exceeds its (?:byte|file|submodule depth) budget$/u.test(finding.message)) ? 'attention' as const : 'failed' as const;
  return { ok: status === 'ok', status, count: pending + stale + verification + errors, findings,
    detail: `repositoryVerification=${verifyRepositories ? 'requested' : 'not_requested'}; configuration=${configured}; historicalHookRequests=${observed}; currentClient=unconfirmed; pending=${verifyRepositories ? pending : 'unverified'}; stale=${verifyRepositories ? stale : 'unverified'}; missingVerification=${verifyRepositories ? verification : 'unverified'}; inspectionErrors=${errors}; sampled=${active.length > 20}; retrieval=${verifyRepositories ? JSON.stringify(retrieval) : 'unverified'}; lastExecutionExitMetadata=${exitMetadata}; hookActivityDoesNotProveExitMetadata=true` };
}
