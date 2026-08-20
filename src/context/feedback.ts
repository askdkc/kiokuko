import { createHash } from 'node:crypto';
import type { SqliteDatabase, SqliteRow } from '../db/adapter.js';
import { withImmediateTransaction } from '../db/transaction.js';
import { KiokukoError } from '../errors.js';
import { sanitizeJson } from '../security/sanitize.js';
import { canonicalContentHash } from '../serialization/validate.js';

export const MAX_FEEDBACK_COMMENT_BYTES = 4 * 1024;
export const MAX_FEEDBACK_IDENTIFIER_LENGTH = 256;

export const CONTEXT_FEEDBACK_VERDICTS = ['helpful', 'irrelevant', 'stale', 'conflicting'] as const;
export type ContextFeedbackVerdict = (typeof CONTEXT_FEEDBACK_VERDICTS)[number];
export const RUN_FEEDBACK_RECOMMENDATION_VERDICTS = ['accepted', 'dismissed', 'resolved'] as const;
export type RunFeedbackRecommendationVerdict = (typeof RUN_FEEDBACK_RECOMMENDATION_VERDICTS)[number];

export interface ContextFeedbackRecord {
  feedbackId: string;
  workspace: string;
  deliveryId: string;
  entryId: string;
  runId: string;
  verdict: ContextFeedbackVerdict;
  comment: string | null;
  actor: string;
  /** The idempotency key is stored as this lowercase SHA-256 digest; the raw key is never returned. */
  idempotencyKeyHash: string;
  createdAt: string;
}

export interface FeedbackListPage<T> {
  records: T[];
  truncated: boolean;
}

export interface ContextFeedbackListInput {
  workspace: string;
  runId?: string;
  deliveryId?: string;
  entryId?: string;
  limit?: number;
}

export interface RunFeedbackRecord {
  feedbackId: string;
  workspace: string;
  runId: string;
  outcome: string | null;
  recommendationCode: string | null;
  recommendationVerdict: RunFeedbackRecommendationVerdict | null;
  rating: number | null;
  comment: string | null;
  actor: string;
  /** The idempotency key is stored as this lowercase SHA-256 digest; the raw key is never returned. */
  idempotencyKeyHash: string;
  createdAt: string;
}

export interface RunFeedbackListInput {
  workspace: string;
  runId?: string;
  limit?: number;
}

interface ValidatedContextFeedbackInput {
  feedbackId: string;
  workspace: string;
  deliveryId: string;
  entryId: string;
  runId: string;
  verdict: ContextFeedbackVerdict;
  comment: string | null;
  actor: string;
  idempotencyKeyHash: string;
  createdAt: string;
}

interface ContextFeedbackRow extends SqliteRow {
  feedback_id: unknown;
  delivery_id: unknown;
  entry_id: unknown;
  run_id: unknown;
  verdict: unknown;
  comment: unknown;
  actor: unknown;
  idempotency_key: unknown;
  created_at: unknown;
  run_workspace: unknown;
  delivery_run_id: unknown;
  joined_delivery_id: unknown;
  linked_delivery_id: unknown;
  linked_entry_id: unknown;
  entry_workspace: unknown;
}

interface RunFeedbackRow extends SqliteRow {
  feedback_id: unknown;
  run_id: unknown;
  outcome: unknown;
  recommendation_code: unknown;
  recommendation_verdict: unknown;
  rating: unknown;
  comment: unknown;
  actor: unknown;
  idempotency_key: unknown;
  created_at: unknown;
  run_workspace: unknown;
}

const CONTEXT_INPUT_FIELDS = new Set([
  'workspace', 'feedbackId', 'deliveryId', 'entryId', 'runId', 'verdict',
  'comment', 'actor', 'idempotencyKey', 'createdAt',
]);
const CONTEXT_LIST_FIELDS = new Set(['workspace', 'runId', 'deliveryId', 'entryId', 'limit']);
const RUN_INPUT_FIELDS = new Set([
  'workspace', 'feedbackId', 'runId', 'outcome', 'recommendationCode', 'recommendationVerdict',
  'rating', 'comment', 'actor', 'idempotencyKey', 'createdAt',
]);
const RUN_LIST_FIELDS = new Set(['workspace', 'runId', 'limit']);
const VALIDATION_MESSAGE = 'Feedback input is invalid';
const NOT_FOUND_MESSAGE = 'Feedback target was not found';
const CONFLICT_MESSAGE = 'Feedback conflicts with existing record';
const INTEGRITY_MESSAGE = 'Stored feedback is invalid';
const DATABASE_MESSAGE = 'Feedback database operation failed';

function fail(code: 'VALIDATION_ERROR' | 'NOT_FOUND' | 'CONFLICT' | 'INTEGRITY_ERROR' | 'DATABASE_ERROR', message: string): never {
  throw new KiokukoError(code, message);
}

function validation(): never {
  return fail('VALIDATION_ERROR', VALIDATION_MESSAGE);
}

function notFound(): never {
  return fail('NOT_FOUND', NOT_FOUND_MESSAGE);
}

function conflict(): never {
  return fail('CONFLICT', CONFLICT_MESSAGE);
}

function integrity(): never {
  return fail('INTEGRITY_ERROR', INTEGRITY_MESSAGE);
}

function databaseFailure(): never {
  return fail('DATABASE_ERROR', DATABASE_MESSAGE);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function isKiokukoError(error: unknown): error is KiokukoError {
  return error instanceof KiokukoError;
}

function normalizeDatabaseError(error: unknown): never {
  if (isKiokukoError(error)) throw error;
  if (error instanceof Error && /unique|constraint/i.test(error.message)) conflict();
  databaseFailure();
}

function requiredString(value: unknown): string {
  if (typeof value !== 'string' || value.length === 0 || value.length > MAX_FEEDBACK_IDENTIFIER_LENGTH) validation();
  return value;
}

function optionalText(value: unknown, maximum: number): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'string' || value.length === 0 || value.length > maximum) validation();
  return value;
}

