import type { SqliteDatabase, SqliteRow } from '../db/adapter.js';
import { KiokukoError } from '../errors.js';
import { isSqliteUniqueConstraintError } from '../db/sqlite-retry.js';
import { validateTimestamp } from '../ledger/validate.js';
import { canonicalContentHash } from '../serialization/validate.js';
import { NUDGE_CODES, NUDGE_POLICY_VERSION, assertNudgeCode, type NudgeCode } from './nudges.js';

export interface NudgeHistory {
  deliveredOccurrenceIds: ReadonlySet<string>;
  runDeliveryCount: number;
  lastSequenceByCode: ReadonlyMap<NudgeCode, number>;
}

interface NudgeDeliveryRow extends SqliteRow {
  id: unknown;
  code: unknown;
  occurrence_id: unknown;
  through_sequence: unknown;
}

function boundedIdentifier(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.length === 0 || value.length > 256 || value.includes('\u0000')) {
    throw new KiokukoError('VALIDATION_ERROR', `${label} must be a non-empty bounded string`);
  }
  return value;
}

function sequence(value: unknown, label: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
    throw new KiokukoError('INTEGRITY_ERROR', `Stored nudge ${label} is invalid`);
  }
  return value;
}

function rowValues(row: NudgeDeliveryRow): { code: NudgeCode; occurrenceId: string; throughSequence: number } {
  const code = row.code;
  if (typeof code !== 'string') throw new KiokukoError('INTEGRITY_ERROR', 'Stored nudge code is invalid');
  assertNudgeCode(code);
  return {
    code,
    occurrenceId: boundedIdentifier(row.occurrence_id, 'occurrenceId'),
    throughSequence: sequence(row.through_sequence, 'sequence'),
  };
}

export function readNudgeHistory(
  database: SqliteDatabase,
  runId: string,
  policyVersion: string,
): NudgeHistory {
  const safeRunId = boundedIdentifier(runId, 'runId');
  const safePolicyVersion = boundedIdentifier(policyVersion, 'policyVersion');
  const rows = database.prepare(`
    SELECT id, code, occurrence_id, through_sequence
      FROM nudge_deliveries
     WHERE run_id = ? AND policy_version = ?
     ORDER BY through_sequence ASC, code ASC, occurrence_id ASC, id ASC
  `).all<NudgeDeliveryRow>(safeRunId, safePolicyVersion);
  const deliveredOccurrenceIds = new Set<string>();
  const lastSequenceByCode = new Map<NudgeCode, number>();
  for (const row of rows) {
    const value = rowValues(row);
    deliveredOccurrenceIds.add(value.occurrenceId);
    const previous = lastSequenceByCode.get(value.code);
    if (previous === undefined || value.throughSequence > previous) lastSequenceByCode.set(value.code, value.throughSequence);
  }
  return {
    deliveredOccurrenceIds,
    runDeliveryCount: rows.length,
    lastSequenceByCode,
  };
}

export function recordNudgeDeliveryInTransaction(
  database: SqliteDatabase,
  input: {
    runId: string;
    policyVersion: string;
    code: NudgeCode;
    occurrenceId: string;
    throughSequence: number;
    priority: number;
    deliveredAt: string;
  },
): void {
  const runId = boundedIdentifier(input.runId, 'runId');
  const policyVersion = boundedIdentifier(input.policyVersion, 'policyVersion');
  const occurrenceId = boundedIdentifier(input.occurrenceId, 'occurrenceId');
  assertNudgeCode(input.code);
  if (!Number.isSafeInteger(input.throughSequence) || input.throughSequence < 0) {
    throw new KiokukoError('VALIDATION_ERROR', 'throughSequence must be a non-negative safe integer');
  }
  if (!Number.isSafeInteger(input.priority) || input.priority < 1) {
    throw new KiokukoError('VALIDATION_ERROR', 'priority must be a positive safe integer');
  }
  const deliveredAt = validateTimestamp(input.deliveredAt, 'deliveredAt');
  const id = canonicalContentHash({ policyVersion, runId, occurrenceId });
  try {
    database.prepare(`
      INSERT INTO nudge_deliveries (
        id, run_id, policy_version, code, occurrence_id,
        through_sequence, priority, delivered_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      id,
      runId,
      policyVersion,
      input.code,
      occurrenceId,
      input.throughSequence,
      input.priority,
      deliveredAt,
    );
  } catch (error) {
    if (isSqliteUniqueConstraintError(error, [
      'nudge_deliveries.id',
      'nudge_deliveries.run_id, nudge_deliveries.policy_version, nudge_deliveries.occurrence_id',
    ])) {
      throw new KiokukoError('CONFLICT', 'Nudge delivery already exists');
    }
    throw error;
  }
}

export { NUDGE_CODES, NUDGE_POLICY_VERSION };
