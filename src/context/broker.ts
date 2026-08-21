import { createHash, randomUUID } from 'node:crypto';
import type { SqliteDatabase } from '../db/adapter.js';
import { KiokukoError } from '../errors.js';
import { readAkinatorSession, readRunIntakeLink } from '../akinator/store.js';
import type { TaskProfile } from '../akinator/types.js';
import { listContextDeliveries, readContextDelivery, recordContextDelivery, type ContextDeliveryInput, type ContextDeliveryView, type ExternalSyncSummary } from './delivery.js';
import { listContextFeedback, type ContextFeedbackRecord } from './feedback.js';
import { buildRecommendations, RECOMMENDATION_POLICY_VERSION, type Recommendation } from './recommendations.js';
import { CONTEXT_RANKING_VERSION, rankContextCandidates, type RankedCandidate } from './ranking.js';
import { searchEntries } from '../memory/retrieval.js';
import type { EntryRecord } from '../memory/entries.js';
import { projectLedger, type LedgerEventSnapshot, type LedgerProjection } from '../ledger/projection.js';
import { LedgerStore } from '../ledger/store.js';
import type { RunRecord } from '../ledger/types.js';
import { prepareOfficialSourceSync, persistOfficialSourceSync, type PreparedOfficialSourceSync, type SourceSyncResult } from '../knowledge/sources.js';
import { canonicalContentHash } from '../serialization/validate.js';

export const CONTEXT_BROKER_POLICY_VERSION = `${CONTEXT_RANKING_VERSION}+${RECOMMENDATION_POLICY_VERSION}` as const;
export const CONTEXT_BROKER_DEFAULT_LIMIT = 20;
export const CONTEXT_BROKER_MAX_LIMIT = 100;
export const CONTEXT_BROKER_DEFAULT_CHARACTER_BUDGET = 8_000;
export const CONTEXT_BROKER_MAX_CHARACTER_BUDGET = 100_000;

export interface ContextBrokerQueryInput {
  workspace?: string;
  runId?: string;
  task?: string;
  taskProfile?: TaskProfile;
  recommendedTags?: string[];
  changedPaths?: string[];
  errorSignatures?: string[];
  limit?: number;
  characterBudget?: number;
}

export interface ContextBrokerContextItem {
  entryId: string;
  entryRevision: number;
  rank: number;
  scoreComponents: RankedCandidate['scoreComponents'];
  selectionReasons: string[];
  content: RankedCandidate['content'];
  untrusted: true;
}

export interface ContextBrokerContext {
  deliveryId: string | null;
  runId: string | null;
  throughSequence: number;
  taskProfileHash: string;
  queryHash: string;
  policyVersion: typeof CONTEXT_BROKER_POLICY_VERSION;
  items: ContextBrokerContextItem[];
  untrusted: true;
}

export interface ContextBrokerResult {
  status: 'needs_answer' | 'ready' | 'exhausted' | 'unbound';
  taskProfile: TaskProfile;
  profileHash: string;
  acceptedThrough: number;
  intakeSessionId: string | null;
  recommendedTags: string[];
  projection: LedgerProjection | null;
  context: ContextBrokerContext | null;
  recommendations: Recommendation[];
  externalSyncSummary: ExternalSyncSummary;
}

export interface ContextBrokerPersistence {
  persistSources?: (workspace: string, prepared: PreparedOfficialSourceSync) => Promise<SourceSyncResult> | SourceSyncResult;
  persistDelivery?: (input: ContextDeliveryInput) => Promise<ContextDeliveryView> | ContextDeliveryView;
}

export interface ContextBrokerOptions {
  readonly now?: () => string;
  readonly fetchImpl?: typeof fetch;
  readonly allowExternalSkillFallback?: boolean;
}

interface RunContext {
  run: RunRecord;
  profile: TaskProfile;
  profileHash: string;
  recommendedTags: string[];
  intakeSessionId: string;
  intakeStatus: 'active' | 'ready' | 'exhausted';
  projection: LedgerProjection | null;
}