function normalizeTimestamp(value: unknown): string {
  if (typeof value !== 'string' || value.length === 0) validation();
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) validation();
  return date.toISOString();
}

function normalizeComment(value: unknown, workspace: string): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'string') validation();
  if (value.trim().length === 0) return null;
  let sanitized: unknown;
  try {
    sanitized = sanitizeJson(value, { workspace }).value;
  } catch {
    validation();
  }
  if (typeof sanitized !== 'string') validation();
  if (sanitized.trim().length === 0) return null;
  if (Buffer.byteLength(sanitized, 'utf8') > MAX_FEEDBACK_COMMENT_BYTES) validation();
  return sanitized;
}

function hashIdempotencyKey(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

function contextBodyHash(input: Pick<ContextFeedbackRecord, 'feedbackId' | 'workspace' | 'deliveryId' | 'entryId' | 'runId' | 'verdict' | 'comment' | 'actor' | 'createdAt'>): string {
  return canonicalContentHash({
    feedbackId: input.feedbackId,
    workspace: input.workspace,
    deliveryId: input.deliveryId,
    entryId: input.entryId,
    runId: input.runId,
    verdict: input.verdict,
    comment: input.comment,
    actor: input.actor,
    createdAt: input.createdAt,
  });
}

function runBodyHash(input: Pick<RunFeedbackRecord, 'feedbackId' | 'workspace' | 'runId' | 'outcome' | 'recommendationCode' | 'recommendationVerdict' | 'rating' | 'comment' | 'actor' | 'createdAt'>): string {
  return canonicalContentHash({
    feedbackId: input.feedbackId,
    workspace: input.workspace,
    runId: input.runId,
    outcome: input.outcome,
    recommendationCode: input.recommendationCode,
    recommendationVerdict: input.recommendationVerdict,
    rating: input.rating,
    comment: input.comment,
    actor: input.actor,
    createdAt: input.createdAt,
  });
}

function validateContextFeedbackInput(value: unknown): ValidatedContextFeedbackInput {
  try {
    if (!isPlainObject(value)) validation();
    for (const field of Object.keys(value)) {
      if (!CONTEXT_INPUT_FIELDS.has(field)) validation();
    }
    const workspace = requiredString(value.workspace);
    const feedbackId = requiredString(value.feedbackId);
    const deliveryId = requiredString(value.deliveryId);
    const entryId = requiredString(value.entryId);
    const runId = requiredString(value.runId);
    if (typeof value.verdict !== 'string' || !CONTEXT_FEEDBACK_VERDICTS.includes(value.verdict as ContextFeedbackVerdict)) validation();
    const verdict = value.verdict as ContextFeedbackVerdict;
    const actor = requiredString(value.actor);
    const idempotencyKey = requiredString(value.idempotencyKey);
    const createdAt = normalizeTimestamp(value.createdAt);
    const comment = normalizeComment(value.comment, workspace);
    return {
      feedbackId,
      workspace,
      deliveryId,
      entryId,
      runId,
      verdict,
      comment,
      actor,
      idempotencyKeyHash: hashIdempotencyKey(idempotencyKey),
      createdAt,
    };
  } catch (error) {
    if (isKiokukoError(error) && error.code === 'VALIDATION_ERROR') validation();
    validation();
  }
}

interface ValidatedContextFeedbackListInput {
  workspace: string;
  runId?: string;
  deliveryId?: string;
  entryId?: string;
  limit: number;
}

function validateContextFeedbackListInput(value: unknown): ValidatedContextFeedbackListInput {
  try {
    if (!isPlainObject(value)) validation();
    for (const field of Object.keys(value)) {
      if (!CONTEXT_LIST_FIELDS.has(field)) validation();
    }
    const workspace = requiredString(value.workspace);
    const runId = value.runId === undefined ? undefined : requiredString(value.runId);
    const deliveryId = value.deliveryId === undefined ? undefined : requiredString(value.deliveryId);
    const entryId = value.entryId === undefined ? undefined : requiredString(value.entryId);
    const limit = value.limit === undefined ? 100 : value.limit;
    if (typeof limit !== 'number' || !Number.isInteger(limit) || limit < 1 || limit > 100) validation();
    return {
      workspace,
      ...(runId === undefined ? {} : { runId }),
      ...(deliveryId === undefined ? {} : { deliveryId }),
      ...(entryId === undefined ? {} : { entryId }),
      limit,
    };
  } catch (error) {
    if (isKiokukoError(error) && error.code === 'VALIDATION_ERROR') validation();
    validation();
  }
}

interface ValidatedRunFeedbackListInput {
  workspace: string;
  runId?: string;
  limit: number;
}

function validateRunFeedbackListInput(value: unknown): ValidatedRunFeedbackListInput {
  try {
    if (!isPlainObject(value)) validation();
    for (const field of Object.keys(value)) {
      if (!RUN_LIST_FIELDS.has(field)) validation();
    }
    const workspace = requiredString(value.workspace);
    const runId = value.runId === undefined ? undefined : requiredString(value.runId);
    const limit = value.limit === undefined ? 100 : value.limit;
    if (typeof limit !== 'number' || !Number.isInteger(limit) || limit < 1 || limit > 100) validation();
    return { workspace, ...(runId === undefined ? {} : { runId }), limit };
  } catch (error) {
    if (isKiokukoError(error) && error.code === 'VALIDATION_ERROR') validation();
    validation();
  }
}

interface ValidatedRunFeedbackInput {
  feedbackId: string;
  workspace: string;
  runId: string;
  outcome: string | null;
  recommendationCode: string | null;
  recommendationVerdict: RunFeedbackRecommendationVerdict | null;
  rating: number | null;
  comment: string | null;
  actor: string;
  idempotencyKeyHash: string;
  createdAt: string;
}

function validateRunFeedbackInput(value: unknown): ValidatedRunFeedbackInput {
  try {
    if (!isPlainObject(value)) validation();
    for (const field of Object.keys(value)) {
      if (!RUN_INPUT_FIELDS.has(field)) validation();
    }
    const workspace = requiredString(value.workspace);
    const feedbackId = requiredString(value.feedbackId);
    const runId = requiredString(value.runId);
    const outcome = optionalText(value.outcome, MAX_FEEDBACK_COMMENT_BYTES);
    const recommendationCode = optionalText(value.recommendationCode, MAX_FEEDBACK_IDENTIFIER_LENGTH);
    const rawRecommendationVerdict = value.recommendationVerdict;
    const recommendationVerdict = rawRecommendationVerdict === undefined || rawRecommendationVerdict === null
      ? null
      : typeof rawRecommendationVerdict === 'string' && RUN_FEEDBACK_RECOMMENDATION_VERDICTS.includes(rawRecommendationVerdict as RunFeedbackRecommendationVerdict)
        ? rawRecommendationVerdict as RunFeedbackRecommendationVerdict
        : validation();
    if ((recommendationCode === null) !== (recommendationVerdict === null)) validation();
    const rawRating = value.rating;
    const rating = rawRating === undefined || rawRating === null
      ? null
      : typeof rawRating === 'number' && Number.isInteger(rawRating) && rawRating >= 1 && rawRating <= 5
        ? rawRating
        : validation();
    if (outcome === null && recommendationCode === null && rating === null) validation();
    const actor = requiredString(value.actor);
    const idempotencyKey = requiredString(value.idempotencyKey);
    const createdAt = normalizeTimestamp(value.createdAt);
    const comment = normalizeComment(value.comment, workspace);
    return {
      feedbackId,
      workspace,
      runId,
      outcome,
      recommendationCode,
      recommendationVerdict,
      rating,
      comment,
      actor,
      idempotencyKeyHash: hashIdempotencyKey(idempotencyKey),
      createdAt,
    };
  } catch (error) {
    if (isKiokukoError(error) && error.code === 'VALIDATION_ERROR') validation();
    validation();
  }
}

function assertContextTarget(database: SqliteDatabase, input: ValidatedContextFeedbackInput): void {
  const target = database.prepare(`
    SELECT 1 AS present
    FROM context_deliveries AS cd
    JOIN ledger_runs AS lr ON lr.run_id = cd.run_id
    JOIN context_delivery_entries AS cde
      ON cde.delivery_id = cd.delivery_id AND cde.entry_id = ?
    JOIN entries AS e ON e.id = cde.entry_id
    WHERE cd.delivery_id = ?
      AND cd.run_id = ?
      AND lr.workspace = ?
      AND e.workspace = ?
  `).get<{ present: number }>(input.entryId, input.deliveryId, input.runId, input.workspace, input.workspace);
  if (!target) notFound();
}

function selectContextByKey(database: SqliteDatabase, input: ValidatedContextFeedbackInput): ContextFeedbackRow | undefined {
  return database.prepare(`
    SELECT
      cf.feedback_id, cf.delivery_id, cf.entry_id, cf.run_id, cf.verdict, cf.comment,
      cf.actor, cf.idempotency_key, cf.created_at,
      lr.workspace AS run_workspace,
      cd.run_id AS delivery_run_id,
      cd.delivery_id AS joined_delivery_id,
      cde.delivery_id AS linked_delivery_id,
      cde.entry_id AS linked_entry_id,
      e.workspace AS entry_workspace
    FROM context_feedback AS cf
    LEFT JOIN ledger_runs AS lr ON lr.run_id = cf.run_id
    LEFT JOIN context_deliveries AS cd ON cd.delivery_id = cf.delivery_id
    LEFT JOIN context_delivery_entries AS cde
      ON cde.delivery_id = cf.delivery_id AND cde.entry_id = cf.entry_id
    LEFT JOIN entries AS e ON e.id = cf.entry_id
    WHERE cf.run_id = ? AND cf.actor = ? AND cf.idempotency_key = ?
  `).get<ContextFeedbackRow>(input.runId, input.actor, input.idempotencyKeyHash);
}

function hasContextFeedbackId(database: SqliteDatabase, feedbackId: string): boolean {
  return Boolean(database.prepare('SELECT 1 AS present FROM context_feedback WHERE feedback_id = ?').get<{ present: number }>(feedbackId));
}

function storedString(value: unknown): string {
  if (typeof value !== 'string' || value.length === 0) integrity();
  return value;
}

function storedHash(value: unknown): string {
  if (typeof value !== 'string' || !/^[0-9a-f]{64}$/.test(value)) integrity();
  return value;
}

function storedTimestamp(value: unknown): string {
  if (typeof value !== 'string') integrity();
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) integrity();
  const normalized = date.toISOString();
  if (normalized !== value) integrity();
  return value;
}

