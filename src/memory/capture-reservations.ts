import type { SqliteDatabase } from '../db/adapter.js';
import { lifecycleEventId } from './hook-observation-dispatch.js';

export interface CaptureReservationContext {
  sessionId: string;
  turnId: string;
  agentId?: string | undefined;
  repositoryRoot: string;
  transcriptPath?: string | undefined;
  runsDirectoryPresent: boolean;
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
  const state = ctx.runsDirectoryPresent ? 'pending' : 'evidence_insufficient';
  const exists = db.prepare('SELECT 1 AS present FROM memory_capture_reservations WHERE event_id = ?').get<{ present: number }>(eventId);
  if (!exists) {
    db.prepare(`INSERT INTO memory_capture_reservations
      (event_id, repository_root, session_id, turn_id, agent_id, transcript_path, state, attempts, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, 0, ?, ?)`)
      .run(eventId, ctx.repositoryRoot, ctx.sessionId, ctx.turnId, ctx.agentId ?? null, ctx.transcriptPath ?? null, state, ctx.now, ctx.now);
  }
  return { eventId, created: !exists };
}

/** User interruption cancels only unconsidered work; never reruns completed effects. */
export function cancelCaptureReservation(db: SqliteDatabase, ctx: { sessionId: string; turnId: string; agentId?: string | undefined; now: string }): void {
  db.prepare(`UPDATE memory_capture_reservations SET state = 'cancelled', updated_at = ?
    WHERE event_id = ? AND state IN ('pending', 'processing')`)
    .run(ctx.now, captureReservationEventId(ctx));
}

/**
 * Best-effort host notification for unapproved, never-announced candidates of
 * this repository. Returns undefined when there is nothing to announce.
 */
export function captureCandidateNotification(db: SqliteDatabase, repositoryRoot: string, now: string): string | undefined {
  const rows = db.prepare(`SELECT c.candidate_id AS candidateId FROM memory_capture_candidates c
    JOIN memory_capture_reservations r ON r.event_id = c.event_id
    WHERE r.repository_root = ? AND c.state = 'pending_review' AND c.presented_at IS NULL
    ORDER BY c.created_at LIMIT 6`).all<{ candidateId: string }>(repositoryRoot);
  if (!rows.length) return undefined;
  const ids = rows.map(row => row.candidateId);
  db.prepare(`UPDATE memory_capture_candidates SET presented_at = ?, updated_at = ?
    WHERE state = 'pending_review' AND presented_at IS NULL AND candidate_id IN (${ids.map(() => '?').join(',')})`)
    .run(now, now, ...ids);
  return `Kiokuko memory: ${ids.length} candidate proposal${ids.length === 1 ? '' : 's'} from completed turns await review. Run "kiokuko memory-review --pending" in this repository to approve or decline. Nothing was saved without approval, and ordinary work is unaffected.`;
}