interface PreparedQuery {
  workspace: string;
  run: RunRecord | null;
  taskProfile: TaskProfile;
  profileHash: string;
  recommendedTags: string[];
  changedPaths: string[];
  errorSignatures: string[];
  task: string;
  limit: number;
  characterBudget: number;
  throughSequence: number;
  intakeSessionId: string | null;
  projection: LedgerProjection | null;
  runStatus: ContextBrokerResult['status'];
  queryHash: string;
  deliveryId: string | null;
}

function invalid(): never {
  throw new KiokukoError('VALIDATION_ERROR', 'Context query input is invalid');
}

function notFound(): never {
  throw new KiokukoError('NOT_FOUND', 'Context run was not found');
}

function isTaskProfile(value: unknown): value is TaskProfile {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const profile = value as Record<string, unknown>;
  return Object.keys(profile).length === 4
    && ['taskType', 'target', 'expected', 'constraints'].every((field) => Object.hasOwn(profile, field))
    && (profile.taskType === null || ['build', 'debug', 'research', 'review', 'devops', 'writing', 'analysis'].includes(String(profile.taskType)))
    && ['target', 'expected', 'constraints'].every((field) => profile[field] === null || typeof profile[field] === 'string');
}

function boundedStringArray(value: unknown, max: number): string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > max || value.some((item) => typeof item !== 'string' || item.length === 0 || item.length > 2_000)) invalid();
  return [...new Set(value as string[])].sort();
}

function normalizeInput(input: unknown): ContextBrokerQueryInput {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) invalid();
  const value = input as Record<string, unknown>;
  const allowed = new Set(['apiVersion', 'workspace', 'runId', 'task', 'taskProfile', 'recommendedTags', 'changedPaths', 'errorSignatures', 'limit', 'characterBudget']);
  if (Object.keys(value).some((key) => !allowed.has(key))) invalid();
  if (value.apiVersion !== undefined && value.apiVersion !== '1') invalid();
  if (value.workspace !== undefined && (typeof value.workspace !== 'string' || value.workspace.length === 0 || value.workspace.length > 256)) invalid();
  if (value.runId === undefined && value.workspace === undefined) invalid();
  if (value.runId !== undefined && (typeof value.runId !== 'string' || value.runId.length === 0 || value.runId.length > 256)) invalid();
  if (value.task !== undefined && (typeof value.task !== 'string' || value.task.length > 16_384)) invalid();
  if (value.taskProfile !== undefined && !isTaskProfile(value.taskProfile)) invalid();
  if (value.limit !== undefined && (typeof value.limit !== 'number' || !Number.isSafeInteger(value.limit) || value.limit < 1 || value.limit > CONTEXT_BROKER_MAX_LIMIT)) invalid();
  if (value.characterBudget !== undefined && (typeof value.characterBudget !== 'number' || !Number.isSafeInteger(value.characterBudget) || value.characterBudget < 1 || value.characterBudget > CONTEXT_BROKER_MAX_CHARACTER_BUDGET)) invalid();
  return {
    ...(value.workspace === undefined ? {} : { workspace: value.workspace }),
    ...(value.runId === undefined ? {} : { runId: value.runId }),
    ...(value.task === undefined ? {} : { task: value.task }),
    ...(value.taskProfile === undefined ? {} : { taskProfile: value.taskProfile }),
    recommendedTags: boundedStringArray(value.recommendedTags, 500),
    changedPaths: boundedStringArray(value.changedPaths, 500),
    errorSignatures: boundedStringArray(value.errorSignatures, 500),
    ...(value.limit === undefined ? {} : { limit: value.limit as number }),
    ...(value.characterBudget === undefined ? {} : { characterBudget: value.characterBudget as number }),
  };
}

function parseEventRows(store: LedgerStore, runId: string): LedgerEventSnapshot[] {
  return store.readEvents(runId).map((row) => {
    let payload: unknown;
    try {
      payload = JSON.parse(String(row.payload_json));
    } catch {
      throw new KiokukoError('INTEGRITY_ERROR', 'Stored ledger payload is invalid');
    }
    const snapshot: LedgerEventSnapshot = {
      eventId: String(row.event_id),
      sequence: Number(row.sequence),
      eventType: row.event_type as LedgerEventSnapshot['eventType'],
      ...(row.outcome === null ? {} : { outcome: row.outcome as string }),
      ...(payload === undefined ? {} : { payload: payload as Exclude<LedgerEventSnapshot['payload'], undefined> }),
    };
    return snapshot;
  });
}