function rowToContextFeedback(row: ContextFeedbackRow, workspace: string): ContextFeedbackRecord {
  const feedbackId = storedString(row.feedback_id);
  const deliveryId = storedString(row.delivery_id);
  const entryId = storedString(row.entry_id);
  const runId = storedString(row.run_id);
  const actor = storedString(row.actor);
  const runWorkspace = storedString(row.run_workspace);
  if (runWorkspace !== workspace) integrity();
  if (storedString(row.delivery_run_id) !== runId) integrity();
  if (storedString(row.joined_delivery_id) !== deliveryId) integrity();
  if (storedString(row.linked_delivery_id) !== deliveryId) integrity();
  if (storedString(row.linked_entry_id) !== entryId) integrity();
  if (storedString(row.entry_workspace) !== workspace) integrity();
  if (typeof row.verdict !== 'string' || !CONTEXT_FEEDBACK_VERDICTS.includes(row.verdict as ContextFeedbackVerdict)) integrity();
  const verdict = row.verdict as ContextFeedbackVerdict;
  let comment: string | null;
  if (row.comment === null) {
    comment = null;
  } else if (typeof row.comment === 'string') {
    if (row.comment.length === 0 || Buffer.byteLength(row.comment, 'utf8') > MAX_FEEDBACK_COMMENT_BYTES) integrity();
    let sanitized: string | null;
    try {
      sanitized = normalizeComment(row.comment, workspace);
    } catch {
      integrity();
    }
    if (sanitized !== row.comment) integrity();
    comment = row.comment;
  } else {
    integrity();
  }
  return {
    feedbackId,
    workspace,
    deliveryId,
    entryId,
    runId,
    verdict,
    comment,
    actor,
    idempotencyKeyHash: storedHash(row.idempotency_key),
    createdAt: storedTimestamp(row.created_at),
  };
}

