import { createHash } from 'node:crypto';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { KiokukoError } from '../errors.js';
import { findSecretInValue } from '../memory/secrets.js';
import { canonicalJson } from '../serialization/validate.js';
import { memoryCaptureReviewMessage, type MemoryCaptureProposal } from './memory-capture-presentation.js';

export type MemoryCaptureReviewStatus = 'saved' | 'declined' | 'unavailable';

export interface MemoryCaptureReviewReceipt<T> {
  review: {
    status: MemoryCaptureReviewStatus;
    digest: string;
    workMayContinue: true;
    reason?: 'proposal_too_large';
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

  const unavailable = <T>(digest: string): MemoryCaptureReviewReceipt<T> => ({
    review: { status: 'unavailable', digest, workMayContinue: true },
  });

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
      if (previouslyApproved === undefined && !server.server.getClientCapabilities()?.elicitation) return unavailable(digest);

      const work = (async (): Promise<MemoryCaptureReviewReceipt<T>> => {
        const signal = input.signal === undefined
          ? shutdown.signal
          : AbortSignal.any([input.signal, shutdown.signal]);
        if (signal.aborted) return unavailable(digest);

        if (previouslyApproved === undefined) {
          const result = await server.server.elicitInput({
            mode: 'form',
            message,
            requestedSchema: {
              type: 'object',
              properties: { choice: { type: 'string', title: 'Save these memories?', enum: ['save', 'decline'] } },
              required: ['choice'],
            },
          }, { signal, timeout: 300_000 }).catch(() => undefined);
          if (result === undefined) return unavailable(digest);
          const choice = result.action === 'accept' ? result.content?.choice : 'decline';
          if (choice !== 'save' || signal.aborted) {
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

        if (signal.aborted) return unavailable(digest);
        try {
          const value = await input.save();
          return {
            review: { status: 'saved', digest, workMayContinue: true },
            value,
          };
        } catch (error) {
          if (signal.aborted) return unavailable(digest);
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
