import { createHash, randomUUID } from 'node:crypto';
import type { SqliteDatabase } from '../db/adapter.js';
import { recordEntryInTransaction } from './entries.js';
import { createApprovedReplayMemoryStore } from './replay-store.js';
import { proposalDigest, type ReplayMemoryProposal } from './replay-review.js';
import { findSecretInValue } from './secrets.js';
import { TURN_BOUND_CAPTURE_CANDIDATE } from './capture-reservations.js';
import { withImmediateTransaction } from '../db/transaction.js';

export interface PendingReviewAnswer { choice: 'approve' | 'decline' | 'revise'; comment?: string; }
export interface PendingReviewQuestion { id: string; revision: number; digest: string; message: string | undefined; }
export interface PendingReviewReceipt {
  status: 'saved' | 'declined' | 'unavailable' | 'not_found';
  workMayContinue: true;
  approvalKey?: string;
  reason?: string;
}

interface CandidateRow extends Record<string, unknown> {
  candidate_id: string;
  event_id: string;
  workspace: string;
  session_id: string;
  turn_id: string;
  revision: number;
  digest: string;
  proposal_json: string;
  state: string;
}

/** Approval binds the candidate identity, its revision, the displayed digest, the scope and the session. */
function captureApprovalKey(row: Pick<CandidateRow, 'workspace' | 'candidate_id' | 'session_id' | 'revision' | 'digest'>): string {
  return createHash('sha256').update(JSON.stringify([row.workspace, row.candidate_id, row.revision, row.digest, row.session_id])).digest('hex');
}

function loadCandidate(db: SqliteDatabase, candidateId: string, workspace: string): CandidateRow | undefined {
  return db.prepare(`SELECT c.candidate_id, c.event_id, c.workspace, c.session_id, c.turn_id, c.revision, c.digest, c.proposal_json, c.state
    FROM memory_capture_candidates c JOIN memory_capture_reservations r ON r.event_id = c.event_id
    WHERE c.candidate_id = ? AND c.workspace = ? AND ${TURN_BOUND_CAPTURE_CANDIDATE}`)
    .get<CandidateRow>(candidateId, workspace);
}

/** Corrections become a new displayed version; recorded evidence stays in place. */
function revisedProposal(proposal: ReplayMemoryProposal, comment: string): ReplayMemoryProposal {
  return { ...proposal, revision: proposal.revision + 1,
    findings: [{ kind: 'key_point', text: comment, basis: 'user_corrected', evidenceRefs: [] }] };
}

/**
 * Host-only review loop for a stored capture candidate. The exact displayed
 * revision is the only value passed to the approved store; tool arguments,
 * model output and lifecycle events never approve anything.
 */
interface PendingReviewInput {
  candidateId: string;
  workspace: string;
  present: (proposal: ReplayMemoryProposal) => string | undefined;
  ask: (question: PendingReviewQuestion) => Promise<PendingReviewAnswer>;
  signal?: AbortSignal;
  canReview?: () => boolean;
  requestId?: string;
}

/** Persistent presentation lease prevents concurrent clients/processes from
 * opening the same question. A crashed presenter can be retried after expiry.
 * UI exactly-once delivery cannot be promised without host acknowledgement. */
