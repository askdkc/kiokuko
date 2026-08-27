import type { SqliteDatabase, SqliteRow } from '../db/adapter.js';
import { KiokukoError } from '../errors.js';
import { canonicalJson } from '../serialization/validate.js';
import { readEntryRevision } from '../memory/revisions.js';
import {
  readContextDelivery,
  scopedDeliveryId,
  type ContextDeliveryInput,
  type ContextDeliveryItemInput,
  type ContextDeliveryView,
} from './delivery.js';

const CURRENT_SCOPED_POLICY_VERSION = 'context-ranking-v4';
const LEGACY_SCOPED_POLICY_VERSIONS = ['context-ranking-v2', 'context-ranking-v3'] as const;
const MAX_DELIVERIES = 100_000;
const MAX_CHARACTER_BUDGET = 100_000;

interface LegacyDeliveryRow extends SqliteRow {
  delivery_id: unknown;
  run_workspace: unknown;
}

interface MaterializedDeliveryItem {
  item: ContextDeliveryItemInput;
  title: string;
  summary: string | null;
  body: string;
}

interface MigratedDelivery extends ContextDeliveryInput {}

function migrationIntegrity(): never {
  throw new KiokukoError('INTEGRITY_ERROR', 'Stored context delivery cannot be migrated safely');
}

function characterCount(value: string): number {
  return Array.from(value).length;
}

function deliveryRows(database: SqliteDatabase): LegacyDeliveryRow[] {
  const placeholders = LEGACY_SCOPED_POLICY_VERSIONS.map(() => '?').join(', ');
  const rows = database.prepare(`
    SELECT cd.delivery_id, lr.workspace AS run_workspace
      FROM context_deliveries AS cd
      LEFT JOIN ledger_runs AS lr ON lr.run_id = cd.run_id
     WHERE cd.score_schema_version = 2
       AND cd.policy_version IN (${placeholders})
     ORDER BY cd.delivery_id ASC
     LIMIT ?
  `).all<LegacyDeliveryRow>(...LEGACY_SCOPED_POLICY_VERSIONS, MAX_DELIVERIES + 1);
  if (rows.length > MAX_DELIVERIES) migrationIntegrity();
  return rows;
}

function readLegacyDelivery(database: SqliteDatabase, row: LegacyDeliveryRow): ContextDeliveryView {
  if (typeof row.delivery_id !== 'string' || row.delivery_id.length === 0
    || typeof row.run_workspace !== 'string' || row.run_workspace.length === 0) migrationIntegrity();
  try {
    return readContextDelivery(database, { workspace: row.run_workspace, deliveryId: row.delivery_id });
  } catch {
    migrationIntegrity();
  }
}

function readDeliveredRevision(
  database: SqliteDatabase,
  delivery: ContextDeliveryView,
  item: ContextDeliveryItemInput,
): { title: string; summary: string | null; body: string } {
  const entry = database.prepare('SELECT workspace FROM entries WHERE id = ?').get<{ workspace: unknown }>(item.entryId);
  if (typeof entry?.workspace !== 'string' || entry.workspace.length === 0) migrationIntegrity();
  try {
    const revision = readEntryRevision(database, {
      entryId: item.entryId,
      workspace: entry.workspace,
      revision: item.entryRevision,
    });
    if (revision.workspace !== entry.workspace || revision.revision !== item.entryRevision) migrationIntegrity();
    return { title: revision.title, summary: revision.summary, body: revision.body };
  } catch {
    migrationIntegrity();
  }
}

function materializeDeliveryItems(database: SqliteDatabase, delivery: ContextDeliveryView): MaterializedDeliveryItem[] {
  return delivery.items.map((item) => ({
    item: {
      ...item,
      scoreComponents: { ...item.scoreComponents },
      selectionReasons: [...item.selectionReasons],
      ...(item.origin === undefined ? {} : { origin: item.origin }),
    },
    ...readDeliveredRevision(database, delivery, item),
  }));
}

