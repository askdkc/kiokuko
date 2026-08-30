import process from 'node:process';
import type { Readable, Writable } from 'node:stream';
import { ErrorCode, type JSONRPCMessage, type RequestId } from '@modelcontextprotocol/sdk/types.js';
import type { Transport, TransportSendOptions } from '@modelcontextprotocol/sdk/shared/transport.js';
import { deserializeMessage, serializeMessage } from '@modelcontextprotocol/sdk/shared/stdio.js';

export const MAX_STDIO_JSON_RPC_MESSAGE_BYTES = 8 * 1024 * 1024;
export const DEFAULT_MCP_REQUEST_TIMEOUT_MS = 55_000;
export const MIN_MCP_REQUEST_TIMEOUT_MS = 10;
export const MAX_MCP_REQUEST_TIMEOUT_MS = 5 * 60 * 1_000;

const MESSAGE_TOO_LARGE = Object.freeze({
  jsonrpc: '2.0' as const,
  error: {
    code: -32000,
    message: 'JSON-RPC message exceeds the configured transport limit.',
  },
});

function requestIdOf(message: JSONRPCMessage): RequestId | undefined {
  if (!('id' in message)) return undefined;
  return typeof message.id === 'string' || typeof message.id === 'number' ? message.id : undefined;
}

function isRequest(message: JSONRPCMessage): boolean {
  return 'method' in message && requestIdOf(message) !== undefined;
}

function isResponse(message: JSONRPCMessage): boolean {
  return !('method' in message) && requestIdOf(message) !== undefined;
}

function cancelledRequestId(message: JSONRPCMessage): RequestId | undefined {
  if (!('method' in message) || message.method !== 'notifications/cancelled' || !('params' in message)) return undefined;
  const params = message.params;
  if (typeof params !== 'object' || params === null || !('requestId' in params)) return undefined;
  return typeof params.requestId === 'string' || typeof params.requestId === 'number' ? params.requestId : undefined;
}

export class BoundedStdioServerTransport implements Transport {
  onclose?: () => void;
  onerror?: (error: Error) => void;
  onmessage?: <T extends JSONRPCMessage>(message: T) => void;

  private buffer: Buffer | undefined;
  private discardingOversizedLine = false;
  private readonly requestDeadlines = new Map<RequestId, ReturnType<typeof setTimeout>>();
  private started = false;
  private closed = false;

  constructor(
    private readonly input: Readable = process.stdin,
    private readonly output: Writable = process.stdout,
    private readonly maxMessageBytes = MAX_STDIO_JSON_RPC_MESSAGE_BYTES,
    private readonly requestTimeoutMs = DEFAULT_MCP_REQUEST_TIMEOUT_MS,
  ) {
    if (!Number.isSafeInteger(maxMessageBytes) || maxMessageBytes < 1) {
      throw new Error('Stdio message limit must be a positive integer');
    }
    if (!Number.isSafeInteger(requestTimeoutMs)
      || requestTimeoutMs < MIN_MCP_REQUEST_TIMEOUT_MS
      || requestTimeoutMs > MAX_MCP_REQUEST_TIMEOUT_MS) {
      throw new Error(`MCP request timeout must be an integer between ${MIN_MCP_REQUEST_TIMEOUT_MS} and ${MAX_MCP_REQUEST_TIMEOUT_MS} milliseconds`);
    }
  }

  private clearRequestDeadline(requestId: RequestId): void {
    const deadline = this.requestDeadlines.get(requestId);
    if (deadline === undefined) return;
    clearTimeout(deadline);
    this.requestDeadlines.delete(requestId);
  }

