import type { SqliteDatabase, SqliteRow } from '../db/adapter.js';
import { withImmediateTransaction } from '../db/transaction.js';
import { KiokukoError } from '../errors.js';
import {
  CONTEXT_RANKING_COMPONENTS,
  CONTEXT_RANKING_COMPONENTS_V2,
  CONTEXT_SELECTION_REASON_ORDER,
  type ContextRankingComponent,
  type ContextRankingV2Component,
} from './ranking.js';
import { sanitizeJson } from '../security/sanitize.js';
import { canonicalJson } from '../serialization/validate.js';
import { entryOriginMatchesWorkspace, isContextEntryOrigin, type ContextEntryOrigin } from './origin.js';

const MAX_IDENTIFIER_BYTES = 256;
const MAX_ITEMS = 100;
const MAX_SCORE_COMPONENT = 1_000_000;
const MAX_CHAR_BUDGET = 100_000;
const MAX_EXTERNAL_SUMMARY_BYTES = 16 * 1024;
const MAX_EXTERNAL_ERROR_BYTES = 1024;
const MAX_SOURCES = 16;
const MAX_LIMIT = 100;
const DEFAULT_LIMIT = 100;
const DELIVERY_CURSOR_VERSION = 1 as const;

const VALIDATION_MESSAGE = 'Context delivery input is invalid';
const NOT_FOUND_MESSAGE = 'Context delivery target was not found';
const CONFLICT_MESSAGE = 'Context delivery conflicts with existing record';
const DATABASE_MESSAGE = 'Context delivery database operation failed';
const INTEGRITY_MESSAGE = 'Stored context delivery is invalid';

export type ContextDeliveryScoreComponents = { [Component in ContextRankingComponent]: number };
export type ContextDeliveryScoreComponentsV2 = { [Component in ContextRankingV2Component]: number };
export type ContextDeliveryScoreComponentsAny = ContextDeliveryScoreComponents | ContextDeliveryScoreComponentsV2;

export interface ContextDeliveryItemInput {
  entryId: string;
  entryRevision: number;
  rank: number;
  scoreComponents: ContextDeliveryScoreComponentsAny;
  selectionReasons: string[];
  /** Set only for v2 cross-scope deliveries; project remains the v1 default. */
  origin?: ContextEntryOrigin;
}

export interface ExternalSyncSourceSummary {
  sourceId: string;
  commit: string | null;
  documents: number;
  imported: number;
  error?: string;
}

export interface ExternalSyncSummary {
  attempted: boolean;
  imported: number;
  sources: ExternalSyncSourceSummary[];
}

export interface ContextDeliveryInput {
  workspace: string;
  deliveryId: string;
  runId: string;
  throughSequence: number;
  intakeSessionId: string | null;
  taskProfileHash: string;
  queryHash: string;
  policyVersion: string;
  externalSyncSummary: ExternalSyncSummary;
  charBudget: number;
  charCount: number;
  truncated: boolean;
  createdAt: string;
  items: ContextDeliveryItemInput[];
  scoreSchemaVersion?: number;
}

export interface ContextDeliveryItemView extends ContextDeliveryItemInput {
  untrusted: true;
}

export interface ContextDeliveryView extends Omit<ContextDeliveryInput, 'items'> {
  items: ContextDeliveryItemView[];
  untrusted: true;
}

export interface ReadContextDeliveryInput {
  workspace: string;
  deliveryId: string;
}

export interface ListContextDeliveriesInput {
  workspace: string;
  runId: string;
  cursor?: string;
  limit?: number;
}

export interface ContextDeliveryPage {
  items: ContextDeliveryView[];
  nextCursor: string | null;
}

interface ValidatedContextDeliveryInput extends ContextDeliveryInput {
  externalSyncSummary: ExternalSyncSummary;
  items: ContextDeliveryItemInput[];
}

interface DeliveryHeaderRow extends SqliteRow {
  delivery_id: unknown;
  run_id: unknown;
  through_sequence: unknown;
  intake_session_id: unknown;
  task_profile_hash: unknown;
  query_hash: unknown;
  policy_version: unknown;
  external_sync_summary_json: unknown;
  char_budget: unknown;
  char_count: unknown;
  truncated: unknown;
  created_at: unknown;
  run_workspace: unknown;
  run_last_sequence: unknown;
  score_schema_version: unknown;
}

interface DeliveryEntryRow extends SqliteRow {
  delivery_id: unknown;
  entry_id: unknown;
  entry_revision: unknown;
  rank: unknown;
  score_components_json: unknown;
  selection_reason_json: unknown;
  entry_workspace: unknown;
  revision_workspace: unknown;
  origin_scope: unknown;
}

