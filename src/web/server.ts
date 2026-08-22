import { randomBytes } from 'node:crypto';
import { type IncomingMessage, type RequestListener, type Server, type ServerResponse } from 'node:http';
import { KiokukoError } from '../errors.js';
import type { SqliteDatabase } from '../db/adapter.js';
import { readEntry, updateCandidateEntry, type EntryRecord } from '../memory/entries.js';
import { searchEntries } from '../memory/retrieval.js';
import { ENTRY_KINDS, ENTRY_STATUSES, requireWorkspace, type EntryKind, type EntryStatus } from '../serialization/validate.js';
import { AgentGatewayService } from '../gateway/agent-service.js';
import { ContextBroker } from '../context/broker.js';
import { listContextFeedback, listIntakeFeedback, listRunFeedback } from '../context/feedback.js';
import { projectLedger } from '../ledger/projection.js';
import { readAkinatorSession, readRunIntakeLink } from '../akinator/store.js';
import { startHttpServer, type HttpApplicationContext, type HttpServerOptions } from '../server/http.js';
import { createAgentV1Handler } from '../server/agent-application.js';
import { WEB_HTML } from './ui.js';
import { curateMemoryCandidates, globalizeCuratorCandidate } from '../memory/curator.js';

const DEFAULT_HOST = '127.0.0.1';
const DEFAULT_PORT = 4173;
const MAX_BODY_BYTES = 2 * 1024 * 1024;
const MAX_WEB_ENTRIES = 200;

type JsonRecord = Record<string, unknown>;

export type WebServerHttpOptions = Omit<
  HttpServerOptions,
  'databasePath' | 'host' | 'port' | 'app' | 'v1' | 'applicationFactory'
>;

export interface WebServerOptions {
  databasePath?: string;
  host?: string;
  port?: number;
  httpOptions?: WebServerHttpOptions;
}

export interface WebServerHandle {
  server: Server;
  url: string;
  close(): Promise<void>;
}

interface WorkspaceSummary {
  workspace: string;
  displayName: string;
  count: number;
}

function jsonResponse(response: ServerResponse, status: number, value: unknown): void {
  const body = JSON.stringify(value);
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'content-length': Buffer.byteLength(body),
  });
  response.end(body);
}

function htmlResponse(response: ServerResponse, sessionToken: string): void {
  response.writeHead(200, {
    'content-type': 'text/html; charset=utf-8',
    'cache-control': 'no-store',
    'set-cookie': `kiokuko_ui_session=${sessionToken}; Path=/; HttpOnly; SameSite=Strict`,
    'content-length': Buffer.byteLength(WEB_HTML),
  });
  response.end(WEB_HTML);
}

const UI_SESSION_COOKIE = 'kiokuko_ui_session';

function cookieValue(request: IncomingMessage, name: string): string | undefined {
  const header = request.headers.cookie;
  if (typeof header !== 'string') return undefined;
  for (const item of header.split(';')) {
    const separator = item.indexOf('=');
    if (separator < 0) continue;
    if (item.slice(0, separator).trim() === name) return item.slice(separator + 1).trim();
  }
  return undefined;
}

function requireUiSession(request: IncomingMessage, sessionToken: string): void {
  if (cookieValue(request, UI_SESSION_COOKIE) !== sessionToken) {
    throw new KiokukoError('AUTHENTICATION_ERROR', 'Authorization is invalid');
  }
  const origin = request.headers.origin;
  const host = request.headers.host;
  const expectedOrigin = host === undefined ? undefined : `http://${host}`;
  if (origin !== undefined && (expectedOrigin === undefined || origin !== expectedOrigin)) {
    throw new KiokukoError('AUTHENTICATION_ERROR', 'Origin is invalid');
  }
  const referer = request.headers.referer;
  if (referer !== undefined) {
    try {
      if (expectedOrigin === undefined || new URL(referer).origin !== expectedOrigin) throw new Error('origin');
    } catch {
      throw new KiokukoError('AUTHENTICATION_ERROR', 'Origin is invalid');
    }
  }
}

