import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import test from 'node:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createKiokukoMcpServer } from '../../src/mcp/server.js';
import { BoundedStdioServerTransport } from '../../src/mcp/bounded-stdio-transport.js';
import { openConnection } from '../../src/db/connection.js';
import { MAX_RAW_CAPABILITY_CATALOG_CODE_POINTS, MAX_RAW_CAPABILITY_DESCRIPTION_CHARS } from '../../src/akinator/capabilities.js';

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

test('task_prepare degrades safely for oversized and malformed capability items', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'kiokuko-mcp-capability-repo-'));
  execFileSync('git', ['init', '-q', root]);
  const data = await mkdtemp(path.join(tmpdir(), 'kiokuko-mcp-capability-data-'));
  const databasePath = path.join(data, 'kiokuko.sqlite3');
  const server = createKiokukoMcpServer({ databasePath, cwd: () => root });
  const client = new Client({ name: 'kiokuko-capability-test', version: '1.0.0' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  try {
    await client.callTool({
      name: 'memory_checkpoint',
      arguments: { memories: [{ kind: 'lesson', title: 'Oversized catalog beacon', body: 'Keep capability handling bounded and ephemeral.' }] },
    });
    const sentinel = 'capability-secret-sentinel-private-path';
    const oversizedCapabilities = [
      { kind: 'skill', name: 'tdd', description: `${sentinel}${'x'.repeat(64_001)}` },
      { kind: 'mcp_tool', name: 'repository_search', description: `${sentinel}${'y'.repeat(64_001)}` },
      { kind: 'invalid', name: 'discarded' },
    ];
    const result = await client.callTool({
      name: 'task_prepare',
      arguments: {
        task: 'Implement the oversized catalog beacon and add tests',
        profileHints: { taskType: 'build', target: 'src/beacon.ts', expected: 'The tests pass' },
        capabilities: oversizedCapabilities,
      },
    });
    assert.equal(result.isError, undefined);
    const content = result.structuredContent as {
      memory: unknown;
      run: { runId: string };
      context: { policyVersion: string; deliveryId: string };
      capabilities: {
        availability: string;
        diagnostics: { received: number; accepted: number; truncated: number; dropped: number };
        externalSkillFallback: { eligible: boolean };
        recommendations: Array<{ name: string; availability: string }>;
        warnings: Array<{ message: string }>;
      };
      warnings: Array<{ message: string }>;
    };
    assert.ok(content.memory);
    assert.equal(content.capabilities.availability, 'known-nonempty');
    assert.deepEqual(content.capabilities.diagnostics, { received: 3, accepted: 2, truncated: 2, dropped: 1 });
    assert.equal(content.capabilities.externalSkillFallback.eligible, false);
    assert.ok(content.capabilities.recommendations.some((item) => item.name === 'tdd' && item.availability === 'available'));
    assert.equal(content.capabilities.warnings.length, 2);
    assert.deepEqual(content.warnings, content.capabilities.warnings);
    assert.match(JSON.stringify(content), /CAPABILITY_CATALOG_COMPACTED|shortened|omitted/u);
    assert.equal(JSON.stringify(content).includes(sentinel), false);
    assert.equal(content.context.policyVersion, 'context-ranking-v3');

    const exactBoundary = await client.callTool({
      name: 'task_prepare',
      arguments: {
        task: 'Implement the oversized catalog beacon and add tests',
        profileHints: { taskType: 'build', target: 'src/beacon.ts', expected: 'The tests pass' },
        capabilities: Array.from({ length: 200 }, (_, index) => ({ kind: 'mcp_tool', name: `tool-${index}` })),
      },
    });
    assert.deepEqual(
      (exactBoundary.structuredContent as { capabilities: { diagnostics: unknown } }).capabilities.diagnostics,
      { received: 200, accepted: 200, truncated: 0, dropped: 0 },
    );

    const boundary = await client.callTool({
      name: 'task_prepare',
      arguments: {
        task: 'Implement the oversized catalog beacon and add tests',
        profileHints: { taskType: 'build', target: 'src/beacon.ts', expected: 'The tests pass' },
        capabilities: Array.from({ length: 201 }, (_, index) => ({ kind: 'mcp_tool', name: `tool-${index}` })),
      },
    });
    const boundaryContent = boundary.structuredContent as { run: { runId: string }; capabilities: { diagnostics: unknown } };
    assert.equal(boundaryContent.run.runId, content.run.runId);
    assert.deepEqual(boundaryContent.capabilities.diagnostics, { received: 201, accepted: 200, truncated: 0, dropped: 1 });

    const finalExactDescription = MAX_RAW_CAPABILITY_CATALOG_CODE_POINTS
      - (7 * MAX_RAW_CAPABILITY_DESCRIPTION_CHARS)
      - 8;
    const budgetCapabilities = [
      ...Array.from({ length: 7 }, () => ({ kind: 'mcp_tool', name: 'x', description: 'a'.repeat(MAX_RAW_CAPABILITY_DESCRIPTION_CHARS) })),
      { kind: 'skill', name: 'y', description: 'b'.repeat(finalExactDescription + 1) },
    ];
    const budget = await client.callTool({
      name: 'task_prepare',
      arguments: {
        task: 'Implement the oversized catalog beacon and add tests',
        profileHints: { taskType: 'build', target: 'src/beacon.ts', expected: 'The tests pass' },
        capabilities: budgetCapabilities,
      },
    });
    const budgetContent = budget.structuredContent as { capabilities: { availability: string; diagnostics: unknown; warnings: Array<{ code: string }> } };
    assert.equal(budgetContent.capabilities.availability, 'known-nonempty');
    assert.deepEqual(budgetContent.capabilities.diagnostics, { received: 8, accepted: 8, truncated: 8, dropped: 0 });
    assert.ok(budgetContent.capabilities.warnings.some((warning) => warning.code === 'CAPABILITY_CATALOG_BUDGET_EXCEEDED'));

    const incomplete = await client.callTool({
      name: 'task_prepare',
      arguments: { task: 'Implement the oversized catalog beacon', profileHints: { taskType: 'build' }, capabilities: oversizedCapabilities },
    });
    const incompleteContent = incomplete.structuredContent as { intake: { sessionId: string; question: { id: string } }; run: { runId: string } };
    const target = await client.callTool({
      name: 'task_answer',
      arguments: {
        sessionId: incompleteContent.intake.sessionId,
        runId: incompleteContent.run.runId,
        questionId: 'target',
        value: 'src/beacon.ts',
        capabilities: oversizedCapabilities,
      },
    });
    assert.equal((target.structuredContent as { intake: { question: { id: string } } }).intake.question.id, 'expected');
    const answered = await client.callTool({
      name: 'task_answer',
      arguments: {
        sessionId: incompleteContent.intake.sessionId,
        runId: incompleteContent.run.runId,
        questionId: 'expected',
        value: 'The tests pass',
        capabilities: oversizedCapabilities,
      },
    });
    assert.equal((answered.structuredContent as { intake: { status: string }; capabilities: { availability: string } }).intake.status, 'ready');
    assert.equal((answered.structuredContent as { capabilities: { availability: string } }).capabilities.availability, 'known-nonempty');

    const fallbackBase = {
      task: 'Implement the oversized catalog beacon and add tests',
      profileHints: { taskType: 'build', target: 'src/beacon.ts', expected: 'The tests pass' },
    };
    const explicitEmpty = await client.callTool({ name: 'task_prepare', arguments: { ...fallbackBase, capabilities: [] } });
    const omitted = await client.callTool({ name: 'task_prepare', arguments: fallbackBase });
    const whollyInvalid = await client.callTool({ name: 'task_prepare', arguments: { ...fallbackBase, capabilities: [{ kind: 'invalid', name: 'invalid' }] } });
    assert.equal((explicitEmpty.structuredContent as { capabilities: { externalSkillFallback: { eligible: boolean } } }).capabilities.externalSkillFallback.eligible, true);
    assert.equal((omitted.structuredContent as { capabilities: { externalSkillFallback: { eligible: boolean } } }).capabilities.externalSkillFallback.eligible, false);
    assert.equal((whollyInvalid.structuredContent as { capabilities: { availability: string; externalSkillFallback: { eligible: boolean } } }).capabilities.availability, 'known-nonempty');
    assert.equal((whollyInvalid.structuredContent as { capabilities: { externalSkillFallback: { eligible: boolean } } }).capabilities.externalSkillFallback.eligible, false);

    const database = openConnection(databasePath);
    try {
      const persisted = JSON.stringify({
        runs: database.prepare('SELECT * FROM ledger_runs').all(),
        sessions: database.prepare('SELECT * FROM akinator_sessions').all(),
        events: database.prepare('SELECT * FROM ledger_events').all(),
        deliveries: database.prepare('SELECT * FROM context_deliveries').all(),
      });
      assert.equal(persisted.includes(sentinel), false);
      assert.equal(database.prepare('SELECT policy_version FROM context_deliveries WHERE delivery_id = ?').get<{ policy_version: string }>(content.context.deliveryId)?.policy_version, 'context-ranking-v3');
      const storedReasons = database.prepare(`
        SELECT selection_reason_json
          FROM context_delivery_entries
         WHERE delivery_id = ?
         ORDER BY rank ASC
         LIMIT 1
      `).get<{ selection_reason_json: string }>(content.context.deliveryId);
      assert.ok(storedReasons);
      const parsedReasons = JSON.parse(storedReasons.selection_reason_json) as string[];
      assert.ok(parsedReasons.some((reason) => ['word_match', 'lexical_match', 'substring_match', 'literal_fallback_match', 'tag_match'].includes(reason)));
    } finally {
      database.close();
    }
  } finally {
    await client.close();
    if (server.isConnected()) await server.close();
  }
});