interface DeliveryCursor {
  version: typeof DELIVERY_CURSOR_VERSION;
  createdAt: string;
  deliveryId: string;
}

function fail(code: 'VALIDATION_ERROR' | 'NOT_FOUND' | 'CONFLICT' | 'DATABASE_ERROR' | 'INTEGRITY_ERROR', message: string): never {
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

function databaseFailure(): never {
  return fail('DATABASE_ERROR', DATABASE_MESSAGE);
}

function integrity(): never {
  return fail('INTEGRITY_ERROR', INTEGRITY_MESSAGE);
}

function isKiokukoError(error: unknown): error is KiokukoError {
  return error instanceof KiokukoError;
}

function normalizeDatabaseError(error: unknown): never {
  if (isKiokukoError(error)) throw error;
  if (error instanceof Error && /unique|constraint/i.test(error.message)) conflict();
  databaseFailure();
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  try {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
    const prototype = Object.getPrototypeOf(value);
    return prototype === Object.prototype || prototype === null;
  } catch {
    return false;
  }
}

function isCanonicalArrayIndex(value: string): boolean {
  if (value === '0') return true;
  if (!/^[1-9]\d*$/u.test(value)) return false;
  const index = Number(value);
  return Number.isSafeInteger(index) && index < 4_294_967_295 && String(index) === value;
}

function ownKeys(value: object): string[] {
  let keys: (string | symbol)[];
  try {
    keys = Reflect.ownKeys(value);
    if (keys.some((key) => typeof key === 'symbol')) validation();
    for (const key of keys) {
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (descriptor === undefined || !('value' in descriptor)) validation();
    }
  } catch (error) {
    if (isKiokukoError(error)) throw error;
    validation();
  }
  return keys as string[];
}

function assertCloneableInput(value: object): void {
  try {
    structuredClone(value);
  } catch {
    validation();
  }
}

function objectInput(value: unknown, fields: readonly string[], requireAll: boolean): Record<string, unknown> {
  if (!isPlainObject(value)) validation();
  const keys = ownKeys(value);
  assertCloneableInput(value);
  const allowed = new Set(fields);
  if (keys.some((key) => !allowed.has(key))) validation();
  if (requireAll && fields.some((field) => !keys.includes(field))) validation();
  return value;
}

function arrayInput(value: unknown): unknown[] {
  if (!Array.isArray(value)) validation();
  try {
    if (Object.getPrototypeOf(value) !== Array.prototype) validation();
    const keys = ownKeys(value);
    assertCloneableInput(value);
    if (!keys.includes('length') || keys.some((key) => key !== 'length' && (!isCanonicalArrayIndex(key) || Number(key) >= value.length))) validation();
    for (let index = 0; index < value.length; index += 1) {
      const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
      if (descriptor === undefined || !('value' in descriptor)) validation();
    }
  } catch (error) {
    if (isKiokukoError(error)) throw error;
    validation();
  }
  return value;
}

function hasOwn(value: Record<string, unknown>, field: string): boolean {
  return Object.prototype.hasOwnProperty.call(value, field);
}

function readField(value: Record<string, unknown>, field: string): unknown {
  const descriptor = Object.getOwnPropertyDescriptor(value, field);
  if (descriptor === undefined || !('value' in descriptor)) validation();
  return descriptor.value;
}

function boundedIdentifier(value: unknown): string {
  if (typeof value !== 'string' || value.trim().length === 0 || /[\p{C}]/u.test(value) || Buffer.byteLength(value, 'utf8') > MAX_IDENTIFIER_BYTES) validation();
  return value;
}

function boundedStoredIdentifier(value: unknown): string {
  if (typeof value !== 'string' || value.trim().length === 0 || /[\p{C}]/u.test(value) || Buffer.byteLength(value, 'utf8') > MAX_IDENTIFIER_BYTES) integrity();
  return value;
}

function nonNegativeSafeInteger(value: unknown): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) validation();
  return value;
}

function positiveSafeInteger(value: unknown): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1) validation();
  return value;
}

function storedNonNegativeSafeInteger(value: unknown): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) integrity();
  return value;
}

function storedPositiveSafeInteger(value: unknown): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1) integrity();
  return value;
}

function hash(value: unknown): string {
  if (typeof value !== 'string' || !/^[0-9a-f]{64}$/u.test(value)) validation();
  return value;
}

function storedHash(value: unknown): string {
  if (typeof value !== 'string' || !/^[0-9a-f]{64}$/u.test(value)) integrity();
  return value;
}

function timestamp(value: unknown): string {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u.test(value)) validation();
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed) || new Date(parsed).toISOString() !== value) validation();
  return value;
}

