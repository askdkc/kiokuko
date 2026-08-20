import { TextDecoder } from 'node:util';
import { getRuntimeDescriptorPath } from '../config/paths.js';
import { KiokukoError, type ErrorCode } from '../errors.js';
import { isPidAlive, type PidLiveness } from '../server/instance-lock.js';
import { readRuntimeDescriptor, type RuntimeDescriptor } from '../server/runtime-descriptor.js';
import type { DiscoverServerOptions } from './runtime-discovery.js';

export type ServerMethod = 'GET' | 'HEAD' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';

export interface ServerRequest {
  readonly method: ServerMethod;
  readonly path: string;
  readonly operation: string;
  readonly body?: unknown;
  readonly idempotencyKey?: string;
  readonly signal?: AbortSignal;
}

export type FetchImplementation = (input: string, init?: RequestInit) => Promise<Response>;

export interface ServerClient {
  request<T = unknown>(request: ServerRequest): Promise<T>;
}

export interface CreateServerClientOptions extends DiscoverServerOptions {
  readonly fetchImplementation?: FetchImplementation;
  readonly fetch?: FetchImplementation;
}

type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };

const MAX_JSON_BYTES = 2 * 1024 * 1024;
const MAX_PATH_BYTES = 16 * 1024;
const MAX_QUERY_BYTES = 8 * 1024;
const MAX_IDEMPOTENCY_KEY_BYTES = 256;
const MAX_OPERATION_BYTES = 256;
const MAX_ERROR_MESSAGE_BYTES = 1024;
const HEALTH_READY_PATH = '/health/ready';
const WRITE_METHODS = new Set<ServerMethod>(['POST', 'PUT', 'PATCH', 'DELETE']);
const READ_METHODS = new Set<ServerMethod>(['GET', 'HEAD']);
const SERVER_METHODS = new Set<ServerMethod>(['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE']);
const ERROR_CODES: readonly ErrorCode[] = [
  'USAGE_ERROR',
  'VALIDATION_ERROR',
  'NOT_FOUND',
  'CONFLICT',
  'DATABASE_ERROR',
  'BACKPRESSURE',
  'SERVICE_UNAVAILABLE',
  'SECURITY_REJECTION',
  'AUTHENTICATION_ERROR',
  'INTEGRITY_ERROR',
  'PARTIAL_FAILURE',
  'NOT_IMPLEMENTED',
];

function validationError(): KiokukoError {
  return new KiokukoError('VALIDATION_ERROR', 'Request is invalid');
}

function integrityError(): KiokukoError {
  return new KiokukoError('INTEGRITY_ERROR', 'Server response is invalid');
}

function unavailableError(): KiokukoError {
  return new KiokukoError('SERVICE_UNAVAILABLE', 'Kiokuko server is unavailable');
}