function errorStatus(error: unknown): number {
  if (!(error instanceof KiokukoError)) return 500;
  if (error.code === 'AUTHENTICATION_ERROR') return 401;
  if (error.code === 'VALIDATION_ERROR' || error.code === 'USAGE_ERROR') return 400;
  if (error.code === 'NOT_FOUND') return 404;
  if (error.code === 'CONFLICT') return 409;
  if (error.code === 'SECURITY_REJECTION') return 422;
  return 500;
}

function errorBody(error: unknown): { error: { code: string; message: string; details: Record<string, unknown> } } {
  if (error instanceof KiokukoError) {
    if (error.code === 'AUTHENTICATION_ERROR') return { error: { code: error.code, message: 'Authorization is invalid', details: {} } };
    return { error: { code: error.code, message: error.message, details: error.details } };
  }
  return { error: { code: 'DATABASE_ERROR', message: 'Unexpected server error', details: {} } };
}

function asRecord(value: unknown, label: string): JsonRecord {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new KiokukoError('VALIDATION_ERROR', `${label} must be a JSON object`);
  }
  return value as JsonRecord;
}

function enumQuery<T extends readonly string[]>(value: string | null, allowed: T, field: string): T[number] | undefined {
  if (value === null || value.length === 0) return undefined;
  if (!allowed.includes(value)) {
    throw new KiokukoError('VALIDATION_ERROR', `${field} must be one of: ${allowed.join(', ')}`);
  }
  return value as T[number];
}

function booleanQuery(value: string | null, field: string): boolean | undefined {
  if (value === null || value.length === 0) return undefined;
  if (value !== 'true' && value !== 'false') throw new KiokukoError('VALIDATION_ERROR', `${field} must be true or false`);
  return value === 'true';
}

function limitQuery(value: string | null): number {
  if (value === null || value.length === 0) return MAX_WEB_ENTRIES;
  const limit = Number(value);
  if (!Number.isInteger(limit) || limit < 1 || limit > MAX_WEB_ENTRIES) {
    throw new KiokukoError('VALIDATION_ERROR', `limit must be an integer between 1 and ${MAX_WEB_ENTRIES}`);
  }
  return limit;
}

async function readJsonBody(request: IncomingMessage): Promise<JsonRecord> {
  const chunks: Buffer[] = [];
  let size = 0;
  const text = await new Promise<string>((resolve, reject) => {
    request.on('data', (chunk: Buffer | string) => {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      size += buffer.byteLength;
      if (size > MAX_BODY_BYTES) {
        reject(new KiokukoError('VALIDATION_ERROR', 'Request body is too large'));
        request.destroy();
        return;
      }
      chunks.push(buffer);
    });
    request.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    request.on('error', reject);
  });
  if (text.trim().length === 0) throw new KiokukoError('VALIDATION_ERROR', 'Request body must contain JSON');
  try {
    return asRecord(JSON.parse(text) as unknown, 'Request body');
  } catch (error) {
    if (error instanceof KiokukoError) throw error;
    throw new KiokukoError('VALIDATION_ERROR', 'Request body is not valid JSON');
  }
}

function workspaceSummaries(database: SqliteDatabase): WorkspaceSummary[] {
  const summaries = new Map<string, WorkspaceSummary>();
  for (const row of database.prepare('SELECT workspace, display_name FROM repositories ORDER BY workspace ASC').all<{ workspace: string; display_name: string }>()) {
    summaries.set(row.workspace, { workspace: row.workspace, displayName: row.display_name, count: 0 });
  }
  for (const row of database.prepare("SELECT workspace, COUNT(*) AS count FROM entries WHERE status <> 'superseded' GROUP BY workspace").all<{ workspace: string; count: number }>()) {
    const existing = summaries.get(row.workspace);
    if (existing) existing.count = Number(row.count);
    else summaries.set(row.workspace, { workspace: row.workspace, displayName: '', count: Number(row.count) });
  }
  return [...summaries.values()].sort((left, right) => left.workspace.localeCompare(right.workspace));
}

function workspaceTags(database: SqliteDatabase, workspace: string): Array<{ tag: string; count: number }> {
  return database
    .prepare("SELECT t.tag, COUNT(*) AS count FROM tags t JOIN entries e ON e.id = t.entry_id WHERE e.workspace = ? AND e.status <> 'superseded' GROUP BY t.tag ORDER BY t.tag ASC")
    .all<{ tag: string; count: number }>(workspace)
    .map((row) => ({ tag: row.tag, count: Number(row.count) }));
}

