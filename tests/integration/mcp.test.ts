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
    assert.deepEqual(tools.tools.map((tool) => tool.name).sort(), ['curator_check', 'curator_globalize', 'memory_checkpoint', 'memory_recall', 'task_answer', 'task_prepare']);
    assert.equal(tools.tools.find((tool) => tool.name === 'memory_recall')?.annotations?.readOnlyHint, true);
    assert.equal(tools.tools.find((tool) => tool.name === 'curator_check')?.annotations?.readOnlyHint, true);
    assert.equal(tools.tools.find((tool) => tool.name === 'task_prepare')?.annotations?.idempotentHint, false);
    assert.equal(tools.tools.find((tool) => tool.name === 'memory_checkpoint')?.annotations?.idempotentHint, true);
    assert.match(tools.tools.find((tool) => tool.name === 'task_prepare')?.description ?? '', /once for the current user request/);
    assert.match(tools.tools.find((tool) => tool.name === 'memory_checkpoint')?.description ?? '', /call no more tools/);
    const globalizeSchema = tools.tools.find((tool) => tool.name === 'curator_globalize')?.inputSchema as { properties?: { confirmed?: { const?: unknown } }; required?: string[] };
    assert.equal(globalizeSchema.properties?.confirmed?.const, true);
    assert.ok(globalizeSchema.required?.includes('confirmed'));

    const checkpoint = await client.callTool({
      name: 'memory_checkpoint',
      arguments: {
        memories: [{ kind: 'lesson', title: 'Implement the durable beacon and add tests', body: 'Use the MCP durable-beacon contract.' }],
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
    assert.equal(recallContent.project.memory.items[0]?.title, 'Implement the durable beacon and add tests');
    assert.equal(recallContent.project.memory.items[0]?.metadata.untrusted, true);

    const prepared = await client.callTool({
      name: 'task_prepare',
      arguments: {
        task: 'Implement the durable beacon and add tests',
        profileHints: {
          taskType: 'build',
          target: 'src/beacon.ts',
          expected: 'The durable beacon tests pass',
        },
        capabilities: [
          { kind: 'skill', name: 'tdd', description: 'Implement changes test first' },
          { kind: 'mcp_tool', name: 'github_search_code', description: 'Search repository code for durable beacon implementations' },
        ],
      },
    });
    const preparedContent = prepared.structuredContent as {
      intake: { status: string; sessionId: string; reasoning: { stage: string; selectedAction: string; silo: { completeness: number } } };
      memory: { project: { memory: { items: Array<{ metadata: { untrusted: boolean } }> } } };
      capabilities: { recommendations: Array<{ kind: string; name: string; availability: string }> };
      nextAction: string;
    };
    assert.equal(preparedContent.intake.status, 'ready');
    assert.equal(preparedContent.intake.reasoning.stage, 'actionable');
    assert.match(preparedContent.intake.reasoning.selectedAction, /src\/beacon\.ts/u);
    assert.equal(preparedContent.intake.reasoning.silo.completeness, 1);
    assert.equal(preparedContent.nextAction, 'proceed');
    assert.equal(preparedContent.memory.project.memory.items[0]?.metadata.untrusted, true);
    assert.ok(preparedContent.capabilities.recommendations.some((item) => item.kind === 'skill' && item.name === 'tdd' && item.availability === 'available'));
    assert.ok(preparedContent.capabilities.recommendations.some((item) => item.kind === 'mcp_tool' && item.name === 'github_search_code' && item.availability === 'available'));

    const incomplete = await client.callTool({
      name: 'task_prepare',
      arguments: {
        task: 'Implement the durable beacon',
        profileHints: { taskType: 'build' },
      },
    });
    const incompleteContent = incomplete.structuredContent as { intake: { status: string; sessionId: string; question: { id: string } }; memory: unknown; nextAction: string };
    assert.equal(incompleteContent.intake.status, 'needs_answer');
    assert.equal(incompleteContent.intake.question.id, 'target');
    assert.equal(incompleteContent.memory, null);
    assert.equal(incompleteContent.nextAction, 'answer_from_evidence_or_ask_user');

    const targetAnswered = await client.callTool({
      name: 'task_answer',
      arguments: {
        sessionId: incompleteContent.intake.sessionId,
        questionId: 'target',
        value: 'src/beacon.ts',
      },
    });
    const targetContent = targetAnswered.structuredContent as { intake: { status: string; question: { id: string } } };
    assert.equal(targetContent.intake.status, 'needs_answer');
    assert.equal(targetContent.intake.question.id, 'expected');

    const completed = await client.callTool({
      name: 'task_answer',
      arguments: {
        sessionId: incompleteContent.intake.sessionId,
        questionId: 'expected',
        value: 'The durable beacon tests pass',
      },
    });
    const completedContent = completed.structuredContent as { intake: { status: string }; nextAction: string };
    assert.equal(completedContent.intake.status, 'ready');
    assert.equal(completedContent.nextAction, 'proceed');
  } finally {
    await client.close();
    if (server.isConnected()) await server.close();
  }
});
