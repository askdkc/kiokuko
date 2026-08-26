import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import test from 'node:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createKiokukoMcpServer } from '../../src/mcp/server.js';
import { BoundedStdioServerTransport } from '../../src/mcp/bounded-stdio-transport.js';
import { openConnection } from '../../src/db/connection.js';
import { migrateDatabase } from '../../src/db/migrate.js';
import { recordEntry } from '../../src/memory/entries.js';
import { buildStructuredScope } from '../../src/memory/structured-memory.js';
import { GLOBAL_WORKSPACE } from '../../src/memory/workspaces.js';
import { MAX_RAW_CAPABILITY_CATALOG_CODE_POINTS, MAX_RAW_CAPABILITY_DESCRIPTION_CHARS } from '../../src/akinator/capabilities.js';
import { KiokukoError } from '../../src/errors.js';
import { PACKAGE_VERSION } from '../../src/package-version.js';

function sqliteError(errcode: number, message = 'sqlite operation failed'): Error {
  return Object.assign(new Error(message), { code: 'ERR_SQLITE_ERROR', errcode });
}

test('MCP exposes only the gated task and lifecycle tools and persists candidate memory', async () => {
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
    assert.deepEqual(client.getServerVersion(), { name: 'kiokuko', version: PACKAGE_VERSION });
    const instructions = client.getInstructions() ?? '';
    assert.match(instructions, /Array<\{kind:'skill'\|'mcp_tool';name:string;description\?:string\}>/u);
    assert.match(instructions, /Every descriptor must include its kind and canonical name/u);
    assert.match(instructions, /memory-reasoning is missing or unknown.*nextAction remains proceed.*repository evidence/iu);
    assert.match(instructions, /read it before modifying code/);
    assert.match(instructions, /convert recalled claims that affect the task into verified premises, falsifiable invariants, concrete counterexamples, and regression tests/);
    assert.match(instructions, /executionContext\.repositoryRoot as the filesystem base/u);
    assert.match(instructions, /OpenCode filesystem tools, prefer canonical absolute paths under that root/u);
    const tools = await client.listTools();
    assert.deepEqual(tools.tools.map((tool) => tool.name).sort(), ['curator_check', 'curator_globalize', 'memory_checkpoint', 'task_answer', 'task_prepare']);
    assert.equal(tools.tools.find((tool) => tool.name === 'task_prepare')?.annotations?.idempotentHint, false);
    assert.equal(tools.tools.find((tool) => tool.name === 'task_answer')?.annotations?.idempotentHint, false);
    assert.equal(tools.tools.find((tool) => tool.name === 'curator_check')?.annotations?.readOnlyHint, false);
    assert.equal(tools.tools.find((tool) => tool.name === 'curator_check')?.annotations?.idempotentHint, false);
    assert.equal(tools.tools.find((tool) => tool.name === 'curator_globalize')?.annotations?.idempotentHint, true);
    assert.match(tools.tools.find((tool) => tool.name === 'curator_globalize')?.description ?? '', /stored as verified\/system_verified memory created by kiokuko-curator/);
    assert.equal(tools.tools.find((tool) => tool.name === 'memory_checkpoint')?.annotations?.idempotentHint, false);
    const taskPrepareTool = tools.tools.find((tool) => tool.name === 'task_prepare');
    const taskAnswerTool = tools.tools.find((tool) => tool.name === 'task_answer');
    assert.match(taskPrepareTool?.description ?? '', /once for one logical user request/);
    assert.match(taskPrepareTool?.description ?? '', /create a new bounded opaque value for each logical request/);
    assert.match(taskPrepareTool?.description ?? '', /reuse it only for an exact transport retry/);
    assert.match(taskPrepareTool?.description ?? '', /Reusing an ID with changed bound input is a conflict/);
    assert.match(taskPrepareTool?.description ?? '', /Inspect the returned nextAction before proceeding/);
    assert.match(taskPrepareTool?.description ?? '', /memory-reasoning is missing or unknown.*nextAction remains proceed.*repository evidence/iu);
    assert.match(taskPrepareTool?.description ?? '', /created by kiokuko-curator and matching the current deterministic Curator projection is system-verified/);
    assert.match(taskPrepareTool?.description ?? '', /repairing Kiokuko itself.*fails before returning scoped context.*repository evidence/iu);
    assert.match(taskPrepareTool?.description ?? '', /Array<\{kind:'skill'\|'mcp_tool';name:string;description\?:string\}>/u);
    assert.match(taskPrepareTool?.description ?? '', /read that Skill before consuming applicable memory and convert recalled claims that affect the task into verified premises, falsifiable invariants, concrete counterexamples, and regression tests/);
    assert.match(taskPrepareTool?.description ?? '', /successful task_prepare or task_answer response includes executionContext/u);
    assert.match(taskPrepareTool?.description ?? '', /never use ~, \$HOME, or HOME-relative path fragments/u);
    assert.match(taskAnswerTool?.description ?? '', /required run ID returned by task_prepare/);
    assert.match(taskAnswerTool?.description ?? '', /Repeat the same capability catalog and context budget/);
    assert.match(taskAnswerTool?.description ?? '', /changed context budget conflicts before intake mutation/);
    assert.match(taskAnswerTool?.description ?? '', /inspect the returned nextAction before proceeding/);
    assert.match(taskAnswerTool?.description ?? '', /memory-reasoning is missing or unknown.*nextAction remains proceed.*repository evidence/iu);
    assert.match(taskAnswerTool?.description ?? '', /created by kiokuko-curator and matching the current deterministic Curator projection is system-verified/);
    assert.match(taskAnswerTool?.description ?? '', /Array<\{kind:'skill'\|'mcp_tool';name:string;description\?:string\}>/u);
    assert.match(taskAnswerTool?.description ?? '', /read that Skill before consuming applicable memory and convert recalled claims that affect the task into verified premises, falsifiable invariants, concrete counterexamples, and regression tests/);
    assert.match(taskAnswerTool?.description ?? '', /successful task_prepare or task_answer response includes executionContext/u);
    type JsonSchema = {
      type?: string;
      description?: string;
      additionalProperties?: boolean;
      properties?: Record<string, JsonSchema>;
      items?: JsonSchema;
      enum?: unknown[];
      maxItems?: number;
      required?: string[];
    };
    type ToolInputSchema = JsonSchema;
    const taskAnswerSchema = taskAnswerTool?.inputSchema as ToolInputSchema;
    const taskPrepareSchema = taskPrepareTool?.inputSchema as ToolInputSchema;
    assert.ok(taskPrepareSchema.required?.includes('requestId'));
    assert.ok(taskAnswerSchema.required?.includes('runId'));
    assert.match(taskAnswerSchema.properties?.value?.description ?? '', /Use the exact current question/);
    assert.match(taskAnswerSchema.properties?.value?.description ?? '', /value must be exactly one returned option/);
    assert.match(taskAnswerSchema.properties?.value?.description ?? '', /options is null, provide grounded non-empty text/);
    for (const schema of [taskPrepareSchema, taskAnswerSchema]) {
      assert.equal(schema.properties?.capabilities?.type, 'array');
      assert.match(
        schema.properties?.capabilities?.description ?? '',
        /Array<\{kind:'skill'\|'mcp_tool';name:string;description\?:string\}>/u,
      );
      assert.match(schema.properties?.capabilities?.description ?? '', /kind and canonical name/u);
    }
    assert.match(tools.tools.find((tool) => tool.name === 'memory_checkpoint')?.description ?? '', /call no more tools/);
    const checkpointTool = tools.tools.find((tool) => tool.name === 'memory_checkpoint');
    assert.match(checkpointTool?.description ?? '', /runId.*active/u);
    assert.match(checkpointTool?.description ?? '', /needs_answer/);
    assert.match(checkpointTool?.description ?? '', /answer_from_evidence_or_ask_user/);
    assert.match(checkpointTool?.description ?? '', /complete the required `task_answer` loop/);
    assert.match(checkpointTool?.description ?? '', /successful terminal checkpoint.*at most once/u);
    assert.match(checkpointTool?.description ?? '', /rejected precondition does not count as that successful checkpoint/u);
    assert.match(checkpointTool?.description ?? '', /indicated run-state change/);
    assert.doesNotMatch(checkpointTool?.description ?? '', /Call at most once per user request/u);
    const checkpointSchema = checkpointTool?.inputSchema as ToolInputSchema;
    assert.equal(checkpointSchema.type, 'object');
    assert.equal(checkpointSchema.additionalProperties, false);
    assert.deepEqual(Object.keys(checkpointSchema.properties ?? {}).sort(), ['cwd', 'deliveryId', 'evidence', 'feedback', 'memories', 'outcome', 'runId']);
    assert.equal(checkpointSchema.properties?.evidence?.type, 'object');
    assert.equal(checkpointSchema.properties?.evidence?.additionalProperties, false);
    assert.deepEqual(Object.keys(checkpointSchema.properties?.evidence?.properties ?? {}).sort(), ['changedPaths', 'commands', 'errorSignatures', 'tests', 'verification']);
    assert.equal(checkpointSchema.properties?.evidence?.properties?.commands?.items?.additionalProperties, false);
    assert.equal(checkpointSchema.properties?.evidence?.properties?.tests?.items?.additionalProperties, false);
    assert.equal(checkpointSchema.properties?.evidence?.properties?.verification?.additionalProperties, false);
    assert.equal(checkpointSchema.properties?.feedback?.items?.additionalProperties, false);
    assert.deepEqual(checkpointSchema.properties?.feedback?.items?.required, ['entryId', 'entryRevision', 'verdict']);
    assert.equal(checkpointSchema.properties?.feedback?.maxItems, 100);
    assert.equal(checkpointSchema.properties?.evidence?.properties?.commands?.maxItems, 100);
    assert.equal(checkpointSchema.properties?.evidence?.properties?.tests?.maxItems, 100);
    assert.equal(checkpointSchema.properties?.evidence?.properties?.changedPaths?.maxItems, 200);
    assert.equal(checkpointSchema.properties?.evidence?.properties?.errorSignatures?.maxItems, 200);
    assert.equal('checks' in (checkpointSchema.properties?.evidence?.properties ?? {}), false);
    assert.match(checkpointSchema.properties?.runId?.description ?? '', /active/u);
    assert.match(checkpointSchema.properties?.runId?.description ?? '', /needs_answer/u);
    const globalizeSchema = tools.tools.find((tool) => tool.name === 'curator_globalize')?.inputSchema as { properties?: { confirmed?: { const?: unknown } }; required?: string[] };
    assert.equal(globalizeSchema.properties?.confirmed?.const, true);
    assert.ok(globalizeSchema.required?.includes('confirmed'));

    const missingRequestId = await client.callTool({
      name: 'task_prepare',
      arguments: {
        task: 'Implement the durable beacon and add tests',
        profileHints: { taskType: 'build', target: 'src/beacon.ts', expected: 'The durable beacon tests pass' },
        capabilities: [],
      },
    });
    assert.equal(missingRequestId.isError, true);
    assert.match(JSON.stringify(missingRequestId.content), /requestId/u);

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

    const prepared = await client.callTool({
      name: 'task_prepare',
      arguments: {
        requestId: 'mcp-gated-ready-request',
        task: 'Implement the durable beacon and add tests',
        profileHints: {
          taskType: 'build',
          target: 'src/beacon.ts',
          expected: 'The durable beacon tests pass',
        },
        capabilities: [
          { kind: 'skill', name: 'tdd', description: 'Implement changes test first' },
          { kind: 'skill', name: 'memory-reasoning', description: 'Verify recalled memory before implementation' },
          { kind: 'mcp_tool', name: 'github_search_code', description: 'Search repository code for durable beacon implementations' },
        ],
      },
    });
    const preparedContent = prepared.structuredContent as {
      intake: { status: string; sessionId: string; reasoning: { stage: string; selectedAction: string; silo: { completeness: number } } };
      context: { items: Array<{ metadata: { untrusted: boolean } }> };
      capabilities: { availability: string; recommendations: Array<{ kind: string; name: string; availability: string }> };
      memoryPolicy: { memoryReasoningRequired: boolean };
      executionContext: { canonicalCwd: string; repositoryRoot: string; cwdIsRepositoryRoot: boolean; pathPolicy: string };
      nextAction: string;
    } & Record<string, unknown>;
    assert.equal(preparedContent.intake.status, 'ready');
    assert.equal(preparedContent.intake.reasoning.stage, 'actionable');
    assert.match(preparedContent.intake.reasoning.selectedAction, /src\/beacon\.ts/u);
    assert.equal(preparedContent.intake.reasoning.silo.completeness, 1);
    assert.equal(preparedContent.nextAction, 'proceed');
    assert.equal(preparedContent.capabilities.availability, 'known-nonempty');
    assert.deepEqual(preparedContent.memoryPolicy, { memoryReasoningRequired: true });
    const canonicalRoot = await realpath(root);
    assert.deepEqual(preparedContent.executionContext, {
      canonicalCwd: canonicalRoot,
      repositoryRoot: canonicalRoot,
      cwdIsRepositoryRoot: true,
      pathPolicy: 'canonical_absolute_under_repository_root',
    });
    assert.equal(preparedContent.context.items[0]?.metadata.untrusted, true);
    assert.equal('memory' in preparedContent, false);
    assert.equal('references' in preparedContent, false);
    assert.ok(preparedContent.capabilities.recommendations.some((item) => item.kind === 'skill' && item.name === 'tdd' && item.availability === 'available'));
    assert.ok(preparedContent.capabilities.recommendations.some((item) => item.kind === 'skill' && item.name === 'memory-reasoning' && item.availability === 'available'));
    assert.ok(preparedContent.capabilities.recommendations.some((item) => item.kind === 'mcp_tool' && item.name === 'github_search_code' && item.availability === 'available'));

    const answerCapabilities = [
      { kind: 'skill', name: 'memory-reasoning', description: 'Verify recalled memory before implementation' },
    ];
    const incomplete = await client.callTool({
      name: 'task_prepare',
      arguments: {
        requestId: 'mcp-gated-incomplete-request',
        task: 'Implement the durable beacon',
        profileHints: { taskType: 'build' },
        capabilities: answerCapabilities,
      },
    });
    const incompleteContent = incomplete.structuredContent as { intake: { status: string; sessionId: string; question: { id: string } }; context: unknown; run: { runId: string }; nextAction: string } & Record<string, unknown>;
    assert.equal(incompleteContent.intake.status, 'needs_answer');
    assert.equal(incompleteContent.intake.question.id, 'target');
    assert.equal(incompleteContent.context, null);
    assert.equal('memory' in incompleteContent, false);
    assert.equal('references' in incompleteContent, false);
    assert.equal(incompleteContent.nextAction, 'answer_from_evidence_or_ask_user');

    const missingRunId = await client.callTool({
      name: 'task_answer',
      arguments: {
        sessionId: incompleteContent.intake.sessionId,
        questionId: 'target',
        value: 'src/beacon.ts',
        capabilities: answerCapabilities,
      },
    });
    assert.equal(missingRunId.isError, true);
    assert.match(JSON.stringify(missingRunId.content), /runId/);

    const targetAnswered = await client.callTool({
      name: 'task_answer',
      arguments: {
        sessionId: incompleteContent.intake.sessionId,
        runId: incompleteContent.run.runId,
        questionId: 'target',
        value: 'src/beacon.ts',
        capabilities: answerCapabilities,
      },
    });
    const targetContent = targetAnswered.structuredContent as { intake: { status: string; question: { id: string } } };
    assert.equal(targetContent.intake.status, 'needs_answer');
    assert.equal(targetContent.intake.question.id, 'expected');

    const completed = await client.callTool({
      name: 'task_answer',
      arguments: {
        sessionId: incompleteContent.intake.sessionId,
        runId: incompleteContent.run.runId,
        questionId: 'expected',
        value: 'The durable beacon tests pass',
        capabilities: answerCapabilities,
      },
    });
    const completedContent = completed.structuredContent as {
      intake: { status: string };
      executionContext: { canonicalCwd: string; repositoryRoot: string; cwdIsRepositoryRoot: boolean; pathPolicy: string };
      capabilities: {
        availability: string;
        diagnostics: { received: number; accepted: number; truncated: number; dropped: number };
        recommendations: Array<{ name: string; source: string; availability: string; required?: boolean }>;
      };
      nextAction: string;
    };
    assert.equal(completedContent.intake.status, 'ready');
    assert.equal(completedContent.nextAction, 'proceed');
    assert.deepEqual(completedContent.executionContext, {
      canonicalCwd: canonicalRoot,
      repositoryRoot: canonicalRoot,
      cwdIsRepositoryRoot: true,
      pathPolicy: 'canonical_absolute_under_repository_root',
    });
    assert.equal(completedContent.capabilities.availability, 'known-nonempty');
    assert.deepEqual(completedContent.capabilities.diagnostics, { received: 1, accepted: 1, truncated: 0, dropped: 0 });
    assert.ok(completedContent.capabilities.recommendations.some((item) => item.name === 'memory-reasoning'
      && item.source === 'akinator_policy'
      && item.availability === 'available'
      && item.required === true));

    for (const catalogAvailability of ['missing', 'unknown'] as const) {
      const catalogArguments = catalogAvailability === 'missing' ? { capabilities: [] } : {};
      const pending = await client.callTool({
        name: 'task_prepare',
        arguments: {
          requestId: `mcp-gated-${catalogAvailability}-request`,
          task: 'Implement the durable beacon and add tests',
          profileHints: { taskType: 'build' },
          client: { kind: 'test', sessionId: `task-answer-${catalogAvailability}` },
          ...catalogArguments,
        },
      });
      const pendingContent = pending.structuredContent as {
        intake: { status: string; sessionId: string; question: { id: string } };
        run: { runId: string };
        nextAction: string;
      };
      assert.equal(pendingContent.intake.status, 'needs_answer');
      assert.equal(pendingContent.intake.question.id, 'target');
      assert.equal(pendingContent.nextAction, 'answer_from_evidence_or_ask_user');

      const target = await client.callTool({
        name: 'task_answer',
        arguments: {
          sessionId: pendingContent.intake.sessionId,
          runId: pendingContent.run.runId,
          questionId: 'target',
          value: 'src/beacon.ts',
          ...catalogArguments,
        },
      });
      const targetContent = target.structuredContent as { intake: { status: string; question: { id: string } }; nextAction: string };
      assert.equal(targetContent.intake.status, 'needs_answer');
      assert.equal(targetContent.intake.question.id, 'expected');
      assert.equal(targetContent.nextAction, 'answer_from_evidence_or_ask_user');

      const stopped = await client.callTool({
        name: 'task_answer',
        arguments: {
          sessionId: pendingContent.intake.sessionId,
          runId: pendingContent.run.runId,
          questionId: 'expected',
          value: 'The durable beacon tests pass',
          ...catalogArguments,
        },
      });
      const stoppedContent = stopped.structuredContent as {
        intake: { status: string };
        context: unknown;
        capabilities: Record<string, unknown> & {
          recommendations: Array<{ name: string; source: string; availability: string; required?: boolean }>;
        };
        skillDiscovery: { attempted: boolean; selected: unknown[] };
        memoryPolicy: { memoryReasoningRequired: boolean };
        nextAction: string;
      } & Record<string, unknown>;
      assert.equal(stoppedContent.intake.status, 'ready');
      assert.equal(stoppedContent.nextAction, 'proceed');
      assert.deepEqual(stoppedContent.memoryPolicy, { memoryReasoningRequired: true });
      assert.equal(stoppedContent.context, null);
      assert.equal('memory' in stoppedContent, false);
      assert.equal('references' in stoppedContent, false);
      assert.ok(stoppedContent.capabilities.recommendations.some((item) => item.name === 'memory-reasoning'
        && item.source === 'akinator_policy'
        && item.availability === catalogAvailability
        && item.required === true));
      assert.equal(stoppedContent.capabilities.recommendations.some((item) => item.name === 'memory-reasoning'
        && item.source === 'catalog_similarity'), false);
      assert.equal('externalSkillFallback' in stoppedContent.capabilities, false);
      assert.equal(stoppedContent.skillDiscovery.attempted, false);
      assert.deepEqual(stoppedContent.skillDiscovery.selected, []);
    }
  } finally {
    await client.close();
    if (server.isConnected()) await server.close();
  }
});

