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
import {
  parseInputIdentifier,
  parseStoredNudgeDelivery,
  type StoredNudgeDelivery,
  validateStoredNudgeHistory,
} from './nudge-validation.js';

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

function deliveredValue(row: NudgeDeliveryRow): DeliveredNudge {
  const value = parseStoredNudgeDelivery(row);
  return {
    occurrenceId: value.occurrenceId,
    code: value.code,
    message: NUDGE_MESSAGES[value.code],
    evidenceEventIds: [...value.evidenceEventIds],
    referenceIds: [...value.referenceIds],
    priority: value.priority,
    policyVersion: NUDGE_POLICY_VERSION,
  };
}

export function readNudgeDeliveryForCheckpoint(
  database: SqliteDatabase,
  input: { runId: string; policyVersion: string; checkpointId: string },
): DeliveredNudge | null {
  const runId = parseInputIdentifier(input.runId, 'runId');
  const policyVersion = parseInputIdentifier(input.policyVersion, 'policyVersion');
  assertNudgePolicyVersion(policyVersion);
  const checkpointId = parseInputIdentifier(input.checkpointId, 'checkpointId');
  const row = database.prepare(`
      SELECT id, policy_version, code, occurrence_id, checkpoint_id, through_sequence, priority,
           evidence_event_ids_json, reference_ids_json, delivered_at
      FROM nudge_deliveries
     WHERE run_id = ? AND checkpoint_id = ?
  `).get<NudgeDeliveryRow>(runId, checkpointId);
  if (row === undefined) return null;
  const stored = parseStoredNudgeDelivery(row);
  if (stored.policyVersion !== policyVersion) throw new KiokukoError('INTEGRITY_ERROR', 'Stored nudge policy identity is invalid');
  if (stored.checkpointId !== checkpointId) throw new KiokukoError('INTEGRITY_ERROR', 'Stored nudge checkpoint identity is invalid');
  return deliveredValue(row);
}

export function readNudgeHistory(
  database: SqliteDatabase,
  runId: string,
  policyVersion: string,
): NudgeHistory {
  const safeRunId = parseInputIdentifier(runId, 'runId');
  const safePolicyVersion = parseInputIdentifier(policyVersion, 'policyVersion');
  assertNudgePolicyVersion(safePolicyVersion);
  const rows = database.prepare(`
    SELECT id, policy_version, code, occurrence_id, checkpoint_id, through_sequence, priority,
           evidence_event_ids_json, reference_ids_json, delivered_at
      FROM nudge_deliveries
     WHERE run_id = ?
      ORDER BY through_sequence ASC, code ASC, occurrence_id ASC, id ASC
  `).all<NudgeDeliveryRow>(safeRunId);
  const deliveredOccurrenceIds = new Set<string>();
  const lastSequenceByCode = new Map<NudgeCode, number>();
  const historyRows: StoredNudgeDelivery[] = [];
  for (const row of rows) {
    const value = parseStoredNudgeDelivery(row);
    if (value.policyVersion !== safePolicyVersion) throw new KiokukoError('INTEGRITY_ERROR', 'Stored nudge policy identity is invalid');
    historyRows.push(value);
    deliveredOccurrenceIds.add(value.occurrenceId);
    const previous = lastSequenceByCode.get(value.code);
    if (previous === undefined || value.throughSequence > previous) lastSequenceByCode.set(value.code, value.throughSequence);
  }
  validateStoredNudgeHistory(historyRows, { maxPerResponse: 1, maxPerRun: 3, minSequenceDistancePerCode: 3 });
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
  const runId = parseInputIdentifier(input.runId, 'runId');
  const policyVersion = parseInputIdentifier(input.policyVersion, 'policyVersion');
  assertNudgePolicyVersion(policyVersion);
  const occurrenceId = parseInputIdentifier(input.occurrenceId, 'occurrenceId');
  const checkpointId = parseInputIdentifier(input.checkpointId ?? occurrenceId, 'checkpointId');
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
    .map((value) => parseInputIdentifier(value, 'evidenceEventId'))
    .sort(compareCanonicalStrings);
  const referenceIds = [...new Set(input.referenceIds ?? [])]
    .map((value) => parseInputIdentifier(value, 'referenceId'))
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
