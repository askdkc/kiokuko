import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { SqliteDatabase } from '../db/adapter.js';
import { pendingCaptureReviewMessage } from '../memory/capture-proposal.js';
import { reviewPendingCaptureCandidate, type PendingReviewReceipt } from '../memory/capture-pending-review.js';
import { resolveProjectWorkspaceReadOnly } from '../memory/workspaces.js';
import { canonicalContentHash } from '../serialization/validate.js';
import { elicitMemorySave } from './memory-capture-review.js';
import { fitsNativeReview } from './memory-capture-presentation.js';

interface PendingReviewInput {
  cwd: string;
  candidateId: string;
  requestId: string;
  turnId: string;
}

export function createMcpPendingCaptureReview(
  server: McpServer, withDatabase: (operation: (db: SqliteDatabase) => Promise<PendingReviewReceipt>) => Promise<PendingReviewReceipt>,
) {
  const active = new Set<string>();
  const shutdown = new AbortController();
  const unavailable: PendingReviewReceipt = { status: 'unavailable', workMayContinue: true };
  return {
    close: () => shutdown.abort(),
    async review(input: PendingReviewInput, signal: AbortSignal): Promise<PendingReviewReceipt> {
      if (!server.server.getClientCapabilities()?.elicitation?.form) return { ...unavailable, reason: 'ui_unsupported' };
      if (active.has(input.candidateId)) return { ...unavailable, reason: 'review_in_progress' };
      const combined = AbortSignal.any([signal, shutdown.signal]);
      active.add(input.candidateId);
      try {
        return await withDatabase(async db => {
          const project = await resolveProjectWorkspaceReadOnly(db, input.cwd);
          if (!project) return unavailable;
          const candidate = db.prepare(`SELECT c.session_id AS sessionId, c.turn_id AS turnId FROM memory_capture_candidates c
            JOIN memory_capture_reservations r ON r.event_id = c.event_id
            WHERE c.candidate_id = ? AND c.workspace = ? AND r.repository_root = ?`)
            .get<{ sessionId: string; turnId: string }>(input.candidateId, project.workspace, project.repositoryRoot);
          if (!candidate || candidate.turnId === input.turnId) return unavailable;
          const identity = canonicalContentHash({ session: candidate.sessionId, turn: input.turnId, agent: 'main', root: project.repositoryRoot });
          const canReview = () => input.requestId === `codex-${identity}` && !!db.prepare(`SELECT 1 FROM codex_hook_requests
            WHERE identity_digest = ? AND request_id = ? AND repository_root = ? AND state != 'cancelled' AND stop_notified = 0
              AND last_event NOT IN ('Stop', 'Interrupt', 'SubagentStop')`)
            .get(identity, input.requestId, project.repositoryRoot);
          return reviewPendingCaptureCandidate(db, {
            candidateId: input.candidateId, workspace: project.workspace, signal: combined, canReview, requestId: input.requestId,
            present: proposal => {
              const message = pendingCaptureReviewMessage(proposal);
              return fitsNativeReview(message) ? message : undefined;
            },
            ask: async question => {
              const reply = await elicitMemorySave(server, question.message!, combined);
              if (reply.action === 'accept' && reply.content?.choice === 'save') return { choice: 'approve' };
              if (reply.action === 'decline' || (reply.action === 'accept' && reply.content?.choice === 'decline')) return { choice: 'decline' };
              throw new Error('capture_review_no_decision');
            },
          });
        });
      } catch {
        return unavailable;
      } finally {
        active.delete(input.candidateId);
      }
    },
  };
}