test('stdio framing rejects an oversized envelope before parsing and accepts the next message', async () => {
  const input = new PassThrough();
  const output = new PassThrough();
  const transport = new BoundedStdioServerTransport(input, output, 256);
  const messages: unknown[] = [];
  const errors: Error[] = [];
  let written = '';
  transport.onmessage = (message) => messages.push(message);
  transport.onerror = (error) => errors.push(error);
  output.on('data', (chunk: Buffer) => { written += chunk.toString('utf8'); });
  await transport.start();
  try {
    const sentinel = 'transport-secret-sentinel';
    input.write(`{"jsonrpc":"2.0","id":1,"method":"tools/list","params":{"value":"${sentinel}${'x'.repeat(400)}`);
    input.write('"}}\n');
    input.write('{"jsonrpc":"2.0","method":"notifications/initialized"}\n');
    await new Promise<void>((resolve) => setImmediate(resolve));

    const responses = written.trim().split('\n').filter(Boolean).map((line) => JSON.parse(line) as Record<string, unknown>);
    assert.equal(responses.length, 1);
    assert.deepEqual(responses[0], {
      jsonrpc: '2.0',
      error: { code: -32000, message: 'JSON-RPC message exceeds the configured transport limit.' },
    });
    assert.equal(written.includes(sentinel), false);
    assert.equal(errors.length, 0);
    assert.deepEqual(messages, [{ jsonrpc: '2.0', method: 'notifications/initialized' }]);
  } finally {
    await transport.close();
  }
});
