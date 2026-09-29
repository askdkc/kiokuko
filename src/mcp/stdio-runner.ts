import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { BoundedStdioServerTransport } from './bounded-stdio-transport.js';

/** Bounded stdio with owner cleanup on EOF, signal and connection failure. */
export async function runStdioServer(server: Pick<McpServer, 'connect' | 'close'>, owner: { close(): void | Promise<void> }): Promise<void> {
  const transport = new BoundedStdioServerTransport();
  let resolveClosed!: () => void;
  let rejectClosed!: (error: unknown) => void;
  const closed = new Promise<void>((resolve, reject) => { resolveClosed = resolve; rejectClosed = reject; });
  transport.onclose = resolveClosed;
  const stop = () => { void server.close().catch(rejectClosed); };
  process.once('SIGTERM', stop);
  process.once('SIGINT', stop);
  const errors: unknown[] = [];
  try {
    await server.connect(transport);
    await closed;
  } catch (error) {
    errors.push(error);
  } finally {
    process.off('SIGTERM', stop);
    process.off('SIGINT', stop);
    try { await server.close(); } catch (error) { errors.push(error); }
    try { await owner.close(); } catch (error) { errors.push(error); }
  }
  if (errors.length === 1) throw errors[0];
  if (errors.length > 1) throw new AggregateError(errors, 'MCP stdio execution and cleanup failed');
}
