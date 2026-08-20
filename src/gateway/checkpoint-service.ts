import { randomUUID } from 'node:crypto';
import type { SqliteDatabase } from '../db/adapter.js';
import { withImmediateTransaction } from '../db/transaction.js';
import { KiokukoError } from '../errors.js';
import { readAkinatorSession, readRunIntakeLink } from '../akinator/store.js';
import { projectLedger, type LedgerProjection } from '../ledger/projection.js';
import { LedgerStore } from '../ledger/store.js';
import { sanitizeEvent } from '../ledger/redaction.js';
import { validateEventBatch, validateTimestamp } from '../ledger/validate.js';
import type { JsonObject, JsonValue, LedgerEventInput, LedgerEventType } from '../ledger/types.js';
import { executeIdempotentInTransaction } from '../server/idempotency.js';
import { buildRecommendations, type Recommendation } from '../context/recommendations.js';
import { recordContextFeedbackInTransaction, recordIntakeFeedbackInTransaction, recordRunFeedbackInTransaction } from '../context/feedback.js';

const CHECKPOINT_EVENT_TYPES: readonly LedgerEventType[] = [
  'step.started', 'step.completed', 'step.failed', 'file.changed', 'error.recorded',
  'context.feedback', 'task_profile.revised', 'correction.recorded', 'request.received',
];
const MAX_TEXT = 4_096;
const MAX_ARRAY = 200;
const PROFILE_FIELDS = ['taskType', 'target', 'expected', 'constraints'] as const;
const TASK_TYPES = ['build', 'debug', 'research', 'review', 'devops', 'writing', 'analysis'] as const;

type CheckpointRequest = {
  events: LedgerEventInput[];
  contextFeedback: unknown[];
  characterBudget: number;
};

export interface CheckpointResponse {
  runId: string;
  acceptedThrough: number;
  localSequences: number[];
  sourceSequences: Array<number | null>;
  eventIds: string[];
  runStatus: 'active';
  taskProfile: {
    taskType: string | null;
    target: string | null;
    expected: string | null;
    constraints: string | null;
    source: 'akinator+ledger-revisions';
  };
  profileHash: string;
  projection: LedgerProjection;
  recommendations: Recommendation[];
  characterBudget: number;
  context: null;
  untrusted: true;
}

function validation(): never {
  throw new KiokukoError('VALIDATION_ERROR', 'Invalid checkpoint request');
}

function conflict(message = 'Checkpoint requires an active run'): never {
  throw new KiokukoError('CONFLICT', message);
}

function assertPlainObject(value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) validation();
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) validation();
  return value as Record<string, unknown>;
}

function boundedString(value: unknown, max = MAX_TEXT): string {
  if (typeof value !== 'string' || value.length === 0 || value.length > max || /\p{Cc}/u.test(value)) validation();
  return value;
}

function stringArray(value: unknown): string[] {
  if (!Array.isArray(value) || value.length > MAX_ARRAY) validation();
  return value.map((item) => boundedString(item));
}

function jsonValue(value: unknown): JsonValue {
  if (value === null || typeof value === 'boolean' || typeof value === 'string') return value;
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (Array.isArray(value)) return value.map(jsonValue);
  const object = assertPlainObject(value);
  const result: JsonObject = {};
  for (const key of Object.keys(object)) result[key] = jsonValue(object[key]);
  return result;
}

function partialProfile(value: unknown): JsonObject {
  const object = assertPlainObject(value);
  if (Object.keys(object).some((field) => !PROFILE_FIELDS.includes(field as (typeof PROFILE_FIELDS)[number]))) validation();
  const result: JsonObject = {};
  for (const field of PROFILE_FIELDS) {
    if (!Object.hasOwn(object, field)) continue;
    const fieldValue = object[field];
    if (field === 'taskType') {
      if (fieldValue !== null && (typeof fieldValue !== 'string' || !TASK_TYPES.includes(fieldValue as (typeof TASK_TYPES)[number]))) validation();
    } else if (fieldValue !== null && typeof fieldValue !== 'string') {
      validation();
    }
    result[field] = jsonValue(fieldValue);
  }
  if (Object.keys(result).length === 0) validation();
  return result;
}

function event(eventType: LedgerEventType, payload: JsonValue, now: string): LedgerEventInput {
  return { eventId: randomUUID(), eventType, actor: 'kiokuko-checkpoint', occurredAt: now, payload };
}

