import { createHash } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import type { SqliteDatabase } from '../db/adapter.js';
import { canonicalJson, requireWorkspace } from '../serialization/validate.js';

export interface ExportOptions {
  workspace: string;
  output?: string;
}

export interface ExportResult {
  workspace: string;
  count: number;
  checksum: string;
  output?: string;
  content: string;
}

interface ExportLine {
  type: string;
  [key: string]: unknown;
}

function rows(database: SqliteDatabase, sql: string, ...parameters: (string | number)[]): Record<string, unknown>[] {
  return database.prepare(sql).all<Record<string, unknown>>(...parameters);
}

function canonicalStoredJson(value: unknown, label: string): string {
  try {
    return canonicalJson(JSON.parse(String(value)));
  } catch {
    throw new Error(`Stored ${label} is not valid JSON`);
  }
}

/**
 * Export a complete workspace snapshot as deterministic, checksummed JSONL.
 * The first line is the checksum of every following line, including its final newline.
 */
export function exportWorkspace(database: SqliteDatabase, options: ExportOptions): ExportResult {
  const workspace = requireWorkspace(options.workspace);
  const entries: Record<string, unknown>[] = rows(
    database,
    `SELECT e.id, e.workspace, r.kind, e.status, r.title, r.body, r.summary,
            r.scope_json, r.provenance_json, e.trust_level, e.confidence,
            r.content_hash, e.current_revision AS revision, e.superseded_by,
            e.created_by, e.created_at, e.updated_at, e.verified_at
       FROM entries AS e
       JOIN entry_revisions AS r ON r.entry_id = e.id AND r.revision = e.current_revision
      WHERE e.workspace = ? ORDER BY e.id ASC`,
    workspace,
  ).map((entry) => ({
    ...entry,
    scope_json: canonicalStoredJson(entry.scope_json, 'scope'),
    provenance_json: canonicalStoredJson(entry.provenance_json, 'provenance'),
  }));
  const entryIds = new Set(entries.map((entry) => String(entry.id)));
  const tags = rows(
    database,
    `SELECT t.entry_id, t.tag
       FROM entry_revision_tags AS t
       JOIN entries AS e ON e.id = t.entry_id AND e.current_revision = t.revision
      WHERE e.workspace = ?
     ORDER BY entry_id ASC, tag ASC`,
    workspace,
  );
  const links = rows(
    database,
    `SELECT l.from_entry_id, l.to_entry_id, l.relation, l.created_at, l.created_by
     FROM entry_links l
     JOIN entries from_entry ON from_entry.id = l.from_entry_id
     JOIN entries to_entry ON to_entry.id = l.to_entry_id
     WHERE from_entry.workspace = ? AND to_entry.workspace = ?
     ORDER BY l.from_entry_id ASC, l.to_entry_id ASC, l.relation ASC`,
    workspace,
    workspace,
  );
  const audit: Record<string, unknown>[] = rows(
    database,
    `SELECT event_id, entry_id, workspace, operation, actor, details_json, created_at
     FROM audit_events WHERE workspace = ? ORDER BY event_id ASC`,
    workspace,
  ).filter((event) => event.entry_id === null || entryIds.has(String(event.entry_id))).map((event) => ({
    ...event,
    details_json: canonicalStoredJson(event.details_json, 'audit details'),
  }));

  const manifest: ExportLine = {
    type: 'manifest',
    apiVersion: '1',
    workspace,
    format: 'kiokuko-jsonl',
    version: 2,
    counts: { entries: entries.length, tags: tags.length, links: links.length, audit: audit.length },
  };
  const payloadLines: ExportLine[] = [
    manifest,
    ...entries.map((entry) => ({ type: 'entry', ...entry })),
    ...tags.map((tag) => ({ type: 'tag', ...tag })),
    ...links.map((link) => ({ type: 'link', ...link })),
    ...audit.map((event) => ({ type: 'audit', ...event })),
  ];
  const payload = `${payloadLines.map((value) => canonicalJson(value)).join('\n')}\n`;
  const checksum = createHash('sha256').update(payload, 'utf8').digest('hex');
  const content = `${canonicalJson({ type: 'checksum', sha256: checksum })}\n${payload}`;
  return { workspace, count: entries.length, checksum, ...(options.output === undefined ? {} : { output: options.output }), content };
}

export async function writeExport(database: SqliteDatabase, options: ExportOptions & { output: string }): Promise<ExportResult> {
  const result = exportWorkspace(database, options);
  await writeFile(options.output, result.content, 'utf8');
  return result;
}