function storedTimestamp(value: unknown): string {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u.test(value)) integrity();
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed) || new Date(parsed).toISOString() !== value) integrity();
  return value;
}

function booleanValue(value: unknown): boolean {
  if (typeof value !== 'boolean') validation();
  return value;
}

function storedBoolean(value: unknown): boolean {
  if (value !== 0 && value !== 1) integrity();
  return value === 1;
}

function scoreComponentsForVersion(value: unknown, version: number): ContextDeliveryScoreComponentsAny {
  const components = version >= 2 ? CONTEXT_RANKING_COMPONENTS_V2 : CONTEXT_RANKING_COMPONENTS;
  const object = objectInput(value, components, true);
  const keys = ownKeys(object);
  if (keys.length !== components.length || components.some((component) => !keys.includes(component))) validation();
  const result = {} as Record<string, number>;
  for (const component of components) {
    const score = readField(object, component);
    if (typeof score !== 'number' || !Number.isSafeInteger(score) || !Number.isFinite(score) || score < -MAX_SCORE_COMPONENT || score > MAX_SCORE_COMPONENT) validation();
    result[component] = score;
  }
  return result as ContextDeliveryScoreComponentsAny;
}

function storedScoreComponents(value: unknown, version: number): ContextDeliveryScoreComponentsAny {
  try {
    return scoreComponentsForVersion(value, version);
  } catch {
    integrity();
  }
}

function selectionReasons(value: unknown): string[] {
  const array = arrayInput(value);
  if (array.length === 0) validation();
  const result: string[] = [];
  let previousIndex = -1;
  for (const item of array) {
    if (typeof item !== 'string') validation();
    const reasonIndex = CONTEXT_SELECTION_REASON_ORDER.indexOf(item as (typeof CONTEXT_SELECTION_REASON_ORDER)[number]);
    if (reasonIndex < 0 || reasonIndex <= previousIndex) validation();
    previousIndex = reasonIndex;
    result.push(item);
  }
  return result;
}

function storedSelectionReasons(value: unknown): string[] {
  try {
    return selectionReasons(value);
  } catch {
    integrity();
  }
}

function validateDeliveryItems(value: unknown, scoreSchemaVersion: number): ContextDeliveryItemInput[] {
  const array = arrayInput(value);
  if (array.length > MAX_ITEMS) validation();
  const entries = new Set<string>();
  return array.map((item, index) => {
    const object = objectInput(item, ['entryId', 'entryRevision', 'rank', 'scoreComponents', 'selectionReasons', 'origin'], false);
    const entryId = boundedIdentifier(readField(object, 'entryId'));
    if (entries.has(entryId)) validation();
    entries.add(entryId);
    const entryRevision = positiveSafeInteger(readField(object, 'entryRevision'));
    const rank = positiveSafeInteger(readField(object, 'rank'));
    if (rank !== index + 1) validation();
    const origin = object.origin === undefined ? undefined : isContextEntryOrigin(object.origin) ? object.origin : validation();
    return {
      entryId,
      entryRevision,
      rank,
      scoreComponents: scoreComponentsForVersion(readField(object, 'scoreComponents'), scoreSchemaVersion),
      selectionReasons: selectionReasons(readField(object, 'selectionReasons')),
      ...(origin === undefined ? {} : { origin }),
    };
  });
}

function sanitizeExternalError(value: unknown, workspace: string): string {
  if (typeof value !== 'string' || value.length === 0) validation();
  let sanitized: unknown;
  try {
    sanitized = sanitizeJson({ error: value }, { workspace }).value;
  } catch {
    validation();
  }
  if (!isPlainObject(sanitized)) validation();
  const error = readField(sanitized, 'error');
  if (typeof error !== 'string' || error.length === 0 || Buffer.byteLength(error, 'utf8') > MAX_EXTERNAL_ERROR_BYTES) validation();
  return error;
}