function writeContextFeedback(database: SqliteDatabase, input: ValidatedContextFeedbackInput): ContextFeedbackRecord {
  assertContextTarget(database, input);
  const existingByKey = selectContextByKey(database, input);
  if (existingByKey) {
    const existing = rowToContextFeedback(existingByKey, input.workspace);
    if (contextBodyHash(existing) === contextBodyHash(input)) return existing;
    conflict();
  }
  if (hasContextFeedbackId(database, input.feedbackId)) conflict();
  database.prepare(`
    INSERT INTO context_feedback (
      feedback_id, delivery_id, entry_id, run_id, verdict, comment, actor, idempotency_key, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    input.feedbackId,
    input.deliveryId,
    input.entryId,
    input.runId,
    input.verdict,
    input.comment,
    input.actor,
    input.idempotencyKeyHash,
    input.createdAt,
  );
  const row = selectContextByKey(database, input);
  if (!row) integrity();
  return rowToContextFeedback(row, input.workspace);
}

export function recordContextFeedbackInTransaction(database: SqliteDatabase, input: unknown): ContextFeedbackRecord {
  const validated = validateContextFeedbackInput(input);
  try {
    return writeContextFeedback(database, validated);
  } catch (error) {
    normalizeDatabaseError(error);
  }
}

export function recordContextFeedback(database: SqliteDatabase, input: unknown): ContextFeedbackRecord {
  const validated = validateContextFeedbackInput(input);
  try {
    return withImmediateTransaction(database, () => writeContextFeedback(database, validated));
  } catch (error) {
    normalizeDatabaseError(error);
  }
}

function runOptionalStoredText(value: unknown, maximum: number): string | null {
  if (value === null) return null;
  if (typeof value !== 'string' || value.length === 0 || value.length > maximum) integrity();
  return value;
}

function runStoredComment(value: unknown, workspace: string): string | null {
  if (value === null) return null;
  if (typeof value !== 'string' || value.length === 0 || Buffer.byteLength(value, 'utf8') > MAX_FEEDBACK_COMMENT_BYTES) integrity();
  let sanitized: string | null;
  try {
    sanitized = normalizeComment(value, workspace);
  } catch {
    integrity();
  }
  if (sanitized !== value) integrity();
  return value;
}

function runBodyHashFromInput(input: ValidatedRunFeedbackInput): string {
  return runBodyHash(input);
}

function assertRunTarget(database: SqliteDatabase, input: ValidatedRunFeedbackInput): void {
  const target = database.prepare('SELECT 1 AS present FROM ledger_runs WHERE run_id = ? AND workspace = ?').get<{ present: number }>(input.runId, input.workspace);
  if (!target) notFound();
}

function selectRunByKey(database: SqliteDatabase, input: ValidatedRunFeedbackInput): RunFeedbackRow | undefined {
  return database.prepare(`
    SELECT
      rf.feedback_id, rf.run_id, rf.outcome, rf.recommendation_code, rf.recommendation_verdict,
      rf.rating, rf.comment, rf.actor, rf.idempotency_key, rf.created_at,
      lr.workspace AS run_workspace
    FROM run_feedback AS rf
    LEFT JOIN ledger_runs AS lr ON lr.run_id = rf.run_id
    WHERE rf.run_id = ? AND rf.actor = ? AND rf.idempotency_key = ?
  `).get<RunFeedbackRow>(input.runId, input.actor, input.idempotencyKeyHash);
}

function hasRunFeedbackId(database: SqliteDatabase, feedbackId: string): boolean {
  return Boolean(database.prepare('SELECT 1 AS present FROM run_feedback WHERE feedback_id = ?').get<{ present: number }>(feedbackId));
}

function rowToRunFeedback(row: RunFeedbackRow, workspace: string): RunFeedbackRecord {
  const feedbackId = storedString(row.feedback_id);
  const runId = storedString(row.run_id);
  const runWorkspace = storedString(row.run_workspace);
  if (runWorkspace !== workspace) integrity();
  const outcome = runOptionalStoredText(row.outcome, MAX_FEEDBACK_COMMENT_BYTES);
  const recommendationCode = runOptionalStoredText(row.recommendation_code, MAX_FEEDBACK_IDENTIFIER_LENGTH);
  let recommendationVerdict: RunFeedbackRecommendationVerdict | null;
  if (row.recommendation_verdict === null) {
    recommendationVerdict = null;
  } else if (typeof row.recommendation_verdict === 'string' && RUN_FEEDBACK_RECOMMENDATION_VERDICTS.includes(row.recommendation_verdict as RunFeedbackRecommendationVerdict)) {
    recommendationVerdict = row.recommendation_verdict as RunFeedbackRecommendationVerdict;
  } else {
    integrity();
  }
  if ((recommendationCode === null) !== (recommendationVerdict === null)) integrity();
  const rating = row.rating === null
    ? null
    : typeof row.rating === 'number' && Number.isInteger(row.rating) && row.rating >= 1 && row.rating <= 5
      ? row.rating
      : integrity();
  if (outcome === null && recommendationCode === null && rating === null) integrity();
  const actor = storedString(row.actor);
  const comment = runStoredComment(row.comment, workspace);
  return {
    feedbackId,
    workspace,
    runId,
    outcome,
    recommendationCode,
    recommendationVerdict,
    rating,
    comment,
    actor,
    idempotencyKeyHash: storedHash(row.idempotency_key),
    createdAt: storedTimestamp(row.created_at),
  };
}

function writeRunFeedback(database: SqliteDatabase, input: ValidatedRunFeedbackInput): RunFeedbackRecord {
  assertRunTarget(database, input);
  const existingByKey = selectRunByKey(database, input);
  if (existingByKey) {
    const existing = rowToRunFeedback(existingByKey, input.workspace);
    if (runBodyHash(existing) === runBodyHashFromInput(input)) return existing;
    conflict();
  }
  if (hasRunFeedbackId(database, input.feedbackId)) conflict();
  database.prepare(`
    INSERT INTO run_feedback (
      feedback_id, run_id, outcome, recommendation_code, recommendation_verdict,
      rating, comment, actor, idempotency_key, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    input.feedbackId,
    input.runId,
    input.outcome,
    input.recommendationCode,
    input.recommendationVerdict,
    input.rating,
    input.comment,
    input.actor,
    input.idempotencyKeyHash,
    input.createdAt,
  );
  const row = selectRunByKey(database, input);
  if (!row) integrity();
  return rowToRunFeedback(row, input.workspace);
}

export function recordRunFeedbackInTransaction(database: SqliteDatabase, input: unknown): RunFeedbackRecord {
  const validated = validateRunFeedbackInput(input);
  try {
    return writeRunFeedback(database, validated);
  } catch (error) {
    normalizeDatabaseError(error);
  }
}

export function recordRunFeedback(database: SqliteDatabase, input: unknown): RunFeedbackRecord {
  const validated = validateRunFeedbackInput(input);
  try {
    return withImmediateTransaction(database, () => writeRunFeedback(database, validated));
  } catch (error) {
    normalizeDatabaseError(error);
  }
}

export function listRunFeedback(database: SqliteDatabase, input: unknown): FeedbackListPage<RunFeedbackRecord> {
  const validated = validateRunFeedbackListInput(input);
  try {
    const conditions = ['(lr.workspace = ? OR lr.workspace IS NULL)'];
    const parameters: Array<string | number> = [validated.workspace];
    if (validated.runId !== undefined) {
      conditions.push('rf.run_id = ?');
      parameters.push(validated.runId);
    }
    const rows = database.prepare(`
      SELECT
        rf.feedback_id, rf.run_id, rf.outcome, rf.recommendation_code, rf.recommendation_verdict,
        rf.rating, rf.comment, rf.actor, rf.idempotency_key, rf.created_at,
        lr.workspace AS run_workspace
      FROM run_feedback AS rf
      LEFT JOIN ledger_runs AS lr ON lr.run_id = rf.run_id
      WHERE ${conditions.join(' AND ')}
      ORDER BY rf.created_at ASC, rf.feedback_id ASC
      LIMIT ?
    `).all<RunFeedbackRow>(...parameters, validated.limit + 1);
    const records = rows.map((row) => rowToRunFeedback(row, validated.workspace));
    return { records: records.slice(0, validated.limit), truncated: records.length > validated.limit };
  } catch (error) {
    normalizeDatabaseError(error);
  }
}

export function listContextFeedback(database: SqliteDatabase, input: unknown): FeedbackListPage<ContextFeedbackRecord> {
  const validated = validateContextFeedbackListInput(input);
  try {
    const conditions = ['(lr.workspace = ? OR lr.workspace IS NULL)'];
    const parameters: Array<string | number> = [validated.workspace];
    if (validated.runId !== undefined) {
      conditions.push('cf.run_id = ?');
      parameters.push(validated.runId);
    }
    if (validated.deliveryId !== undefined) {
      conditions.push('cf.delivery_id = ?');
      parameters.push(validated.deliveryId);
    }
    if (validated.entryId !== undefined) {
      conditions.push('cf.entry_id = ?');
      parameters.push(validated.entryId);
    }
    const rows = database.prepare(`
      SELECT
        cf.feedback_id, cf.delivery_id, cf.entry_id, cf.run_id, cf.verdict, cf.comment,
        cf.actor, cf.idempotency_key, cf.created_at,
        lr.workspace AS run_workspace,
        cd.run_id AS delivery_run_id,
        cd.delivery_id AS joined_delivery_id,
        cde.delivery_id AS linked_delivery_id,
        cde.entry_id AS linked_entry_id,
        e.workspace AS entry_workspace
      FROM context_feedback AS cf
      LEFT JOIN ledger_runs AS lr ON lr.run_id = cf.run_id
      LEFT JOIN context_deliveries AS cd ON cd.delivery_id = cf.delivery_id
      LEFT JOIN context_delivery_entries AS cde
        ON cde.delivery_id = cf.delivery_id AND cde.entry_id = cf.entry_id
      LEFT JOIN entries AS e ON e.id = cf.entry_id
      WHERE ${conditions.join(' AND ')}
      ORDER BY cf.created_at ASC, cf.feedback_id ASC
      LIMIT ?
    `).all<ContextFeedbackRow>(...parameters, validated.limit + 1);
    const records = rows.map((row) => rowToContextFeedback(row, validated.workspace));
    return { records: records.slice(0, validated.limit), truncated: records.length > validated.limit };
  } catch (error) {
    normalizeDatabaseError(error);
  }
}

export const INTAKE_FEEDBACK_VERDICTS = ['helpful', 'unnecessary', 'corrected'] as const;
export type IntakeFeedbackVerdict = (typeof INTAKE_FEEDBACK_VERDICTS)[number];

export interface IntakeFeedbackRecord {
  feedbackId: string;
  workspace: string;
  runId: string;
  sessionId: string;
  questionId: string | null;
  profileField: string | null;
  verdict: IntakeFeedbackVerdict;
  comment: string | null;
  actor: string;
  idempotencyKeyHash: string;
  createdAt: string;
}

const INTAKE_FEEDBACK_FIELDS = new Set([
  'workspace', 'feedbackId', 'runId', 'sessionId', 'questionId', 'profileField',
  'verdict', 'comment', 'actor', 'idempotencyKey', 'createdAt',
]);
const INTAKE_PROFILE_FIELDS = new Set(['taskType', 'target', 'expected', 'constraints']);

function initialInputFields(value: unknown): Record<string, unknown> {
  try {
    if (!isPlainObject(value)) validation();
    const keys = Reflect.ownKeys(value);
    if (keys.length !== INTAKE_FEEDBACK_FIELDS.size || keys.some((key) => typeof key !== 'string' || !INTAKE_FEEDBACK_FIELDS.has(key))) validation();
    const descriptors = Object.getOwnPropertyDescriptors(value);
    const result: Record<string, unknown> = {};
    for (const field of INTAKE_FEEDBACK_FIELDS) {
      const descriptor = descriptors[field];
      if (!descriptor || !('value' in descriptor) || descriptor.enumerable !== true) validation();
      result[field] = descriptor.value;
    }
    structuredClone(value);
    return result;
  } catch {
    validation();
  }
}

function initialInputIdentifier(value: unknown): string {
  if (typeof value !== 'string' || value.length === 0 || Buffer.byteLength(value, 'utf8') > MAX_FEEDBACK_IDENTIFIER_LENGTH || /\p{Cc}/u.test(value)) validation();
  return value;
}

function initialInputTimestamp(value: unknown): string {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value)) validation();
  const date = new Date(value);
  if (Number.isNaN(date.getTime()) || date.toISOString() !== value) validation();
  return value;
}

