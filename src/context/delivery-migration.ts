import type { SqliteDatabase, SqliteRow } from '../db/adapter.js';
import { KiokukoError } from '../errors.js';
import { readEntryRevision } from '../memory/revisions.js';
import {
  readContextDelivery,
  type ContextDeliveryItemInput,
  type ContextDeliveryView,
} from './delivery.js';
import type { ScopedContextItem } from './scoped-broker.js';

const LEGACY_SCOPED_POLICY_VERSIONS = ['context-ranking-v2', 'context-ranking-v3'] as const;
const MAX_DELIVERIES = 100_000;

interface LegacyDeliveryRow extends SqliteRow {
  delivery_id: unknown;
  run_workspace: unknown;
}

function migrationIntegrity(): never {
  throw new KiokukoError('INTEGRITY_ERROR', 'Stored context delivery cannot be migrated safely');
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

/** Reproduce the released v2/v3 scoped materializer without changing its persisted identity. */
export function storedLegacyScopedItems(
  database: SqliteDatabase,
  delivery: ContextDeliveryView,
): ScopedContextItem[] {
  if (!LEGACY_SCOPED_POLICY_VERSIONS.includes(delivery.policyVersion as (typeof LEGACY_SCOPED_POLICY_VERSIONS)[number])) {
    migrationIntegrity();
  }
  const items: ScopedContextItem[] = [];
  let remaining = delivery.charBudget;
  let charCount = 0;
  for (const item of delivery.items) {
    if (remaining <= 0) migrationIntegrity();
    const revision = readDeliveredRevision(database, delivery, item);
    const bodySource = revision.summary ?? revision.body;
    const bodyPreview = Array.from(bodySource).slice(0, remaining).join('');
    const cost = Array.from(revision.title).length
      + Array.from(revision.summary ?? '').length
      + bodyPreview.length;
    const scoreComponents = item.scoreComponents as ScopedContextItem['scoreComponents'];
    items.push({
      entryId: item.entryId,
      revision: item.entryRevision,
      origin: item.origin ?? 'project',
      title: revision.title,
      summary: revision.summary,
      bodyPreview,
      score: Object.values(scoreComponents).reduce((total, component) => total + component, 0),
      scoreComponents: { ...scoreComponents },
      selectionReasons: [...item.selectionReasons],
      metadata: { storedData: true, untrusted: true, instructions: false },
    });
    charCount += bodyPreview.length;
    remaining -= cost;
  }
  if (charCount !== delivery.charCount) migrationIntegrity();
  return items;
}

function migrateOneDelivery(database: SqliteDatabase, row: LegacyDeliveryRow): void {
  const legacy = readLegacyDelivery(database, row);
  storedLegacyScopedItems(database, legacy);
}

/** Validate released scoped delivery formats inside the caller-owned migration transaction. */
export function migrateLegacyContextDeliveries(database: SqliteDatabase): void {
  const rows = deliveryRows(database);
  for (const row of rows) migrateOneDelivery(database, row);
}