function validateExternalSummary(value: unknown, workspace: string): ExternalSyncSummary {
  const object = objectInput(value, ['attempted', 'imported', 'sources'], true);
  const attempted = booleanValue(readField(object, 'attempted'));
  const imported = nonNegativeSafeInteger(readField(object, 'imported'));
  const sourceArray = arrayInput(readField(object, 'sources'));
  if (sourceArray.length > MAX_SOURCES) validation();
  const sourceIds = new Set<string>();
  const sources = sourceArray.map((source) => {
    const sourceObject = objectInput(source, ['sourceId', 'commit', 'documents', 'imported', 'error'], false);
    for (const field of ['sourceId', 'commit', 'documents', 'imported'] as const) {
      if (!hasOwn(sourceObject, field)) validation();
    }
    const sourceId = boundedIdentifier(readField(sourceObject, 'sourceId'));
    if (sourceIds.has(sourceId)) validation();
    sourceIds.add(sourceId);
    const rawCommit = readField(sourceObject, 'commit');
    const commit = rawCommit === null
      ? null
      : typeof rawCommit === 'string' && rawCommit.length > 0 && /^[0-9a-f]+$/u.test(rawCommit) && Buffer.byteLength(rawCommit, 'utf8') <= MAX_IDENTIFIER_BYTES
        ? rawCommit
        : validation();
    const documents = nonNegativeSafeInteger(readField(sourceObject, 'documents'));
    const sourceImported = nonNegativeSafeInteger(readField(sourceObject, 'imported'));
    if (sourceImported > documents) validation();
    const result: ExternalSyncSourceSummary = { sourceId, commit, documents, imported: sourceImported };
    if (hasOwn(sourceObject, 'error')) result.error = sanitizeExternalError(readField(sourceObject, 'error'), workspace);
    return result;
  });
  if (!attempted && (imported !== 0 || sources.length !== 0)) validation();
  const sourceTotal = sources.reduce((total, source) => total + source.imported, 0);
  if (imported !== sourceTotal) validation();
  const summary = { attempted, imported, sources };
  if (Buffer.byteLength(canonicalJson(summary), 'utf8') > MAX_EXTERNAL_SUMMARY_BYTES) validation();
  return summary;
}

function validateContextDeliveryInput(value: unknown): ValidatedContextDeliveryInput {
  try {
    const object = objectInput(value, [
      'workspace', 'deliveryId', 'runId', 'throughSequence', 'intakeSessionId', 'taskProfileHash',
      'queryHash', 'policyVersion', 'externalSyncSummary', 'charBudget', 'charCount', 'truncated',
      'createdAt', 'items', 'scoreSchemaVersion',
    ], false);
    for (const field of ['workspace', 'deliveryId', 'runId', 'throughSequence', 'intakeSessionId', 'taskProfileHash', 'queryHash', 'policyVersion', 'externalSyncSummary', 'charBudget', 'charCount', 'truncated', 'createdAt', 'items']) {
      if (!hasOwn(object, field)) validation();
    }
    const workspace = boundedIdentifier(readField(object, 'workspace'));
    const deliveryId = boundedIdentifier(readField(object, 'deliveryId'));
    const runId = boundedIdentifier(readField(object, 'runId'));
    const throughSequence = nonNegativeSafeInteger(readField(object, 'throughSequence'));
    const rawIntakeSessionId = readField(object, 'intakeSessionId');
    const intakeSessionId = rawIntakeSessionId === null ? null : boundedIdentifier(rawIntakeSessionId);
    const taskProfileHash = hash(readField(object, 'taskProfileHash'));
    const queryHash = hash(readField(object, 'queryHash'));
    const policyVersion = boundedIdentifier(readField(object, 'policyVersion'));
    const externalSyncSummary = validateExternalSummary(readField(object, 'externalSyncSummary'), workspace);
    const charBudget = readField(object, 'charBudget');
    if (typeof charBudget !== 'number' || !Number.isSafeInteger(charBudget) || charBudget < 1 || charBudget > MAX_CHAR_BUDGET) validation();
    const charCount = readField(object, 'charCount');
    if (typeof charCount !== 'number' || !Number.isSafeInteger(charCount) || charCount < 0 || charCount > charBudget) validation();
    const truncated = booleanValue(readField(object, 'truncated'));
    const createdAt = timestamp(readField(object, 'createdAt'));
    const scoreSchemaVersion = object.scoreSchemaVersion === undefined ? undefined : positiveSafeInteger(object.scoreSchemaVersion);
    const items = validateDeliveryItems(readField(object, 'items'), scoreSchemaVersion ?? 1);
    return {
      workspace,
      deliveryId,
      runId,
      throughSequence,
      intakeSessionId,
      taskProfileHash,
      queryHash,
      policyVersion,
      externalSyncSummary,
      charBudget,
      charCount,
      truncated,
      createdAt,
      items,
      ...(scoreSchemaVersion === undefined ? {} : { scoreSchemaVersion }),
    };
  } catch {
    validation();
  }
}

function validateReadInput(value: unknown): ReadContextDeliveryInput {
  try {
    const object = objectInput(value, ['workspace', 'deliveryId'], true);
    return {
      workspace: boundedIdentifier(readField(object, 'workspace')),
      deliveryId: boundedIdentifier(readField(object, 'deliveryId')),
    };
  } catch {
    validation();
  }
}

