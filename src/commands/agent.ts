import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { TextDecoder } from 'node:util';
import { Command } from 'commander';
import { KiokukoError } from '../errors.js';
import { successEnvelope } from '../serialization/envelope.js';
import {
  createServerClient,
  type CreateServerClientOptions,
  type FetchImplementation,
  type ServerClient,
  type ServerRequest,
} from '../client/server-client.js';

const MAX_INPUT_BYTES = 2 * 1024 * 1024;
const MAX_ID_BYTES = 256;
const MAX_TEXT_BYTES = 16 * 1024;
const MAX_INPUT_PATH_BYTES = 4 * 1024;
const CONTROL_CHARACTERS = /\p{Cc}/u;
const CAPTURE_PROFILES = new Set(['minimal', 'standard', 'full']);

type AgentCaptureProfile = 'minimal' | 'standard' | 'full';

export interface AgentCommandDependencies {
  readonly createClient?: (options?: CreateServerClientOptions) => Promise<ServerClient>;
  readonly fetchImplementation?: FetchImplementation;
  readonly idempotencyKeyFactory?: () => string;
  readonly readJsonInput?: (filePath: string) => Promise<unknown>;
}

function validationError(): KiokukoError {
  return new KiokukoError('VALIDATION_ERROR', 'Agent input is invalid');
}

function boundedString(value: unknown, maximumBytes: number): string {
  if (typeof value !== 'string' || value.length === 0 || value.trim().length === 0
    || Buffer.byteLength(value, 'utf8') > maximumBytes || CONTROL_CHARACTERS.test(value)) {
    throw validationError();
  }
  return value;
}

function boundedId(value: unknown): string {
  return boundedString(value, MAX_ID_BYTES);
}

function assertPlainObject(value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw validationError();
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) throw validationError();
  return value as Record<string, unknown>;
}

function validateInputPath(value: unknown): string {
  if (value === '-') return value;
  return boundedString(value, MAX_INPUT_PATH_BYTES);
}

async function readStdinBytes(): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let size = 0;
  try {
    for await (const chunk of process.stdin) {
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as string, 'utf8');
      size += bytes.byteLength;
      if (size > MAX_INPUT_BYTES) throw validationError();
      chunks.push(bytes);
    }
  } catch (error) {
    if (error instanceof KiokukoError) throw error;
    throw validationError();
  }
  return Buffer.concat(chunks);
}

async function readStrictJsonInput(filePath: string): Promise<unknown> {
  const safePath = validateInputPath(filePath);
  let bytes: Buffer;
  try {
    bytes = safePath === '-' ? await readStdinBytes() : await readFile(safePath);
  } catch (error) {
    if (error instanceof KiokukoError) throw error;
    throw validationError();
  }
  if (bytes.byteLength > MAX_INPUT_BYTES) throw validationError();

  let text: string;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    throw validationError();
  }
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw validationError();
  }
}

function captureProfile(value: unknown): AgentCaptureProfile {
  if (typeof value !== 'string' || !CAPTURE_PROFILES.has(value)) throw validationError();
  return value as AgentCaptureProfile;
}

function transportCaptureProfile(value: AgentCaptureProfile): 'minimal' | 'standard' | 'diagnostic' {
  return value === 'full' ? 'diagnostic' : value;
}

function runPath(runId: unknown, suffix: string): string {
  const id = boundedId(runId);
  if (id === '.' || id === '..' || id.includes('/') || id.includes('\\')) throw validationError();
  const encoded = encodeURIComponent(id);
  const path = `/api/v1/agent/runs/${encoded}/${suffix}`;
  if (Buffer.byteLength(path, 'utf8') > MAX_INPUT_PATH_BYTES) throw validationError();
  return path;
}

function keyFromFactory(dependencies: AgentCommandDependencies): string {
  const factory = dependencies.idempotencyKeyFactory ?? randomUUID;
  try {
    return boundedString(factory(), MAX_ID_BYTES);
  } catch (error) {
    if (error instanceof KiokukoError) throw error;
    throw validationError();
  }
}

function bodyAndKey(value: Record<string, unknown>, dependencies: AgentCommandDependencies): {
  body: Record<string, unknown>;
  idempotencyKey: string;
} {
  if (Object.prototype.hasOwnProperty.call(value, 'idempotencyKey')) {
    const idempotencyKey = boundedString(value.idempotencyKey, MAX_ID_BYTES);
    const { idempotencyKey: _removed, ...body } = value;
    return { body, idempotencyKey };
  }
  return { body: value, idempotencyKey: keyFromFactory(dependencies) };
}

async function readInput(dependencies: AgentCommandDependencies, filePath: string): Promise<Record<string, unknown>> {
  const value = await (dependencies.readJsonInput === undefined
    ? readStrictJsonInput(filePath)
    : dependencies.readJsonInput(validateInputPath(filePath)));
  return assertPlainObject(value);
}

async function getClient(dependencies: AgentCommandDependencies): Promise<ServerClient> {
  const factory = dependencies.createClient ?? createServerClient;
  const options: CreateServerClientOptions = dependencies.fetchImplementation === undefined
    ? {}
    : { fetchImplementation: dependencies.fetchImplementation };
  try {
    return await factory(options);
  } catch (error) {
    if (error instanceof KiokukoError) throw error;
    throw new KiokukoError('SERVICE_UNAVAILABLE', 'Kiokuko server is unavailable');
  }
}

