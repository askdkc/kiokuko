import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createKiokukoMcpServer } from '../../src/mcp/server.js';

test('MCP exposes high-level recall/checkpoint tools and persists candidate memory', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'kiokuko-mcp-repo-'));
  execFileSync('git', ['init', '-q', root]);
  const data = await mkdtemp(path.join(tmpdir(), 'kiokuko-mcp-data-'));
  const databasePath = path.join(data, 'kiokuko.sqlite3');
  const server = createKiokukoMcpServer({ databasePath, cwd: () => root });
  const client = new Client({ name: 'kiokuko-test', version: '1.0.0' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  try {
    const tools = await client.listTools();
    assert.deepEqual(tools.tools.map((tool) => tool.name).sort(), ['memory_checkpoint', 'memory_recall']);
    assert.equal(tools.tools.find((tool) => tool.name === 'memory_recall')?.annotations?.readOnlyHint, true);

    const checkpoint = await client.callTool({
      name: 'memory_checkpoint',
      arguments: {
        memories: [{ kind: 'lesson', title: 'MCP durable beacon', body: 'Use the MCP durable-beacon contract.' }],
      },
    });
    assert.equal(checkpoint.isError, undefined);
    const checkpointContent = checkpoint.structuredContent as { entries: Array<{ status: string; workspace: string }> };
    assert.equal(checkpointContent.entries[0]?.status, 'candidate');
    assert.match(checkpointContent.entries[0]?.workspace ?? '', /^project:/);

    const recalled = await client.callTool({
      name: 'memory_recall',
      arguments: { query: 'durable beacon' },
    });
    const recallContent = recalled.structuredContent as { project: { memory: { items: Array<{ title: string; metadata: { untrusted: boolean } }> } } };
    assert.equal(recallContent.project.memory.items[0]?.title, 'MCP durable beacon');
    assert.equal(recallContent.project.memory.items[0]?.metadata.untrusted, true);
  } finally {
    await client.close();
    if (server.isConnected()) await server.close();
  }
});
