import { spawnSync } from 'node:child_process';
import type { SqliteDatabase, SqliteRow } from '../db/adapter.js';
import { readContextBrokerRunState } from '../context/broker.js';
import { repositoryStateDigest } from './snapshot.js';
import type { VerificationSource } from './verification-contracts.js';

export interface VerificationCheckRow extends SqliteRow {
  check_id: string; target: string; expected: string; method: string; definition_hash: string;
}
export interface VerificationResultRow extends SqliteRow {
  outcome: 'passed' | 'failed' | 'skipped' | 'unknown'; state_digest: string; source_json: string;
  provenance: 'model_reported' | 'client_observed';
}
export interface TaskVerificationReport {
  mode: 'legacy_unobserved' | 'required' | 'not_required'; contractVersion: number | null;
  ready: boolean; checks: Array<{
    id: string; target: string; expected: string; method: string;
    status: 'pending' | 'passed' | 'failed' | 'skipped' | 'unknown'; stale: boolean;
    provenance: 'model_reported' | 'client_observed' | null;
  }>;
}

export function verificationVersion(db: SqliteDatabase, runId: string): number | null {
  return db.prepare('SELECT MAX(version) version FROM task_verification_contracts WHERE run_id=?')
    .get<{ version: number | null }>(runId)?.version ?? null;
}

/** Remote results can describe this checkout only at the same clean commit. */
export function matchesCiCommit(root: string, commit: string): boolean {
  const options = { encoding: 'utf8' as const, timeout: 5000, maxBuffer: 4 * 1024 * 1024 };
  const head = spawnSync('git', ['-C', root, 'rev-parse', 'HEAD'], options);
  const status = spawnSync('git', ['-C', root, 'status', '--porcelain', '--untracked-files=all'], options);
  return head.status === 0 && status.status === 0 && head.stdout.trim() === commit && status.stdout.trim() === '';
}

export function taskVerificationReport(db: SqliteDatabase, runId: string, verifyState: boolean): TaskVerificationReport {
  const state = db.prepare('SELECT verification_version, repository_root, observed_changes FROM task_assurance WHERE run_id=?')
    .get<{ verification_version: number; repository_root: string | null; observed_changes: number }>(runId);
  const empty = { contractVersion: null, checks: [] };
  if (!state?.verification_version) return { ...empty, mode: 'legacy_unobserved', ready: false };
  const profile = readContextBrokerRunState(db, runId).taskProfile;
  const version = verificationVersion(db, runId);
  const required = profile.taskType === 'build' || profile.taskType === 'debug' || state.observed_changes === 1 || version !== null;
  if (!required) return { ...empty, mode: 'not_required', ready: true };
  if (version === null) return { ...empty, mode: 'required', ready: false };
  const definitions = db.prepare('SELECT * FROM task_verification_checks WHERE run_id=? AND contract_version=? ORDER BY check_id')
    .all<VerificationCheckRow>(runId, version);
  let digest: string | undefined;
  const checks: TaskVerificationReport['checks'] = definitions.map(check => {
    // Select the latest result before comparing definitions: changing a check back
    // must not resurrect a superseded success from an older definition.
    const result = db.prepare('SELECT * FROM task_verification_results WHERE run_id=? AND check_id=? ORDER BY sequence DESC LIMIT 1')
      .get<VerificationResultRow & { definition_hash: string }>(runId, check.check_id);
    let stale = false;
    let status: TaskVerificationReport['checks'][number]['status'] = 'pending';
    if (result) {
      stale = result.definition_hash !== check.definition_hash || !state.repository_root;
      if (!stale && verifyState && state.repository_root) {
        digest ??= repositoryStateDigest(state.repository_root);
        const source = JSON.parse(result.source_json) as VerificationSource;
        stale = result.state_digest !== digest || (source.kind === 'ci' && !matchesCiCommit(state.repository_root, source.commit));
      }
      status = stale ? 'pending' : !verifyState ? 'unknown' : result.outcome;
    }
    return { id: check.check_id, target: check.target, expected: check.expected, method: check.method,
      status, stale, provenance: result?.provenance ?? null };
  });
  return { mode: 'required', contractVersion: version, checks, ready: checks.length > 0 && checks.every(check => check.status === 'passed') };
}
