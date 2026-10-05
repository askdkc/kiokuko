import type { SqliteDatabase, SqliteRow } from '../db/adapter.js';
import { canonicalContentHash } from '../serialization/validate.js';
import { sanitizeJson } from '../security/sanitize.js';
import { KiokukoError } from '../errors.js';
import { assuranceMutation } from './service.js';
import { parseAssurance } from './contracts.js';
import { TaskStateConflict } from './conflicts.js';
import { repositoryStateDigest } from './snapshot.js';
import { verificationDefineSchema, verificationRecordSchema } from './verification-contracts.js';
import { matchesCiCommit, verificationVersion, type VerificationCheckRow } from './verification-state.js';

export function defineTaskVerification(db: SqliteDatabase, raw: unknown) {
  const input = parseAssurance(verificationDefineSchema, raw);
  return assuranceMutation(db, input, () => {
    const priorVersion = verificationVersion(db, input.runId);
    const version = (priorVersion ?? 0) + 1;
    const clean = sanitizeJson({ reason: input.reason, checks: input.checks }).value as { reason: string; checks: typeof input.checks };
    // Do not silently change identities while sanitizing untrusted descriptions.
    if (canonicalContentHash(clean) !== canonicalContentHash({ reason: input.reason, checks: input.checks }))
      throw new KiokukoError('SECURITY_REJECTION', 'Verification descriptions contain private or secret-like content');
    db.prepare('INSERT INTO task_verification_contracts VALUES (?, ?, ?, ?)').run(input.runId, version, clean.reason, new Date().toISOString());
    const insert = db.prepare('INSERT INTO task_verification_checks VALUES (?, ?, ?, ?, ?, ?, ?)');
    for (const check of clean.checks) {
      const prior = priorVersion === null ? undefined : db.prepare('SELECT * FROM task_verification_checks WHERE run_id=? AND contract_version=? AND check_id=?')
        .get<VerificationCheckRow>(input.runId, priorVersion, check.id);
      const unchanged = prior?.target === check.target && prior.expected === check.expected && prior.method === check.method;
      const hash = unchanged ? prior.definition_hash : canonicalContentHash({ check, version });
      insert.run(input.runId, version, check.id, check.target, check.expected, check.method, hash);
    }
    return { contractVersion: version, checkCount: clean.checks.length, provenance: 'model_reported' as const };
  });
}

export function recordTaskVerification(db: SqliteDatabase, raw: unknown) {
  const input = parseAssurance(verificationRecordSchema, raw);
  return assuranceMutation(db, input, state => {
    if (verificationVersion(db, input.runId) !== input.contractVersion) throw new TaskStateConflict('verification_contract_changed');
    const check = db.prepare('SELECT * FROM task_verification_checks WHERE run_id=? AND contract_version=? AND check_id=?')
      .get<VerificationCheckRow>(input.runId, input.contractVersion, input.checkId);
    if (!check || check.target !== input.target) throw new TaskStateConflict('verification_target_mismatch');
    const digest = repositoryStateDigest(state.repository_root!);
    let outcome: 'passed' | 'failed' | 'skipped' | 'unknown';
    let provenance: 'model_reported' | 'client_observed' = 'model_reported';
    if (input.source.kind === 'local') {
      const evidence = db.prepare('SELECT e.*, t.target FROM task_execution_evidence e LEFT JOIN task_execution_targets t USING(evidence_id) WHERE e.evidence_id=?')
        .get<SqliteRow>(input.source.evidenceId);
      if (!evidence || evidence.run_id !== input.runId || evidence.repository_root !== state.repository_root
        || evidence.state_digest !== digest || evidence.target !== input.target)
        throw new TaskStateConflict('verification_target_mismatch');
      outcome = evidence.outcome as typeof outcome;
      if (outcome === 'passed' && evidence.exit_code !== 0) outcome = 'unknown';
      provenance = evidence.provenance as typeof provenance;
    } else {
      if (!matchesCiCommit(state.repository_root!, input.source.commit)) throw new TaskStateConflict('verification_target_mismatch');
      outcome = input.source.conclusion === 'success' ? 'passed'
        : input.source.conclusion === 'skipped' ? 'skipped'
          : input.source.conclusion === 'unknown' ? 'unknown' : 'failed';
    }
    db.prepare(`INSERT INTO task_verification_results
      (run_id, contract_version, check_id, definition_hash, target, outcome, state_digest, source_json, provenance, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(input.runId, input.contractVersion, input.checkId, check.definition_hash,
        input.target, outcome, digest, JSON.stringify(input.source), provenance, new Date().toISOString());
    return { recorded: true, outcome, provenance };
  });
}