function currentRunContext(database: SqliteDatabase, runId: string): RunContext {
  const run = new LedgerStore(database).readRun(runId);
  if (!run) notFound();
  const link = readRunIntakeLink(database, { workspace: run.workspace, runId });
  const session = readAkinatorSession(database, { workspace: run.workspace, sessionId: link.sessionId });
  const status = session.status;
  if (status === 'active') {
    return {
      run,
      profile: session.profile,
      profileHash: link.initialProfileHash ?? canonicalContentHash(session.profile),
      recommendedTags: [...link.recommendedTags],
      intakeSessionId: link.sessionId,
      intakeStatus: status,
      projection: null,
    };
  }
  const projection = projectLedger({
    initialProfile: session.profile,
    intakeStatus: status,
    coverage: run.coverage,
    throughSequence: run.lastSequence,
    events: parseEventRows(new LedgerStore(database), runId),
  });
  return {
    run,
    profile: projection.taskProfile,
    profileHash: projection.profileHash,
    recommendedTags: [...link.recommendedTags],
    intakeSessionId: link.sessionId,
    intakeStatus: status,
    projection,
  };
}

function preparedQuery(database: SqliteDatabase, input: ContextBrokerQueryInput): PreparedQuery {
  const runContext = input.runId === undefined ? null : currentRunContext(database, input.runId);
  const requestedWorkspace = input.workspace ?? 'run-bound';
  const profile = runContext?.profile ?? input.taskProfile;
  if (profile === undefined || !isTaskProfile(profile)) invalid();
  const task = runContext?.run.title ?? input.task ?? [profile.target, profile.expected, profile.constraints].filter((value): value is string => value !== null).join(' ');
  const throughSequence = runContext?.run.lastSequence ?? 0;
  const taskProfileHash = runContext?.profileHash ?? canonicalContentHash(profile);
  const recommendedTags = runContext?.recommendedTags ?? input.recommendedTags ?? [];
  const queryShape = {
    runId: input.runId ?? null,
    workspace: input.runId === undefined ? requestedWorkspace : null,
    task,
    taskProfile: profile,
    recommendedTags: [...recommendedTags].sort(),
    changedPaths: input.changedPaths ?? [],
    errorSignatures: input.errorSignatures ?? [],
    throughSequence,
    characterBudget: input.characterBudget ?? CONTEXT_BROKER_DEFAULT_CHARACTER_BUDGET,
    limit: input.limit ?? CONTEXT_BROKER_DEFAULT_LIMIT,
  };
  const queryHash = canonicalContentHash(queryShape);
  return {
    workspace: runContext?.run.workspace ?? requestedWorkspace,
    run: runContext?.run ?? null,
    taskProfile: profile,
    profileHash: taskProfileHash,
    recommendedTags,
    changedPaths: input.changedPaths ?? [],
    errorSignatures: input.errorSignatures ?? [],
    task,
    limit: input.limit ?? CONTEXT_BROKER_DEFAULT_LIMIT,
    characterBudget: input.characterBudget ?? CONTEXT_BROKER_DEFAULT_CHARACTER_BUDGET,
    throughSequence,
    intakeSessionId: runContext?.intakeSessionId ?? null,
    projection: runContext?.projection ?? null,
    runStatus: runContext === null ? 'unbound' : runContext.intakeStatus === 'active' ? 'needs_answer' : runContext.intakeStatus,
    queryHash,
    deliveryId: input.runId === undefined ? null : `context-${queryHash}`,
  };
}

