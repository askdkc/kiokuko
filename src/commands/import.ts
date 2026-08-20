import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import type { SqliteDatabase } from '../db/adapter.js';
import { withImmediateTransaction } from '../db/transaction.js';
import { KiokukoError } from '../errors.js';
import { findSecret } from '../memory/secrets.js';
import {
  ENTRY_KINDS,
  ENTRY_STATUSES,
  TRUST_LEVELS,
  canonicalContentHash,
  canonicalJson,
  requireWorkspace,
  validateRecordInput,
  type EntryKind,
  type EntryStatus,
  type JsonObject,
  type TrustLevel,
} from '../serialization/validate.js';

export interface ImportOptions {
  input: string;
  dryRun?: boolean;
  workspace?: string;
}

export interface ImportResult {
  count: number;
  imported: number;
  duplicates: number;
  dryRun: boolean;
  workspace: string | null;
}

interface ImportDocument {
  manifest: Record<string, unknown>;
  entries: Record<string, unknown>[];
  tags: Record<string, unknown>[];
  links: Record<string, unknown>[];
  audit: Record<string, unknown>[];
}

interface ImportEntry {
  id: string;
  workspace: string;
  kind: EntryKind;
  status: EntryStatus;
  title: string;
  body: string;
  summary: string | null;
  scopeJson: string;
  provenanceJson: string;
  trustLevel: TrustLevel;
  confidence: number;
  contentHash: string;
  revision: number;
  supersededBy: string | null;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
  verifiedAt: string | null;
}

const RELATIONS = new Set(['supports', 'contradicts', 'derived_from', 'related_to']);
const AUDIT_OPERATIONS = new Set(['record', 'promote', 'supersede', 'link', 'import', 'purge']);

function objectValue(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new KiokukoError('VALIDATION_ERROR', `${label} must be a JSON object`);
  }
  return value as Record<string, unknown>;
}

function stringValue(value: unknown, label: string, allowEmpty = false): string {
  if (typeof value !== 'string' || (!allowEmpty && value.length === 0)) {
    throw new KiokukoError('VALIDATION_ERROR', `${label} must be a ${allowEmpty ? '' : 'non-empty '}string`);
  }
  return value;
}

function nullableString(value: unknown, label: string): string | null {
  if (value === null || value === undefined) return null;
  return stringValue(value, label, true);
}

function parsedJsonObject(value: unknown, label: string): JsonObject {
  if (typeof value === 'object' && value !== null && !Array.isArray(value)) return value as JsonObject;
  const parsed = JSON.parse(stringValue(value, label));
  return objectValue(parsed, label) as JsonObject;
}

function parseJson(text: string): Record<string, unknown> {
  try {
    return objectValue(JSON.parse(text), 'JSON line');
  } catch (error) {
    if (error instanceof KiokukoError) throw error;
    throw new KiokukoError('VALIDATION_ERROR', 'Import contains invalid JSON');
  }
}

function parseImport(text: string): ImportDocument {
  const lines = text.split('\n');
  while (lines.at(-1) === '') lines.pop();
  if (lines.length < 2) throw new KiokukoError('VALIDATION_ERROR', 'Import file is empty or missing manifest');
  const checksumLine = parseJson(lines[0]!);
  if (checksumLine.type !== 'checksum' || typeof checksumLine.sha256 !== 'string') {
    throw new KiokukoError('VALIDATION_ERROR', 'Import checksum line is invalid');
  }
  const payload = `${lines.slice(1).join('\n')}\n`;
  const actual = createHash('sha256').update(payload, 'utf8').digest('hex');
  if (actual !== checksumLine.sha256) throw new KiokukoError('INTEGRITY_ERROR', 'Import checksum mismatch');

  const payloadLines = lines.slice(1).map(parseJson);
  const manifest = payloadLines.find((line) => line.type === 'manifest');
  if (!manifest || typeof manifest.workspace !== 'string') throw new KiokukoError('VALIDATION_ERROR', 'Import manifest is invalid');
  if (manifest.format !== 'kiokuko-jsonl' || manifest.apiVersion !== '1') {
    throw new KiokukoError('VALIDATION_ERROR', 'Unsupported import format');
  }
  const entries = payloadLines.filter((line) => line.type === 'entry');
  const tags = payloadLines.filter((line) => line.type === 'tag');
  const links = payloadLines.filter((line) => line.type === 'link');
  const audit = payloadLines.filter((line) => line.type === 'audit');
  const counts = objectValue(manifest.counts ?? {}, 'manifest.counts');
  for (const [key, actualCount] of Object.entries({ entries, tags, links, audit })) {
    if (counts[key] !== undefined && counts[key] !== actualCount.length) {
      throw new KiokukoError('INTEGRITY_ERROR', `Import ${key} count does not match manifest`);
    }
  }
  return { manifest, entries, tags, links, audit };
}

