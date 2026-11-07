import { createHash } from 'node:crypto';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { ErrorCode, McpError } from '@modelcontextprotocol/sdk/types.js';
import { KiokukoError } from '../errors.js';
import { findSecret, findSecretInValue } from '../memory/secrets.js';
import { canonicalJson } from '../serialization/validate.js';
import { memoryCaptureReviewMessage, type MemoryCaptureProposal } from './memory-capture-presentation.js';

export type MemoryCaptureReviewStatus = 'saved' | 'declined' | 'unavailable';
export const MEMORY_CAPTURE_UNAVAILABLE_REASONS = ['proposal_too_large', 'capture_disabled', 'elicitation_not_supported',
  'form_elicitation_not_supported', 'elicitation_request_failed', 'elicitation_timeout',
  'request_cancelled', 'server_closed', 'save_interrupted'] as const;
type UnavailableReason = typeof MEMORY_CAPTURE_UNAVAILABLE_REASONS[number];
export const MEMORY_CAPTURE_DIAGNOSTIC_CATEGORIES = ['invalid_params', 'method_not_found', 'timeout', 'connection_closed', 'request_error'] as const;

interface ReviewDiagnostic {
  category: typeof MEMORY_CAPTURE_DIAGNOSTIC_CATEGORIES[number];
  code?: number;
  message: string;
}

/** Keep useful protocol detail, never the error's data, stack or secret-bearing message. */
function reviewDiagnostic(error: unknown): ReviewDiagnostic {
  const code = error instanceof McpError ? error.code : undefined;
  const message = error instanceof Error ? error.message : 'Native elicitation failed with a non-Error value';
  return {
    category: code === ErrorCode.InvalidParams ? 'invalid_params' : code === ErrorCode.MethodNotFound ? 'method_not_found'
      : code === ErrorCode.RequestTimeout ? 'timeout' : code === ErrorCode.ConnectionClosed ? 'connection_closed' : 'request_error',
    ...(code === undefined ? {} : { code }),
    message: findSecret(message) ? '[redacted: secret-bearing error message]'
      : message.replace(/[\p{Cc}\p{Cf}]/gu, ' ').slice(0, 500),
  };
}

const guidance: Partial<Record<UnavailableReason, string>> = {
  elicitation_not_supported: 'The connected client did not advertise native elicitation. Nothing was saved. Use a client connection that supports form elicitation; do not repeat the same call or substitute model approval.',
  form_elicitation_not_supported: 'The connected client does not advertise form elicitation. Nothing was saved; URL elicitation cannot approve this memory proposal.',
  elicitation_request_failed: 'The native review request failed. Nothing was saved. Inspect diagnostic for the protocol error before retrying; do not substitute terminal or model approval.',
  elicitation_timeout: 'The native review request timed out. Nothing was saved. Check the client approval UI and connection before retrying.',
  request_cancelled: 'The request was cancelled. No approval was retained and nothing was saved by this review.',
  server_closed: 'The MCP connection closed during review. No approval was retained and nothing was saved by this review.',
  save_interrupted: 'The connection was interrupted during the approved save. Persistence is unconfirmed. Reconcile this exact operation before retrying; do not assume the write failed.',
};

export interface MemoryCaptureReviewReceipt<T> {
  review: {
    status: MemoryCaptureReviewStatus;
    digest: string;
    workMayContinue: true;
    reason?: UnavailableReason;
    diagnostic?: ReviewDiagnostic;
    guidance?: string;
  };
  value?: T;
}

export function memoryProposalDigest(proposal: unknown): string {
  return createHash('sha256').update(canonicalJson(proposal)).digest('hex');
}

/**
 * Turns a model-organized proposal into a native human yes/no decision.
 * Tool arguments never contain approval, and the exact displayed proposal is
 * the only value passed to the save callback after the client accepts it.
 */