function entrySnapshot(entry: EntryRecord): Parameters<typeof rankContextCandidates>[0] extends infer _ ? {
  id: string; revision: number; kind: EntryRecord['kind']; status: EntryRecord['status']; trustLevel: EntryRecord['trustLevel']; confidence: number;
  title: string; summary: string | null; body: string; tags: string[]; scope: JsonObject; updatedAt: string;
} : never {
  return {
    id: entry.id,
    revision: entry.revision,
    kind: entry.kind,
    status: entry.status,
    trustLevel: entry.trustLevel,
    confidence: entry.confidence,
    title: entry.title,
    summary: entry.summary,
    body: entry.body,
    tags: [...entry.tags],
    scope: entry.scope,
    updatedAt: entry.updatedAt,
  };
}

type JsonObject = Record<string, unknown>;

function retrievalQuery(query: PreparedQuery): string {
  const values = [query.task, query.taskProfile.target, query.taskProfile.expected, ...query.recommendedTags].filter((value): value is string => value !== null && value.length > 0);
  return values.join(' ').slice(0, 16_384) || 'kiokuko';
}

function retrieveEntries(database: SqliteDatabase, query: PreparedQuery): EntryRecord[] {
  const terms = [query.task, query.taskProfile.target, query.taskProfile.expected, ...query.recommendedTags]
    .filter((value): value is string => value !== null && value.length > 0)
    .map((value) => value.slice(0, 2_000));
  const queries = [retrievalQuery(query), ...terms];
  const entries = new Map<string, EntryRecord>();
  for (const value of queries) {
    for (const entry of searchEntries(database, { workspace: query.workspace, query: value, limit: 500, includeSuperseded: false }).items) {
      entries.set(entry.id, entry);
    }
  }
  return [...entries.values()];
}

function priorData(database: SqliteDatabase, query: PreparedQuery): { delivered: Array<{ entryId: string; revision: number }>; feedback: Array<{ entryId: string; verdict: 'helpful' | 'irrelevant' | 'stale' | 'conflicting' }>; stale: Array<{ entryId: string; deliveredRevision: number; currentRevision: number; stale: true }> } {
  if (query.run === null) return { delivered: [], feedback: [], stale: [] };
  const deliveries = [] as ContextDeliveryView[];
  let cursor: string | undefined;
  for (let page = 0; page < 10; page += 1) {
    const result = listContextDeliveries(database, { workspace: query.workspace, runId: query.run.runId, limit: 100, ...(cursor === undefined ? {} : { cursor }) });
    deliveries.push(...result.items);
    if (result.nextCursor === null) break;
    cursor = result.nextCursor;
  }
  const delivered = deliveries.flatMap((delivery) => delivery.items.map((item) => ({ entryId: item.entryId, revision: item.entryRevision })));
  const feedbackPage = listContextFeedback(database, { workspace: query.workspace, runId: query.run.runId, limit: 100 });
  const feedback = feedbackPage.records.map((record: ContextFeedbackRecord) => ({ entryId: record.entryId, verdict: record.verdict }));
  const stale = deliveries.flatMap((delivery) => delivery.items.flatMap((item) => {
    const current = database.prepare('SELECT revision FROM entries WHERE id = ? AND workspace = ?').get<{ revision: number }>(item.entryId, query.workspace);
    return current && current.revision > item.entryRevision ? [{ entryId: item.entryId, deliveredRevision: item.entryRevision, currentRevision: current.revision, stale: true as const }] : [];
  }));
  return { delivered, feedback, stale };
}

function rank(database: SqliteDatabase, query: PreparedQuery, prior: ReturnType<typeof priorData>): RankedCandidate[] {
  const entries = retrieveEntries(database, query);
  return rankContextCandidates({
    taskProfile: query.taskProfile,
    recommendedTags: query.recommendedTags,
    changedPaths: query.changedPaths,
    errorSignatures: query.errorSignatures,
    priorDelivered: prior.delivered,
    feedback: prior.feedback,
    candidates: entries.map(entrySnapshot),
    limit: query.limit,
    characterBudget: query.characterBudget,
  });
}

