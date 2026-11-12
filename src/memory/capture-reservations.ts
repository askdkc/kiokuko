import type { SqliteDatabase } from '../db/adapter.js';
import { lifecycleEventId } from './hook-observation-dispatch.js';

export interface CaptureReservationContext {
  sessionId: string;
  turnId: string;
  agentId?: string | undefined;
  repositoryRoot: string;
  transcriptPath?: string | undefined;
  now: string;
}
export interface CaptureReservationResult {
  eventId: string;
  created: boolean;
}

/** One reservation per turn completion event; replayed events are ignored. */
export function captureReservationEventId(ctx: Pick<CaptureReservationContext, 'sessionId' | 'turnId' | 'agentId'>): string {
  return lifecycleEventId(ctx.sessionId, ctx.turnId, ctx.agentId, 'completion');
}

export function recordCaptureReservation(db: SqliteDatabase, ctx: CaptureReservationContext): CaptureReservationResult {
  const eventId = captureReservationEventId(ctx);
  const state = ctx.transcriptPath ? 'pending' : 'evidence_insufficient';
  const inserted = db.prepare(`INSERT INTO memory_capture_reservations
    (event_id, repository_root, session_id, turn_id, agent_id, transcript_path, state, attempts, last_reason, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?) ON CONFLICT(event_id) DO NOTHING RETURNING event_id`)
    .get(eventId, ctx.repositoryRoot, ctx.sessionId, ctx.turnId, ctx.agentId ?? null, ctx.transcriptPath ?? null,
      state, ctx.transcriptPath ? null : 'desktop_transcript_unavailable', ctx.now, ctx.now);
  return { eventId, created: inserted !== undefined };
}

/** User interruption cancels only unconsidered work; never reruns completed effects. */
export function cancelCaptureReservation(db: SqliteDatabase, ctx: { sessionId: string; turnId: string; agentId?: string | undefined; now: string }): void {
  db.prepare(`UPDATE memory_capture_reservations SET state = 'cancelled', updated_at = ?
    WHERE event_id = ? AND state IN ('pending', 'processing')`)
    .run(ctx.now, captureReservationEventId(ctx));
}

/** Pending rows created before exact-turn validation cannot be offered for approval. */
export const TURN_BOUND_CAPTURE_CANDIDATE = `r.state = 'useful_candidates'
  AND r.session_id = c.session_id AND r.turn_id = c.turn_id AND r.transcript_path IS NOT NULL
  AND CASE WHEN json_valid(c.proposal_json) THEN
    json_extract(c.proposal_json, '$.source.sessionId') = c.session_id
    AND json_extract(c.proposal_json, '$.source.turnId') = c.turn_id
  ELSE 0 END`;

export function nextCaptureCandidate(db: SqliteDatabase, repositoryRoot: string, sessionId: string, currentTurnId: string): string | undefined {
  return db.prepare(`SELECT c.candidate_id AS candidateId FROM memory_capture_candidates c
    JOIN memory_capture_reservations r ON r.event_id = c.event_id
    WHERE r.repository_root = ? AND c.session_id = ? AND c.turn_id != ? AND c.state = 'pending_review'
      AND c.presented_at IS NULL AND ${TURN_BOUND_CAPTURE_CANDIDATE}
    ORDER BY c.created_at, c.candidate_id LIMIT 1`).get<{ candidateId: string }>(repositoryRoot, sessionId, currentTurnId)?.candidateId;
}