function listEntries(
  database: SqliteDatabase,
  workspace: string,
  query: string,
  kind: EntryKind | undefined,
  status: EntryStatus | undefined,
  tag: string | undefined,
  includeSuperseded: boolean,
  limit: number,
): { entries: EntryRecord[]; count: number } {
  if (query.trim().length > 0) {
    const searchInput: Parameters<typeof searchEntries>[1] = { workspace, query, limit, includeSuperseded };
    if (kind !== undefined) searchInput.kind = kind;
    if (status !== undefined) searchInput.status = status;
    if (tag !== undefined) searchInput.tag = tag;
    const result = searchEntries(database, searchInput);
    return { entries: result.items, count: result.count };
  }

  const parameters: Array<string | number> = [workspace];
  const clauses = ['workspace = ?'];
  if (!includeSuperseded) clauses.push("status <> 'superseded'");
  if (kind !== undefined) {
    clauses.push('kind = ?');
    parameters.push(kind);
  }
  if (status !== undefined) {
    clauses.push('status = ?');
    parameters.push(status);
  }
  if (tag !== undefined) {
    clauses.push('EXISTS (SELECT 1 FROM tags filter_tags WHERE filter_tags.entry_id = entries.id AND filter_tags.tag = ?)');
    parameters.push(tag);
  }
  parameters.push(limit);
  const rows = database.prepare(`SELECT id FROM entries WHERE ${clauses.join(' AND ')} ORDER BY updated_at DESC, id ASC LIMIT ?`).all<{ id: string }>(...parameters);
  const entries = rows.map((row) => readEntry(database, { workspace, entryId: row.id }));
  return { entries, count: entries.length };
}

function entryIdFromPath(pathname: string): string {
  const prefix = '/api/entries/';
  if (!pathname.startsWith(prefix) || pathname.slice(prefix.length).includes('/')) {
    throw new KiokukoError('NOT_FOUND', 'Endpoint not found');
  }
  try {
    return decodeURIComponent(pathname.slice(prefix.length));
  } catch {
    throw new KiokukoError('VALIDATION_ERROR', 'entry id is not valid URL encoding');
  }
}

function operatorRunIdFromPath(pathname: string): string | undefined {
  const prefix = '/api/operator/runs/';
  if (!pathname.startsWith(prefix) || pathname.slice(prefix.length).includes('/')) return undefined;
  try {
    const runId = decodeURIComponent(pathname.slice(prefix.length));
    if (runId.length === 0) throw new Error('empty');
    return runId;
  } catch {
    throw new KiokukoError('VALIDATION_ERROR', 'run id is not valid URL encoding');
  }
}

function operatorRunList(context: HttpApplicationContext, url: URL): unknown {
  const workspace = requireWorkspace(url.searchParams.get('workspace') ?? '');
  const service = new AgentGatewayService(context.database);
  const input: Record<string, unknown> = { workspace };
  for (const field of ['client', 'status', 'cursor'] as const) {
    const value = url.searchParams.get(field);
    if (value !== null) input[field] = value;
  }
  const limit = url.searchParams.get('limit');
  if (limit !== null) input.limit = Math.min(limitQuery(limit), 100);
  return { workspace, ...service.listRuns(input) };
}