function encodeCursor(cursor: DeliveryCursor): string {
  return Buffer.from(JSON.stringify(cursor), 'utf8').toString('base64url');
}

function parseCursor(value: unknown): DeliveryCursor | undefined {
  if (value === undefined) return undefined;
  try {
    if (typeof value !== 'string' || !/^[A-Za-z0-9_-]+$/u.test(value)) validation();
    const decoded = Buffer.from(value, 'base64url');
    if (decoded.toString('base64url') !== value) validation();
    const parsed: unknown = JSON.parse(decoded.toString('utf8'));
    if (!isPlainObject(parsed)) validation();
    const keys = ownKeys(parsed);
    if (keys.length !== 3 || keys[0] !== 'version' || keys[1] !== 'createdAt' || keys[2] !== 'deliveryId') validation();
    if (readField(parsed, 'version') !== DELIVERY_CURSOR_VERSION) validation();
    const createdAt = timestamp(readField(parsed, 'createdAt'));
    const deliveryId = boundedIdentifier(readField(parsed, 'deliveryId'));
    const cursor = { version: DELIVERY_CURSOR_VERSION, createdAt, deliveryId } as const;
    if (encodeCursor(cursor) !== value) validation();
    return cursor;
  } catch {
    validation();
  }
}

function validateListInput(value: unknown): { workspace: string; runId: string; limit: number; cursor?: DeliveryCursor } {
  try {
    const object = objectInput(value, ['workspace', 'runId', 'cursor', 'limit'], false);
    if (!hasOwn(object, 'workspace') || !hasOwn(object, 'runId')) validation();
    const workspace = boundedIdentifier(readField(object, 'workspace'));
    const runId = boundedIdentifier(readField(object, 'runId'));
    const rawLimit = hasOwn(object, 'limit') ? readField(object, 'limit') : undefined;
    const limit = rawLimit === undefined ? DEFAULT_LIMIT : rawLimit;
    if (typeof limit !== 'number' || !Number.isSafeInteger(limit) || limit < 1 || limit > MAX_LIMIT) validation();
    const cursor = parseCursor(hasOwn(object, 'cursor') ? readField(object, 'cursor') : undefined);
    return { workspace, runId, limit, ...(cursor === undefined ? {} : { cursor }) };
  } catch {
    validation();
  }
}

function canonicalDeliveryBody(input: ContextDeliveryInput): string {
  return canonicalJson({
    workspace: input.workspace,
    deliveryId: input.deliveryId,
    runId: input.runId,
    throughSequence: input.throughSequence,
    intakeSessionId: input.intakeSessionId,
    taskProfileHash: input.taskProfileHash,
    queryHash: input.queryHash,
    policyVersion: input.policyVersion,
    externalSyncSummary: input.externalSyncSummary,
    charBudget: input.charBudget,
    charCount: input.charCount,
    truncated: input.truncated,
    createdAt: input.createdAt,
    items: input.items.map((item) => ({
      entryId: item.entryId,
      entryRevision: item.entryRevision,
      rank: item.rank,
      scoreComponents: item.scoreComponents,
      selectionReasons: item.selectionReasons,
      ...(item.origin === undefined ? {} : { origin: item.origin }),
    })),
    scoreSchemaVersion: input.scoreSchemaVersion ?? 1,
  });
}

function selectHeaderByDeliveryId(database: SqliteDatabase, deliveryId: string): DeliveryHeaderRow | undefined {
  return database.prepare(`
    SELECT cd.delivery_id, cd.run_id, cd.through_sequence, cd.intake_session_id,
           cd.task_profile_hash, cd.query_hash, cd.policy_version,
           cd.external_sync_summary_json, cd.char_budget, cd.char_count,
           cd.truncated, cd.created_at, cd.score_schema_version,
           lr.workspace AS run_workspace, lr.last_sequence AS run_last_sequence
      FROM context_deliveries AS cd
      LEFT JOIN ledger_runs AS lr ON lr.run_id = cd.run_id
     WHERE cd.delivery_id = ?
  `).get<DeliveryHeaderRow>(deliveryId);
}

