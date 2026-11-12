import type { SqliteDatabase } from '../db/adapter.js';

/** Bounded, content-free diagnostics. An absent row is not proof of completion. */
export function captureDiagnostics(db: SqliteDatabase, root: string, sessionId?: string) {
  try {
    const reservations = db.prepare(`SELECT r.event_id, r.session_id, r.turn_id, r.state AS consideration,
      r.last_reason, c.candidate_id, c.state AS review, c.presented_at, c.review_reason
      FROM memory_capture_reservations r LEFT JOIN memory_capture_candidates c ON c.event_id = r.event_id
      WHERE r.repository_root = ? AND (? IS NULL OR r.session_id = ?) ORDER BY r.created_at DESC LIMIT 20`)
      .all(root, sessionId ?? null, sessionId ?? null);
    const receipts = db.prepare(`SELECT source, session_id, turn_id, reason FROM memory_capture_receipts
      WHERE repository_root = ? AND (? IS NULL OR session_id = ?) ORDER BY received_at DESC LIMIT 20`)
      .all(root, sessionId ?? null, sessionId ?? null);
    return { workMayContinue: true, notification: reservations.length ? 'observed' : 'hook_not_observed',
      chatgpt: 'adapter_unsupported', confirmation: 'next_turn_memory_review_pending_fallback',
      alternative: 'memory_capture', reservations, receipts };
  } catch {
    return { workMayContinue: true, reason: 'capture_diagnostics_unavailable' };
  }
}