function operatorRunDetail(context: HttpApplicationContext, runId: string): unknown {
  const service = new AgentGatewayService(context.database);
  const run = service.readRun({ runId });
  const intake = service.readIntake({ runId });
  const events = service.listEvents({ runId, limit: 100 });
  const link = readRunIntakeLink(context.database, { workspace: run.workspace, runId });
  const session = readAkinatorSession(context.database, { workspace: run.workspace, sessionId: link.sessionId });
  const initialProfile = { ...session.profile };
  const projection = projectLedger({
    initialProfile,
    intakeStatus: session.status,
    coverage: run.coverage,
    throughSequence: run.lastSequence,
    events: events.items.map((event) => ({
      eventId: event.eventId,
      sequence: event.sequence,
      eventType: event.eventType as never,
      ...(event.outcome === null ? {} : { outcome: event.outcome }),
      payload: event.payload,
    })),
  });
  const deliveries = new ContextBroker(context.database).listDeliveries({ runId, limit: 100 });
  const feedback = {
    context: listContextFeedback(context.database, { workspace: run.workspace, runId, limit: 100 }),
    run: listRunFeedback(context.database, { workspace: run.workspace, runId, limit: 100 }),
    intake: listIntakeFeedback(context.database, { workspace: run.workspace, runId, limit: 100 }),
  };
  const evidence = context.database.prepare(`
    SELECT evidence_id AS evidenceId, event_id AS eventId, kind, digest_algorithm AS digestAlgorithm,
      digest, byte_size AS byteSize, summary, created_at AS createdAt
    FROM ledger_evidence WHERE run_id = ? ORDER BY created_at ASC, evidence_id ASC LIMIT 100
  `).all<Record<string, unknown>>(runId);
  const memoryLinks = context.database.prepare(`
    SELECT link_id AS linkId, event_id AS eventId, delivery_id AS deliveryId, entry_id AS entryId, created_at AS createdAt
    FROM ledger_memory_links WHERE run_id = ? ORDER BY created_at ASC, link_id ASC LIMIT 100
  `).all<Record<string, unknown>>(runId);
  const warnings: string[] = [];
  if (run.coverage.run !== 'complete') warnings.push('coverage is partial');
  if (projection.evidenceState !== 'fresh') warnings.push(`evidence is ${projection.evidenceState}`);
  if (session.status === 'active') warnings.push('intake is incomplete');
  return {
    run,
    intake,
    profile: {
      initial: initialProfile,
      projected: projection.taskProfile,
      source: link.profileSources,
      policyVersion: link.policyVersion,
      initialProfileHash: link.initialProfileHash,
    },
    timeline: events,
    evidence,
    coverage: run.coverage,
    evidenceState: projection.evidenceState,
    warnings,
    deliveries,
    feedback,
    memoryLinks,
    proposals: events.items.filter((event) => event.eventType === 'memory.proposed').map((event) => ({ eventId: event.eventId, sequence: event.sequence })),
    untrusted: true,
  };
}

