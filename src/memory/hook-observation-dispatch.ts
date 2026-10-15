import { createHash } from 'node:crypto';
import path from 'node:path';
import type { MemoryObservation } from './observation-contract.js';
const object = (value: unknown): Record<string, unknown> => value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
/** Allowlisted host metadata only. No tool input, response or transcript. */
export function lifecycleObservation(raw: unknown): MemoryObservation | undefined {
  const input = object(raw), event = input.hook_event_name;
  if (!['PostCompact', 'Stop', 'SubagentStop'].includes(String(event))
    || typeof input.cwd !== 'string' || !path.isAbsolute(input.cwd)
    || typeof input.session_id !== 'string' || typeof input.turn_id !== 'string') return undefined;
  const kind = event === 'PostCompact' ? 'compaction' : 'completion';
  const eventId = 'codex-' + createHash('sha256').update(JSON.stringify([input.session_id, input.turn_id, input.agent_id ?? 'main', kind])).digest('hex');
  return { cwd: input.cwd, eventId, sessionId: input.session_id, kind,
    summary: `Codex emitted a ${kind} lifecycle signal. This does not verify product correctness.`,
    tags: ['codex', 'lifecycle-signal'], outcome: 'unknown', verification: 'unknown', actions: [],
    source: { producer: 'codex', eventIds: [eventId], revision: 0, tombstone: false } };
}
/** Lifecycle notifications are not permission to persist or extract memories. */
export function dispatchHookObservation(_raw: unknown, _databasePath: string): boolean {
  return false;
}