function initialInputComment(value: unknown, workspace: string): string | null {
  if (value === null) return null;
  if (typeof value !== 'string' || value.length === 0) validation();
  let sanitized: unknown;
  try {
    sanitized = sanitizeJson(value, { workspace }).value;
  } catch {
    validation();
  }
  if (typeof sanitized !== 'string' || sanitized.length === 0 || Buffer.byteLength(sanitized, 'utf8') > MAX_FEEDBACK_COMMENT_BYTES) validation();
  return sanitized;
}

function validateInitialIntakeFeedbackInput(value: unknown): {
  feedbackId: string;
  workspace: string;
  runId: string;
  sessionId: string;
  questionId: string | null;
  profileField: string | null;
  verdict: IntakeFeedbackVerdict;
  comment: string | null;
  actor: string;
  idempotencyKeyHash: string;
  createdAt: string;
} {
  const fields = initialInputFields(value);
  const workspace = initialInputIdentifier(fields.workspace);
  const feedbackId = initialInputIdentifier(fields.feedbackId);
  const runId = initialInputIdentifier(fields.runId);
  const sessionId = initialInputIdentifier(fields.sessionId);
  const questionId = fields.questionId === null
    ? null
    : typeof fields.questionId === 'string' && INTAKE_PROFILE_FIELDS.has(fields.questionId)
      ? fields.questionId
      : validation();
  const profileField = fields.profileField === null
    ? null
    : typeof fields.profileField === 'string' && INTAKE_PROFILE_FIELDS.has(fields.profileField)
      ? fields.profileField
      : validation();
  if ((questionId === null) === (profileField === null)) validation();
  if (typeof fields.verdict !== 'string' || !INTAKE_FEEDBACK_VERDICTS.includes(fields.verdict as IntakeFeedbackVerdict)) validation();
  const actor = initialInputIdentifier(fields.actor);
  const idempotencyKey = initialInputIdentifier(fields.idempotencyKey);
  return {
    workspace,
    feedbackId,
    runId,
    sessionId,
    questionId,
    profileField,
    verdict: fields.verdict as IntakeFeedbackVerdict,
    comment: initialInputComment(fields.comment, workspace),
    actor,
    idempotencyKeyHash: hashIdempotencyKey(idempotencyKey),
    createdAt: initialInputTimestamp(fields.createdAt),
  };
}

