import { randomUUID } from 'node:crypto';
import { readFileSync, realpathSync } from 'node:fs';
import path from 'node:path';
import type { SqliteDatabase, SqliteRow } from '../db/adapter.js';
import { canonicalContentHash } from '../serialization/validate.js';
import { readContextBrokerRunState } from '../context/broker.js';
import { repositoryStateDigest } from './snapshot.js';
import { KiokukoError } from '../errors.js';

export interface DecisionDependencies { paths: string[]; errors: string[] }
export interface DecisionRecord extends SqliteRow {
  decision_id: string;
  context_hash: string;
  source_delivery_id: string;
  review_json: string;
}
interface Review {
  decision: string;
  evidenceIds: string[];
  verificationDefinitionHash?: string;
  dependencies?: DecisionDependencies | undefined;
}
function fileCondition(root: string, file: string): [string, string | null] {
  if (path.isAbsolute(file) || file.split(/[\\/]/).includes('..')) {
    throw new KiokukoError('VALIDATION_ERROR', 'Decision paths must stay within repository');
  }
  const canonicalRoot = realpathSync(root);
  try {
    const resolved = realpathSync(path.resolve(root, file));
    if (!resolved.startsWith(canonicalRoot + path.sep)) {
      throw new KiokukoError('VALIDATION_ERROR', 'Decision path escapes repository');
    }
    return [file, canonicalContentHash(readFileSync(resolved).toString('base64'))];
  } catch (error) {
    // A missing target is also a condition; creating it invalidates this assessment.
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [file, null];
    throw error;
  }
}
function contextHash(db: SqliteDatabase, runId: string, entryId: string, revision: number,
  root: string, delivery: string, deps?: DecisionDependencies, stateDigest?: string): string {
  const entry = db.prepare('SELECT scope_json FROM entry_revisions WHERE entry_id=? AND revision=?')
    .get<{ scope_json: string }>(entryId, revision);
  const signals = db.prepare('SELECT errors_json FROM task_delivery_signals WHERE delivery_id=?')
    .get<{ errors_json: string }>(delivery);
  const errors = JSON.parse(signals?.errors_json ?? '[]') as string[];
  const selection = db.prepare('SELECT selection_reason_json FROM context_delivery_entries WHERE delivery_id=? AND entry_id=? AND entry_revision=?').get<{selection_reason_json:string}>(delivery,entryId,revision);
  const communication = (JSON.parse(selection?.selection_reason_json ?? '[]') as string[]).includes('general_communication_preference');
  return canonicalContentHash({
    policy: 'review-decision-v1', runId, root,
    profile: readContextBrokerRunState(db, runId).taskProfile,
    entryId, revision, scope: entry?.scope_json,
    files: deps?.paths.length ? deps.paths.map(file => fileCondition(root, file)) : communication ? null : stateDigest ?? repositoryStateDigest(root),
    dependencies: deps ?? null,
    errors: deps?.errors.map(error => [error, errors.includes(error)]) ?? [],
  });
}
function link(db: SqliteDatabase, run: string, delivery: string, entry: string, revision: number, id: string): void {
  db.prepare(`INSERT INTO task_delivery_decisions VALUES (?,?,?,?,?)
    ON CONFLICT(run_id,delivery_id,entry_id,entry_revision) DO UPDATE SET decision_id=excluded.decision_id`)
    .run(run, delivery, entry, revision, id);
}
export function saveDecision(db: SqliteDatabase,
  input: { runId: string; entryId: string; entryRevision: number; deliveryId: string; dependencies?: DecisionDependencies | undefined },
  root: string, review: Review): string {
  const id = randomUUID();
  db.prepare(`INSERT INTO task_memory_decisions
    (decision_id,run_id,entry_id,entry_revision,context_hash,source_delivery_id,review_json) VALUES (?,?,?,?,?,?,?)`)
    .run(id, input.runId, input.entryId, input.entryRevision,
      contextHash(db, input.runId, input.entryId, input.entryRevision, root, input.deliveryId, input.dependencies),
      input.deliveryId, JSON.stringify({ ...review, verificationDefinitionHash: verificationDefinitionHash(db, input.runId) }));
  link(db, input.runId, input.deliveryId, input.entryId, input.entryRevision, id);
  return id;
}
/** Select newest first. Reverting a target must never resurrect a superseded assessment. */
export function currentDecision(db: SqliteDatabase, run: string, delivery: string, entry: string, revision: number,
  root: string, stateDigest?: string): { record: DecisionRecord; review: Review } | null {
  const record = db.prepare(`SELECT * FROM task_memory_decisions
    WHERE run_id=? AND entry_id=? AND entry_revision=? ORDER BY sequence DESC LIMIT 1`)
    .get<DecisionRecord>(run, entry, revision);
  if (!record) return null;
  const review = JSON.parse(record.review_json) as Review;
  if (record.context_hash !== contextHash(db, run, entry, revision, root, delivery, review.dependencies, stateDigest)) return null;
  return { record, review };
}
export function inheritDecisions(db: SqliteDatabase, run: string, delivery: string, root: string): void {
  const items = db.prepare('SELECT entry_id,entry_revision FROM context_delivery_entries WHERE delivery_id=?')
    .all<{ entry_id: string; entry_revision: number }>(delivery);
  if (!items.length) return;
  const digest = repositoryStateDigest(root);
  for (const item of items) {
    const found = currentDecision(db, run, delivery, item.entry_id, item.entry_revision, root, digest);
    if (found) link(db, run, delivery, item.entry_id, item.entry_revision, found.record.decision_id);
    else db.prepare('DELETE FROM task_delivery_decisions WHERE run_id=? AND delivery_id=? AND entry_id=? AND entry_revision=?')
      .run(run, delivery, item.entry_id, item.entry_revision);
  }
}

export function verificationDefinitionHash(db: SqliteDatabase, runId: string): string {
  const definitions = db.prepare(`SELECT check_id, target, definition_hash FROM task_verification_checks
    WHERE run_id=? AND contract_version=(SELECT MAX(version) FROM task_verification_contracts WHERE run_id=?)
    ORDER BY check_id`).all(runId, runId);
  return canonicalContentHash(definitions);
}
