import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { readdir, realpath, stat } from 'node:fs/promises';
import type { SqliteDatabase } from '../db/adapter.js';
import { resolveProjectWorkspace } from './workspaces.js';
import { extractReplayProposal } from './replay-extract.js';
import { proposalDigest, type ReplayMemoryProposal } from './replay-review.js';
import { findSecretInValue } from './secrets.js';

export interface ConsiderationReceipt {
  considered: number;
  created: number;
  states: Record<string, string>;
  warnings: string[];
}

const MAX_TRACES = 3;
const MAX_ATTEMPTS = 3;
/** Bounded, known source failures. They classify evidence as insufficient, never as a bug loop. */
const boundedSourceError = /replay_(scope_mismatch|source_bound|event_file_ambiguous_or_missing|event_invalid|event_bound|blob_invalid|blob_integrity|integrity_mismatch|contract_mismatch|desktop_turn_mismatch|desktop_memory_empty)|unsafe_extraction/u;

interface PendingReservation extends Record<string, unknown> {
  event_id: string;
  session_id: string;
  turn_id: string;
  attempts: number;
}

async function newestTraceDirectories(root: string, limit: number): Promise<string[]> {
  const runs = await realpath(path.join(root, '.agenticreplay', 'runs'));
  const entries = await readdir(runs, { withFileTypes: true });
  const directories: Array<{ name: string; modifiedAt: number }> = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const info = await stat(path.join(runs, entry.name));
    directories.push({ name: entry.name, modifiedAt: info.mtimeMs });
  }
  return directories.sort((a, b) => b.modifiedAt - a.modifiedAt).slice(0, limit).map(entry => path.join(runs, entry.name));
}

function finalize(db: SqliteDatabase, eventId: string, state: string, reason: string | null): void {
  db.prepare(`UPDATE memory_capture_reservations SET state = ?, last_reason = ?, updated_at = ?
    WHERE event_id = ? AND state IN ('pending', 'processing')`)
    .run(state, reason, new Date().toISOString(), eventId);
}

async function considerOne(db: SqliteDatabase, reservation: PendingReservation, root: string, now: string): Promise<{ created: boolean; warning?: string | undefined }> {
  db.prepare(`UPDATE memory_capture_reservations SET state = 'processing', updated_at = ?
    WHERE event_id = ? AND state = 'pending'`).run(now, reservation.event_id);
  if (!db.prepare(`SELECT 1 FROM memory_capture_reservations WHERE event_id = ? AND state = 'processing'`).get(reservation.event_id)) {
    return { created: false }; // Cancelled or already finalized between reads.
  }
  const project = await resolveProjectWorkspace(db, root);
  if (!project) {
    finalize(db, reservation.event_id, 'evidence_insufficient', 'workspace_unavailable');
    return { created: false, warning: 'workspace_unavailable' };
  }
  let traces: string[];
  try { traces = await newestTraceDirectories(root, MAX_TRACES); }
  catch {
    finalize(db, reservation.event_id, 'evidence_insufficient', 'replay_source_unavailable');
    return { created: false, warning: 'replay_source_unavailable' };
  }
  let proposal: ReplayMemoryProposal | undefined;
  let warning: string | undefined;
  for (const traceDirectory of traces) {
    try {
      proposal = await extractReplayProposal({ cwd: root, traceDirectory,
        taskId: `turn:${reservation.turn_id}`.slice(0, 128), sessionId: reservation.session_id, workspace: project.workspace });
      break;
    } catch (error) {
      const message = error instanceof Error ? error.message : 'replay_source_unavailable';
      if (!boundedSourceError.test(message)) throw error;
      warning = message;
    }
  }
  if (!proposal) {
    finalize(db, reservation.event_id, 'evidence_insufficient', warning ?? 'replay_source_unavailable');
    return { created: false, warning };
  }
  if (proposal.attempts.length === 0 && proposal.findings.length === 0) {
    finalize(db, reservation.event_id, 'no_candidates', null);
    return { created: false };
  }
  const evidenceKey = `${proposal.source.traces[0]!.runId}:${proposal.source.traces[0]!.eventsSha256}`;
  const digest = proposalDigest(proposal);
  const bytes = JSON.stringify(proposal);
  if (bytes.length > 256 * 1024 || findSecretInValue(proposal)) {
    finalize(db, reservation.event_id, 'evidence_insufficient', 'unsafe_extraction');
    return { created: false, warning: 'unsafe_extraction' };
  }
  const reservationState = db.prepare(`SELECT state FROM memory_capture_reservations WHERE event_id = ?`).get<{ state: string }>(reservation.event_id);
  if (reservationState?.state !== 'processing') return { created: false }; // Cancelled during extraction.
  const existing = db.prepare('SELECT 1 FROM memory_capture_candidates WHERE workspace = ? AND evidence_key = ?')
    .get(project.workspace, evidenceKey);
  if (!existing) {
    db.prepare(`INSERT INTO memory_capture_candidates
      (candidate_id, event_id, workspace, session_id, turn_id, evidence_key, revision, digest, proposal_json, state, presented_at, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending_review', NULL, ?, ?)`)
      .run(randomUUID(), reservation.event_id, project.workspace, reservation.session_id, reservation.turn_id, evidenceKey, proposal.revision, digest, bytes, now, now);
  }
  finalize(db, reservation.event_id, 'useful_candidates', null);
  return { created: !existing };
}

/**
 * Dedicated, host-owned candidate consideration. Reads only bounded, verified
 * replay traces and never writes memories: candidates stay in their own table
 * until the human approves the exact displayed revision.
 */
export async function considerPendingCaptureReservations(db: SqliteDatabase, rootInput: string, options: { limit?: number } = {}): Promise<ConsiderationReceipt> {
  const root = await realpath(rootInput);
  const now = new Date().toISOString();
  const staleBefore = new Date(Date.now() - 10 * 60 * 1000).toISOString();
  const pending = db.prepare(`SELECT event_id, session_id, turn_id, attempts FROM memory_capture_reservations
    WHERE repository_root = ? AND (state = 'pending' OR (state = 'processing' AND updated_at < ?))
    ORDER BY created_at LIMIT ?`).all<PendingReservation>(root, staleBefore, Math.max(1, Math.min(8, options.limit ?? 4)));
  const receipt: ConsiderationReceipt = { considered: 0, created: 0, states: {}, warnings: [] };
  for (const reservation of pending) {
    try {
      const result = await considerOne(db, reservation, root, now);
      receipt.considered += 1;
      receipt.created += result.created ? 1 : 0;
      if (result.warning) receipt.warnings.push(result.warning);
      const state = db.prepare('SELECT state FROM memory_capture_reservations WHERE event_id = ?').get<{ state: string }>(reservation.event_id)?.state ?? 'unknown';
      receipt.states[reservation.event_id] = state;
    } catch (error) {
      const reason = error instanceof Error ? error.message.slice(0, 200) : 'consideration_error';
      const attempts = reservation.attempts + 1;
      db.prepare(`UPDATE memory_capture_reservations SET attempts = ?, last_reason = ?,
        state = CASE WHEN ? >= ? THEN 'processing_failed' ELSE 'pending' END, updated_at = ?
        WHERE event_id = ? AND state IN ('pending', 'processing')`)
        .run(attempts, reason, attempts, MAX_ATTEMPTS, now, reservation.event_id);
      receipt.warnings.push('consideration_error');
      const state = db.prepare('SELECT state FROM memory_capture_reservations WHERE event_id = ?').get<{ state: string }>(reservation.event_id)?.state ?? 'unknown';
      receipt.states[reservation.event_id] = state;
    }
  }
  return receipt;
}