function outputContext(query: PreparedQuery, items: RankedCandidate[], delivery: ContextDeliveryView | null): ContextBrokerContext {
  const sourceItems = items.map((item, index) => ({
    entryId: item.entryId,
    entryRevision: item.revision,
    rank: index + 1,
    scoreComponents: item.scoreComponents,
    selectionReasons: [...item.selectionReasons],
    content: item.content,
    untrusted: true as const,
  }));
  return {
    deliveryId: delivery?.deliveryId ?? query.deliveryId,
    runId: query.run?.runId ?? null,
    throughSequence: query.throughSequence,
    taskProfileHash: query.profileHash,
    queryHash: query.queryHash,
    policyVersion: CONTEXT_BROKER_POLICY_VERSION,
    items: sourceItems,
    untrusted: true,
  };
}

function deliveryInput(query: PreparedQuery, ranked: RankedCandidate[], summary: ExternalSyncSummary): ContextDeliveryInput {
  const items = ranked.map((item, index) => ({
    entryId: item.entryId,
    entryRevision: item.revision,
    rank: index + 1,
    scoreComponents: item.scoreComponents,
    selectionReasons: [...item.selectionReasons],
  }));
  const charCount = ranked.reduce((sum, item) => sum + item.content.characterCount, 0);
  const truncated = ranked.some((item) => item.content.truncated);
  return {
    workspace: query.workspace,
    deliveryId: query.deliveryId as string,
    runId: query.run?.runId as string,
    throughSequence: query.throughSequence,
    intakeSessionId: query.intakeSessionId,
    taskProfileHash: query.profileHash,
    queryHash: query.queryHash,
    policyVersion: CONTEXT_BROKER_POLICY_VERSION,
    externalSyncSummary: summary,
    charBudget: query.characterBudget,
    charCount,
    truncated,
    createdAt: query.run?.updatedAt ?? new Date().toISOString(),
    items,
  };
}

function emptyExternalSummary(): ExternalSyncSummary {
  return { attempted: false, imported: 0, sources: [] };
}

function storedContext(database: SqliteDatabase, query: PreparedQuery, delivery: ContextDeliveryView): ContextBrokerContext {
  let remaining = query.characterBudget;
  const items = delivery.items.map((item) => {
    const entry = database.prepare('SELECT id, revision, title, summary, body FROM entries WHERE id = ? AND workspace = ?').get<{ id: string; revision: number; title: string; summary: string | null; body: string }>(item.entryId, query.workspace);
    if (!entry) throw new KiokukoError('INTEGRITY_ERROR', 'Stored context entry is missing');
    const take = (value: string, budget: number): string => Array.from(value).slice(0, Math.max(0, budget)).join('');
    const count = (value: string): number => Array.from(value).length;
    const title = take(entry.title, remaining);
    remaining -= count(title);
    const summary = entry.summary === null ? null : take(entry.summary, remaining);
    remaining -= count(summary ?? '');
    const bodyPreview = take(entry.body, remaining);
    remaining -= count(bodyPreview);
    return {
      entryId: item.entryId,
      entryRevision: item.entryRevision,
      rank: item.rank,
      scoreComponents: item.scoreComponents,
      selectionReasons: [...item.selectionReasons],
      content: {
        title,
        summary,
        bodyPreview,
        characterCount: title.length + (summary?.length ?? 0) + bodyPreview.length,
        truncated: title.length < entry.title.length || (entry.summary !== null && summary?.length !== entry.summary.length) || bodyPreview.length < entry.body.length,
      },
      untrusted: true as const,
    };
  });
  return {
    deliveryId: delivery.deliveryId,
    runId: delivery.runId,
    throughSequence: delivery.throughSequence,
    taskProfileHash: delivery.taskProfileHash,
    queryHash: delivery.queryHash,
    policyVersion: delivery.policyVersion as typeof CONTEXT_BROKER_POLICY_VERSION,
    items,
    untrusted: true,
  };
}

export class ContextBroker {
  private readonly inFlight = new Map<string, Promise<ContextBrokerResult>>();

  constructor(private readonly database: SqliteDatabase, private readonly options: ContextBrokerOptions = {}) {}

