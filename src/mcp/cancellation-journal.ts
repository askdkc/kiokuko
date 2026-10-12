import { createHash, randomUUID } from 'node:crypto';
import { PACKAGE_VERSION } from '../package-version.js';
import type { McpDeadlineObservation } from './request-deadline.js';

export const MCP_CANCELLATION_CONTRACT = 'kiokuko/mcp-cancellation@1';
export const MAX_MCP_CANCELLATION_RECEIPTS = 128;

interface CancellationReceipt {
  receiptId: string;
  operation: 'task_answer' | 'task_memory_refresh';
  requestHash: string;
  transportRequestHash: string;
  source: 'mcp_sdk_signal';
  abortReceivedAt: string | null;
  handlerSettledAt: string | null;
  handlerSettled: boolean;
}

interface TrackedRequest {
  receipt: CancellationReceipt;
  scope?: { runId: string; repositoryRoot: string };
}

export interface McpCancellationObservation extends McpDeadlineObservation {
  bind(runId: string, repositoryRoot: string): void;
}

/** Connection-local diagnostics, written only by the SDK signal/deadline owner.
 * Never retain arguments, abort reasons, or claim that settling means success.
 */
export class McpCancellationJournal {
  readonly #instanceId = randomUUID();
  readonly #requests = new Map<string, TrackedRequest>();
  #dropped = 0;

  begin(operation: CancellationReceipt['operation'], transportRequestId: string | number, requestHash: string): McpCancellationObservation {
    if (this.#requests.size >= MAX_MCP_CANCELLATION_RECEIPTS) {
      const disposable = [...this.#requests].find(([, request]) => request.receipt.handlerSettled);
      if (disposable) this.#requests.delete(disposable[0]);
      this.#dropped++;
    }
    if (this.#requests.size >= MAX_MCP_CANCELLATION_RECEIPTS) {
      return { bind() {}, callerAborted() {}, operationSettled() {} };
    }
    const receiptId = randomUUID();
    const request: TrackedRequest = { receipt: {
      receiptId, operation, requestHash,
      transportRequestHash: createHash('sha256').update(JSON.stringify(transportRequestId)).digest('hex'),
      source: 'mcp_sdk_signal', abortReceivedAt: null, handlerSettledAt: null, handlerSettled: false,
    } };
    this.#requests.set(receiptId, request);
    return {
      bind: (runId, repositoryRoot) => { request.scope = { runId, repositoryRoot }; },
      callerAborted: () => { request.receipt.abortReceivedAt ??= new Date().toISOString(); },
      operationSettled: () => {
        if (request.receipt.handlerSettled) return;
        request.receipt.handlerSettled = true;
        request.receipt.handlerSettledAt = new Date().toISOString();
        if (request.receipt.abortReceivedAt === null || !request.scope) this.#requests.delete(receiptId);
      },
    };
  }

  read(runId: string, repositoryRoot: string) {
    return {
      contract: MCP_CANCELLATION_CONTRACT,
      provenance: 'server_observed' as const,
      serverInstanceId: this.#instanceId,
      processId: process.pid,
      loadedPackageVersion: PACKAGE_VERSION,
      retention: 'connection_local' as const,
      droppedReceipts: this.#dropped,
      receipts: [...this.#requests.values()]
        .filter(request => request.scope?.runId === runId && request.scope.repositoryRoot === repositoryRoot
          && request.receipt.abortReceivedAt !== null)
        .map(request => ({ ...request.receipt })),
    };
  }
}