function normalizeRequest(raw: unknown, workspace: string, now: string): CheckpointRequest {
  const value = assertPlainObject(raw);
  const allowed = new Set([
    'apiVersion', 'events', 'currentGoal', 'currentStep', 'changedPaths', 'errorSignatures',
    'unresolvedItems', 'contextFeedback', 'taskProfileRevision', 'characterBudget',
  ]);
  if (Object.keys(value).some((key) => !allowed.has(key)) || value.apiVersion !== '1') validation();
  const events: LedgerEventInput[] = [];
  if (value.events !== undefined) {
    if (!Array.isArray(value.events) || value.events.length === 0) validation();
    const validated = validateEventBatch({ events: value.events });
    for (const item of validated) {
      if (!CHECKPOINT_EVENT_TYPES.includes(item.eventType)) validation();
      events.push(sanitizeEvent(item, { workspace }).value);
    }
  }
  if (value.currentGoal !== undefined) events.push(event('step.started', { goal: boundedString(value.currentGoal) }, now));
  if (value.currentStep !== undefined) events.push(event('step.started', { step: boundedString(value.currentStep) }, now));
  if (value.changedPaths !== undefined) {
    for (const path of stringArray(value.changedPaths)) events.push(event('file.changed', { path }, now));
  }
  if (value.errorSignatures !== undefined) {
    for (const signature of stringArray(value.errorSignatures)) events.push(event('error.recorded', { signature }, now));
  }
  if (value.unresolvedItems !== undefined) {
    for (const item of stringArray(value.unresolvedItems)) events.push(event('correction.recorded', { unresolved: item }, now));
  }
  if (value.taskProfileRevision !== undefined) events.push(event('task_profile.revised', { profile: partialProfile(value.taskProfileRevision) }, now));
  const contextFeedback = value.contextFeedback === undefined ? [] : (() => {
    if (!Array.isArray(value.contextFeedback) || value.contextFeedback.length > MAX_ARRAY) validation();
    return value.contextFeedback.map((item) => {
      const feedback = assertPlainObject(item);
      if (feedback.comment !== undefined && feedback.comment !== null) boundedString(feedback.comment);
      return item;
    });
  })();
  for (const feedback of contextFeedback) events.push(event('context.feedback', jsonValue(feedback), now));
  if (events.length === 0 || events.length > 200) validation();
  const characterBudget = value.characterBudget === undefined ? 8_000 : value.characterBudget;
  if (typeof characterBudget !== 'number' || !Number.isSafeInteger(characterBudget) || characterBudget < 1 || characterBudget > 100_000) validation();
  return { events, contextFeedback, characterBudget };
}

function projectionFor(database: SqliteDatabase, runId: string, acceptedThrough: number): LedgerProjection {
  const store = new LedgerStore(database);
  const run = store.readRun(runId);
  if (!run) throw new KiokukoError('NOT_FOUND', 'Ledger run not found');
  const link = readRunIntakeLink(database, { workspace: run.workspace, runId });
  const session = readAkinatorSession(database, { workspace: run.workspace, sessionId: link.sessionId });
  if (session.status !== 'ready' && session.status !== 'exhausted') conflict('Checkpoint requires finalized intake');
  const events = store.readEvents(runId).map((row) => ({
    eventId: row.event_id,
    sequence: row.sequence,
    eventType: row.event_type as LedgerEventType,
    ...(row.outcome === null ? {} : { outcome: row.outcome }),
    ...(row.payload_json === null ? {} : { payload: JSON.parse(row.payload_json) as JsonValue }),
  }));
  return projectLedger({
    initialProfile: session.profile,
    intakeStatus: session.status,
    coverage: run.coverage,
    throughSequence: acceptedThrough,
    events,
  });
}

function responseValue(database: SqliteDatabase, runId: string, request: CheckpointRequest, idempotencyKey: string, now: string): CheckpointResponse {
  const store = new LedgerStore(database);
  const run = store.readRun(runId);
  if (!run) throw new KiokukoError('NOT_FOUND', 'Ledger run not found');
  if (run.status !== 'active') conflict(run.status === 'intake' ? 'Checkpoint is not allowed during intake' : 'Checkpoint is not allowed for a terminal run');
  const ack = store.appendBatchInTransaction(runId, { events: request.events });
  for (let index = 0; index < request.contextFeedback.length; index += 1) {
    const feedback = assertPlainObject(request.contextFeedback[index]);
    recordContextFeedbackInTransaction(database, {
      ...feedback,
      workspace: run.workspace,
      runId,
      actor: typeof feedback.actor === 'string' ? feedback.actor : 'kiokuko-checkpoint',
      idempotencyKey: `${idempotencyKey}:context:${index}`,
      createdAt: typeof feedback.createdAt === 'string' ? feedback.createdAt : now,
    });
  }
  const projection = projectionFor(database, runId, ack.acceptedThrough);
  const recommendations = buildRecommendations({ projection, broker: {} });
  return {
    ...ack,
    runStatus: 'active',
    taskProfile: { ...projection.taskProfile, source: 'akinator+ledger-revisions' },
    profileHash: projection.profileHash,
    projection,
    recommendations,
    characterBudget: request.characterBudget,
    context: null,
    untrusted: true,
  };
}

export class CheckpointService {
  constructor(private readonly database: SqliteDatabase, private readonly now: () => string = () => new Date().toISOString()) {}