  listDeliveries(input: { runId: string; cursor?: string; limit?: number }): ReturnType<typeof listContextDeliveries> & { untrusted: true } {
    const context = currentRunContext(this.database, input.runId);
    return {
      ...listContextDeliveries(this.database, {
        workspace: context.run.workspace,
        runId: input.runId,
        ...(input.cursor === undefined ? {} : { cursor: input.cursor }),
        ...(input.limit === undefined ? {} : { limit: input.limit }),
      }),
      untrusted: true,
    };
  }

  async query(rawInput: unknown, persistence: ContextBrokerPersistence = {}): Promise<ContextBrokerResult> {
    const input = normalizeInput(rawInput);
    const query = preparedQuery(this.database, input);
    const previous = this.inFlight.get(query.queryHash);
    if (previous !== undefined) return previous;
    const operation = this.queryPrepared(query, persistence);
    this.inFlight.set(query.queryHash, operation);
    try {
      return await operation;
    } finally {
      if (this.inFlight.get(query.queryHash) === operation) this.inFlight.delete(query.queryHash);
    }
  }

  private async queryPrepared(query: PreparedQuery, persistence: ContextBrokerPersistence): Promise<ContextBrokerResult> {
    const base = {
      status: query.runStatus,
      taskProfile: { ...query.taskProfile },
      profileHash: query.profileHash,
      acceptedThrough: query.throughSequence,
      intakeSessionId: query.intakeSessionId,
      recommendedTags: [...query.recommendedTags],
      projection: query.projection,
      context: null,
      recommendations: query.projection === null ? [] : buildRecommendations({ projection: query.projection, broker: {} }),
      externalSyncSummary: emptyExternalSummary(),
    } satisfies Omit<ContextBrokerResult, 'context'> & { context: null };
    if (query.runStatus === 'needs_answer') return base;

    const prior = priorData(this.database, query);
    const existing = query.deliveryId === null ? null : (() => {
      try {
        return readContextDelivery(this.database, { workspace: query.workspace, deliveryId: query.deliveryId });
      } catch (error) {
        if (error instanceof KiokukoError && error.code === 'NOT_FOUND') return null;
        throw error;
      }
    })();
    if (existing) {
      return {
        ...base,
        context: storedContext(this.database, query, existing),
        externalSyncSummary: existing.externalSyncSummary,
        recommendations: query.projection === null ? [] : buildRecommendations({ projection: query.projection, broker: { staleDeliveredEntries: prior.stale } }),
      };
    }

    let ranked = rank(this.database, query, prior);
    let externalSyncSummary = emptyExternalSummary();
    if (ranked.length < query.limit && query.taskProfile !== undefined && this.options.allowExternalSkillFallback === true) {
      const prepared = await prepareOfficialSourceSync({
        workspace: query.workspace,
        task: query.task,
        profile: query.taskProfile,
        recommendedTags: query.recommendedTags,
        ...(this.options.fetchImpl === undefined ? {} : { fetchImpl: this.options.fetchImpl }),
      });
      const result = persistence.persistSources === undefined
        ? persistOfficialSourceSync(this.database, { workspace: query.workspace, prepared })
        : await persistence.persistSources(query.workspace, prepared);
      externalSyncSummary = { attempted: result.attempted, imported: result.imported, sources: result.sources };
      ranked = rank(this.database, query, priorData(this.database, query));
    }

    const recommendations = query.projection === null
      ? []
      : buildRecommendations({ projection: query.projection, broker: { staleDeliveredEntries: prior.stale } });
    const context = outputContext(query, ranked, null);
    if (query.deliveryId === null || query.run === null) {
      return { ...base, context, recommendations, externalSyncSummary };
    }
    const deliveryRequest = deliveryInput(query, ranked, externalSyncSummary);
    const delivery = persistence.persistDelivery === undefined
      ? recordContextDelivery(this.database, deliveryRequest)
      : await persistence.persistDelivery(deliveryRequest);
    return { ...base, context: outputContext(query, ranked, delivery), recommendations, externalSyncSummary };
  }
}

export function contextBrokerQueryHash(input: unknown): string {
  return createHash('sha256').update(JSON.stringify(input), 'utf8').digest('hex');
}

export function newContextDeliveryId(): string {
  return `context-${randomUUID()}`;
}