async function readLiveRuntimeDescriptor(options: {
  readonly descriptorPath?: string;
  readonly isPidAlive?: PidLiveness;
}): Promise<RuntimeDescriptor> {
  let descriptorPath: string;
  try {
    descriptorPath = options.descriptorPath ?? getRuntimeDescriptorPath();
  } catch {
    throw unavailableError();
  }
  let descriptor: RuntimeDescriptor | undefined;
  try {
    descriptor = await readRuntimeDescriptor(descriptorPath);
  } catch (error) {
    if (error instanceof KiokukoError) throw error;
    throw unavailableError();
  }
  if (!descriptor) throw unavailableError();

  let live: boolean;
  try {
    live = await (options.isPidAlive ?? isPidAlive)(descriptor.pid);
  } catch {
    throw unavailableError();
  }
  if (!live) throw unavailableError();
  return descriptor;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function hasControlCharacters(value: string): boolean {
  return /[\u0000-\u001f\u007f]/.test(value);
}

function isCanonicalArrayIndex(value: string): boolean {
  if (value === '0') return true;
  if (!/^[1-9]\d*$/.test(value)) return false;
  const index = Number(value);
  return Number.isSafeInteger(index) && index < 4_294_967_295 && String(index) === value;
}

function cloneJson(value: unknown, seen: Set<object>): JsonValue {
  if (value === null || typeof value === 'boolean' || typeof value === 'string') return value;
  if (typeof value === 'number') {
    if (Number.isFinite(value)) return value;
    throw validationError();
  }
  if (typeof value !== 'object') throw validationError();
  if (seen.has(value)) throw validationError();
  seen.add(value);
  try {
    if (Array.isArray(value)) {
      const keys = Reflect.ownKeys(value);
      if (keys.some((key) => typeof key === 'symbol'
        || (typeof key === 'string' && key !== 'length' && !isCanonicalArrayIndex(key)))) {
        throw validationError();
      }
      const result: JsonValue[] = [];
      for (let index = 0; index < value.length; index += 1) {
        if (!Object.prototype.hasOwnProperty.call(value, index)) throw validationError();
        result.push(cloneJson(value[index], seen));
      }
      return result;
    }
    if (!isPlainObject(value) || Object.getOwnPropertySymbols(value).length > 0) throw validationError();
    const result: Record<string, JsonValue> = {};
    for (const key of Object.keys(value).sort()) result[key] = cloneJson(value[key], seen);
    return result;
  } finally {
    seen.delete(value);
  }
}

function jsonSnapshot(value: unknown): string {
  let snapshot: string;
  try {
    snapshot = JSON.stringify(cloneJson(value, new Set())) as string;
  } catch (error) {
    if (error instanceof KiokukoError) throw error;
    throw validationError();
  }
  if (Buffer.byteLength(snapshot, 'utf8') > MAX_JSON_BYTES) throw validationError();
  return snapshot;
}

function validateOperation(value: unknown): string {
  if (typeof value !== 'string' || value.length === 0 || Buffer.byteLength(value, 'utf8') > MAX_OPERATION_BYTES
    || hasControlCharacters(value)) throw validationError();
  return value;
}

function validatePath(value: unknown, method: ServerMethod, baseUrl: string): string {
  if (typeof value !== 'string' || value.length === 0 || Buffer.byteLength(value, 'utf8') > MAX_PATH_BYTES
    || hasControlCharacters(value) || value.includes('\\') || value.includes('#')
    || value.startsWith('//') || /^[A-Za-z][A-Za-z\d+.-]*:/.test(value)) throw validationError();

  const queryIndex = value.indexOf('?');
  const rawPath = queryIndex < 0 ? value : value.slice(0, queryIndex);
  const query = queryIndex < 0 ? undefined : value.slice(queryIndex + 1);
  const healthPath = rawPath === HEALTH_READY_PATH;
  if (!rawPath.startsWith('/api/v1/') && !healthPath) throw validationError();
  if (healthPath && queryIndex >= 0) throw validationError();
  if (queryIndex >= 0 && !READ_METHODS.has(method)) throw validationError();
  if (query !== undefined && Buffer.byteLength(query, 'utf8') > MAX_QUERY_BYTES) throw validationError();

  for (const segment of rawPath.split('/')) {
    let decoded: string;
    try {
      decoded = decodeURIComponent(segment);
    } catch {
      throw validationError();
    }
    if (decoded === '.' || decoded === '..' || decoded.includes('/') || decoded.includes('\\')
      || hasControlCharacters(decoded)) throw validationError();
  }

  try {
    const base = new URL(baseUrl);
    const target = new URL(value, `${baseUrl}/`);
    if (target.origin !== base.origin || target.username !== '' || target.password !== '') throw validationError();
    return target.toString();
  } catch (error) {
    if (error instanceof KiokukoError) throw error;
    throw validationError();
  }
}

function validateIdempotencyKey(method: ServerMethod, value: unknown): string | undefined {
  if (!WRITE_METHODS.has(method)) {
    if (value !== undefined) throw validationError();
    return undefined;
  }
  if (typeof value !== 'string' || value.length === 0 || Buffer.byteLength(value, 'utf8') > MAX_IDEMPOTENCY_KEY_BYTES
    || hasControlCharacters(value)) throw validationError();
  return value;
}

function assertExactKeys(value: Record<string, unknown>, keys: readonly string[]): void {
  const allowed = new Set(keys);
  if (Object.keys(value).some((key) => !allowed.has(key))) throw integrityError();
}

function isErrorCode(value: unknown): value is ErrorCode {
  return typeof value === 'string' && ERROR_CODES.includes(value as ErrorCode);
}

function safeMessage(value: unknown, forbidden: readonly string[]): string {
  if (typeof value !== 'string' || value.length === 0 || Buffer.byteLength(value, 'utf8') > MAX_ERROR_MESSAGE_BYTES
    || hasControlCharacters(value) || forbidden.some((fragment) => fragment.length > 0 && value.includes(fragment))) {
    throw integrityError();
  }
  return value;
}

function collectBodyFragments(value: unknown, fragments: Set<string>): void {
  if (typeof value === 'string' || typeof value === 'number') {
    const fragment = String(value);
    if (fragment.length >= 4) fragments.add(fragment);
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) collectBodyFragments(item, fragments);
    return;
  }
  if (isPlainObject(value)) {
    for (const [key, child] of Object.entries(value)) {
      if (key.length >= 4) fragments.add(key);
      collectBodyFragments(child, fragments);
    }
  }
}