test('memory_checkpoint returns actionable MCP guidance during intake and succeeds after task_answer finalizes the run', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'kiokuko-mcp-checkpoint-recovery-repo-'));
  execFileSync('git', ['init', '-q', root]);
  const data = await mkdtemp(path.join(tmpdir(), 'kiokuko-mcp-checkpoint-recovery-data-'));
  const databasePath = path.join(data, 'kiokuko.sqlite3');
  const server = createKiokukoMcpServer({ databasePath, cwd: () => root });
  const client = new Client({ name: 'kiokuko-checkpoint-recovery-test', version: '1.0.0' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  try {
    const capabilities = [{ kind: 'skill', name: 'memory-reasoning' }];
    const prepared = await client.callTool({
      name: 'task_prepare',
      arguments: {
        requestId: 'mcp-checkpoint-recovery-request',
        task: 'Implement the checkpoint recovery behavior',
        profileHints: { taskType: 'build' },
        capabilities,
      },
    });
    const preparedContent = prepared.structuredContent as {
      intake: { status: string; sessionId: string; question: { id: string } };
      run: { runId: string };
      nextAction: string;
    };
    assert.equal(preparedContent.intake.status, 'needs_answer');
    assert.equal(preparedContent.nextAction, 'answer_from_evidence_or_ask_user');
    const runId = preparedContent.run.runId;

    const before = openConnection(databasePath);
    let eventCount: number;
    try {
      eventCount = before.prepare('SELECT COUNT(*) AS count FROM ledger_events WHERE run_id = ?').get<{ count: number }>(runId)?.count ?? 0;
    } finally {
      before.close();
    }

    const earlyCheckpoint = await client.callTool({
      name: 'memory_checkpoint',
      arguments: {
        runId,
        outcome: 'completed',
        memories: [{ kind: 'lesson', title: 'Recovery sentinel', body: 'token=private-intake-checkpoint-sentinel must not persist during intake.' }],
      },
    });
    assert.equal(earlyCheckpoint.isError, true);
    assert.equal(JSON.stringify(earlyCheckpoint).includes('private-intake-checkpoint-sentinel'), false);
    assert.deepEqual(earlyCheckpoint.content, [{
      type: 'text',
      text: 'Checkpoint is blocked while the run awaits intake answers. Complete task_answer before retrying.',
    }]);
    assert.deepEqual(earlyCheckpoint.structuredContent, {
      code: 'CHECKPOINT_RUN_NOT_ACTIVE',
      reason: 'run_awaiting_intake_answer',
      runStatus: 'intake',
      nextAction: 'answer_from_evidence_or_ask_user',
      retryableAfterStateChange: true,
    });

    const afterEarlyCheckpoint = openConnection(databasePath);
    try {
      assert.equal(afterEarlyCheckpoint.prepare('SELECT status FROM ledger_runs WHERE run_id = ?').get<{ status: string }>(runId)?.status, 'intake');
      assert.equal(afterEarlyCheckpoint.prepare('SELECT COUNT(*) AS count FROM ledger_events WHERE run_id = ?').get<{ count: number }>(runId)?.count, eventCount);
      assert.equal(afterEarlyCheckpoint.prepare('SELECT COUNT(*) AS count FROM entries').get<{ count: number }>()?.count, 0);
      assert.equal(afterEarlyCheckpoint.prepare('SELECT COUNT(*) AS count FROM context_feedback').get<{ count: number }>()?.count, 0);
    } finally {
      afterEarlyCheckpoint.close();
    }

    const target = await client.callTool({
      name: 'task_answer',
      arguments: {
        sessionId: preparedContent.intake.sessionId,
        runId,
        questionId: 'target',
        value: 'src/mcp/server.ts',
        capabilities,
      },
    });
    const targetContent = target.structuredContent as { intake: { status: string; question: { id: string } }; nextAction: string };
    assert.equal(targetContent.intake.status, 'needs_answer');
    assert.equal(targetContent.intake.question.id, 'expected');
    assert.equal(targetContent.nextAction, 'answer_from_evidence_or_ask_user');

    const completed = await client.callTool({
      name: 'task_answer',
      arguments: {
        sessionId: preparedContent.intake.sessionId,
        runId,
        questionId: 'expected',
        value: 'Focused tests pass',
        capabilities,
      },
    });
    const completedContent = completed.structuredContent as { intake: { status: string }; nextAction: string };
    assert.equal(completedContent.intake.status, 'ready');
    assert.equal(completedContent.nextAction, 'proceed');

    const finalCheckpoint = await client.callTool({
      name: 'memory_checkpoint',
      arguments: {
        runId,
        outcome: 'completed',
        memories: [{ kind: 'lesson', title: 'Recovery lesson', body: 'Complete task_answer before checkpointing the run.' }],
      },
    });
    assert.equal(finalCheckpoint.isError, undefined);
    const finalContent = finalCheckpoint.structuredContent as { run: { runId: string; status: string }; entries: unknown[] };
    assert.deepEqual(finalContent.run, {
      runId,
      status: 'completed',
      feedbackCount: 0,
      evidenceCount: 0,
      reasoningPaths: 1,
      qualifiedReasoningPaths: 0,
    });
    assert.equal(finalContent.entries.length, 1);

    const terminalRetry = await client.callTool({
      name: 'memory_checkpoint',
      arguments: {
        runId,
        outcome: 'completed',
        memories: [{ kind: 'lesson', title: 'Terminal retry sentinel', body: 'This must not create a second checkpoint.' }],
      },
    });
    assert.equal(terminalRetry.isError, true);
    assert.deepEqual(terminalRetry.content, [{
      type: 'text',
      text: 'Checkpoint is blocked because the run is terminal.',
    }]);
    assert.deepEqual(terminalRetry.structuredContent, {
      code: 'CHECKPOINT_RUN_NOT_ACTIVE',
      reason: 'run_terminal',
      runStatus: 'completed',
      nextAction: 'stop',
      retryableAfterStateChange: false,
    });
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
        requestId: 'mcp-oversized-catalog-request',
        task: 'Implement the oversized catalog beacon and add tests',
        profileHints: { taskType: 'build', target: 'src/beacon.ts', expected: 'The tests pass' },
        capabilities: oversizedCapabilities,
      },
    });
    assert.equal(result.isError, undefined);
    const content = result.structuredContent as {
      run: { runId: string };
      nextAction: string;
      context: null;
      capabilities: {
        availability: string;
        diagnostics: { received: number; accepted: number; truncated: number; dropped: number };
        recommendations: Array<{ name: string; availability: string }>;
        warnings: Array<{ message: string }>;
      };
      warnings: Array<{ message: string }>;
    } & Record<string, unknown>;
    assert.equal(content.context, null);
    assert.equal('memory' in content, false);
    assert.equal('references' in content, false);
    assert.equal(content.capabilities.availability, 'unknown');
    assert.deepEqual(content.capabilities.diagnostics, { received: 3, accepted: 2, truncated: 2, dropped: 1 });
    assert.ok(content.capabilities.recommendations.some((item) => item.name === 'tdd' && item.availability === 'available'));
    assert.ok(content.capabilities.recommendations.some((item) => item.name === 'memory-reasoning' && item.availability === 'unknown'));
    assert.equal(content.nextAction, 'proceed');
    assert.equal(content.capabilities.warnings.length, 3);
    assert.deepEqual(content.warnings, content.capabilities.warnings);
    assert.match(JSON.stringify(content), /CAPABILITY_CATALOG_UNAVAILABLE|could not be safely classified/u);
    assert.equal(JSON.stringify(content).includes(sentinel), false);
    const available = await client.callTool({
      name: 'task_prepare',
      arguments: {
        requestId: 'mcp-available-catalog-request',
        task: 'Implement the oversized catalog beacon and add tests',
        profileHints: { taskType: 'build', target: 'src/beacon.ts', expected: 'The tests pass' },
        capabilities: [{ kind: 'skill', name: 'memory-reasoning' }],
      },
    });
    const availableContent = available.structuredContent as {
      context: { policyVersion: string; deliveryId: string };
      capabilities: {
        availability: string;
        diagnostics: { received: number; accepted: number; truncated: number; dropped: number };
      };
      nextAction: string;
    };
    assert.equal(availableContent.nextAction, 'proceed');
    assert.equal(availableContent.capabilities.availability, 'known-nonempty');
    assert.deepEqual(availableContent.capabilities.diagnostics, { received: 1, accepted: 1, truncated: 0, dropped: 0 });
    assert.equal(availableContent.context.policyVersion, 'context-ranking-v4');

    const exactBoundary = await client.callTool({
      name: 'task_prepare',
      arguments: {
        requestId: 'mcp-exact-boundary-catalog-request',
        task: 'Implement the oversized catalog beacon and add tests',
        profileHints: { taskType: 'build', target: 'src/beacon.ts', expected: 'The tests pass' },
        capabilities: Array.from({ length: 200 }, (_, index) => ({ kind: 'mcp_tool', name: `tool-${index}` })),
      },
    });
    const exactBoundaryContent = exactBoundary.structuredContent as { run: { runId: string }; capabilities: { availability: string; diagnostics: unknown } };
    assert.equal(exactBoundaryContent.capabilities.availability, 'known-nonempty');
    assert.deepEqual(
      exactBoundaryContent.capabilities.diagnostics,
      { received: 200, accepted: 200, truncated: 0, dropped: 0 },
    );

    const boundary = await client.callTool({
      name: 'task_prepare',
      arguments: {
        requestId: 'mcp-over-boundary-catalog-request',
        task: 'Implement the oversized catalog beacon and add tests',
        profileHints: { taskType: 'build', target: 'src/beacon.ts', expected: 'The tests pass' },
        capabilities: Array.from({ length: 201 }, (_, index) => ({ kind: 'mcp_tool', name: `tool-${index}` })),
      },
    });
    const boundaryContent = boundary.structuredContent as { run: { runId: string }; capabilities: { availability: string; diagnostics: unknown } };
    assert.notEqual(exactBoundaryContent.run.runId, content.run.runId);
    assert.notEqual(boundaryContent.run.runId, exactBoundaryContent.run.runId);
    assert.equal(boundaryContent.capabilities.availability, 'unknown');
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
        requestId: 'mcp-budget-catalog-request',
        task: 'Implement the oversized catalog beacon and add tests',
        profileHints: { taskType: 'build', target: 'src/beacon.ts', expected: 'The tests pass' },
        capabilities: budgetCapabilities,
      },
    });
    const budgetContent = budget.structuredContent as { capabilities: { availability: string; diagnostics: unknown; warnings: Array<{ code: string }> } };
    assert.equal(budgetContent.capabilities.availability, 'unknown');
    assert.deepEqual(budgetContent.capabilities.diagnostics, { received: 8, accepted: 8, truncated: 8, dropped: 0 });
    assert.ok(budgetContent.capabilities.warnings.some((warning) => warning.code === 'CAPABILITY_CATALOG_BUDGET_EXCEEDED'));

    const incomplete = await client.callTool({
      name: 'task_prepare',
      arguments: { requestId: 'mcp-oversized-incomplete-request', task: 'Implement the oversized catalog beacon', profileHints: { taskType: 'build' }, capabilities: oversizedCapabilities },
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
    assert.equal((answered.structuredContent as { capabilities: { availability: string } }).capabilities.availability, 'unknown');

    const catalogBase = {
      task: 'Implement the oversized catalog beacon and add tests',
      profileHints: { taskType: 'build', target: 'src/beacon.ts', expected: 'The tests pass' },
    };
    const explicitEmpty = await client.callTool({ name: 'task_prepare', arguments: { ...catalogBase, requestId: 'mcp-explicit-empty-catalog-request', capabilities: [] } });
    const omitted = await client.callTool({ name: 'task_prepare', arguments: { ...catalogBase, requestId: 'mcp-omitted-catalog-request' } });
    const whollyInvalid = await client.callTool({ name: 'task_prepare', arguments: { ...catalogBase, requestId: 'mcp-invalid-catalog-request', capabilities: [{ kind: 'invalid', name: 'invalid' }] } });
    const nonArray = await client.callTool({ name: 'task_prepare', arguments: { ...catalogBase, requestId: 'mcp-non-array-catalog-request', capabilities: { kind: 'skill', name: 'memory-reasoning' } } });
    assert.equal((explicitEmpty.structuredContent as { capabilities: { availability: string } }).capabilities.availability, 'known-empty');
    assert.equal((omitted.structuredContent as { capabilities: { availability: string } }).capabilities.availability, 'unknown');
    assert.equal((whollyInvalid.structuredContent as { capabilities: { availability: string } }).capabilities.availability, 'unknown');
    assert.equal(nonArray.isError, true);

    const database = openConnection(databasePath);
    try {
      const persisted = JSON.stringify({
        runs: database.prepare('SELECT * FROM ledger_runs').all(),
        sessions: database.prepare('SELECT * FROM akinator_sessions').all(),
        events: database.prepare('SELECT * FROM ledger_events').all(),
        deliveries: database.prepare('SELECT * FROM context_deliveries').all(),
      });
      assert.equal(persisted.includes(sentinel), false);
      assert.equal(database.prepare('SELECT COUNT(*) AS count FROM context_deliveries WHERE run_id = ?').get<{ count: number }>(content.run.runId)?.count, 0);
      assert.equal(database.prepare('SELECT policy_version FROM context_deliveries WHERE delivery_id = ?').get<{ policy_version: string }>(availableContent.context.deliveryId)?.policy_version, 'context-ranking-v4');
      const storedReasons = database.prepare(`
        SELECT selection_reason_json
          FROM context_delivery_entries
         WHERE delivery_id = ?
         ORDER BY rank ASC
         LIMIT 1
      `).get<{ selection_reason_json: string }>(availableContent.context.deliveryId);
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

test('task_prepare accepts stored v2 curator memory whose legacy tag is not managed external identity', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'kiokuko-mcp-legacy-curator-repo-'));
  execFileSync('git', ['init', '-q', root]);
  const data = await mkdtemp(path.join(tmpdir(), 'kiokuko-mcp-legacy-curator-data-'));
  const databasePath = path.join(data, 'kiokuko.sqlite3');
  const database = openConnection(databasePath);
  migrateDatabase(database);
  const legacy = recordEntry(database, {
    workspace: GLOBAL_WORKSPACE,
    kind: 'lesson',
    status: 'candidate',
    title: 'Legacy curator task intake guidance',
    body: 'Reproduce task intake failures against the stored context selection state.',
    scope: {
      schemaVersion: 2,
      visibility: 'global',
      memoryClass: 'troubleshooting',
      portableReason: 'This diagnostic workflow applies across Kiokuko repositories.',
    },
    provenance: { type: 'curator_globalize', reference: 'project:legacy-curator-source' },
    tags: ['external:skill', 'kiokuko'],
    createdBy: 'kiokuko-curator',
    actor: 'kiokuko-curator',
  }, { now: '2026-08-22T15:20:49.813Z' });
  database.close();

  const server = createKiokukoMcpServer({ databasePath, cwd: () => root });
  const client = new Client({ name: 'kiokuko-legacy-curator-test', version: '1.0.0' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  try {
    const result = await client.callTool({
      name: 'task_prepare',
      arguments: {
        requestId: 'mcp-legacy-curator-task-prepare',
        task: 'Fix the Kiokuko task intake integrity error',
        profileHints: {
          taskType: 'debug',
          target: 'Kiokuko task intake',
          expected: 'The focused regression passes',
        },
        capabilities: [{ kind: 'skill', name: 'memory-reasoning' }],
      },
    });
    assert.equal(result.isError, undefined);
    const content = result.structuredContent as {
      run: { status: string };
      nextAction: string;
      context: { items: Array<{ entryId: string }> };
    };
    assert.equal(content.run.status, 'active');
    assert.equal(content.nextAction, 'proceed');
    assert.equal(content.context.items.some((item) => item.entryId === legacy.id), false);
  } finally {
    await client.close();
    if (server.isConnected()) await server.close();
  }
});

test('task_prepare proceeds without memory-reasoning for managed curator global memory', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'kiokuko-mcp-curator-trust-repo-'));
  execFileSync('git', ['init', '-q', root]);
  const data = await mkdtemp(path.join(tmpdir(), 'kiokuko-mcp-curator-trust-data-'));
  const databasePath = path.join(data, 'kiokuko.sqlite3');
  const database = openConnection(databasePath);
  migrateDatabase(database);
  const now = '2026-08-26T00:00:00.000Z';
  const curated = recordEntry(database, {
    workspace: GLOBAL_WORKSPACE,
    kind: 'lesson',
    status: 'verified',
    title: 'Kiokuko intake capability repair workflow',
    body: 'Repair Kiokuko intake capability failures with focused regression tests.',
    scope: buildStructuredScope({
      visibility: 'global',
      retrievalScope: 'global',
      memoryClass: 'troubleshooting',
      portableReason: 'This Kiokuko repair workflow applies across repositories.',
    }),
    provenance: {
      type: 'curator_globalize',
      reference: 'source-entry@1#deterministic-v1',
      sourceWorkspace: 'project:curator-source',
      clientKind: 'kiokuko-curator',
      timestamp: now,
    },
    trustLevel: 'system_verified',
    confidence: 0.8,
    tags: ['curator:deterministic-v1', 'global', 'kiokuko', 'skill:curated'],
    createdBy: 'kiokuko-curator',
    actor: 'kiokuko-curator',
  }, { now });
  database.close();

  const server = createKiokukoMcpServer({ databasePath, cwd: () => root });
  const client = new Client({ name: 'kiokuko-curator-trust-test', version: '1.0.0' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  try {
    const result = await client.callTool({
      name: 'task_prepare',
      arguments: {
        requestId: 'mcp-curator-trust-task-prepare',
        task: 'Repair the Kiokuko intake capability failure',
        profileHints: {
          taskType: 'debug',
          target: 'Kiokuko intake capability',
          expected: 'The focused regression passes',
        },
        capabilities: [],
      },
    });
    assert.equal(result.isError, undefined);
    const content = result.structuredContent as {
      nextAction: string;
      memoryPolicy: { memoryReasoningRequired: boolean };
      context: { items: Array<{ entryId: string }> };
    };
    assert.equal(content.nextAction, 'proceed');
    assert.equal(content.memoryPolicy.memoryReasoningRequired, false);
    assert.equal(content.context.items.some((item) => item.entryId === curated.id), true);
  } finally {
    await client.close();
    if (server.isConnected()) await server.close();
  }
});

test('MCP tool failures redact arbitrary internal error messages', async () => {
  const data = await mkdtemp(path.join(tmpdir(), 'kiokuko-mcp-error-boundary-'));
  const sentinel = 'token=private-mcp-sentinel';
  const privateMigrationsPath = path.join(data, sentinel, 'private-migrations');
  const server = createKiokukoMcpServer({
    databasePath: path.join(data, 'kiokuko.sqlite3'),
    migrationsDirectory: privateMigrationsPath,
  });
  const client = new Client({ name: 'kiokuko-error-boundary-test', version: '1.0.0' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  try {
    const result = await client.callTool({
      name: 'task_prepare',
      arguments: { requestId: 'untyped-error-boundary-request', task: 'Boundary failure', profileHints: { taskType: 'review' }, capabilities: [] },
    });
    const serialized = JSON.stringify(result);
    assert.equal(result.isError, true);
    assert.match(serialized, /Internal integrity error/u);
    assert.doesNotMatch(serialized, /Database unavailable/u);
    assert.equal(serialized.includes(sentinel), false);
    assert.equal(serialized.includes(privateMigrationsPath), false);
  } finally {
    await client.close();
    if (server.isConnected()) await server.close();
  }
});

test('MCP cwd-bearing tools reject relative paths without reporting an internal integrity error', async () => {
  const data = await mkdtemp(path.join(tmpdir(), 'kiokuko-mcp-relative-cwd-'));
  const server = createKiokukoMcpServer({ databasePath: path.join(data, 'kiokuko.sqlite3') });
  const client = new Client({ name: 'kiokuko-relative-cwd-test', version: '1.0.0' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  try {
    const calls = [
      {
        name: 'task_prepare',
        arguments: { requestId: 'relative-cwd-request', task: 'Review', cwd: 'Sites/project', capabilities: [] },
      },
      {
        name: 'task_answer',
        arguments: {
          sessionId: 'relative-cwd-session',
          runId: 'relative-cwd-run',
          questionId: 'taskType',
          value: 'review',
          cwd: 'Sites/project',
          capabilities: [],
        },
      },
      { name: 'curator_check', arguments: { cwd: 'Sites/project' } },
      {
        name: 'memory_checkpoint',
        arguments: {
          cwd: 'Sites/project',
          memories: [{ kind: 'lesson', title: 'Relative cwd rejection', body: 'Use an absolute cwd.' }],
        },
      },
    ];

    for (const call of calls) {
      const result = await client.callTool(call);
      const serialized = JSON.stringify(result);
      assert.equal(result.isError, true, call.name);
      assert.match(serialized, /cwd must be an absolute path|Request is invalid/u, call.name);
      assert.doesNotMatch(serialized, /Internal integrity error/u, call.name);
    }
  } finally {
    await client.close();
    if (server.isConnected()) await server.close();
  }
});

test('task_prepare reports a missing absolute cwd as not found instead of an integrity error', async () => {
  const data = await mkdtemp(path.join(tmpdir(), 'kiokuko-mcp-missing-cwd-'));
  const missing = path.join(data, 'missing-worktree');
  const server = createKiokukoMcpServer({ databasePath: path.join(data, 'kiokuko.sqlite3') });
  const client = new Client({ name: 'kiokuko-missing-cwd-test', version: '1.0.0' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  try {
    const result = await client.callTool({
      name: 'task_prepare',
      arguments: { requestId: 'missing-cwd-request', task: 'Review', cwd: missing, capabilities: [] },
    });
    const serialized = JSON.stringify(result);
    assert.equal(result.isError, true);
    assert.match(serialized, /Resource not found/u);
    assert.doesNotMatch(serialized, /Internal integrity error/u);
  } finally {
    await client.close();
    if (server.isConnected()) await server.close();
  }
});

test('task_prepare reports exhausted SQLite locking as service backpressure', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'kiokuko-mcp-locked-repo-'));
  execFileSync('git', ['init', '-q', root]);
  const data = await mkdtemp(path.join(tmpdir(), 'kiokuko-mcp-locked-data-'));
  let beginAttempts = 0;
  const server = createKiokukoMcpServer({
    databasePath: path.join(data, 'kiokuko.sqlite3'),
    openConnection: (databasePath, options) => {
      const database = openConnection(databasePath, options);
      const exec = database.exec.bind(database);
      database.exec = (sql: string): void => {
        if (sql === 'BEGIN IMMEDIATE') {
          beginAttempts += 1;
          throw sqliteError(5);
        }
        exec(sql);
      };
      return database;
    },
  });
  const client = new Client({ name: 'kiokuko-locked-database-test', version: '1.0.0' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  try {
    const result = await client.callTool({
      name: 'task_prepare',
      arguments: { requestId: 'locked-database-request', task: 'Review', cwd: root, capabilities: [] },
    });
    const serialized = JSON.stringify(result);
    assert.equal(result.isError, true);
    assert.match(serialized, /Service is busy/u);
    assert.doesNotMatch(serialized, /Internal integrity error/u);
    assert.equal(beginAttempts, 5);
  } finally {
    await client.close();
    if (server.isConnected()) await server.close();
  }
});

test('MCP identity schemas reject padding instead of normalizing identities', async () => {
  const data = await mkdtemp(path.join(tmpdir(), 'kiokuko-mcp-canonical-identities-'));
  const server = createKiokukoMcpServer({ databasePath: path.join(data, 'kiokuko.sqlite3') });
  const client = new Client({ name: 'kiokuko-identity-boundary-test', version: '1.0.0' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  try {
    const calls = [
      { name: 'task_prepare', arguments: { requestId: 'identity-prepare', task: 'Review', client: { sessionId: ' padded-client-session ' } } },
      { name: 'task_answer', arguments: { sessionId: ' padded-session ', runId: 'run-1', questionId: 'taskType', value: 'review' } },
      { name: 'task_answer', arguments: { sessionId: 'session-1', runId: ' padded-run ', questionId: 'taskType', value: 'review' } },
      { name: 'curator_check', arguments: { workspace: ' project:workspace ' } },
      { name: 'curator_globalize', arguments: { workspace: 'project:workspace', entryId: ' padded-entry ', expectedRevision: 1, confirmed: true } },
      { name: 'memory_checkpoint', arguments: { runId: ' padded-run ' } },
      { name: 'memory_checkpoint', arguments: { deliveryId: ' padded-delivery ' } },
    ];
    for (const call of calls) {
      const result = await client.callTool(call);
      assert.equal(result.isError, true, call.name);
    }
  } finally {
    await client.close();
    if (server.isConnected()) await server.close();
  }
});

test('MCP preserves only typed database failures as DATABASE_ERROR', async () => {
  const data = await mkdtemp(path.join(tmpdir(), 'kiokuko-mcp-database-error-boundary-'));
  const sentinel = 'private-database-detail';
  const server = createKiokukoMcpServer({
    databasePath: path.join(data, 'kiokuko.sqlite3'),
    cwd: () => { throw new KiokukoError('DATABASE_ERROR', sentinel, { debug: sentinel }); },
  });
  const client = new Client({ name: 'kiokuko-database-boundary-test', version: '1.0.0' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  try {
    const result = await client.callTool({
      name: 'task_prepare',
      arguments: { requestId: 'database-error-request', task: 'Database failure', capabilities: [] },
    });
    const serialized = JSON.stringify(result);
    assert.equal(result.isError, true);
    assert.match(serialized, /Database unavailable/u);
    assert.equal(serialized.includes(sentinel), false);
  } finally {
    await client.close();
    if (server.isConnected()) await server.close();
  }
});

test('MCP tool failures sanitize typed Kiokuko errors instead of trusting their message or details', async () => {
  const data = await mkdtemp(path.join(tmpdir(), 'kiokuko-mcp-typed-error-boundary-'));
  const sentinel = 'token=private-typed-mcp-sentinel';
  const server = createKiokukoMcpServer({
    databasePath: path.join(data, 'kiokuko.sqlite3'),
    cwd: () => { throw new KiokukoError('INTEGRITY_ERROR', sentinel, { debug: sentinel }); },
  });
  const client = new Client({ name: 'kiokuko-typed-error-boundary-test', version: '1.0.0' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  try {
    const result = await client.callTool({
      name: 'task_prepare',
      arguments: { requestId: 'typed-error-boundary-request', task: 'Typed boundary failure', profileHints: { taskType: 'review' }, capabilities: [] },
    });
    const serialized = JSON.stringify(result);
    assert.equal(result.isError, true);
    assert.match(serialized, /Internal integrity error/u);
    assert.equal(serialized.includes(sentinel), false);
  } finally {
    await client.close();
    if (server.isConnected()) await server.close();
  }
});

test('MCP checkpoint keeps unsupported eligibility details on the generic redacted error path', async () => {
  const data = await mkdtemp(path.join(tmpdir(), 'kiokuko-mcp-checkpoint-redaction-'));
  const sentinel = 'token=private-unsupported-checkpoint-sentinel';
  const server = createKiokukoMcpServer({
    databasePath: path.join(data, 'kiokuko.sqlite3'),
    openConnection: () => {
      throw new KiokukoError('CONFLICT', sentinel, {
        runStatus: 'intake',
        checkpointEligibility: {
          allowed: false,
          reason: 'unsupported_reason',
          nextAction: 'leak_internal_action',
          retryableAfterStateChange: true,
        },
        secret: sentinel,
      });
    },
  });
  const client = new Client({ name: 'kiokuko-checkpoint-redaction-test', version: '1.0.0' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  try {
    const result = await client.callTool({
      name: 'memory_checkpoint',
      arguments: { memories: [{ kind: 'lesson', title: 'Redaction test', body: 'bounded' }] },
    });
    const serialized = JSON.stringify(result);
    assert.equal(result.isError, true);
    assert.match(serialized, /Request conflicts with current state/u);
    assert.equal(serialized.includes(sentinel), false);
    assert.equal(serialized.includes('unsupported_reason'), false);
    assert.equal(serialized.includes('leak_internal_action'), false);
    assert.equal(result.structuredContent, undefined);
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