function initialIntakeTarget(database: SqliteDatabase, input: ReturnType<typeof validateInitialIntakeFeedbackInput>): void {
  const linked = database.prepare(`
    SELECT ri.run_id, ri.session_id
    FROM run_intakes AS ri
    JOIN ledger_runs AS lr ON lr.run_id = ri.run_id
    JOIN akinator_sessions AS s ON s.id = ri.session_id
    WHERE ri.run_id = ? AND ri.session_id = ?
      AND lr.workspace = ? AND s.workspace = ?
  `).get<{ run_id: string; session_id: string }>(input.runId, input.sessionId, input.workspace, input.workspace);
  if (!linked) notFound();
  if (input.questionId !== null) {
    const answer = database.prepare(`
      SELECT 1 AS present
      FROM akinator_answers
      WHERE session_id = ? AND question_id = ?
    `).get<{ present: number }>(input.sessionId, input.questionId);
    if (!answer) notFound();
  }
}

interface InitialIntakeFeedbackRow extends SqliteRow {
  feedback_id: unknown;
  run_id: unknown;
  session_id: unknown;
  question_id: unknown;
  profile_field: unknown;
  verdict: unknown;
  comment: unknown;
  actor: unknown;
  idempotency_key: unknown;
  created_at: unknown;
  run_workspace: unknown;
  session_workspace: unknown;
  linked_run_id: unknown;
  linked_session_id: unknown;
  question_answer_session_id: unknown;
}

function initialIntakeRecord(input: ReturnType<typeof validateInitialIntakeFeedbackInput>): IntakeFeedbackRecord {
  return {
    feedbackId: input.feedbackId,
    workspace: input.workspace,
    runId: input.runId,
    sessionId: input.sessionId,
    questionId: input.questionId,
    profileField: input.profileField,
    verdict: input.verdict,
    comment: input.comment,
    actor: input.actor,
    idempotencyKeyHash: input.idempotencyKeyHash,
    createdAt: input.createdAt,
  };
}