function bodyForbiddenFragments(snapshot: string | undefined): string[] {
  if (snapshot === undefined) return [];
  const fragments = new Set<string>();
  try {
    collectBodyFragments(JSON.parse(snapshot), fragments);
  } catch {
    return [];
  }
  return [...fragments];
}

function containsUnsafeErrorKey(key: string): boolean {
  return /^(?:key|body)$/i.test(key)
    || /authorization|bearer|token|secret|password|cookie|credential|api[-_]?key|idempotency|request[-_]?body|requestbody|payload/i.test(key);
}

function safeDetails(value: unknown, forbidden: readonly string[]): Record<string, unknown> {
  if (!isPlainObject(value)) throw integrityError();
  if (Object.keys(value).some(containsUnsafeErrorKey)) throw integrityError();
  const cloned = cloneJson(value, new Set());
  if (typeof cloned !== 'object' || cloned === null || Array.isArray(cloned)) throw integrityError();
  const text = JSON.stringify(cloned);
  if (forbidden.some((fragment) => fragment.length > 0 && text.includes(fragment))) throw integrityError();
  if (Buffer.byteLength(text, 'utf8') > MAX_JSON_BYTES) throw integrityError();
  return cloned as Record<string, unknown>;
}

async function readBoundedBody(response: Response): Promise<string> {
  const contentLength = response.headers.get('content-length');
  if (contentLength !== null && /^\d+$/.test(contentLength) && Number(contentLength) > MAX_JSON_BYTES) {
    throw integrityError();
  }
  if (response.body === null) return '';
  const reader = response.body.getReader();
  const chunks: Buffer[] = [];
  let size = 0;
  try {
    while (true) {
      const item = await reader.read();
      if (item.done) break;
      size += item.value.byteLength;
      if (size > MAX_JSON_BYTES) {
        await reader.cancel().catch(() => undefined);
        throw integrityError();
      }
      chunks.push(Buffer.from(item.value));
    }
  } catch (error) {
    if (error instanceof KiokukoError) throw error;
    throw unavailableError();
  }
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks));
  } catch {
    throw integrityError();
  }
}

function parseJson(text: string): unknown {
  if (text.length === 0) throw integrityError();
  try {
    return JSON.parse(text);
  } catch {
    throw integrityError();
  }
}

function validateHealthResponse(value: unknown): { ok: true } {
  if (!isPlainObject(value)) throw integrityError();
  assertExactKeys(value, ['ok']);
  if (value.ok !== true) throw integrityError();
  return { ok: true };
}

function validateSuccessResponse(value: unknown, operation: string): unknown {
  if (!isPlainObject(value)) throw integrityError();
  assertExactKeys(value, ['apiVersion', 'ok', 'operation', 'data', 'meta']);
  if (value.apiVersion !== '1' || value.ok !== true || value.operation !== operation
    || !Object.prototype.hasOwnProperty.call(value, 'data')) throw integrityError();
  if (Object.prototype.hasOwnProperty.call(value, 'meta') && !isPlainObject(value.meta)) throw integrityError();
  return value.data;
}

