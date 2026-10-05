import type { SqliteDatabase } from '../db/adapter.js';
import { KiokukoError } from '../errors.js';

/** Read only the bounded protocol metadata for an operator-provided call ID. */
export function codexHookDiagnostics(db: SqliteDatabase, correlationId: string): object {
  if (!/^[0-9a-f]{16}$/u.test(correlationId)) throw new KiokukoError('VALIDATION_ERROR', 'Hook correlation ID must be 16 lowercase hex characters');
  const rows = db.prepare(`SELECT event_name, decision, observed_at,
    json_extract(response_shape, '$.reason') AS reason, response_shape
    FROM codex_hook_observations WHERE json_extract(response_shape, '$.call') = ?
    ORDER BY rowid DESC LIMIT 20`).all<{ event_name: string; decision: string; observed_at: string; reason: string | null; response_shape: string }>(correlationId);
  return {
    correlationId,
    retention: 'Last 1000 hook observations; at most 20 matching events. Absence is not proof an event never occurred.',
    events: rows.reverse().map(row => {
      const metadata = JSON.parse(row.response_shape) as Record<string, unknown>;
      return { event: row.event_name, decision: row.decision, reason: row.reason, observedAt: row.observed_at,
        recoverable: metadata.recoverable ?? null, nextAction: metadata.nextAction ?? null,
        contract: {id: metadata.contractId ?? null, version: metadata.contractVersion ?? null},
        observedHookPackageVersion: metadata.hookPackageVersion ?? null, exitMetadata: metadata.exitMetadata ?? 'unavailable' };
    }),
  };
}
