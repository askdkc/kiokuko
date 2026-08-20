import { randomUUID } from 'node:crypto';
import type { SqliteDatabase, SqliteRow } from '../db/adapter.js';
import { withImmediateTransaction } from '../db/transaction.js';
import { KiokukoError } from '../errors.js';
import { canonicalContentHash, canonicalJson, type JsonObject, validateRecordInput, requireWorkspace, type EntryKind, type EntryStatus, type TrustLevel } from '../serialization/validate.js';
import { recordAuditEvent } from './audit.js';
import { findSecret } from './secrets.js';

export interface RecordEntryInput {
  workspace: string;
  kind: EntryKind;
  status?: EntryStatus;
  title: string;
  body: string;
  summary?: string | null;
  scope?: JsonObject;
  provenance?: JsonObject;
  trustLevel?: TrustLevel;
  confidence?: number;
  tags?: string[];
  createdBy?: string;
  actor?: string;
}

export interface RecordEntryOptions {
  now?: string;
  idFactory?: () => string;
}

export interface ReadEntryInput {
  workspace: string;
  entryId: string;
}

export interface UpdateCandidateEntryInput {
  workspace: string;
  entryId: string;
  expectedRevision: number;
  kind: EntryKind;
  title: string;
  body: string;
  summary?: string | null;
  scope?: JsonObject;
  provenance?: JsonObject;
  tags?: string[];
  actor?: string;
  now?: string;
}

export interface EntryRecord {
  id: string;
  workspace: string;
  kind: EntryKind;
  status: EntryStatus;
  title: string;
  body: string;
  summary: string | null;
  scope: JsonObject;
  provenance: JsonObject;
  trustLevel: TrustLevel;
  confidence: number;
  contentHash: string;
  revision: number;
  supersededBy: string | null;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
  verifiedAt: string | null;
  tags: string[];
}

interface EntryRow extends SqliteRow {
  id: string;
  workspace: string;
  kind: EntryKind;
  status: EntryStatus;
  title: string;
  body: string;
  summary: string | null;
  scope_json: string;
  provenance_json: string;
  trust_level: TrustLevel;
  confidence: number;
  content_hash: string;
  revision: number;
  superseded_by: string | null;
  created_by: string;
  created_at: string;
  updated_at: string;
  verified_at: string | null;
}

function parseStoredObject(value: string, field: string): JsonObject {
  try {
    const parsed: unknown = JSON.parse(value);
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) throw new Error('not object');
    return parsed as JsonObject;
  } catch {
    throw new KiokukoError('INTEGRITY_ERROR', `Stored ${field} is not valid JSON`);
  }
}

function rowToEntry(database: SqliteDatabase, row: EntryRow): EntryRecord {
  const tags = database
    .prepare('SELECT tag FROM tags WHERE entry_id = ? ORDER BY tag ASC')
    .all<{ tag: string }>(row.id)
    .map((tag) => tag.tag);
  return {
    id: row.id,
    workspace: row.workspace,
    kind: row.kind,
    status: row.status,
    title: row.title,
    body: row.body,
    summary: row.summary,
    scope: parseStoredObject(row.scope_json, 'scope'),
    provenance: parseStoredObject(row.provenance_json, 'provenance'),
    trustLevel: row.trust_level,
    confidence: Number(row.confidence),
    contentHash: row.content_hash,
    revision: Number(row.revision),
    supersededBy: row.superseded_by,
    createdBy: row.created_by,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    verifiedAt: row.verified_at,
    tags,
  };
}

function selectEntry(database: SqliteDatabase, workspace: string, entryId: string): EntryRecord | undefined {
  const row = database
    .prepare(
      `SELECT id, workspace, kind, status, title, body, summary, scope_json, provenance_json,
              trust_level, confidence, content_hash, revision, superseded_by, created_by,
              created_at, updated_at, verified_at
       FROM entries
       WHERE id = ? AND workspace = ?`,
    )
    .get<EntryRow>(entryId, workspace);
  return row ? rowToEntry(database, row) : undefined;
}

