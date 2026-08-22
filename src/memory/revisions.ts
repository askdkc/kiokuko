import type { SqliteDatabase, SqliteRow } from '../db/adapter.js';
import { KiokukoError } from '../errors.js';
import {
  canonicalContentHash,
  canonicalJson,
  requireWorkspace,
  validateRecordInput,
  type EntryKind,
  type JsonObject,
} from '../serialization/validate.js';

export interface EntryRevisionRecord {
  entryId: string;
  workspace: string;
  revision: number;
  kind: EntryKind;
  title: string;
  body: string;
  summary: string | null;
  scope: JsonObject;
  provenance: JsonObject;
  tags: string[];
  contentHash: string;
  createdBy: string;
  createdAt: string;
}

export interface EntryRevisionInput {
  entryId: string;
  workspace: string;
  revision: number;
  kind: EntryKind;
  title: string;
  body: string;
  summary?: string | null;
  scope?: JsonObject;
  provenance?: JsonObject;
  tags?: string[];
  contentHash?: string;
  createdBy: string;
  createdAt: string;
}

interface RevisionRow extends SqliteRow {
  entry_id: string;
  workspace: string;
  revision: number;
  kind: EntryKind;
  title: string;
  body: string;
  summary: string | null;
  scope_json: string;
  provenance_json: string;
  content_hash: string;
  created_by: string;
  created_at: string;
}

function parseObject(value: string, field: string): JsonObject {
  try {
    const parsed: unknown = JSON.parse(value);
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) throw new Error('not object');
    return parsed as JsonObject;
  } catch {
    throw new KiokukoError('INTEGRITY_ERROR', `Stored ${field} is not valid JSON`);
  }
}

function revisionKey(input: { entryId: string; workspace: string; revision: number }): void {
  if (typeof input.entryId !== 'string' || input.entryId.length === 0) {
    throw new KiokukoError('VALIDATION_ERROR', 'entryId must be a non-empty string');
  }
  requireWorkspace(input.workspace);
  if (!Number.isSafeInteger(input.revision) || input.revision < 1) {
    throw new KiokukoError('VALIDATION_ERROR', 'revision must be a positive integer');
  }
}

function tagsFor(database: SqliteDatabase, entryId: string, revision: number): string[] {
  return database
    .prepare('SELECT tag FROM entry_revision_tags WHERE entry_id = ? AND revision = ? ORDER BY tag ASC')
    .all<{ tag: string }>(entryId, revision)
    .map((row) => row.tag);
}

function rowToRevision(database: SqliteDatabase, row: RevisionRow): EntryRevisionRecord {
  return {
    entryId: row.entry_id,
    workspace: row.workspace,
    revision: Number(row.revision),
    kind: row.kind,
    title: row.title,
    body: row.body,
    summary: row.summary,
    scope: parseObject(row.scope_json, 'scope'),
    provenance: parseObject(row.provenance_json, 'provenance'),
    tags: tagsFor(database, row.entry_id, Number(row.revision)),
    contentHash: row.content_hash,
    createdBy: row.created_by,
    createdAt: row.created_at,
  };
}

function selectRevision(database: SqliteDatabase, input: { entryId: string; workspace: string; revision: number }): EntryRevisionRecord | undefined {
  const row = database.prepare(`
    SELECT entry_id, workspace, revision, kind, title, body, summary,
           scope_json, provenance_json, content_hash, created_by, created_at
      FROM entry_revisions
     WHERE entry_id = ? AND workspace = ? AND revision = ?
  `).get<RevisionRow>(input.entryId, input.workspace, input.revision);
  return row === undefined ? undefined : rowToRevision(database, row);
}

export function readEntryRevision(database: SqliteDatabase, input: { entryId: string; workspace: string; revision: number }): EntryRevisionRecord {
  revisionKey(input);
  const result = selectRevision(database, input);
  if (result === undefined) throw new KiokukoError('NOT_FOUND', 'Entry revision not found');
  return result;
}

export function findEntryRevision(database: SqliteDatabase, input: { entryId: string; workspace: string; revision: number }): EntryRevisionRecord | undefined {
  revisionKey(input);
  return selectRevision(database, input);
}

export function insertEntryRevisionInTransaction(database: SqliteDatabase, input: EntryRevisionInput): EntryRevisionRecord {
  revisionKey(input);
  if (typeof input.createdBy !== 'string' || input.createdBy.length === 0 || typeof input.createdAt !== 'string' || input.createdAt.length === 0) {
    throw new KiokukoError('VALIDATION_ERROR', 'Revision creator and timestamp are required');
  }
  const owner = database.prepare('SELECT workspace FROM entries WHERE id = ?').get<{ workspace: string }>(input.entryId);
  if (owner === undefined) throw new KiokukoError('NOT_FOUND', 'Entry not found');
  if (owner.workspace !== input.workspace) throw new KiokukoError('NOT_FOUND', 'Entry does not belong to workspace');

  const validated = validateRecordInput({
    workspace: input.workspace,
    kind: input.kind,
    title: input.title,
    body: input.body,
    summary: input.summary,
    scope: input.scope,
    provenance: input.provenance,
    tags: input.tags,
    createdBy: input.createdBy,
    actor: input.createdBy,
  });
  const contentHash = canonicalContentHash({
    kind: validated.kind,
    title: validated.title,
    body: validated.body,
    summary: validated.summary,
    scope: validated.scope,
    provenance: validated.provenance,
    tags: validated.tags,
  });
  if (input.contentHash !== undefined && input.contentHash !== contentHash) {
    throw new KiokukoError('INTEGRITY_ERROR', 'Entry revision content hash does not match its content');
  }
  try {
    database.prepare(`
      INSERT INTO entry_revisions (
        entry_id, workspace, revision, kind, title, body, summary, scope_json,
        provenance_json, content_hash, created_by, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      input.entryId,
      input.workspace,
      input.revision,
      validated.kind,
      validated.title,
      validated.body,
      validated.summary,
      canonicalJson(validated.scope),
      canonicalJson(validated.provenance),
      contentHash,
      input.createdBy,
      input.createdAt,
    );
    for (const tag of validated.tags) {
      database.prepare('INSERT INTO entry_revision_tags (entry_id, revision, tag) VALUES (?, ?, ?)').run(input.entryId, input.revision, tag);
    }
  } catch (error) {
    if (error instanceof Error && /UNIQUE|constraint/i.test(error.message)) {
      throw new KiokukoError('CONFLICT', 'Entry revision or content already exists');
    }
    throw error;
  }
  const result = selectRevision(database, input);
  if (result === undefined) throw new KiokukoError('INTEGRITY_ERROR', 'Inserted entry revision could not be read back');
  return result;
}
