import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { readdir, realpath, stat } from 'node:fs/promises';
import type { SqliteDatabase } from '../db/adapter.js';
import { withImmediateTransaction } from '../db/transaction.js';
import { hasDesktopTranscript } from '../assurance/codex-desktop-turn.js';
import { discoverCodexDockSocket } from '../agenticreplay/codex-service.js';
import { waitForCompletedDesktopTurn, waitForSealedDesktopTrace } from '../agenticreplay/codex-replay.js';
import { resolveProjectWorkspace } from './workspaces.js';
import { extractReplayProposal } from './replay-extract.js';
import { compactCaptureProposal } from './capture-proposal.js';
import { proposalDigest, type ReplayMemoryProposal } from './replay-review.js';

export interface ConsiderationReceipt {
  considered: number;
  created: number;
  states: Record<string, string>;
  warnings: string[];
}

const MAX_TRACES = 3;
const MAX_ATTEMPTS = 3;
const knownSourceError = /^replay_(scope_mismatch|source_bound|event_file_ambiguous_or_missing|event_invalid|event_bound|blob_invalid|blob_integrity|blob_budget_exceeded|integrity_mismatch|contract_mismatch|desktop_(?:turn_mismatch|memory_empty|response_(?:bound|incomplete|invalid|mismatch)|call_(?:invalid|ambiguous|bound)|result_invalid))$|^unsafe_extraction$/u;

interface PendingReservation extends Record<string, unknown> {
  event_id: string;
  session_id: string;
  turn_id: string;
  transcript_path: string | null;
  attempts: number;
  state: 'pending' | 'processing';
  updated_at: string;
}

async function newestTraceDirectories(root: string): Promise<string[]> {
  const runs = await realpath(path.join(root, '.agenticreplay', 'runs'));
  if (runs !== path.join(root, '.agenticreplay', 'runs')) return [];
  const entries = await readdir(runs, { withFileTypes: true });
  const newest: Array<{ directory: string; modifiedAt: number }> = [];
  for (const entry of entries) {
    if (!entry.isDirectory() || !/^(?:run_|\d{14}-codex-desktop-api-[a-z0-9-]+-)[a-f0-9]{6,32}$/u.test(entry.name)) continue;
    const directory = path.join(runs, entry.name);
    const info = await stat(directory).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== 'ENOENT') throw error;
      return undefined;
    });
    if (!info) continue;
    newest.push({ directory, modifiedAt: info.mtimeMs });
    newest.sort((a, b) => b.modifiedAt - a.modifiedAt);
    if (newest.length > MAX_TRACES) newest.pop();
  }
  return newest.map(entry => entry.directory);
}

async function findProposal(
  root: string, workspace: string, reservation: PendingReservation, active: () => boolean,
): Promise<{ proposal?: ReplayMemoryProposal; empty?: boolean; warning?: string }> {
  const { session_id: sessionId, turn_id: turnId, transcript_path: transcriptPath } = reservation;
  if (!transcriptPath || !hasDesktopTranscript({ sessionId, turnId, transcriptPath }, root)) {
    return { warning: 'desktop_transcript_unavailable' };
  }
  const signal = AbortSignal.timeout(120_000);
  const binding = { sessionId, turnId, transcriptPath };
  let userTextDigests: string[];
  try {
    const { turn } = await waitForCompletedDesktopTurn(root, async () => {
      if (!active()) throw new Error('capture_reservation_inactive');
      return binding;
    }, signal);
    userTextDigests = turn.userTextDigests;
  } catch (error) {
    if (signal.aborted) return { warning: 'desktop_turn_completion_timeout' };
    throw error;
  }
  const explicitSocket = process.env.AGENTICREPLAY_CODEX_REVIEW_SOCKET;
  const socket = explicitSocket && path.isAbsolute(explicitSocket)
    ? explicitSocket : await discoverCodexDockSocket(root, signal);
  // The normal route waits for the recorder's exact turn receipt. An already
  // sealed trace can also be recovered after a recorder restart.
  const sealed = socket && active()
    ? await waitForSealedDesktopTrace(root, socket, binding, signal).catch(() => null) : null;
  const extract = (traceDirectory: string) => extractReplayProposal({ cwd: root, traceDirectory,
    taskId: `turn:${turnId}`.slice(0, 128), sessionId, workspace,
    desktopTurnId: turnId, desktopUserTextDigests: userTextDigests });
  let warning: string | undefined;
  let empty = false;
  const tryTrace = async (directory: string): Promise<ReplayMemoryProposal | undefined> => {
    try {
      const proposal = await extract(directory);
      if (proposal.findings.length) return compactCaptureProposal(proposal);
      empty = true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
      const reason = error instanceof SyntaxError ? 'replay_event_invalid' : error instanceof Error ? error.message : '';
      if (!knownSourceError.test(reason)) throw error;
      if (reason === 'replay_desktop_memory_empty') empty = true;
      else if (reason !== 'replay_desktop_turn_mismatch') warning ??= reason;
    }
  };
  if (sealed && active()) {
    const proposal = await tryTrace(sealed);
    if (proposal) return { proposal };
  }
  const traces = await newestTraceDirectories(root).catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT') return [];
    throw error;
  });
  for (const directory of traces) {
    if (!active()) break;
    if (directory === sealed) continue;
    const proposal = await tryTrace(directory);
    if (proposal) return { proposal, ...(warning ? { warning } : {}) };
  }
  return { empty, warning: warning ?? (empty ? 'replay_desktop_memory_empty' : 'replay_source_unavailable') };
}