function initialIntakeBodyHash(input: IntakeFeedbackRecord): string {
  return canonicalContentHash({
    feedbackId: input.feedbackId,
    workspace: input.workspace,
    runId: input.runId,
    sessionId: input.sessionId,
    questionId: input.questionId,
    profileField: input.profileField,
    verdict: input.verdict,
    comment: input.comment,
    actor: input.actor,
    createdAt: input.createdAt,
  });
}

function selectInitialIntakeByKey(database: SqliteDatabase, input: ReturnType<typeof validateInitialIntakeFeedbackInput>): InitialIntakeFeedbackRow | undefined {
  return database.prepare(`
    SELECT
      ifb.feedback_id, ifb.run_id, ifb.session_id, ifb.question_id, ifb.profile_field,
      ifb.verdict, ifb.comment, ifb.actor, ifb.idempotency_key, ifb.created_at,
      lr.workspace AS run_workspace,
      s.workspace AS session_workspace,
      ri.run_id AS linked_run_id,
      ri.session_id AS linked_session_id,
      aa.session_id AS question_answer_session_id
    FROM intake_feedback AS ifb
    LEFT JOIN ledger_runs AS lr ON lr.run_id = ifb.run_id
    LEFT JOIN akinator_sessions AS s ON s.id = ifb.session_id
    LEFT JOIN run_intakes AS ri ON ri.run_id = ifb.run_id AND ri.session_id = ifb.session_id
    LEFT JOIN akinator_answers AS aa ON aa.session_id = ifb.session_id AND aa.question_id = ifb.question_id
    WHERE ifb.run_id = ? AND ifb.actor = ? AND ifb.idempotency_key = ?
  `).get<InitialIntakeFeedbackRow>(input.runId, input.actor, input.idempotencyKeyHash);
}

function hasInitialIntakeFeedbackId(database: SqliteDatabase, feedbackId: string): boolean {
  return Boolean(database.prepare('SELECT 1 AS present FROM intake_feedback WHERE feedback_id = ?').get<{ present: number }>(feedbackId));
}

function initialStoredIdentifier(value: unknown): string {
  if (typeof value !== 'string' || value.length === 0 || Buffer.byteLength(value, 'utf8') > MAX_FEEDBACK_IDENTIFIER_LENGTH || /\p{Cc}/u.test(value)) integrity();
  return value;
}

function initialStoredHash(value: unknown): string {
  if (typeof value !== 'string' || !/^[0-9a-f]{64}$/.test(value)) integrity();
  return value;
}

function initialStoredTimestamp(value: unknown): string {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value)) integrity();
  const date = new Date(value);
  if (Number.isNaN(date.getTime()) || date.toISOString() !== value) integrity();
  return value;
}

function initialStoredComment(value: unknown, workspace: string): string | null {
  if (value === null) return null;
  if (typeof value !== 'string' || value.length === 0 || Buffer.byteLength(value, 'utf8') > MAX_FEEDBACK_COMMENT_BYTES) integrity();
  let sanitized: string | null;
  try {
    sanitized = normalizeComment(value, workspace);
  } catch {
    integrity();
  }
  if (sanitized !== value) integrity();
  return value;
}

function rowToInitialIntakeFeedback(row: InitialIntakeFeedbackRow, workspace: string): IntakeFeedbackRecord {
  const feedbackId = initialStoredIdentifier(row.feedback_id);
  const runId = initialStoredIdentifier(row.run_id);
  const sessionId = initialStoredIdentifier(row.session_id);
  const actor = initialStoredIdentifier(row.actor);
  const runWorkspace = initialStoredIdentifier(row.run_workspace);
  const sessionWorkspace = initialStoredIdentifier(row.session_workspace);
  const linkedRunId = initialStoredIdentifier(row.linked_run_id);
  const linkedSessionId = initialStoredIdentifier(row.linked_session_id);
  if (runWorkspace !== workspace || sessionWorkspace !== workspace || linkedRunId !== runId || linkedSessionId !== sessionId) integrity();

  const questionId = row.question_id === null
    ? null
    : typeof row.question_id === 'string' && INTAKE_PROFILE_FIELDS.has(row.question_id)
      ? row.question_id
      : integrity();
  const profileField = row.profile_field === null
    ? null
    : typeof row.profile_field === 'string' && INTAKE_PROFILE_FIELDS.has(row.profile_field)
      ? row.profile_field
      : integrity();
  if ((questionId === null) === (profileField === null)) integrity();
  if (questionId !== null && initialStoredIdentifier(row.question_answer_session_id) !== sessionId) integrity();
  if (typeof row.verdict !== 'string' || !INTAKE_FEEDBACK_VERDICTS.includes(row.verdict as IntakeFeedbackVerdict)) integrity();

  return {
    feedbackId,
    workspace,
    runId,
    sessionId,
    questionId,
    profileField,
    verdict: row.verdict as IntakeFeedbackVerdict,
    comment: initialStoredComment(row.comment, workspace),
    actor,
    idempotencyKeyHash: initialStoredHash(row.idempotency_key),
    createdAt: initialStoredTimestamp(row.created_at),
  };
}