function migratedDelivery(
  delivery: ContextDeliveryView,
  items: readonly MaterializedDeliveryItem[],
): MigratedDelivery {
  const fullCharacterCount = items.reduce(
    (total, item) => total + characterCount(item.title) + characterCount(item.summary ?? '') + characterCount(item.body),
    0,
  );
  const charBudget = Math.max(delivery.charBudget, fullCharacterCount);
  if (charBudget > MAX_CHARACTER_BUDGET) migrationIntegrity();
  const input: ContextDeliveryInput = {
    workspace: delivery.workspace,
    deliveryId: '',
    runId: delivery.runId,
    throughSequence: delivery.throughSequence,
    intakeSessionId: delivery.intakeSessionId,
    taskProfileHash: delivery.taskProfileHash,
    queryHash: delivery.queryHash,
    policyVersion: CURRENT_SCOPED_POLICY_VERSION,
    charBudget,
    charCount: fullCharacterCount,
    truncated: delivery.truncated,
    createdAt: delivery.createdAt,
    scoreSchemaVersion: 2,
    items: items.map((item, index) => ({ ...item.item, rank: index + 1 })),
  };
  return { ...input, deliveryId: scopedDeliveryId(input) };
}

function insertMigratedDelivery(database: SqliteDatabase, delivery: MigratedDelivery): void {
  if (database.prepare('SELECT 1 AS present FROM context_deliveries WHERE delivery_id = ?').get(delivery.deliveryId)) {
    migrationIntegrity();
  }
  database.prepare(`
    INSERT INTO context_deliveries (
      delivery_id, run_id, through_sequence, intake_session_id, task_profile_hash, query_hash,
      policy_version, external_sync_summary_json, char_budget, char_count, truncated, created_at,
      score_schema_version
    ) VALUES (?, ?, ?, ?, ?, ?, ?, '{}', ?, ?, ?, ?, ?)
  `).run(
    delivery.deliveryId,
    delivery.runId,
    delivery.throughSequence,
    delivery.intakeSessionId,
    delivery.taskProfileHash,
    delivery.queryHash,
    delivery.policyVersion,
    delivery.charBudget,
    delivery.charCount,
    delivery.truncated ? 1 : 0,
    delivery.createdAt,
    delivery.scoreSchemaVersion ?? 2,
  );
  for (const item of delivery.items) {
    database.prepare(`
      INSERT INTO context_delivery_entries (
        delivery_id, entry_id, entry_revision, rank, score_components_json, selection_reason_json, origin_scope
      ) VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(
      delivery.deliveryId,
      item.entryId,
      item.entryRevision,
      item.rank,
      canonicalJson(item.scoreComponents),
      canonicalJson(item.selectionReasons),
      item.origin ?? 'project',
    );
  }
}

function moveDeliveryReferences(database: SqliteDatabase, oldDeliveryId: string, newDeliveryId: string): void {
  database.prepare('UPDATE context_feedback SET delivery_id = ? WHERE delivery_id = ?').run(newDeliveryId, oldDeliveryId);
  database.prepare('UPDATE ledger_memory_links SET delivery_id = ? WHERE delivery_id = ?').run(newDeliveryId, oldDeliveryId);
  database.prepare(`
    UPDATE ledger_purge_audit
       SET delivery_id = ?, target_id = CASE WHEN target_type = 'delivery' THEN ? ELSE target_id END
     WHERE delivery_id = ?
  `).run(newDeliveryId, newDeliveryId, oldDeliveryId);
}

function migrateOneDelivery(database: SqliteDatabase, row: LegacyDeliveryRow): void {
  const legacy = readLegacyDelivery(database, row);
  const materialized = materializeDeliveryItems(database, legacy);
  const migrated = migratedDelivery(legacy, materialized);
  insertMigratedDelivery(database, migrated);
  moveDeliveryReferences(database, legacy.deliveryId, migrated.deliveryId);
  database.prepare('DELETE FROM context_deliveries WHERE delivery_id = ?').run(legacy.deliveryId);
}

/** Convert released scoped delivery formats inside the caller-owned migration transaction. */
export function migrateLegacyContextDeliveries(database: SqliteDatabase): void {
  const rows = deliveryRows(database);
  for (const row of rows) migrateOneDelivery(database, row);
}
