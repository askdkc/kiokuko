// Synthetic model host; tool schemas and results come from the real Kiokuko MCP server.
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const root = fileURLToPath(new URL('../../', import.meta.url));
const client = new Client({ name: 'kiokuko-agenticreplay-smoke', version: '1' });
const transport = new StdioClientTransport({
  command: process.execPath,
  args: [path.join(root, 'dist/bin/kiokuko.js'), 'mcp'],
  env: {
    PATH: process.env.PATH,
    XDG_CONFIG_HOME: process.env.XDG_CONFIG_HOME,
    KIOKUKO_DATA_DIR: path.join(process.cwd(), 'memory'),
    KIOKUKO_EMBEDDINGS: 'off',
    KIOKUKO_RERANKER_MODE: 'off',
    KIOKUKO_SKILL_DISCOVERY: 'off',
    KIOKUKO_HANDOFF: 'off',
    KIOKUKO_INTERACTION_MEMORY: 'off',
  },
  stderr: 'pipe',
});

async function complete(messages, tools) {
  assert.ok(process.env.OPENAI_BASE_URL, 'Record this host through AgenticReplay');
  const response = await fetch(`${process.env.OPENAI_BASE_URL}/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ model: 'kiokuko-smoke', messages, tools }),
    signal: AbortSignal.timeout(15_000),
  });
  assert.equal(response.status, 200);
  return (await response.json()).choices[0].message;
}

try {
  await client.connect(transport);
  const { tools: available } = await client.listTools();
  const tool = available.find(({ name }) => name === 'task_inspect');
  assert.ok(tool);
  const tools = [{ type: 'function', function: {
    name: tool.name, description: tool.description, parameters: tool.inputSchema,
  } }];
  const messages = [{ role: 'user', content: 'Read the Kiokuko SOUL skill.' }];
  const assistant = await complete(messages, tools);
  const call = assistant.tool_calls[0];
  assert.equal(call.function.name, 'task_inspect');
  const result = await client.callTool({ name: call.function.name,
    arguments: JSON.parse(call.function.arguments) }, undefined, { timeout: 15_000 });
  assert.notEqual(result.isError, true);
  assert.equal(result.structuredContent.contract.id, 'kiokuko/model-managed');
  assert.match(result.structuredContent.text, /# Kiokuko SOUL router/u);
  messages.push(assistant, { role: 'tool', tool_call_id: call.id, content: JSON.stringify(result) });
  assert.equal((await complete(messages, tools)).content, 'Kiokuko skill read.');
} finally {
  await client.close();
}
