import { createHash } from 'node:crypto';
import { KiokukoError } from '../errors.js';

export const ENTRY_KINDS = ['fact', 'decision', 'lesson', 'preference', 'reference'] as const;
export const ENTRY_STATUSES = ['candidate', 'verified', 'superseded'] as const;
export const TRUST_LEVELS = ['untrusted', 'user_asserted', 'source_verified', 'system_verified'] as const;

export type EntryKind = (typeof ENTRY_KINDS)[number];
export type EntryStatus = (typeof ENTRY_STATUSES)[number];
export type TrustLevel = (typeof TRUST_LEVELS)[number];
export type JsonObject = { [key: string]: JsonValue };
export type JsonValue = null | boolean | number | string | JsonValue[] | JsonObject;

export interface ValidatedRecordInput {
  workspace: string;
  kind: EntryKind;
  status: EntryStatus;
  title: string;
  body: string;
  summary: string | null;
  scope: JsonObject;
  provenance: JsonObject;
  trustLevel: TrustLevel;
  confidence: number;
  tags: string[];
  createdBy: string;
  actor: string;
}

const RECORD_FIELDS = new Set([
  'workspace',
  'kind',
  'status',
  'title',
  'body',
  'summary',
  'scope',
  'provenance',
  'trustLevel',
  'confidence',
  'tags',
  'createdBy',
  'actor',
]);
const PROVENANCE_FIELDS = new Set(['type', 'reference']);

function validation(message: string, details: Record<string, unknown> = {}): never {
  throw new KiokukoError('VALIDATION_ERROR', message, details);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function assertObject(value: unknown, field: string): asserts value is Record<string, unknown> {
  if (!isPlainObject(value)) validation(`${field} must be a JSON object`);
}

function assertKnownFields(value: Record<string, unknown>, allowed: Set<string>, label: string): void {
  for (const field of Object.keys(value)) {
    if (!allowed.has(field)) validation(`Unknown ${label} field: ${field}`, { field });
  }
}

function assertJsonValue(value: unknown, path: string): asserts value is JsonValue {
  if (value === null || typeof value === 'boolean' || typeof value === 'string') return;
  if (typeof value === 'number') {
    if (Number.isFinite(value)) return;
    validation(`${path} must contain only finite JSON numbers`);
  }
  if (Array.isArray(value)) {
    for (let index = 0; index < value.length; index += 1) assertJsonValue(value[index], `${path}[${index}]`);
    return;
  }
  if (isPlainObject(value)) {
    for (const [key, child] of Object.entries(value)) assertJsonValue(child, `${path}.${key}`);
    return;
  }
  validation(`${path} must be JSON-compatible`);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function enumValue<T extends readonly string[]>(value: unknown, allowed: T, field: string): T[number] {
  if (typeof value !== 'string' || !allowed.includes(value)) {
    validation(`${field} must be one of: ${allowed.join(', ')}`);
  }
  return value as T[number];
}

function cloneAndSort(value: JsonValue): JsonValue {
  if (Array.isArray(value)) return value.map(cloneAndSort);
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [key, cloneAndSort(value[key] as JsonValue)]),
    ) as JsonObject;
  }
  return value;
}

/** Serialize JSON values with recursively sorted object keys and no insignificant whitespace. */
export function canonicalJson(value: unknown): string {
  assertJsonValue(value, 'value');
  return JSON.stringify(cloneAndSort(value)) as string;
}

export function canonicalContentHash(value: unknown): string {
  return createHash('sha256').update(canonicalJson(value), 'utf8').digest('hex');
}

export function requireWorkspace(value: unknown): string {
  if (!isNonEmptyString(value)) validation('workspace must be a non-empty string');
  return value;
}

function validateObjectField(value: unknown, field: string): JsonObject {
  assertObject(value, field);
  assertJsonValue(value, field);
  return value as JsonObject;
}

function validateProvenance(value: unknown): JsonObject {
  const provenance = validateObjectField(value, 'provenance');
  assertKnownFields(provenance, PROVENANCE_FIELDS, 'provenance');
  if (Object.keys(provenance).length > 0) {
    if (!isNonEmptyString(provenance.type)) validation('provenance.type must be a non-empty string');
    if (!isNonEmptyString(provenance.reference)) validation('provenance.reference must be a non-empty string');
  }
  return provenance;
}

function validateTags(value: unknown): string[] {
  if (!Array.isArray(value)) validation('tags must be an array of strings');
  if (value.length > 100) validation('tags must contain at most 100 values');
  const tags = value.map((tag, index) => {
    if (!isNonEmptyString(tag) || tag.length > 200) validation(`tags[${index}] must be a non-empty string of at most 200 characters`);
    return tag;
  });
  return [...new Set(tags)].sort((left, right) => left.localeCompare(right));
}

export function validateRecordInput(value: unknown): ValidatedRecordInput {
  assertObject(value, 'record input');
  assertKnownFields(value, RECORD_FIELDS, 'record input');

  const workspace = requireWorkspace(value.workspace);
  const kind = enumValue(value.kind, ENTRY_KINDS, 'kind');
  const status = value.status === undefined ? 'candidate' : enumValue(value.status, ENTRY_STATUSES, 'status');
  const title = value.title;
  if (!isNonEmptyString(title)) validation('title must be a non-empty string');
  if (typeof value.body !== 'string') validation('body must be a string');

  let summary: string | null = null;
  if (value.summary !== undefined && value.summary !== null) {
    if (typeof value.summary !== 'string') validation('summary must be a string or null');
    summary = value.summary;
  }

  const scope = value.scope === undefined ? {} : validateObjectField(value.scope, 'scope');
  const provenance = value.provenance === undefined ? {} : validateProvenance(value.provenance);
  const trustLevel = value.trustLevel === undefined ? 'user_asserted' : enumValue(value.trustLevel, TRUST_LEVELS, 'trustLevel');
  const confidence = value.confidence === undefined ? 1.0 : value.confidence;
  if (typeof confidence !== 'number' || !Number.isFinite(confidence) || confidence < 0 || confidence > 1) {
    validation('confidence must be between 0 and 1');
  }
  const tags = value.tags === undefined ? [] : validateTags(value.tags);
  const createdBy = value.createdBy === undefined ? 'kiokuko-cli' : value.createdBy;
  if (!isNonEmptyString(createdBy)) validation('createdBy must be a non-empty string');
  const actor = value.actor === undefined ? createdBy : value.actor;
  if (!isNonEmptyString(actor)) validation('actor must be a non-empty string');

  return {
    workspace,
    kind,
    status,
    title,
    body: value.body,
    summary,
    scope,
    provenance,
    trustLevel,
    confidence,
    tags,
    createdBy,
    actor,
  };
}
