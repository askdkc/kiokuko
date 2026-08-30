import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import test from 'node:test';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import {
  BoundedStdioServerTransport,
  MAX_MCP_REQUEST_TIMEOUT_MS,
  MIN_MCP_REQUEST_TIMEOUT_MS,
} from '../../src/mcp/bounded-stdio-transport.js';

type JsonRpcMessage = Record<string, unknown>;

function collectJsonLines(stream: PassThrough): JsonRpcMessage[] {
  const messages: JsonRpcMessage[] = [];
  let buffered = '';
  stream.on('data', (chunk: Buffer) => {
    buffered += chunk.toString('utf8');
    for (;;) {
      const newline = buffered.indexOf('\n');
      if (newline === -1) return;
      const line = buffered.slice(0, newline);
      buffered = buffered.slice(newline + 1);
      if (line.length > 0) messages.push(JSON.parse(line) as JsonRpcMessage);
    }
  });
  return messages;
}

async function waitFor(predicate: () => boolean, label: string): Promise<void> {
  const deadline = Date.now() + 1_000;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error(`Timed out waiting for ${label}`);
    await new Promise<void>((resolve) => setTimeout(resolve, 5));
  }
}

test('stdio request deadline aborts the MCP handler, returns RequestTimeout, and keeps the connection usable', async () => {
  const input = new PassThrough();
  const output = new PassThrough();
  const transport = new BoundedStdioServerTransport(input, output, 8 * 1024, 30);
  const responses = collectJsonLines(output);
  const server = new McpServer({ name: 'deadline-test', version: '1.0.0' });
  let aborted = false;

  server.registerTool('hang', { inputSchema: {} }, async (_args, extra) => new Promise((resolve, reject) => {
    extra.signal.addEventListener('abort', () => {
      aborted = true;
      reject(extra.signal.reason);
    }, { once: true });
  }));
  server.registerTool('healthy', { inputSchema: {} }, async () => ({
    content: [{ type: 'text', text: 'ok' }],
  }));

  await server.connect(transport);
  try {
    const sentinel = 'request-timeout-secret-must-not-leak';
    input.write(`{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"hang","arguments":{"value":"${sentinel}"}}}\n`);
    await waitFor(() => responses.some((message) => message.id === 1), 'deadline response');

    assert.equal(aborted, true);
    assert.deepEqual(responses.find((message) => message.id === 1), {
      jsonrpc: '2.0',
      id: 1,
      error: {
        code: -32001,
        message: 'MCP request exceeded the server deadline.',
        data: { timeoutMs: 30, cancelled: true },
      },
    });
    assert.equal(JSON.stringify(responses).includes(sentinel), false);

    input.write('{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"healthy","arguments":{}}}\n');
    await waitFor(() => responses.some((message) => message.id === 2), 'healthy response after timeout');
    assert.deepEqual(responses.find((message) => message.id === 2), {
      jsonrpc: '2.0',
      id: 2,
      result: { content: [{ type: 'text', text: 'ok' }] },
    });
    await new Promise<void>((resolve) => setTimeout(resolve, 40));
    assert.equal(responses.filter((message) => message.id === 2).length, 1);
  } finally {
    if (server.isConnected()) await server.close();
  }
});

test('stdio request deadline rejects unsafe timeout bounds', () => {
  const input = new PassThrough();
  const output = new PassThrough();
  assert.throws(
    () => new BoundedStdioServerTransport(input, output, 8 * 1024, MIN_MCP_REQUEST_TIMEOUT_MS - 1),
    /request timeout/u,
  );
  assert.throws(
    () => new BoundedStdioServerTransport(input, output, 8 * 1024, MAX_MCP_REQUEST_TIMEOUT_MS + 1),
    /request timeout/u,
  );
});

test('stdio input end closes the transport exactly once', async () => {
  const input = new PassThrough();
  const output = new PassThrough();
  const transport = new BoundedStdioServerTransport(input, output);
  let closes = 0;
  transport.onclose = () => { closes += 1; };
  await transport.start();
  input.end();
  await waitFor(() => closes === 1, 'stdio transport close');
  await transport.close();
  assert.equal(closes, 1);
});