function importedEntry(raw: Record<string, unknown>, workspace: string): ImportEntry {
  const id = stringValue(raw.id, 'entry.id');
  const kind = stringValue(raw.kind, 'entry.kind') as EntryKind;
  const status = stringValue(raw.status, 'entry.status') as EntryStatus;
  const title = stringValue(raw.title, 'entry.title');
  const body = stringValue(raw.body, 'entry.body', true);
  const summary = nullableString(raw.summary, 'entry.summary');
  const scope = parsedJsonObject(raw.scope_json, 'entry.scope_json');
  const provenance = parsedJsonObject(raw.provenance_json, 'entry.provenance_json');
  const trustLevel = stringValue(raw.trust_level, 'entry.trust_level') as TrustLevel;
  const confidence = Number(raw.confidence);
  const tags = Array.isArray(raw.tags) ? raw.tags : [];
  const createdBy = stringValue(raw.created_by, 'entry.created_by');
  const supersededBy = nullableString(raw.superseded_by, 'entry.superseded_by');
  const createdAt = stringValue(raw.created_at, 'entry.created_at');
  const updatedAt = stringValue(raw.updated_at, 'entry.updated_at');
  const verifiedAt = nullableString(raw.verified_at, 'entry.verified_at');
  const revision = Number(raw.revision);
  const contentHash = stringValue(raw.content_hash, 'entry.content_hash');

  const validated = validateRecordInput({
    workspace,
    kind,
    status,
    title,
    body,
    summary,
    scope,
    provenance,
    trustLevel,
    confidence,
    tags,
    createdBy,
  });
  if (status === 'superseded' && !supersededBy) throw new KiokukoError('VALIDATION_ERROR', 'Superseded entry needs superseded_by');
  if (!Number.isInteger(revision) || revision < 1) throw new KiokukoError('VALIDATION_ERROR', 'entry.revision must be a positive integer');
  const expectedHash = canonicalContentHash({
    kind: validated.kind,
    title: validated.title,
    body: validated.body,
    summary: validated.summary,
    scope: validated.scope,
    provenance: validated.provenance,
    tags: validated.tags,
  });
  if (expectedHash !== contentHash) throw new KiokukoError('INTEGRITY_ERROR', `Content hash mismatch for entry ${id}`);
  const secretFinding = findSecret(canonicalJson({
    title: validated.title,
    body: validated.body,
    summary: validated.summary,
    scope: validated.scope,
    provenance: validated.provenance,
    tags: validated.tags,
  }));
  if (secretFinding) throw new KiokukoError('SECURITY_REJECTION', 'Import contains secret-like content', { kind: secretFinding.kind });

  return {
    id,
    workspace,
    kind: validated.kind,
    status: validated.status,
    title: validated.title,
    body: validated.body,
    summary: validated.summary,
    scopeJson: canonicalJson(validated.scope),
    provenanceJson: canonicalJson(validated.provenance),
    trustLevel: validated.trustLevel,
    confidence: validated.confidence,
    contentHash,
    revision,
    supersededBy,
    createdBy: validated.createdBy,
    createdAt,
    updatedAt,
    verifiedAt,
  };
}

function validateRelatedLines(document: ImportDocument, entryIds: Set<string>): void {
  for (const tag of document.tags) {
    const entryId = stringValue(tag.entry_id, 'tag.entry_id');
    stringValue(tag.tag, 'tag.tag');
    if (!entryIds.has(entryId)) throw new KiokukoError('VALIDATION_ERROR', `Tag references unknown entry ${entryId}`);
  }
  for (const link of document.links) {
    const from = stringValue(link.from_entry_id, 'link.from_entry_id');
    const to = stringValue(link.to_entry_id, 'link.to_entry_id');
    const relation = stringValue(link.relation, 'link.relation');
    if (!entryIds.has(from) || !entryIds.has(to) || !RELATIONS.has(relation)) {
      throw new KiokukoError('VALIDATION_ERROR', 'Import contains an invalid link');
    }
  }
  for (const event of document.audit) {
    const entryId = nullableString(event.entry_id, 'audit.entry_id');
    const operation = stringValue(event.operation, 'audit.operation');
    if (entryId !== null && !entryIds.has(entryId)) throw new KiokukoError('VALIDATION_ERROR', `Audit references unknown entry ${entryId}`);
    if (!AUDIT_OPERATIONS.has(operation)) throw new KiokukoError('VALIDATION_ERROR', `Unsupported audit operation ${operation}`);
    stringValue(event.event_id, 'audit.event_id');
    stringValue(event.workspace, 'audit.workspace');
    stringValue(event.actor, 'audit.actor');
    stringValue(event.details_json, 'audit.details_json', true);
    stringValue(event.created_at, 'audit.created_at');
  }
}