function recordInitialIntakeFeedback(database: SqliteDatabase, input: ReturnType<typeof validateInitialIntakeFeedbackInput>): IntakeFeedbackRecord {
  initialIntakeTarget(database, input);
  const existingByKey = selectInitialIntakeByKey(database, input);
  if (existingByKey) {
    const existing = rowToInitialIntakeFeedback(existingByKey, input.workspace);
    if (initialIntakeBodyHash(existing) === initialIntakeBodyHash(initialIntakeRecord(input))) return existing;
    conflict();
  }
  if (hasInitialIntakeFeedbackId(database, input.feedbackId)) conflict();
  database.prepare(`
    INSERT INTO intake_feedback (
      feedback_id, run_id, session_id, question_id, profile_field, verdict, comment, actor, idempotency_key, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    input.feedbackId,
    input.runId,
    input.sessionId,
    input.questionId,
    input.profileField,
    input.verdict,
    input.comment,
    input.actor,
    input.idempotencyKeyHash,
    input.createdAt,
  );
  const row = selectInitialIntakeByKey(database, input);
  if (!row) integrity();
  return rowToInitialIntakeFeedback(row, input.workspace);
}

export function recordIntakeFeedback(database: SqliteDatabase, input: unknown): IntakeFeedbackRecord {
  const validated = validateInitialIntakeFeedbackInput(input);
  try {
    return withImmediateTransaction(database, () => recordInitialIntakeFeedback(database, validated));
  } catch (error) {
    normalizeDatabaseError(error);
  }
}

export function recordIntakeFeedbackInTransaction(database: SqliteDatabase, input: unknown): IntakeFeedbackRecord {
  const validated = validateInitialIntakeFeedbackInput(input);
  try {
    return recordInitialIntakeFeedback(database, validated);
  } catch (error) {
    normalizeDatabaseError(error);
  }
}

interface ValidatedInitialIntakeFeedbackListInput {
  workspace: string;
  runId?: string;
  sessionId?: string;
  questionId?: string;
  profileField?: string;
  limit: number;
}

const INTAKE_FEEDBACK_LIST_FIELDS = new Set(['workspace', 'runId', 'sessionId', 'questionId', 'profileField', 'limit']);

function initialListInputFields(value: unknown): Record<string, unknown> {
  try {
    if (!isPlainObject(value)) validation();
    const keys = Reflect.ownKeys(value);
    if (keys.some((key) => typeof key !== 'string' || !INTAKE_FEEDBACK_LIST_FIELDS.has(key))) validation();
    const descriptors = Object.getOwnPropertyDescriptors(value);
    const result: Record<string, unknown> = {};
    for (const key of keys) {
      if (typeof key !== 'string') validation();
      const descriptor = descriptors[key];
      if (!descriptor || !('value' in descriptor) || descriptor.enumerable !== true) validation();
      result[key] = descriptor.value;
    }
    structuredClone(value);
    return result;
  } catch {
    validation();
  }
}

function validateInitialIntakeFeedbackListInput(value: unknown): ValidatedInitialIntakeFeedbackListInput {
  const fields = initialListInputFields(value);
  const workspace = initialInputIdentifier(fields.workspace);
  const runId = fields.runId === undefined ? undefined : initialInputIdentifier(fields.runId);
  const sessionId = fields.sessionId === undefined ? undefined : initialInputIdentifier(fields.sessionId);
  const questionId = fields.questionId === undefined ? undefined : initialInputIdentifier(fields.questionId);
  const profileField = fields.profileField === undefined ? undefined : initialInputIdentifier(fields.profileField);
  if (questionId !== undefined && !INTAKE_PROFILE_FIELDS.has(questionId)) validation();
  if (profileField !== undefined && !INTAKE_PROFILE_FIELDS.has(profileField)) validation();
  if (questionId !== undefined && profileField !== undefined) validation();
  const limit = fields.limit === undefined ? 100 : fields.limit;
  if (typeof limit !== 'number' || !Number.isInteger(limit) || limit < 1 || limit > 100) validation();
  return { workspace, ...(runId === undefined ? {} : { runId }), ...(sessionId === undefined ? {} : { sessionId }), ...(questionId === undefined ? {} : { questionId }), ...(profileField === undefined ? {} : { profileField }), limit };
}

function selectInitialIntakeRows(database: SqliteDatabase, input: ValidatedInitialIntakeFeedbackListInput): InitialIntakeFeedbackRow[] {
  const conditions = ['(lr.workspace = ? OR lr.workspace IS NULL)'];
  const parameters: Array<string | number> = [input.workspace];
  if (input.runId !== undefined) {
    conditions.push('ifb.run_id = ?');
    parameters.push(input.runId);
  }
  if (input.sessionId !== undefined) {
    conditions.push('ifb.session_id = ?');
    parameters.push(input.sessionId);
  }
  if (input.questionId !== undefined) {
    conditions.push('ifb.question_id = ?');
    parameters.push(input.questionId);
  }
  if (input.profileField !== undefined) {
    conditions.push('ifb.profile_field = ?');
    parameters.push(input.profileField);
  }
  return database.prepare(`
    SELECT
      ifb.feedback_id, ifb.run_id, ifb.session_id, ifb.question_id, ifb.profile_field,
      ifb.verdict, ifb.comment, ifb.actor, ifb.idempotency_key, ifb.created_at,
      lr.workspace AS run_workspace,
      s.workspace AS session_workspace,
      ri.run_id AS linked_run_id,
      ri.session_id AS linked_session_id,
      aa.session_id AS question_answer_session_id
    FROM intake_feedback AS ifb
    LEFT JOIN ledger_runs AS lr ON lr.run_id = ifb.run_id
    LEFT JOIN akinator_sessions AS s ON s.id = ifb.session_id
    LEFT JOIN run_intakes AS ri ON ri.run_id = ifb.run_id AND ri.session_id = ifb.session_id
    LEFT JOIN akinator_answers AS aa ON aa.session_id = ifb.session_id AND aa.question_id = ifb.question_id
    WHERE ${conditions.join(' AND ')}
    ORDER BY ifb.created_at ASC, ifb.feedback_id ASC
    LIMIT ?
  `).all<InitialIntakeFeedbackRow>(...parameters, input.limit + 1);
}

export function listIntakeFeedback(database: SqliteDatabase, input: unknown): FeedbackListPage<IntakeFeedbackRecord> {
  const validated = validateInitialIntakeFeedbackListInput(input);
  try {
    const rows = selectInitialIntakeRows(database, validated);
    const records = rows.map((row) => rowToInitialIntakeFeedback(row, validated.workspace));
    return { records: records.slice(0, validated.limit), truncated: records.length > validated.limit };
  } catch (error) {
    normalizeDatabaseError(error);
  }
}