function validateErrorResponse(
  value: unknown,
  operation: string,
  forbidden: readonly string[],
): { code: ErrorCode; message: string; details: Record<string, unknown> } {
  if (!isPlainObject(value)) throw integrityError();
  assertExactKeys(value, ['apiVersion', 'ok', 'operation', 'error']);
  if (value.apiVersion !== '1' || value.ok !== false || value.operation !== operation || !isPlainObject(value.error)) {
    throw integrityError();
  }
  assertExactKeys(value.error, ['code', 'message', 'details']);
  if (!isErrorCode(value.error.code)) throw integrityError();
  return {
    code: value.error.code,
    message: safeMessage(value.error.message, forbidden),
    details: safeDetails(value.error.details, forbidden),
  };
}

function safeRetryAfter(response: Response): number | undefined {
  const value = response.headers.get('retry-after');
  if (value === null || !/^\d{1,5}$/.test(value)) return undefined;
  const seconds = Number(value);
  return Number.isSafeInteger(seconds) && seconds <= 86_400 ? seconds : undefined;
}

async function parseResponse(
  response: Response,
  requestPath: string,
  operation: string,
  authorizationHeader: string,
  baseUrl: string,
  idempotencyKey: string | undefined,
  bodySnapshot: string | undefined,
): Promise<unknown> {
  const forbidden = [
    authorizationHeader.startsWith('Bearer ') ? authorizationHeader.slice('Bearer '.length) : authorizationHeader,
    baseUrl,
    idempotencyKey ?? '',
    bodySnapshot ?? '',
    ...bodyForbiddenFragments(bodySnapshot),
  ];
  if (response.status === 204) {
    if (requestPath === HEALTH_READY_PATH) return undefined;
    throw integrityError();
  }
  const contentType = response.headers.get('content-type') ?? '';
  if (!/^application\/json(?:\s*;|\s*$)/i.test(contentType)) throw integrityError();
  const parsed = parseJson(await readBoundedBody(response));
  const isSuccess = response.status >= 200 && response.status < 300;
  if (requestPath === HEALTH_READY_PATH && isSuccess) return validateHealthResponse(parsed);
  if (!isSuccess) {
    const error = validateErrorResponse(parsed, operation, forbidden);
    const retryAfter = safeRetryAfter(response);
    if (retryAfter !== undefined && error.details.retryAfterSeconds === undefined) {
      error.details.retryAfterSeconds = retryAfter;
    }
    throw new KiokukoError(error.code, error.message, error.details);
  }
  return validateSuccessResponse(parsed, operation);
}

export async function createServerClient(options: CreateServerClientOptions = {}): Promise<ServerClient> {
  const descriptor = await readLiveRuntimeDescriptor(options);
  const baseUrl = descriptor.baseUrl;
  const authorizationHeader = `Bearer ${descriptor.capabilityToken}`;
  const fetchImplementation = options.fetchImplementation ?? options.fetch ?? globalThis.fetch;
  const request = async <T = unknown>(input: ServerRequest): Promise<T> => {
    if (typeof input !== 'object' || input === null) throw validationError();
    const method = input.method;
    if (typeof method !== 'string' || !SERVER_METHODS.has(method as ServerMethod)) throw validationError();
    const typedMethod = method as ServerMethod;
    const operation = validateOperation(input.operation);
    const url = validatePath(input.path, typedMethod, baseUrl);
    const idempotencyKey = validateIdempotencyKey(typedMethod, input.idempotencyKey);
    const bodySnapshot = input.body === undefined ? undefined : jsonSnapshot(input.body);
    if (typeof fetchImplementation !== 'function') throw unavailableError();

    const headers: Record<string, string> = {
      Accept: 'application/json',
      Authorization: authorizationHeader,
    };
    if (bodySnapshot !== undefined) headers['Content-Type'] = 'application/json';
    if (idempotencyKey !== undefined) headers['Idempotency-Key'] = idempotencyKey;
    const init: RequestInit = {
      method: typedMethod,
      headers,
      ...(bodySnapshot === undefined ? {} : { body: bodySnapshot }),
      ...(input.signal === undefined ? {} : { signal: input.signal }),
    };

    let response: Response;
    try {
      response = await fetchImplementation(url, init);
    } catch {
      throw unavailableError();
    }
    return await parseResponse(response, input.path.split('?')[0] ?? input.path, operation, authorizationHeader,
      baseUrl, idempotencyKey, bodySnapshot) as T;
  };
  return Object.freeze({ request });
}