export async function reviewPendingCaptureCandidate(db: SqliteDatabase, input: PendingReviewInput): Promise<PendingReviewReceipt> {
  const token = randomUUID();
  const now = new Date().toISOString();
  const deadline = AbortSignal.timeout(120_000);
  const signal = input.signal ? AbortSignal.any([input.signal, deadline]) : deadline;
  let claimed = false;
  try {
    if (signal.aborted || !(input.canReview?.() ?? true)) return { status: 'unavailable', workMayContinue: true };
    const row = loadCandidate(db, input.candidateId, input.workspace);
    if (!row) return { status: 'not_found', workMayContinue: true };
    if (row.state === 'saved') return { status: 'saved', workMayContinue: true, approvalKey: captureApprovalKey(row) };
    if (row.state === 'declined') return { status: 'declined', workMayContinue: true };
    if (input.requestId && db.prepare(`SELECT 1 FROM memory_capture_presentations
      WHERE candidate_id = ? AND request_id = ?`).get(input.candidateId, input.requestId)) {
      return { status: 'unavailable', reason: 'review_already_presented', workMayContinue: true };
    }
    claimed = !!db.prepare(`UPDATE memory_capture_candidates SET review_token = ?, review_until = ?, review_reason = 'presenting'
      WHERE candidate_id = ? AND state = 'pending_review' AND (review_token IS NULL OR review_until < ?) RETURNING candidate_id`)
      .get(token, new Date(Date.now() + 125_000).toISOString(), input.candidateId, now);
    if (!claimed) return { status: 'unavailable', reason: 'review_in_progress', workMayContinue: true };
    const owned = () => !signal.aborted && (input.canReview?.() ?? true) && !!db.prepare(`SELECT 1 FROM memory_capture_candidates
      WHERE candidate_id = ? AND review_token = ? AND review_until > ?`).get(input.candidateId, token, new Date().toISOString());
    let presented = false;
    const result = await reviewCandidate(db, { ...input, signal, canReview: owned,
      ask: async question => {
        withImmediateTransaction(db, () => {
          if (!owned()) throw new Error('review_ownership_lost');
          if (!presented && input.requestId) db.prepare(`INSERT INTO memory_capture_presentations
            (candidate_id, request_id, presented_at) VALUES (?, ?, ?)`).run(input.candidateId, input.requestId, new Date().toISOString());
          db.prepare('UPDATE memory_capture_candidates SET presented_at = ? WHERE candidate_id = ? AND review_token = ?')
            .run(new Date().toISOString(), input.candidateId, token);
        });
        presented = true;
        let abort: () => void = () => {};
        try {
          return await Promise.race([input.ask(question), new Promise<never>((_, reject) => {
            abort = () => reject(new Error('review_cancelled_or_timeout'));
            signal.addEventListener('abort', abort, { once: true });
            if (signal.aborted) abort();
          })]);
        } finally { signal.removeEventListener('abort', abort); }
      },
    });
    db.prepare('UPDATE memory_capture_candidates SET review_reason = ? WHERE candidate_id = ? AND review_token = ?')
      .run(result.status, input.candidateId, token);
    return result;
  } catch {
    try { db.prepare('UPDATE memory_capture_candidates SET review_reason = ? WHERE candidate_id = ? AND review_token = ?')
      .run('review_unavailable', input.candidateId, token); } catch { /* Optional diagnostics. */ }
    return { status: 'unavailable', reason: 'review_unavailable', workMayContinue: true };
  } finally {
    if (claimed) try { db.prepare('UPDATE memory_capture_candidates SET review_token = NULL, review_until = NULL WHERE candidate_id = ? AND review_token = ?')
      .run(input.candidateId, token); } catch { /* A durable lease expires without blocking work. */ }
  }
}