  checkpoint(input: unknown): CheckpointResponse {
    const value = assertPlainObject(input);
    if (typeof value.runId !== 'string' || value.runId.length === 0 || typeof value.idempotencyKey !== 'string' || value.idempotencyKey.length === 0) validation();
    const run = new LedgerStore(this.database).readRun(value.runId);
    if (!run) throw new KiokukoError('NOT_FOUND', 'Ledger run not found');
    const now = validateTimestamp(this.now(), 'createdAt');
    const request = normalizeRequest(value.request, run.workspace, now);
    return withImmediateTransaction(this.database, () => executeIdempotentInTransaction(
      this.database,
      { scope: `agent.checkpoint.${value.runId}`, key: value.idempotencyKey, request: value.request, createdAt: now },
      () => responseValue(this.database, value.runId as string, request, value.idempotencyKey as string, now) as unknown as JsonValue,
    ) as unknown as CheckpointResponse);
  }
}

export interface FeedbackResponse {
  category: 'context' | 'recommendation' | 'intake' | 'run';
  record: unknown;
  untrusted: true;
}

function feedbackRequest(raw: unknown): Record<string, unknown> {
  const value = assertPlainObject(raw);
  if (value.apiVersion !== '1' || typeof value.category !== 'string' || !['context', 'recommendation', 'intake', 'run'].includes(value.category)) validation();
  const categoryFields = value.category === 'context'
    ? ['deliveryId', 'entryId', 'verdict']
    : value.category === 'intake'
      ? ['sessionId', 'questionId', 'profileField', 'verdict']
      : ['outcome', 'recommendationCode', 'recommendationVerdict', 'rating'];
  const allowed = new Set(['apiVersion', 'category', 'feedbackId', 'actor', 'createdAt', 'comment', ...categoryFields]);
  if (Object.keys(value).some((field) => !allowed.has(field))) validation();
  return value;
}

function feedbackField(value: Record<string, unknown>, field: string): unknown {
  return Object.hasOwn(value, field) ? value[field] : undefined;
}

function feedbackValue(database: SqliteDatabase, runId: string, key: string, raw: unknown, now: string): FeedbackResponse {
  const run = new LedgerStore(database).readRun(runId);
  if (!run) throw new KiokukoError('NOT_FOUND', 'Ledger run not found');
  const value = feedbackRequest(raw);
  const category = value.category as FeedbackResponse['category'];
  const actor = value.actor === undefined ? 'kiokuko-feedback' : boundedString(value.actor);
  const feedbackId = boundedString(value.feedbackId, 256);
  const common = { workspace: run.workspace, feedbackId, actor, createdAt: typeof value.createdAt === 'string' ? value.createdAt : now, idempotencyKey: key };
  let record: unknown;
  if (category === 'context') {
    record = recordContextFeedbackInTransaction(database, {
      ...common,
      deliveryId: boundedString(feedbackField(value, 'deliveryId'), 256),
      entryId: boundedString(feedbackField(value, 'entryId'), 256),
      runId,
      verdict: feedbackField(value, 'verdict'),
      ...(feedbackField(value, 'comment') === undefined ? {} : { comment: feedbackField(value, 'comment') }),
    });
  } else if (category === 'intake') {
    const link = readRunIntakeLink(database, { workspace: run.workspace, runId });
    record = recordIntakeFeedbackInTransaction(database, {
      ...common,
      runId,
      sessionId: value.sessionId ?? link.sessionId,
      questionId: value.questionId ?? null,
      profileField: value.profileField ?? null,
      verdict: feedbackField(value, 'verdict'),
      comment: value.comment ?? null,
    });
  } else {
    record = recordRunFeedbackInTransaction(database, {
      ...common,
      runId,
      outcome: value.outcome ?? null,
      recommendationCode: value.recommendationCode ?? null,
      recommendationVerdict: value.recommendationVerdict ?? null,
      rating: value.rating ?? null,
      comment: value.comment ?? null,
    });
  }
  return { category, record, untrusted: true };
}

export class FeedbackService {
  constructor(private readonly database: SqliteDatabase, private readonly now: () => string = () => new Date().toISOString()) {}

  feedback(input: unknown): FeedbackResponse {
    const value = assertPlainObject(input);
    if (typeof value.runId !== 'string' || value.runId.length === 0 || typeof value.idempotencyKey !== 'string' || value.idempotencyKey.length === 0) validation();
    const run = new LedgerStore(this.database).readRun(value.runId);
    if (!run) throw new KiokukoError('NOT_FOUND', 'Ledger run not found');
    const now = validateTimestamp(this.now(), 'createdAt');
    feedbackRequest(value.request);
    return withImmediateTransaction(this.database, () => executeIdempotentInTransaction(
      this.database,
      { scope: `agent.feedback.${value.runId}`, key: value.idempotencyKey, request: value.request, createdAt: now },
      () => feedbackValue(this.database, value.runId as string, value.idempotencyKey as string, value.request, now) as unknown as JsonValue,
    ) as unknown as FeedbackResponse);
  }
}
