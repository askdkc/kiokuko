import type { SqliteDatabase, SqliteRow } from '../db/adapter.js';
import { KiokukoError } from '../errors.js';
import { isSqliteUniqueConstraintError } from '../db/sqlite-retry.js';
import { validateTimestamp } from '../ledger/validate.js';
import { canonicalContentHash, compareCanonicalStrings } from '../serialization/validate.js';
import {
  NUDGE_CODES,
  NUDGE_MESSAGES,
  NUDGE_POLICY_VERSION,
  NUDGE_PRIORITY,
  assertNudgeCode,
  assertNudgePolicyVersion,
  type DeliveredNudge,
  type NudgeCode,
} from './nudges.js';

export interface NudgeHistory {
  deliveredOccurrenceIds: ReadonlySet<string>;
  runDeliveryCount: number;
  lastSequenceByCode: ReadonlyMap<NudgeCode, number>;
}

interface NudgeDeliveryRow extends SqliteRow {
  id: unknown;
  policy_version: unknown;
  code: unknown;
  occurrence_id: unknown;
  checkpoint_id: unknown;
  through_sequence: unknown;
  priority: unknown;
  evidence_event_ids_json: unknown;
  reference_ids_json: unknown;
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

function idList(value: unknown, label: string): string[] {
  if (typeof value !== 'string') throw new KiokukoError('INTEGRITY_ERROR', `Stored nudge ${label} is invalid`);
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw new KiokukoError('INTEGRITY_ERROR', `Stored nudge ${label} is invalid`);
  }
  if (!Array.isArray(parsed) || parsed.length > 16 || parsed.some((item) => typeof item !== 'string')) {
    throw new KiokukoError('INTEGRITY_ERROR', `Stored nudge ${label} is invalid`);
  }
  const result = parsed.map((item) => boundedIdentifier(item, label));
  if (new Set(result).size !== result.length) throw new KiokukoError('INTEGRITY_ERROR', `Stored nudge ${label} is invalid`);
  return result;
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

function deliveredValue(row: NudgeDeliveryRow): DeliveredNudge {
  if (typeof row.policy_version !== 'string') throw new KiokukoError('INTEGRITY_ERROR', 'Stored nudge policy version is invalid');
  assertNudgePolicyVersion(row.policy_version);
  const value = rowValues(row);
  const priority = sequence(row.priority, 'priority');
  if (priority !== NUDGE_PRIORITY[value.code]) throw new KiokukoError('INTEGRITY_ERROR', 'Stored nudge priority is invalid');
  return {
    occurrenceId: value.occurrenceId,
    code: value.code,
    message: NUDGE_MESSAGES[value.code],
    evidenceEventIds: idList(row.evidence_event_ids_json, 'evidenceEventIds'),
    referenceIds: idList(row.reference_ids_json, 'referenceIds'),
    priority,
    policyVersion: NUDGE_POLICY_VERSION,
  };
}

export function readNudgeDeliveryForCheckpoint(
  database: SqliteDatabase,
  input: { runId: string; policyVersion: string; checkpointId: string },
): DeliveredNudge | null {
  const runId = boundedIdentifier(input.runId, 'runId');
  const policyVersion = boundedIdentifier(input.policyVersion, 'policyVersion');
  assertNudgePolicyVersion(policyVersion);
  const checkpointId = boundedIdentifier(input.checkpointId, 'checkpointId');
  const row = database.prepare(`
    SELECT id, policy_version, code, occurrence_id, checkpoint_id, through_sequence, priority,
           evidence_event_ids_json, reference_ids_json
      FROM nudge_deliveries
     WHERE run_id = ? AND policy_version = ? AND checkpoint_id = ?
  `).get<NudgeDeliveryRow>(runId, policyVersion, checkpointId);
  if (row === undefined) return null;
  if (row.checkpoint_id !== checkpointId) throw new KiokukoError('INTEGRITY_ERROR', 'Stored nudge checkpoint identity is invalid');
  return deliveredValue(row);
}

export function readNudgeHistory(
  database: SqliteDatabase,
  runId: string,
  policyVersion: string,
): NudgeHistory {
  const safeRunId = boundedIdentifier(runId, 'runId');
  const safePolicyVersion = boundedIdentifier(policyVersion, 'policyVersion');
  assertNudgePolicyVersion(safePolicyVersion);
  const rows = database.prepare(`
    SELECT id, policy_version, code, occurrence_id, through_sequence
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
    checkpointId?: string;
    throughSequence: number;
    priority: number;
    evidenceEventIds?: readonly string[];
    referenceIds?: readonly string[];
    deliveredAt: string;
  },
): void {
  const runId = boundedIdentifier(input.runId, 'runId');
  const policyVersion = boundedIdentifier(input.policyVersion, 'policyVersion');
  assertNudgePolicyVersion(policyVersion);
  const occurrenceId = boundedIdentifier(input.occurrenceId, 'occurrenceId');
  const checkpointId = boundedIdentifier(input.checkpointId ?? occurrenceId, 'checkpointId');
  assertNudgeCode(input.code);
  if (!Number.isSafeInteger(input.throughSequence) || input.throughSequence < 0) {
    throw new KiokukoError('VALIDATION_ERROR', 'throughSequence must be a non-negative safe integer');
  }
  if (!Number.isSafeInteger(input.priority) || input.priority < 1) {
    throw new KiokukoError('VALIDATION_ERROR', 'priority must be a positive safe integer');
  }
  if (input.priority !== NUDGE_PRIORITY[input.code]) {
    throw new KiokukoError('VALIDATION_ERROR', 'priority does not match nudge code');
  }
  const deliveredAt = validateTimestamp(input.deliveredAt, 'deliveredAt');
  const evidenceEventIds = [...new Set(input.evidenceEventIds ?? [])]
    .map((value) => boundedIdentifier(value, 'evidenceEventId'))
    .sort(compareCanonicalStrings);
  const referenceIds = [...new Set(input.referenceIds ?? [])]
    .map((value) => boundedIdentifier(value, 'referenceId'))
    .sort(compareCanonicalStrings);
  if (evidenceEventIds.length > 16 || referenceIds.length > 16) {
    throw new KiokukoError('VALIDATION_ERROR', 'Nudge evidence is too large');
  }
  const id = canonicalContentHash({ policyVersion, runId, occurrenceId });
  try {
    database.prepare(`
      INSERT INTO nudge_deliveries (
        id, run_id, policy_version, code, occurrence_id,
        checkpoint_id, through_sequence, priority,
        evidence_event_ids_json, reference_ids_json, delivered_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      id,
      runId,
      policyVersion,
      input.code,
      occurrenceId,
      checkpointId,
      input.throughSequence,
      input.priority,
      JSON.stringify(evidenceEventIds),
      JSON.stringify(referenceIds),
      deliveredAt,
    );
  } catch (error) {
    if (isSqliteUniqueConstraintError(error, [
      'nudge_deliveries.id',
      'nudge_deliveries.run_id, nudge_deliveries.policy_version, nudge_deliveries.occurrence_id',
      'nudge_deliveries.run_id, nudge_deliveries.policy_version, nudge_deliveries.checkpoint_id',
    ])) {
      throw new KiokukoError('CONFLICT', 'Nudge delivery already exists');
    }
    throw error;
  }
}

export { NUDGE_CODES, NUDGE_POLICY_VERSION };