async function considerOne(
  db: SqliteDatabase, reservation: PendingReservation, root: string,
): Promise<{ created: boolean; warning?: string }> {
  const claimedAt = new Date().toISOString();
  const claim = db.prepare(`UPDATE memory_capture_reservations SET state = 'processing', updated_at = ?
    WHERE event_id = ? AND updated_at = ? AND state = ? RETURNING event_id`)
    .get(claimedAt, reservation.event_id, reservation.updated_at, reservation.state);
  if (!claim) return { created: false };
  const active = () => !!db.prepare(`SELECT 1 FROM memory_capture_reservations
    WHERE event_id = ? AND state = 'processing' AND updated_at = ?`).get(reservation.event_id, claimedAt);
  const finish = (state: string, reason: string | null = null) => db.prepare(`UPDATE memory_capture_reservations
    SET state = ?, last_reason = ?, updated_at = ? WHERE event_id = ? AND state = 'processing' AND updated_at = ?`)
    .run(state, reason, new Date().toISOString(), reservation.event_id, claimedAt);
  try {
    const project = await resolveProjectWorkspace(db, root);
    const result = project ? await findProposal(root, project.workspace, reservation, active)
      : { warning: 'workspace_unavailable' };
    const { proposal, warning, empty } = result;
    if (!proposal || !project) {
      finish(empty && warning === 'replay_desktop_memory_empty' ? 'no_candidates' : 'evidence_insufficient', warning ?? null);
      return { created: false, ...(warning && warning !== 'replay_desktop_memory_empty' ? { warning } : {}) };
    }
    const bytes = JSON.stringify(proposal);
    if (Buffer.byteLength(bytes) > 256 * 1024) {
      finish('evidence_insufficient', 'replay_proposal_bound');
      return { created: false, warning: 'replay_proposal_bound' };
    }
    const source = proposal.source.traces[0]!;
    const created = withImmediateTransaction(db, () => {
      if (!active()) return false;
      const now = new Date().toISOString();
      const candidate = db.prepare(`INSERT INTO memory_capture_candidates
        (candidate_id, event_id, workspace, session_id, turn_id, evidence_key, revision, digest, proposal_json, state, presented_at, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending_review', NULL, ?, ?)
        ON CONFLICT(workspace, evidence_key) DO NOTHING RETURNING candidate_id`)
        .get(randomUUID(), reservation.event_id, project.workspace, reservation.session_id, reservation.turn_id,
          `${source.runId}:${source.eventsSha256}`, proposal.revision, proposalDigest(proposal), bytes, now, now);
      finish('useful_candidates');
      return candidate !== undefined;
    });
    return { created, ...(warning ? { warning } : {}) };
  } catch {
    const attempts = reservation.attempts + 1;
    db.prepare(`UPDATE memory_capture_reservations SET attempts = ?, last_reason = 'consideration_error',
      state = CASE WHEN ? >= ? THEN 'processing_failed' ELSE 'pending' END, updated_at = ?
      WHERE event_id = ? AND state = 'processing' AND updated_at = ?`)
      .run(attempts, attempts, MAX_ATTEMPTS, new Date().toISOString(), reservation.event_id, claimedAt);
    return { created: false, warning: 'consideration_error' };
  }
}

/** Background consideration saves only candidates from a verified completed turn. */
export async function considerPendingCaptureReservations(db: SqliteDatabase, rootInput: string, options: { limit?: number } = {}): Promise<ConsiderationReceipt> {
  const root = await realpath(rootInput);
  const staleBefore = new Date(Date.now() - 10 * 60 * 1000).toISOString();
  const pending = db.prepare(`SELECT event_id, session_id, turn_id, transcript_path, attempts, state, updated_at
    FROM memory_capture_reservations WHERE repository_root = ? AND
      (state = 'pending' OR (state = 'processing' AND updated_at < ?))
    ORDER BY created_at DESC LIMIT ?`).all<PendingReservation>(root, staleBefore, Math.max(1, Math.min(8, options.limit ?? 4)));
  const receipt: ConsiderationReceipt = { considered: 0, created: 0, states: {}, warnings: [] };
  for (const reservation of pending) {
    const result = await considerOne(db, reservation, root);
    receipt.considered += 1;
    receipt.created += result.created ? 1 : 0;
    if (result.warning) receipt.warnings.push(result.warning);
    receipt.states[reservation.event_id] = db.prepare('SELECT state FROM memory_capture_reservations WHERE event_id = ?')
      .get<{ state: string }>(reservation.event_id)?.state ?? 'unknown';
  }
  return receipt;
}
