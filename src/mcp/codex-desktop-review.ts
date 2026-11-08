import type { SqliteDatabase } from '../db/adapter.js';
import type { DesktopReplayBinding } from '../assurance/codex-desktop-turn.js';
import { waitForCompletedDesktopTurn, waitForSealedDesktopTrace, type DesktopReviewTurn } from '../agenticreplay/codex-replay.js';

export type { DesktopReviewTurn } from '../agenticreplay/codex-replay.js';

export function desktopReplayBinding(database: SqliteDatabase, runId: string, root: string): DesktopReplayBinding | undefined {
  return database.prepare(`SELECT b.session_id AS sessionId, b.turn_id AS turnId, b.transcript_path AS transcriptPath
    FROM codex_desktop_replay_bindings b JOIN codex_hook_requests h ON h.identity_digest = b.identity_digest
    WHERE b.run_id = ? AND h.repository_root = ? AND h.stop_notified = 0
      AND ((h.run_id = b.run_id AND h.state = 'bound') OR (h.run_id IS NULL AND h.state = 'pending'))`).get<DesktopReplayBinding & Record<string, string>>(runId, root);
}

export async function prepareDesktopReview(
  cwd: string, socketPath: string,
  resolveBinding: () => Promise<DesktopReplayBinding | undefined>, signal: AbortSignal,
): Promise<{ traceDirectory: string; turn: DesktopReviewTurn } | null> {
  const reviewSignal = AbortSignal.any([signal, AbortSignal.timeout(120_000)]);
  const { binding, turn } = await waitForCompletedDesktopTurn(cwd, resolveBinding, reviewSignal);
  const traceDirectory = await waitForSealedDesktopTrace(cwd, socketPath, binding, reviewSignal);
  return traceDirectory ? { traceDirectory, turn } : null;
}