export function recordEntryInTransaction(database: SqliteDatabase, input: RecordEntryInput, options: RecordEntryOptions = {}): EntryRecord {
  const validated = validateRecordInput(input);
  const secretFinding = findSecret(canonicalJson({
    title: validated.title,
    body: validated.body,
    summary: validated.summary,
    scope: validated.scope,
    provenance: validated.provenance,
    tags: validated.tags,
  }));
  if (secretFinding) {
    throw new KiokukoError('SECURITY_REJECTION', 'Entry content resembles a secret and was not stored', { kind: secretFinding.kind });
  }
  if (validated.status === 'superseded') {
    throw new KiokukoError('CONFLICT', 'A new entry cannot start in superseded status');
  }
  const contentHash = canonicalContentHash({
    kind: validated.kind,
    title: validated.title,
    body: validated.body,
    summary: validated.summary,
    scope: validated.scope,
    provenance: validated.provenance,
    tags: validated.tags,
  });
  const now = options.now ?? new Date().toISOString();
  const idFactory = options.idFactory ?? randomUUID;

  const existing = database
    .prepare('SELECT id FROM entries WHERE workspace = ? AND content_hash = ?')
    .get<{ id: string }>(validated.workspace, contentHash);
  if (existing) {
    const record = selectEntry(database, validated.workspace, existing.id);
    if (!record) throw new KiokukoError('INTEGRITY_ERROR', 'Entry hash index points to a missing entry');
    return record;
  }

  const id = idFactory();
  const verifiedAt = validated.status === 'verified' ? now : null;
  database
    .prepare(
      `INSERT INTO entries (
        id, workspace, kind, status, title, body, summary, scope_json, provenance_json,
        trust_level, confidence, content_hash, revision, superseded_by, created_by,
        created_at, updated_at, verified_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      id,
      validated.workspace,
      validated.kind,
      validated.status,
      validated.title,
      validated.body,
      validated.summary,
      JSON.stringify(validated.scope),
      JSON.stringify(validated.provenance),
      validated.trustLevel,
      validated.confidence,
      contentHash,
      1,
      null,
      validated.createdBy,
      now,
      now,
      verifiedAt,
    );

  for (const tag of validated.tags) {
    database.prepare('INSERT INTO tags (entry_id, tag) VALUES (?, ?)').run(id, tag);
  }

  recordAuditEvent(database, {
    entryId: id,
    workspace: validated.workspace,
    operation: 'record',
    actor: validated.actor,
    details: { contentHash, status: validated.status },
    createdAt: now,
  });

  const record = selectEntry(database, validated.workspace, id);
  if (!record) throw new KiokukoError('INTEGRITY_ERROR', 'Recorded entry could not be read back');
  return record;
}

export function recordEntry(database: SqliteDatabase, input: RecordEntryInput, options: RecordEntryOptions = {}): EntryRecord {
  return withImmediateTransaction(database, () => recordEntryInTransaction(database, input, options));
}

export function readEntry(database: SqliteDatabase, input: ReadEntryInput): EntryRecord {
  const workspace = requireWorkspace(input.workspace);
  if (typeof input.entryId !== 'string' || input.entryId.length === 0) {
    throw new KiokukoError('VALIDATION_ERROR', 'entryId must be a non-empty string');
  }
  const record = selectEntry(database, workspace, input.entryId);
  if (!record) throw new KiokukoError('NOT_FOUND', 'Entry not found');
  return record;
}

export function updateCandidateEntry(database: SqliteDatabase, input: UpdateCandidateEntryInput): EntryRecord {
  const workspace = requireWorkspace(input.workspace);
  if (!Number.isInteger(input.expectedRevision) || input.expectedRevision < 1) {
    throw new KiokukoError('VALIDATION_ERROR', 'expectedRevision must be a positive integer');
  }
  const validated = validateRecordInput({
    workspace,
    kind: input.kind,
    status: 'candidate',
    title: input.title,
    body: input.body,
    summary: input.summary,
    scope: input.scope,
    provenance: input.provenance,
    tags: input.tags,
    createdBy: 'kiokuko-web',
    actor: input.actor ?? 'kiokuko-web',
  });
  const secretFinding = findSecret(canonicalJson({
    title: validated.title,
    body: validated.body,
    summary: validated.summary,
    scope: validated.scope,
    provenance: validated.provenance,
    tags: validated.tags,
  }));
  if (secretFinding) throw new KiokukoError('SECURITY_REJECTION', 'Entry content resembles a secret and was not stored', { kind: secretFinding.kind });
  const contentHash = canonicalContentHash({
    kind: validated.kind,
    title: validated.title,
    body: validated.body,
    summary: validated.summary,
    scope: validated.scope,
    provenance: validated.provenance,
    tags: validated.tags,
  });
  const now = input.now ?? new Date().toISOString();

  return withImmediateTransaction(database, () => {
    const current = database.prepare('SELECT status, revision, content_hash FROM entries WHERE id = ? AND workspace = ?').get<{ status: EntryStatus; revision: number; content_hash: string }>(input.entryId, workspace);
    if (!current) throw new KiokukoError('NOT_FOUND', 'Entry not found');
    if (current.status !== 'candidate') throw new KiokukoError('CONFLICT', 'Verified or superseded entries must be replaced, not edited');
    if (Number(current.revision) !== input.expectedRevision) throw new KiokukoError('CONFLICT', 'Entry revision is stale');
    const duplicate = database.prepare('SELECT id FROM entries WHERE workspace = ? AND content_hash = ? AND id <> ?').get<{ id: string }>(workspace, contentHash, input.entryId);
    if (duplicate) throw new KiokukoError('CONFLICT', 'Another entry already contains this content');

    database.prepare(`
      UPDATE entries SET kind = ?, title = ?, body = ?, summary = ?, scope_json = ?, provenance_json = ?,
        content_hash = ?, revision = revision + 1, updated_at = ?, verified_at = NULL
      WHERE id = ? AND workspace = ? AND revision = ?
    `).run(
      validated.kind,
      validated.title,
      validated.body,
      validated.summary,
      canonicalJson(validated.scope),
      canonicalJson(validated.provenance),
      contentHash,
      now,
      input.entryId,
      workspace,
      input.expectedRevision,
    );
    database.prepare('DELETE FROM tags WHERE entry_id = ?').run(input.entryId);
    for (const tag of validated.tags) database.prepare('INSERT INTO tags (entry_id, tag) VALUES (?, ?)').run(input.entryId, tag);
    recordAuditEvent(database, {
      entryId: input.entryId,
      workspace,
      operation: 'record',
      actor: validated.actor,
      details: { edited: true, previousRevision: input.expectedRevision, contentHash },
      createdAt: now,
    });
    const updated = selectEntry(database, workspace, input.entryId);
    if (!updated) throw new KiokukoError('INTEGRITY_ERROR', 'Updated entry could not be read back');
    return updated;
  });
}