async function handleRequest(request: IncomingMessage, response: ServerResponse, context: HttpApplicationContext, sessionToken: string): Promise<void> {
  if (request.method === 'OPTIONS') {
    response.writeHead(204, { 'cache-control': 'no-store' });
    response.end();
    return;
  }
  const url = new URL(request.url ?? '/', 'http://127.0.0.1');
  if (request.method === 'GET' && url.pathname === '/') {
    htmlResponse(response, sessionToken);
    return;
  }
  if (request.method === 'GET' && url.pathname === '/api/health') {
    jsonResponse(response, 200, { ok: true });
    return;
  }
  requireUiSession(request, sessionToken);
  if (request.method === 'GET' && url.pathname === '/api/operator/runs') {
    jsonResponse(response, 200, operatorRunList(context, url));
    return;
  }
  if (request.method === 'GET' && operatorRunIdFromPath(url.pathname) !== undefined) {
    jsonResponse(response, 200, operatorRunDetail(context, operatorRunIdFromPath(url.pathname) as string));
    return;
  }
  if (request.method === 'GET' && url.pathname === '/api/workspaces') {
    const workspaces = await workspaceSummaries(context.database);
    jsonResponse(response, 200, { workspaces });
    return;
  }
  if (request.method === 'GET' && url.pathname === '/api/tags') {
    const workspace = requireWorkspace(url.searchParams.get('workspace') ?? '');
    const tags = await workspaceTags(context.database, workspace);
    jsonResponse(response, 200, { workspace, tags });
    return;
  }
  if (request.method === 'GET' && url.pathname === '/api/curator/candidates') {
    const workspaceParam = url.searchParams.get('workspace');
    const skillReadyOnly = booleanQuery(url.searchParams.get('skillReadyOnly'), 'skillReadyOnly') ?? false;
    const result = workspaceParam === null || workspaceParam === 'all'
      ? await curateMemoryCandidates(context.database, { allWorkspaces: true, limit: Math.min(limitQuery(url.searchParams.get('limit')), 50), skillReadyOnly })
      : await curateMemoryCandidates(context.database, { workspace: requireWorkspace(workspaceParam), limit: Math.min(limitQuery(url.searchParams.get('limit')), 50), skillReadyOnly });
    jsonResponse(response, 200, result);
    return;
  }
  if (request.method === 'POST' && url.pathname === '/api/curator/globalize') {
    const payload = await readJsonBody(request);
    const workspace = requireWorkspace(url.searchParams.get('workspace') ?? (typeof payload.workspace === 'string' ? payload.workspace : ''));
    const result = await context.enqueueWrite(() => globalizeCuratorCandidate(context.database, {
      workspace,
      entryId: payload.entryId as string,
      expectedRevision: payload.expectedRevision as number,
      ...(typeof payload.actor === 'string' ? { actor: payload.actor } : {}),
    }));
    jsonResponse(response, 200, result);
    return;
  }
  if (request.method === 'GET' && url.pathname === '/api/entries') {
    const workspace = requireWorkspace(url.searchParams.get('workspace') ?? '');
    const kind = enumQuery(url.searchParams.get('kind'), ENTRY_KINDS, 'kind');
    const status = enumQuery(url.searchParams.get('status'), ENTRY_STATUSES, 'status');
    const tagValue = url.searchParams.get('tag');
    const tag = tagValue === null || tagValue.trim().length === 0 ? undefined : tagValue;
    const includeSuperseded = booleanQuery(url.searchParams.get('includeSuperseded'), 'includeSuperseded') ?? false;
    const result = await listEntries(context.database, workspace, url.searchParams.get('q') ?? '', kind, status, tag, includeSuperseded, limitQuery(url.searchParams.get('limit')));
    jsonResponse(response, 200, { workspace, entries: result.entries, count: result.count });
    return;
  }
  if ((request.method === 'GET' || request.method === 'PUT') && url.pathname.startsWith('/api/entries/')) {
    const workspace = requireWorkspace(url.searchParams.get('workspace') ?? '');
    const entryId = entryIdFromPath(url.pathname);
    if (request.method === 'GET') {
      const entry = await readEntry(context.database, { workspace, entryId });
      jsonResponse(response, 200, { entry });
      return;
    }
    const payload = await readJsonBody(request);
    const expectedRevision = payload.expectedRevision;
    const input: Parameters<typeof updateCandidateEntry>[1] = {
      workspace,
      entryId,
      expectedRevision: expectedRevision as number,
      kind: payload.kind as EntryKind,
      title: payload.title as string,
      body: payload.body as string,
    };
    if ('summary' in payload) input.summary = payload.summary as string | null;
    if ('scope' in payload) input.scope = payload.scope as never;
    if ('provenance' in payload) input.provenance = payload.provenance as never;
    if ('tags' in payload) input.tags = payload.tags as string[];
    if ('actor' in payload) input.actor = payload.actor as string;
    const entry = await context.enqueueWrite(() => updateCandidateEntry(context.database, input));
    jsonResponse(response, 200, { entry });
    return;
  }
  throw new KiokukoError('NOT_FOUND', 'Endpoint not found');
}

function isSharedServerPath(pathname: string): boolean {
  return pathname.startsWith('/health/') || pathname === '/api/v1' || pathname.startsWith('/api/v1/');
}

function createLegacyApplication(context: HttpApplicationContext): RequestListener {
  const sharedApplication = context.createAuthenticatedApp(createAgentV1Handler(context));
  const sessionToken = randomBytes(32).toString('base64url');
  return (request, response) => {
    const pathname = new URL(request.url ?? '/', 'http://127.0.0.1').pathname;
    if (isSharedServerPath(pathname)) {
      sharedApplication(request, response);
      return;
    }
    void handleRequest(request, response, context, sessionToken).catch((error: unknown) => {
      if (!response.headersSent) jsonResponse(response, errorStatus(error), errorBody(error));
      else response.destroy();
    });
  };
}

export async function startWebServer(options: WebServerOptions = {}): Promise<WebServerHandle> {
  const runtime = await startHttpServer({
    ...(options.httpOptions ?? {}),
    ...(options.databasePath === undefined ? {} : { databasePath: options.databasePath }),
    host: options.host ?? DEFAULT_HOST,
    port: options.port ?? DEFAULT_PORT,
    applicationFactory: createLegacyApplication,
  });
  return {
    server: runtime.server,
    url: runtime.url,
    close: () => runtime.close(),
  };
}