  private startRequestDeadline(requestId: RequestId): void {
    this.clearRequestDeadline(requestId);
    const deadline = setTimeout(() => {
      if (!this.requestDeadlines.delete(requestId)) return;
      try {
        this.onmessage?.({
          jsonrpc: '2.0',
          method: 'notifications/cancelled',
          params: { requestId, reason: 'Server request deadline exceeded' },
        });
      } catch (error) {
        this.onerror?.(error instanceof Error ? error : new Error('Failed to cancel timed out MCP request'));
      }
      void this.send({
        jsonrpc: '2.0',
        id: requestId,
        error: {
          code: ErrorCode.RequestTimeout,
          message: 'MCP request exceeded the server deadline.',
          data: { timeoutMs: this.requestTimeoutMs, cancelled: true },
        },
      }).catch((error: unknown) => {
        this.onerror?.(error instanceof Error ? error : new Error('Failed to write MCP request timeout'));
      });
    }, this.requestTimeoutMs);
    this.requestDeadlines.set(requestId, deadline);
  }

  private trackIncomingMessage(message: JSONRPCMessage): void {
    const cancelledId = cancelledRequestId(message);
    if (cancelledId !== undefined) {
      this.clearRequestDeadline(cancelledId);
      return;
    }
    if (!isRequest(message)) return;
    const requestId = requestIdOf(message);
    if (requestId !== undefined) this.startRequestDeadline(requestId);
  }

  private readonly onData = (value: Buffer | string): void => {
    const chunk = Buffer.isBuffer(value) ? value : Buffer.from(value);
    let offset = 0;
    while (offset < chunk.length) {
      if (this.discardingOversizedLine) {
        const newline = chunk.indexOf(0x0a, offset);
        if (newline === -1) return;
        this.discardingOversizedLine = false;
        offset = newline + 1;
        continue;
      }

      const newline = chunk.indexOf(0x0a, offset);
      const end = newline === -1 ? chunk.length : newline;
      const segment = chunk.subarray(offset, end);
      const bufferedBytes = this.buffer?.length ?? 0;
      if (bufferedBytes + segment.length > this.maxMessageBytes) {
        this.buffer = undefined;
        this.writeOversizedMessageError();
        if (newline === -1) {
          this.discardingOversizedLine = true;
          return;
        }
      } else if (newline === -1) {
        this.buffer = this.buffer === undefined ? Buffer.from(segment) : Buffer.concat([this.buffer, segment]);
        return;
      } else {
        const line = this.buffer === undefined ? segment : Buffer.concat([this.buffer, segment]);
        this.buffer = undefined;
        try {
          const text = line.toString('utf8').replace(/\r$/u, '');
          const message = deserializeMessage(text);
          this.trackIncomingMessage(message);
          this.onmessage?.(message);
        } catch (error) {
          this.onerror?.(error instanceof Error ? error : new Error('Invalid JSON-RPC stdio message'));
        }
      }
      offset = newline + 1;
    }
  };

  private readonly onInputError = (error: Error): void => {
    this.onerror?.(error);
  };

  private readonly onInputEnd = (): void => {
    void this.close();
  };

  private writeOversizedMessageError(): void {
    void this.send(MESSAGE_TOO_LARGE).catch((error: unknown) => {
      this.onerror?.(error instanceof Error ? error : new Error('Failed to write JSON-RPC transport error'));
    });
  }

  async start(): Promise<void> {
    if (this.started || this.closed) throw new Error('BoundedStdioServerTransport cannot be started again');
    this.started = true;
    this.input.on('data', this.onData);
    this.input.on('error', this.onInputError);
    this.input.on('end', this.onInputEnd);
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.started = false;
    this.input.off('data', this.onData);
    this.input.off('error', this.onInputError);
    this.input.off('end', this.onInputEnd);
    if (this.input.listenerCount('data') === 0) this.input.pause();
    this.buffer = undefined;
    this.discardingOversizedLine = false;
    for (const deadline of this.requestDeadlines.values()) clearTimeout(deadline);
    this.requestDeadlines.clear();
    this.onclose?.();
  }

  send(message: JSONRPCMessage, _options?: TransportSendOptions): Promise<void> {
    if (isResponse(message)) {
      const requestId = requestIdOf(message);
      if (requestId !== undefined) this.clearRequestDeadline(requestId);
    }
    return new Promise((resolve, reject) => {
      try {
        if (this.output.write(serializeMessage(message))) resolve();
        else this.output.once('drain', resolve);
      } catch (error) {
        reject(error instanceof Error ? error : new Error('Failed to write JSON-RPC stdio message'));
      }
    });
  }
}
