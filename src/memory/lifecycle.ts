import type { SqliteDatabase } from '../db/adapter.js';
import { withImmediateTransaction } from '../db/transaction.js';
import { KiokukoError } from '../errors.js';
import { readEntry, type EntryRecord } from './entries.js';
import { recordAuditEvent } from './audit.js';

export interface PromoteInput {
  workspace: string;
  entryId: string;
  expectedRevision: number;
  actor?: string;
  now?: string;
}

export interface SupersedeInput {
  workspace: string;
  oldEntryId: string;
  replacementEntryId: string;
  expectedRevision: number;
  actor?: string;
  now?: string;
}

export interface LinkInput {
  workspace: string;
  fromEntryId: string;
  toEntryId: string;
  relation: 'supports' | 'contradicts' | 'derived_from' | 'related_to';
  actor?: string;
  now?: string;
}

function ensureRevision(expectedRevision: number): void {
  if (!Number.isInteger(expectedRevision) || expectedRevision < 1) {
    throw new KiokukoError('VALIDATION_ERROR', 'expectedRevision must be a positive integer');
  }
}

export function promoteEntry(database: SqliteDatabase, input: PromoteInput): EntryRecord {
  ensureRevision(input.expectedRevision);
  const now = input.now ?? new Date().toISOString();
  const actor = input.actor ?? 'kiokuko-cli';
  withImmediateTransaction(database, () => {
    const current = database.prepare('SELECT status, current_revision FROM entries WHERE id = ? AND workspace = ?').get<{ status: string; current_revision: number }>(input.entryId, input.workspace);
    if (!current) throw new KiokukoError('NOT_FOUND', 'Entry not found');
    if (Number(current.current_revision) !== input.expectedRevision) throw new KiokukoError('CONFLICT', 'Entry revision is stale');
    if (current.status !== 'candidate') throw new KiokukoError('CONFLICT', 'Only candidate entries can be promoted');
    database.prepare("UPDATE entries SET status = 'verified', verified_at = ?, updated_at = ? WHERE id = ? AND workspace = ? AND current_revision = ?")
      .run(now, now, input.entryId, input.workspace, input.expectedRevision);
    recordAuditEvent(database, { entryId: input.entryId, workspace: input.workspace, operation: 'promote', actor, details: { expectedRevision: input.expectedRevision }, createdAt: now });
  });
  return readEntry(database, { workspace: input.workspace, entryId: input.entryId });
}

export function supersedeEntry(database: SqliteDatabase, input: SupersedeInput): EntryRecord {
  ensureRevision(input.expectedRevision);
  if (input.oldEntryId === input.replacementEntryId) throw new KiokukoError('VALIDATION_ERROR', 'An entry cannot supersede itself');
  const now = input.now ?? new Date().toISOString();
  const actor = input.actor ?? 'kiokuko-cli';
  withImmediateTransaction(database, () => {
    const oldEntry = database.prepare('SELECT status, current_revision FROM entries WHERE id = ? AND workspace = ?').get<{ status: string; current_revision: number }>(input.oldEntryId, input.workspace);
    const replacement = database.prepare('SELECT id, status FROM entries WHERE id = ? AND workspace = ?').get<{ id: string; status: string }>(input.replacementEntryId, input.workspace);
    if (!oldEntry || !replacement) throw new KiokukoError('NOT_FOUND', 'Entry not found');
    if (Number(oldEntry.current_revision) !== input.expectedRevision) throw new KiokukoError('CONFLICT', 'Entry revision is stale');
    if (oldEntry.status === 'superseded') throw new KiokukoError('CONFLICT', 'Entry is already superseded');
    database.prepare("UPDATE entries SET status = 'superseded', superseded_by = ?, updated_at = ? WHERE id = ? AND workspace = ? AND current_revision = ?")
      .run(input.replacementEntryId, now, input.oldEntryId, input.workspace, input.expectedRevision);
    recordAuditEvent(database, { entryId: input.oldEntryId, workspace: input.workspace, operation: 'supersede', actor, details: { replacementEntryId: input.replacementEntryId, expectedRevision: input.expectedRevision }, createdAt: now });
  });
  return readEntry(database, { workspace: input.workspace, entryId: input.oldEntryId });
}

export function linkEntries(database: SqliteDatabase, input: LinkInput): void {
  const now = input.now ?? new Date().toISOString();
  const actor = input.actor ?? 'kiokuko-cli';
  withImmediateTransaction(database, () => {
    const count = database.prepare('SELECT COUNT(*) AS count FROM entries WHERE workspace = ? AND id IN (?, ?)').get<{ count: number }>(input.workspace, input.fromEntryId, input.toEntryId)?.count ?? 0;
    if (count !== 2) throw new KiokukoError('NOT_FOUND', 'Entry not found');
    database.prepare('INSERT INTO entry_links (from_entry_id, to_entry_id, relation, created_at, created_by) VALUES (?, ?, ?, ?, ?)')
      .run(input.fromEntryId, input.toEntryId, input.relation, now, actor);
    recordAuditEvent(database, { entryId: input.fromEntryId, workspace: input.workspace, operation: 'link', actor, details: { toEntryId: input.toEntryId, relation: input.relation }, createdAt: now });
  });
}