function assertRunForWrite(database: SqliteDatabase, input: ValidatedContextDeliveryInput): void {
  const run = database.prepare('SELECT run_id, last_sequence FROM ledger_runs WHERE run_id = ? AND workspace = ?').get<{ run_id: unknown; last_sequence: unknown }>(input.runId, input.workspace);
  if (!run) notFound();
  if (typeof run.run_id !== 'string') integrity();
  const lastSequence = storedNonNegativeSafeInteger(run.last_sequence);
  if (input.throughSequence > lastSequence) conflict();
  if (input.intakeSessionId !== null) {
    const intake = database.prepare(`
      SELECT ri.session_id, s.id AS session_id_join, s.workspace AS session_workspace
        FROM run_intakes AS ri
        LEFT JOIN akinator_sessions AS s ON s.id = ri.session_id
       WHERE ri.run_id = ?
    `).get<{ session_id: unknown; session_id_join: unknown; session_workspace: unknown }>(input.runId);
    if (!intake || intake.session_id !== input.intakeSessionId || intake.session_id_join !== input.intakeSessionId || intake.session_workspace !== input.workspace) notFound();
  }
  for (const item of input.items) {
    const entry = database.prepare(`
      SELECT e.id, e.workspace, r.workspace AS revision_workspace, r.scope_json
        FROM entry_revisions AS r
        JOIN entries AS e ON e.id = r.entry_id
       WHERE r.entry_id = ? AND r.revision = ?
    `).get<{ id: unknown; workspace: unknown; revision_workspace: unknown; scope_json: unknown }>(item.entryId, item.entryRevision);
    if (!entry || entry.id !== item.entryId) notFound();
    const entryWorkspace = typeof entry.workspace === 'string' ? entry.workspace : notFound();
    const origin = item.origin ?? 'project';
    if (entry.revision_workspace !== entryWorkspace || !entryOriginMatchesWorkspace({ origin, runWorkspace: input.workspace, entryWorkspace })) notFound();
    if (origin === 'global') {
      if (entry.workspace !== 'global' || typeof entry.scope_json !== 'string' || !/"visibility"\s*:\s*"global"/u.test(entry.scope_json)) notFound();
    } else if (origin === 'ecosystem' && (typeof entry.scope_json !== 'string' || (!/"retrievalScope"\s*:\s*"ecosystem"/u.test(entry.scope_json) && !/"applicability"\s*:/u.test(entry.scope_json)))) notFound();
  }
}

function validateStoredJson(value: unknown): unknown {
  if (typeof value !== 'string') integrity();
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    integrity();
  }
  try {
    if (canonicalJson(parsed) !== value) integrity();
  } catch {
    integrity();
  }
  return parsed;
}

function validateStoredExternalSummary(value: unknown, workspace: string): ExternalSyncSummary {
  try {
    const parsed = validateStoredJson(value);
    const normalized = validateExternalSummary(parsed, workspace);
    if (canonicalJson(normalized) !== value) integrity();
    return normalized;
  } catch (error) {
    if (isKiokukoError(error) && error.code === 'INTEGRITY_ERROR') throw error;
    integrity();
  }
}

function validateStoredHeader(row: DeliveryHeaderRow, workspace: string): ContextDeliveryInput {
  const deliveryId = boundedStoredIdentifier(row.delivery_id);
  const runId = boundedStoredIdentifier(row.run_id);
  const runWorkspace = boundedStoredIdentifier(row.run_workspace);
  if (runWorkspace !== workspace) notFound();
  const lastSequence = storedNonNegativeSafeInteger(row.run_last_sequence);
  const throughSequence = storedNonNegativeSafeInteger(row.through_sequence);
  if (throughSequence > lastSequence) integrity();
  const rawIntakeSessionId = row.intake_session_id;
  const intakeSessionId = rawIntakeSessionId === null ? null : boundedStoredIdentifier(rawIntakeSessionId);
  const taskProfileHash = storedHash(row.task_profile_hash);
  const queryHash = storedHash(row.query_hash);
  const policyVersion = boundedStoredIdentifier(row.policy_version);
  const scoreSchemaVersion = storedPositiveSafeInteger(row.score_schema_version);
  const externalSyncSummary = validateStoredExternalSummary(row.external_sync_summary_json, workspace);
  const charBudget = storedPositiveSafeInteger(row.char_budget);
  if (charBudget > MAX_CHAR_BUDGET) integrity();
  const charCount = storedNonNegativeSafeInteger(row.char_count);
  if (charCount > charBudget) integrity();
  const truncated = storedBoolean(row.truncated);
  const createdAt = storedTimestamp(row.created_at);
  return {
    workspace,
    deliveryId,
    runId,
    throughSequence,
    intakeSessionId,
    taskProfileHash,
    queryHash,
    policyVersion,
    externalSyncSummary,
    charBudget,
    charCount,
    truncated,
    createdAt,
    items: [],
    ...(scoreSchemaVersion > 1 ? { scoreSchemaVersion } : {}),
  };
}