async function sendRequest<T>(dependencies: AgentCommandDependencies, request: ServerRequest): Promise<T> {
  try {
    return await (await getClient(dependencies)).request<T>(request);
  } catch (error) {
    if (error instanceof KiokukoError) throw error;
    throw new KiokukoError('SERVICE_UNAVAILABLE', 'Kiokuko server is unavailable');
  }
}

function responseStatus(data: unknown): string {
  if (typeof data !== 'object' || data === null || Array.isArray(data)) return 'completed';
  const value = data as Record<string, unknown>;
  for (const field of ['intakeStatus', 'runStatus', 'status']) {
    if (typeof value[field] === 'string') return value[field] as string;
  }
  return 'completed';
}

function responseQuestion(data: unknown): string | undefined {
  if (typeof data !== 'object' || data === null || Array.isArray(data)) return undefined;
  const value = data as Record<string, unknown>;
  const question = value.currentQuestion;
  if (typeof question !== 'object' || question === null || Array.isArray(question)) return undefined;
  const id = (question as Record<string, unknown>).id;
  return typeof id === 'string' ? id : undefined;
}

function humanSummary(operation: string, data: unknown): string {
  const question = responseQuestion(data);
  const status = responseStatus(data);
  const context = typeof data === 'object' && data !== null && !Array.isArray(data)
    && (data as Record<string, unknown>).context !== null
    && (data as Record<string, unknown>).context !== undefined
    ? '; initial context available'
    : '';
  return question === undefined
    ? `Kiokuko ${operation}: ${status}${context}`
    : `Kiokuko ${operation}: ${status} (current question ${question})${context}`;
}

function emitResult(json: boolean | undefined, operation: string, data: unknown): void {
  if (json) process.stdout.write(`${JSON.stringify(successEnvelope(operation, data))}\n`);
  else process.stdout.write(`${humanSummary(operation, data)}\n`);
}

export function registerAgentCommand(cli: Command, dependencies: AgentCommandDependencies = {}): Command {
  const agent = cli.command('agent').description('Send generic agent lifecycle requests through the Kiokuko server');

  agent.command('open')
    .description('Open an authenticated generic agent run')
    .requiredOption('--workspace <workspace>')
    .requiredOption('--client <kind>')
    .requiredOption('--task <task>')
    .option('--client-version <version>')
    .option('--session-id <id>')
    .option('--capture-profile <profile>', 'Capture profile: minimal, standard, or full', 'standard')
    .option('--json')
    .action(async (options: {
      workspace: string;
      client: string;
      task: string;
      clientVersion?: string;
      sessionId?: string;
      captureProfile: string;
      json?: boolean;
    }) => {
      const workspace = boundedString(options.workspace, MAX_TEXT_BYTES);
      const clientKind = boundedId(options.client);
      const task = boundedString(options.task, MAX_TEXT_BYTES);
      const profile = captureProfile(options.captureProfile);
      const client = {
        kind: clientKind,
        ...(options.clientVersion === undefined ? {} : { version: boundedId(options.clientVersion) }),
        ...(options.sessionId === undefined ? {} : { sessionId: boundedId(options.sessionId) }),
      };
      const body = {
        apiVersion: '1' as const,
        workspace,
        client,
        task: {
          title: task,
          query: task,
          profileHints: { taskType: null, target: null, expected: null, constraints: null },
        },
        captureProfile: transportCaptureProfile(profile),
        coverage: {
          run: 'declared' as const,
          tool: 'declared' as const,
          command: 'declared' as const,
          file: 'declared' as const,
          approval: 'unavailable' as const,
        },
        metadata: {},
      };
      const data = await sendRequest(dependencies, {
        method: 'POST',
        path: '/api/v1/agent/runs',
        operation: 'agent.open',
        body,
        idempotencyKey: keyFromFactory(dependencies),
      });
      emitResult(options.json, 'agent.open', data);
    });

  agent.command('answer')
    .description('Answer the current agent intake question without inference')
    .argument('<run-id>')
    .requiredOption('--question-id <id>')
    .requiredOption('--value <answer>')
    .option('--json')
    .action(async (runId: string, options: { questionId: string; value: string; json?: boolean }) => {
      const questionId = boundedId(options.questionId);
      const value = boundedString(options.value, MAX_TEXT_BYTES);
      const data = await sendRequest(dependencies, {
        method: 'POST',
        path: runPath(runId, 'intake/answers'),
        operation: 'agent.answer',
        body: { apiVersion: '1' as const, questionId, value },
        idempotencyKey: keyFromFactory(dependencies),
      });
      emitResult(options.json, 'agent.answer', data);
    });

  for (const [name, operation, suffix] of [
    ['events', 'agent.events', 'events'],
    ['checkpoint', 'agent.checkpoint', 'checkpoints'],
    ['close', 'agent.close', 'close'],
    ['feedback', 'agent.feedback', 'feedback'],
  ] as const) {
    agent.command(name)
      .description(`Send an ${name} request for an agent run`)
      .argument('<run-id>')
      .requiredOption('--input-json <file|->')
      .option('--json')
      .action(async (runId: string, options: { inputJson: string; json?: boolean }) => {
        const input = await readInput(dependencies, options.inputJson);
        const request = bodyAndKey(input, dependencies);
        const data = await sendRequest(dependencies, {
          method: 'POST',
          path: runPath(runId, suffix),
          operation,
          body: request.body,
          idempotencyKey: request.idempotencyKey,
        });
        emitResult(options.json, operation, data);
      });
  }

  return agent;
}