export function createMcpMemoryCaptureReview(server: McpServer) {
  const approved = new Map<string, string>();
  const finished = new Map<string, { digest: string; receipt: MemoryCaptureReviewReceipt<unknown> }>();
  const active = new Map<string, { digest: string; promise: Promise<MemoryCaptureReviewReceipt<unknown>> }>();
  const shutdown = new AbortController();

  const makeRoom = (): void => {
    if (approved.size + finished.size < 256) return;
    const finishedKey = finished.keys().next().value as string | undefined;
    if (finishedKey !== undefined) finished.delete(finishedKey);
    else {
      const approvedKey = approved.keys().next().value as string | undefined;
      if (approvedKey !== undefined) approved.delete(approvedKey);
    }
  };

  const unavailable = <T>(digest: string, reason: UnavailableReason, diagnostic?: ReviewDiagnostic): MemoryCaptureReviewReceipt<T> => ({
    review: { status: 'unavailable', digest, workMayContinue: true, reason,
      ...(guidance[reason] === undefined ? {} : { guidance: guidance[reason] }),
      ...(diagnostic === undefined ? {} : { diagnostic }) },
  });
  const cancellation = (): UnavailableReason => shutdown.signal.aborted ? 'server_closed' : 'request_cancelled';

  return {
    close(): void {
      shutdown.abort();
      approved.clear();
      finished.clear();
      active.clear();
    },

    async review<T>(input: {
      operationId: string;
      proposal: MemoryCaptureProposal;
      validateBeforePrompt?: () => void;
      save: () => Promise<T>;
      signal?: AbortSignal;
    }): Promise<MemoryCaptureReviewReceipt<T>> {
      if (findSecretInValue(input.proposal)) throw new KiokukoError('SECURITY_REJECTION', 'Memory proposal resembles a secret');
      const digest = memoryProposalDigest(input.proposal);
      const prior = finished.get(input.operationId);
      if (prior !== undefined) {
        if (prior.digest !== digest) throw new KiokukoError('CONFLICT', 'Memory review operation conflicts with a different proposal');
        return structuredClone(prior.receipt) as MemoryCaptureReviewReceipt<T>;
      }
      const previouslyApproved = approved.get(input.operationId);
      if (previouslyApproved !== undefined && previouslyApproved !== digest) {
        throw new KiokukoError('CONFLICT', 'Memory review operation conflicts with a different proposal');
      }
      const pending = active.get(input.operationId);
      if (pending !== undefined) {
        if (pending.digest !== digest) throw new KiokukoError('CONFLICT', 'Memory review operation conflicts with a different proposal');
        return structuredClone(await pending.promise) as MemoryCaptureReviewReceipt<T>;
      }
      const message = memoryCaptureReviewMessage(input.proposal);
      if (message === undefined) return {
        review: {
          status: 'unavailable', digest, workMayContinue: true, reason: 'proposal_too_large',
          guidance: 'Nothing was saved or shown for approval. Shorten the proposal in plain language: what to remember, why it will help, and when it applies. Keep necessary caveats; remove logs and unnecessary metadata. Use fewer items and a new operationId for revised content. Do not split it into repeated approval prompts or block the completed task.',
        },
      };
      if (previouslyApproved === undefined) {
        const elicitation = server.server.getClientCapabilities()?.elicitation;
        if (!elicitation) return unavailable(digest, 'elicitation_not_supported');
        if (!elicitation.form) return unavailable(digest, 'form_elicitation_not_supported');
      }

      const work = (async (): Promise<MemoryCaptureReviewReceipt<T>> => {
        const signal = input.signal === undefined
          ? shutdown.signal
          : AbortSignal.any([input.signal, shutdown.signal]);
        if (signal.aborted) return unavailable(digest, cancellation());

        if (previouslyApproved === undefined) {
          input.validateBeforePrompt?.();
          let result;
          try { result = await server.server.elicitInput({
            mode: 'form',
            message,
            requestedSchema: {
              type: 'object',
              properties: { choice: { type: 'string', title: 'Save these memories?', enum: ['save', 'decline'] } },
              required: ['choice'],
            },
          }, { signal, timeout: 300_000 });
          } catch (error) {
            if (signal.aborted) return unavailable(digest, cancellation());
            const diagnostic = reviewDiagnostic(error);
            return unavailable(digest, diagnostic.category === 'timeout' ? 'elicitation_timeout' : 'elicitation_request_failed', diagnostic);
          }
          if (signal.aborted) return unavailable(digest, cancellation());
          const choice = result.action === 'accept' ? result.content?.choice : 'decline';
          if (choice !== 'save') {
            const receipt: MemoryCaptureReviewReceipt<T> = {
              review: { status: 'declined', digest, workMayContinue: true },
            };
            makeRoom();
            finished.set(input.operationId, { digest, receipt });
            return receipt;
          }
          makeRoom();
          approved.set(input.operationId, digest);
        }

        if (signal.aborted) return unavailable(digest, cancellation());
        try {
          const value = await input.save();
          return {
            review: { status: 'saved', digest, workMayContinue: true },
            value,
          };
        } catch (error) {
          if (signal.aborted) return unavailable(digest, 'save_interrupted');
          throw error;
        }
      })();
      active.set(input.operationId, { digest, promise: work });
      try {
        return await work;
      } finally {
        active.delete(input.operationId);
      }
    },
  };
}