function selectDeliveryEntries(database: SqliteDatabase, deliveryId: string): DeliveryEntryRow[] {
  return database.prepare(`
    SELECT cde.delivery_id, cde.entry_id, cde.entry_revision, cde.rank,
           cde.score_components_json, cde.selection_reason_json, cde.origin_scope,
           e.workspace AS entry_workspace, r.workspace AS revision_workspace
      FROM context_delivery_entries AS cde
      LEFT JOIN entry_revisions AS r
        ON r.entry_id = cde.entry_id AND r.revision = cde.entry_revision
      LEFT JOIN entries AS e ON e.id = r.entry_id
     WHERE cde.delivery_id = ?
     ORDER BY cde.rank ASC, cde.entry_id ASC
  `).all<DeliveryEntryRow>(deliveryId);
}

function validateStoredEntries(database: SqliteDatabase, header: ContextDeliveryInput): ContextDeliveryItemInput[] {
  const rows = selectDeliveryEntries(database, header.deliveryId);
  if (rows.length > MAX_ITEMS) integrity();
  const entryIds = new Set<string>();
  let expectedRank = 1;
  return rows.map((row) => {
    const deliveryId = boundedStoredIdentifier(row.delivery_id);
    const entryId = boundedStoredIdentifier(row.entry_id);
    if (deliveryId !== header.deliveryId || entryIds.has(entryId)) integrity();
    entryIds.add(entryId);
    const entryWorkspace = boundedStoredIdentifier(row.entry_workspace);
    const origin = isContextEntryOrigin(row.origin_scope) ? row.origin_scope : integrity();
    if (!entryOriginMatchesWorkspace({ origin, runWorkspace: header.workspace, entryWorkspace })) integrity();
    const entryRevision = storedPositiveSafeInteger(row.entry_revision);
    const revisionWorkspace = boundedStoredIdentifier(row.revision_workspace);
    if (revisionWorkspace !== entryWorkspace) integrity();
    const rank = storedPositiveSafeInteger(row.rank);
    if (rank !== expectedRank) integrity();
    expectedRank += 1;
    const scoreValue = validateStoredJson(row.score_components_json);
    const reasonValue = validateStoredJson(row.selection_reason_json);
    const score = storedScoreComponents(scoreValue, header.scoreSchemaVersion ?? 1);
    const reasons = storedSelectionReasons(reasonValue);
    if (canonicalJson(score) !== row.score_components_json || canonicalJson(reasons) !== row.selection_reason_json) integrity();
    return { entryId, entryRevision, rank, scoreComponents: score, selectionReasons: reasons, ...(origin === 'project' ? {} : { origin }) };
  });
}

function assertStoredIntakeLink(database: SqliteDatabase, header: ContextDeliveryInput): void {
  if (header.intakeSessionId === null) return;
  const intake = database.prepare(`
    SELECT ri.run_id, ri.session_id, s.id AS session_id_join, s.workspace AS session_workspace
      FROM run_intakes AS ri
      LEFT JOIN akinator_sessions AS s ON s.id = ri.session_id
     WHERE ri.run_id = ?
  `).get<{ run_id: unknown; session_id: unknown; session_id_join: unknown; session_workspace: unknown }>(header.runId);
  if (!intake || intake.run_id !== header.runId || intake.session_id !== header.intakeSessionId || intake.session_id_join !== header.intakeSessionId || intake.session_workspace !== header.workspace) integrity();
}

function readStoredDelivery(database: SqliteDatabase, workspace: string, deliveryId: string): ContextDeliveryView {
  const row = selectHeaderByDeliveryId(database, deliveryId);
  if (!row) notFound();
  if (row.run_workspace === null || row.run_workspace === undefined) integrity();
  if (row.run_workspace !== workspace) notFound();
  const header = validateStoredHeader(row, workspace);
  assertStoredIntakeLink(database, header);
  const items = validateStoredEntries(database, header);
  const view: ContextDeliveryView = {
    ...header,
    items: items.map((item) => ({ ...item, scoreComponents: { ...item.scoreComponents }, selectionReasons: [...item.selectionReasons], untrusted: true })),
    untrusted: true,
  };
  return view;
}