function existingEntry(database: SqliteDatabase, id: string): { id: string; content_hash: string } | undefined {
  return database.prepare('SELECT id, content_hash FROM entries WHERE id = ?').get<{ id: string; content_hash: string }>(id);
}

export async function importWorkspace(database: SqliteDatabase | undefined, options: ImportOptions): Promise<ImportResult> {
  const parsed = parseImport(await readFile(options.input, 'utf8'));
  const sourceWorkspace = requireWorkspace(parsed.manifest.workspace);
  const workspace = requireWorkspace(options.workspace ?? sourceWorkspace);
  const tagsByEntry = new Map<string, string[]>();
  for (const tag of parsed.tags) {
    const entryId = stringValue(tag.entry_id, 'tag.entry_id');
    const values = tagsByEntry.get(entryId) ?? [];
    values.push(stringValue(tag.tag, 'tag.tag'));
    tagsByEntry.set(entryId, values);
  }
  const entries = parsed.entries.map((entry) => importedEntry({ ...entry, tags: tagsByEntry.get(String(entry.id)) ?? [] }, workspace));
  const sourceIds = new Set(entries.map((entry) => entry.id));
  if (sourceIds.size !== entries.length) throw new KiokukoError('VALIDATION_ERROR', 'Import contains duplicate entry IDs');
  validateRelatedLines(parsed, sourceIds);

  if (database === undefined && !options.dryRun) throw new KiokukoError('DATABASE_ERROR', 'Database is required for a non-dry import');

  const idMap = new Map<string, string>();
  const newEntries: ImportEntry[] = [];
  let duplicates = 0;
  for (const entry of entries) {
    if (!database) {
      idMap.set(entry.id, entry.id);
      newEntries.push(entry);
      continue;
    }
    const byId = existingEntry(database, entry.id);
    if (byId) {
      if (byId.content_hash !== entry.contentHash) throw new KiokukoError('CONFLICT', `Entry ID ${entry.id} already contains different content`);
      idMap.set(entry.id, entry.id);
      duplicates += 1;
      continue;
    }
    const byHash = database.prepare('SELECT id FROM entries WHERE workspace = ? AND content_hash = ?').get<{ id: string }>(workspace, entry.contentHash);
    if (byHash) {
      idMap.set(entry.id, byHash.id);
      duplicates += 1;
      continue;
    }
    idMap.set(entry.id, entry.id);
    newEntries.push(entry);
  }

  if (options.dryRun) {
    return { count: entries.length, imported: newEntries.length, duplicates, dryRun: true, workspace };
  }

  const db = database!;
  withImmediateTransaction(db, () => {
    const insertEntry = db.prepare(`
      INSERT INTO entries (
        id, workspace, kind, status, title, body, summary, scope_json, provenance_json,
        trust_level, confidence, content_hash, revision, superseded_by, created_by,
        created_at, updated_at, verified_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    for (const entry of newEntries) {
      insertEntry.run(
        entry.id,
        workspace,
        entry.kind,
        entry.status,
        entry.title,
        entry.body,
        entry.summary,
        entry.scopeJson,
        entry.provenanceJson,
        entry.trustLevel,
        entry.confidence,
        entry.contentHash,
        entry.revision,
        entry.supersededBy === null ? null : idMap.get(entry.supersededBy) ?? entry.supersededBy,
        entry.createdBy,
        entry.createdAt,
        entry.updatedAt,
        entry.verifiedAt,
      );
    }

    const insertTag = db.prepare('INSERT OR IGNORE INTO tags (entry_id, tag) VALUES (?, ?)');
    for (const tag of parsed.tags) insertTag.run(idMap.get(String(tag.entry_id)) ?? String(tag.entry_id), String(tag.tag));

    const insertLink = db.prepare(`
      INSERT OR IGNORE INTO entry_links (from_entry_id, to_entry_id, relation, created_at, created_by)
      VALUES (?, ?, ?, ?, ?)
    `);
    for (const link of parsed.links) {
      insertLink.run(
        idMap.get(String(link.from_entry_id)) ?? String(link.from_entry_id),
        idMap.get(String(link.to_entry_id)) ?? String(link.to_entry_id),
        String(link.relation),
        String(link.created_at),
        String(link.created_by),
      );
    }

    const insertAudit = db.prepare(`
      INSERT OR IGNORE INTO audit_events (event_id, entry_id, workspace, operation, actor, details_json, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `);
    for (const event of parsed.audit) {
      insertAudit.run(
        String(event.event_id),
        event.entry_id === null || event.entry_id === undefined ? null : idMap.get(String(event.entry_id)) ?? String(event.entry_id),
        workspace,
        String(event.operation),
        String(event.actor),
        String(event.details_json),
        String(event.created_at),
      );
    }
  });

  return { count: entries.length, imported: newEntries.length, duplicates, dryRun: false, workspace };
}
