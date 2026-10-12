import type { SqliteDatabase } from '../db/adapter.js';
import { KiokukoError } from '../errors.js';

/** Read only the bounded protocol metadata for an operator-provided call ID. */
export function codexHookDiagnostics(db: SqliteDatabase, correlationId: string): object {
  const request = /^codex-[0-9a-f]{64}$/u.test(correlationId);
  if (!request && !/^[0-9a-f]{16}$/u.test(correlationId)) throw new KiokukoError('VALIDATION_ERROR', 'Hook correlation ID must be 16 lowercase hex characters or a Codex request ID');
  const rows = db.prepare(`SELECT event_name, tool_name, decision, observed_at,
    json_extract(response_shape, '$.reason') AS reason, response_shape
    FROM codex_hook_observations WHERE json_extract(response_shape, '${request ? '$.request' : '$.call'}') = ?
    ORDER BY rowid DESC LIMIT 20`).all<{ event_name: string; tool_name: string | null; decision: string; observed_at: string; reason: string | null; response_shape: string }>(correlationId);
  return {
    correlationId,
    retention: 'Last 1000 hook observations; at most 20 matching events. Absence is not proof an event never occurred.',
    events: rows.reverse().map(row => {
      const metadata = JSON.parse(row.response_shape) as Record<string, unknown>;
      return { event: row.event_name, tool: row.tool_name, correlationId: metadata.call ?? null, decision: row.decision, reason: row.reason, observedAt: row.observed_at,
        execution: metadata.execution ?? { occurred: row.event_name === 'PostToolUse', completionRecorded: null, exitCode: null },
        recoverable: metadata.recoverable ?? null, nextAction: metadata.nextAction ?? null,
        contract: {id: metadata.contractId ?? null, version: metadata.contractVersion ?? null},
        observedHookPackageVersion: metadata.hookPackageVersion ?? null, exitMetadata: metadata.exitMetadata ?? 'unavailable', exitSource:metadata.exitSource ?? 'unavailable',
        shape: {type:metadata.type ?? 'unknown', structured:metadata.structured ?? false, content:metadata.content ?? false,
          exitCode:metadata.exitCode ?? 'undefined', hostFields:metadata.hostFields ?? {}} };
    }),
  };
}