function writeContextDelivery(database: SqliteDatabase, input: ValidatedContextDeliveryInput): ContextDeliveryView {
  const existing = selectHeaderByDeliveryId(database, input.deliveryId);
  if (existing) {
    if (existing.run_workspace !== input.workspace) conflict();
    const stored = readStoredDelivery(database, input.workspace, input.deliveryId);
    if (canonicalDeliveryBody(stored) === canonicalDeliveryBody(input)) return stored;
    conflict();
  }
  assertRunForWrite(database, input);
  const summaryJson = canonicalJson(input.externalSyncSummary);
  database.prepare(`
    INSERT INTO context_deliveries (
      delivery_id, run_id, through_sequence, intake_session_id, task_profile_hash, query_hash,
      policy_version, external_sync_summary_json, char_budget, char_count, truncated, created_at, score_schema_version
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    input.deliveryId,
    input.runId,
    input.throughSequence,
    input.intakeSessionId,
    input.taskProfileHash,
    input.queryHash,
    input.policyVersion,
    summaryJson,
    input.charBudget,
    input.charCount,
    input.truncated ? 1 : 0,
    input.createdAt,
    input.scoreSchemaVersion ?? 1,
  );
  for (const item of input.items) {
    database.prepare(`
      INSERT INTO context_delivery_entries (
        delivery_id, entry_id, entry_revision, rank, score_components_json, selection_reason_json, origin_scope
      ) VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(
      input.deliveryId,
      item.entryId,
      item.entryRevision,
      item.rank,
      canonicalJson(item.scoreComponents),
      canonicalJson(item.selectionReasons),
      item.origin ?? 'project',
    );
  }
  return readStoredDelivery(database, input.workspace, input.deliveryId);
}

export function recordContextDeliveryInTransaction(database: SqliteDatabase, input: unknown): ContextDeliveryView {
  const validated = validateContextDeliveryInput(input);
  try {
    return writeContextDelivery(database, validated);
  } catch (error) {
    normalizeDatabaseError(error);
  }
}

export function recordContextDelivery(database: SqliteDatabase, input: unknown): ContextDeliveryView {
  const validated = validateContextDeliveryInput(input);
  try {
    return withImmediateTransaction(database, () => writeContextDelivery(database, validated));
  } catch (error) {
    normalizeDatabaseError(error);
  }
}

export function readContextDelivery(database: SqliteDatabase, input: unknown): ContextDeliveryView {
  const validated = validateReadInput(input);
  try {
    return readStoredDelivery(database, validated.workspace, validated.deliveryId);
  } catch (error) {
    normalizeDatabaseError(error);
  }
}

export function listContextDeliveries(database: SqliteDatabase, input: unknown): ContextDeliveryPage {
  const validated = validateListInput(input);
  try {
    const run = database.prepare('SELECT run_id, workspace, last_sequence FROM ledger_runs WHERE run_id = ? AND workspace = ?').get<{ run_id: unknown; workspace: unknown; last_sequence: unknown }>(validated.runId, validated.workspace);
    if (!run) notFound();
    if (run.run_id !== validated.runId || run.workspace !== validated.workspace) integrity();
    storedNonNegativeSafeInteger(run.last_sequence);
    const parameters: Array<string | number> = [validated.runId, validated.workspace];
    let cursorClause = '';
    if (validated.cursor !== undefined) {
      cursorClause = ' AND (cd.created_at < ? OR (cd.created_at = ? AND cd.delivery_id > ?))';
      parameters.push(validated.cursor.createdAt, validated.cursor.createdAt, validated.cursor.deliveryId);
    }
    parameters.push(validated.limit + 1);
    const rows = database.prepare(`
      SELECT cd.delivery_id, cd.run_id, cd.through_sequence, cd.intake_session_id,
             cd.task_profile_hash, cd.query_hash, cd.policy_version,
             cd.external_sync_summary_json, cd.char_budget, cd.char_count,
             cd.truncated, cd.created_at, cd.score_schema_version,
             lr.workspace AS run_workspace, lr.last_sequence AS run_last_sequence
        FROM context_deliveries AS cd
        LEFT JOIN ledger_runs AS lr ON lr.run_id = cd.run_id
       WHERE cd.run_id = ? AND lr.workspace = ?${cursorClause}
       ORDER BY cd.created_at DESC, cd.delivery_id ASC
       LIMIT ?
    `).all<DeliveryHeaderRow>(...parameters);
    const pageRows = rows.slice(0, validated.limit);
    const items = pageRows.map((row) => {
      const header = validateStoredHeader(row, validated.workspace);
      assertStoredIntakeLink(database, header);
      const storedItems = validateStoredEntries(database, header);
      return {
        ...header,
        items: storedItems.map((item) => ({ ...item, scoreComponents: { ...item.scoreComponents }, selectionReasons: [...item.selectionReasons], untrusted: true as const })),
        untrusted: true as const,
      };
    });
    const last = pageRows.at(-1);
    const nextCursor = rows.length > validated.limit && last !== undefined
      ? encodeCursor({ version: DELIVERY_CURSOR_VERSION, createdAt: storedTimestamp(last.created_at), deliveryId: boundedStoredIdentifier(last.delivery_id) })
      : null;
    return { items, nextCursor };
  } catch (error) {
    normalizeDatabaseError(error);
  }
}
