import type { SqliteDatabase } from '../db/adapter.js';
import { KiokukoError } from '../errors.js';
import type { EntryRecord } from './entries.js';

export type TemporalBasis = 'recorded' | 'occurred';
export type TemporalMode = 'boost' | 'restrict';

export interface TemporalConstraint {
  basis: TemporalBasis;
  mode: TemporalMode;
  start?: string;
  end?: string;
  anchorTime: string;
  timezone: string;
}

const HASH = /^[a-f0-9]{64}$/u;
const INSTANT = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,3}))?(Z|[+-]\d{2}:\d{2})$/u;

function invalid(): never {
  throw new KiokukoError('VALIDATION_ERROR', 'Temporal search condition is invalid');
}

function canonicalInstant(value: unknown): string {
  if (typeof value !== 'string') return invalid();
  const match = INSTANT.exec(value);
  if (!match) return invalid();
  const [, yearText, monthText, dayText, hourText, minuteText, secondText] = match;
  const zone = match[8];
  if (zone === undefined) return invalid();
  const year = Number(yearText), month = Number(monthText), day = Number(dayText);
  const hour = Number(hourText), minute = Number(minuteText), second = Number(secondText);
  const daysInMonth = month === 2
    ? ((year % 4 === 0 && year % 100 !== 0) || year % 400 === 0 ? 29 : 28)
    : [4, 6, 9, 11].includes(month) ? 30 : 31;
  if (year < 1 || year > 9999 || month < 1 || month > 12 || day < 1 || day > daysInMonth
    || hour > 23 || minute > 59 || second > 59) return invalid();
  if (zone !== 'Z') {
    const offsetHours = Number(zone.slice(1, 3));
    const offsetMinutes = Number(zone.slice(4, 6));
    if (offsetHours > 14 || offsetMinutes > 59 || (offsetHours === 14 && offsetMinutes !== 0)) return invalid();
  }
  const epoch = Date.parse(value);
  if (!Number.isFinite(epoch)) return invalid();
  return new Date(epoch).toISOString();
}

/** Validate once at the boundary and bind absolute instants for replay. */
export function normalizeTemporalConstraint(value: unknown): TemporalConstraint | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return invalid();
  const raw = value as Record<string, unknown>;
  const allowed = new Set(['basis', 'mode', 'start', 'end', 'anchorTime', 'timezone']);
  if (Object.keys(raw).some((key) => !allowed.has(key))
    || (raw.basis !== 'recorded' && raw.basis !== 'occurred')
    || (raw.mode !== 'boost' && raw.mode !== 'restrict')
    || typeof raw.timezone !== 'string' || raw.timezone.length < 1 || raw.timezone.length > 128) return invalid();
  let timezone: string;
  try {
    timezone = new Intl.DateTimeFormat('en-US', { timeZone: raw.timezone }).resolvedOptions().timeZone;
  } catch {
    return invalid();
  }
  const anchorTime = canonicalInstant(raw.anchorTime);
  const start = raw.start === undefined ? undefined : canonicalInstant(raw.start);
  const end = raw.end === undefined ? undefined : canonicalInstant(raw.end);
  if (start === undefined && end === undefined) return invalid();
  if (start !== undefined && end !== undefined && Date.parse(start) >= Date.parse(end)) return invalid();
  return {
    basis: raw.basis,
    mode: raw.mode,
    ...(start === undefined ? {} : { start }),
    ...(end === undefined ? {} : { end }),
    anchorTime,
    timezone,
  };
}

function occurredEvidenceTime(database: SqliteDatabase, entry: EntryRecord): string | undefined {
  const temporal = entry.provenance.temporal;
  if (typeof temporal !== 'object' || temporal === null || Array.isArray(temporal)) return undefined;
  const occurred = (temporal as Record<string, unknown>).occurredAt;
  if (typeof occurred !== 'object' || occurred === null || Array.isArray(occurred)) return undefined;
  const evidence = occurred as Record<string, unknown>;
  const source = evidence.source;
  if (typeof source !== 'object' || source === null || Array.isArray(source)) return undefined;
  const reference = source as Record<string, unknown>;
  if (typeof reference.entryId !== 'string' || reference.entryId.length === 0
    || reference.entryId === entry.id || reference.workspace !== entry.workspace
    || !Number.isSafeInteger(reference.revision) || Number(reference.revision) < 1
    || typeof reference.contentHash !== 'string' || !HASH.test(reference.contentHash)) return undefined;
  const row = database.prepare(`
    SELECT e.status, e.current_revision, r.content_hash
      FROM entries AS e
      JOIN entry_revisions AS r ON r.entry_id = e.id AND r.revision = ?
     WHERE e.id = ? AND e.workspace = ?
  `).get<{ status: unknown; current_revision: unknown; content_hash: unknown }>(
    Number(reference.revision), reference.entryId, reference.workspace,
  );
  if (row === undefined || row.status === 'superseded'
    || row.current_revision !== reference.revision
    || row.content_hash !== reference.contentHash) return undefined;
  try {
    return canonicalInstant(evidence.instant);
  } catch {
    return undefined;
  }
}

/** Recorded time is the selected revision's immutable created_at, never entries.updated_at. */
export function temporalTimestamp(
  database: SqliteDatabase,
  entry: EntryRecord,
  basis: TemporalBasis,
): string | undefined {
  if (basis === 'occurred') return occurredEvidenceTime(database, entry);
  const row = database.prepare(`
    SELECT created_at
      FROM entry_revisions
     WHERE entry_id = ? AND revision = ? AND workspace = ?
  `).get<{ created_at: unknown }>(entry.id, entry.revision, entry.workspace);
  if (typeof row?.created_at !== 'string') {
    throw new KiokukoError('INTEGRITY_ERROR', 'Entry revision timestamp is unavailable');
  }
  return canonicalInstant(row.created_at);
}

export function matchesTemporalConstraint(
  database: SqliteDatabase,
  entry: EntryRecord,
  condition: TemporalConstraint,
): boolean {
  const instant = temporalTimestamp(database, entry, condition.basis);
  if (instant === undefined) return false;
  const value = Date.parse(instant);
  return (condition.start === undefined || value >= Date.parse(condition.start))
    && (condition.end === undefined || value < Date.parse(condition.end));
}