async function reviewCandidate(db: SqliteDatabase, input: PendingReviewInput): Promise<PendingReviewReceipt> {
  const available = () => !input.signal?.aborted && (input.canReview?.() ?? true);
  if (!available()) return { status: 'unavailable', workMayContinue: true };
  let row = loadCandidate(db, input.candidateId, input.workspace);
  if (!row) return { status: 'not_found', workMayContinue: true };
  if (row.state === 'declined') return { status: 'declined', workMayContinue: true };
  if (row.state === 'saved') return { status: 'saved', workMayContinue: true, approvalKey: captureApprovalKey(row) };
  let proposal = JSON.parse(row.proposal_json) as ReplayMemoryProposal;
  if (proposal.source.workspace !== row.workspace) return { status: 'unavailable', workMayContinue: true };
  for (;;) {
    if (!available()) return { status: 'unavailable', workMayContinue: true };
    const digest = proposalDigest(proposal);
    if (digest !== row.digest || proposal.revision !== row.revision) return { status: 'unavailable', workMayContinue: true };
    const question: PendingReviewQuestion = { id: randomUUID(), revision: proposal.revision, digest, message: input.present(proposal) };
    if (question.message === undefined) return { status: 'unavailable', workMayContinue: true };
    const answer = await input.ask(question);
    if (!available()) return { status: 'unavailable', workMayContinue: true };
    if (answer.choice === 'decline') {
      const updated = db.prepare(`UPDATE memory_capture_candidates SET state = 'declined', updated_at = ?
        WHERE candidate_id = ? AND state = 'pending_review' AND revision = ? AND digest = ? RETURNING candidate_id`)
        .get(new Date().toISOString(), input.candidateId, row.revision, row.digest);
      return { status: updated ? 'declined' : 'unavailable', workMayContinue: true };
    }
    if (answer.choice === 'revise' || answer.comment?.trim()) {
      const comment = answer.comment?.trim() ?? '';
      if (!comment || comment.length > 2048 || findSecretInValue(comment)) return { status: 'unavailable', workMayContinue: true };
      if (proposal.findings.length === 1 && proposal.findings[0]?.basis === 'user_corrected' && proposal.findings[0].text === comment) {
        return { status: 'unavailable', workMayContinue: true };
      }
      proposal = revisedProposal(proposal, comment);
      const revisedDigest = proposalDigest(proposal);
      const bytes = JSON.stringify(proposal);
      if (bytes.length > 256 * 1024 || findSecretInValue(proposal)) return { status: 'unavailable', workMayContinue: true };
      const updated = db.prepare(`UPDATE memory_capture_candidates SET revision = ?, digest = ?, proposal_json = ?, updated_at = ?
        WHERE candidate_id = ? AND state = 'pending_review' AND revision = ? AND digest = ? RETURNING candidate_id`)
        .get(proposal.revision, revisedDigest, bytes, new Date().toISOString(), input.candidateId, row.revision, row.digest);
      if (!updated) return { status: 'unavailable', workMayContinue: true };
      const reloaded = loadCandidate(db, input.candidateId, input.workspace);
      if (!reloaded || reloaded.state !== 'pending_review') return { status: 'unavailable', workMayContinue: true };
      row = reloaded;
      continue;
    }
    if (answer.choice !== 'approve' || proposalDigest(proposal) !== row.digest) {
      return { status: 'declined', workMayContinue: true };
    }
    const approvalKey = captureApprovalKey(row);
    try {
      createApprovedReplayMemoryStore(db, input.workspace, approved => recordEntryInTransaction(db, {
        workspace: input.workspace,
        kind: 'reference',
        title: `Approved experience: ${approved.request.text.slice(0, 100) || approved.source.taskId}`,
        body: JSON.stringify(approved),
        summary: approved.findings.map(finding => finding.text).join('\n').slice(0, 2048) || approved.request.text.slice(0, 2048),
        tags: [...new Set([...approved.tags, ...approved.keywords])].slice(0, 20),
        scope: { visibility: 'project' },
        provenance: { type: 'user_approved_replay', reference: approvalKey,
          evidenceIds: [...new Set([...approved.findings.flatMap(finding => finding.evidenceRefs), ...approved.request.evidenceRefs,
            ...approved.attempts.flatMap(attempt => [attempt.callRef, ...(attempt.resultRef ? [attempt.resultRef] : [])])])].slice(0, 200) },
        trustLevel: 'untrusted',
        confidence: 0.4,
        createdBy: 'kiokuko-capture-review',
        actor: 'user',
      })).save(proposal, approvalKey, () => {
        const current = loadCandidate(db, input.candidateId, input.workspace);
        if (!available() || current?.state !== 'pending_review' || current.revision !== proposal.revision || current.digest !== digest) {
          throw new Error('capture_review_binding_changed');
        }
        db.prepare(`UPDATE memory_capture_candidates SET state = 'saved', updated_at = ? WHERE candidate_id = ?`)
          .run(new Date().toISOString(), input.candidateId);
      });
      return { status: 'saved', workMayContinue: true, approvalKey };
    } catch {
      // Nothing was marked saved; a later exact re-approval reconciles by key.
      return { status: 'unavailable', workMayContinue: true };
    }
  }
}
