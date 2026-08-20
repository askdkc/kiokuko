import assert from 'node:assert/strict';
import { createServer, type RequestListener, type Server } from 'node:http';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { inspect } from 'node:util';
import test from 'node:test';
import { createRuntimeDescriptor, writeRuntimeDescriptor } from '../../src/server/runtime-descriptor.js';
import { discoverServer } from '../../src/client/runtime-discovery.js';
import { createServerClient, type FetchImplementation } from '../../src/client/server-client.js';

async function temp(prefix: string): Promise<string> {
  return mkdtemp(path.join(tmpdir(), `kiokuko-${prefix}-`));
}

async function listen(handler: RequestListener): Promise<{ server: Server; baseUrl: string }> {
  const server = createServer(handler);
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('server did not expose an address');
  return { server, baseUrl: `http://127.0.0.1:${address.port}` };
}

async function close(server: Server): Promise<void> {
  if (!server.listening) return;
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
}

async function clientForFetch(prefix: string, fetchImplementation: FetchImplementation) {
  const directory = await temp(prefix);
  const descriptorPath = path.join(directory, 'server.json');
  await writeRuntimeDescriptor(descriptorPath, createRuntimeDescriptor({
    databasePath: path.join(directory, 'kiokuko.sqlite3'),
    baseUrl: 'http://127.0.0.1:49152',
    pid: process.pid,
    capabilityToken: 'a'.repeat(64),
  }));
  return createServerClient({ descriptorPath, isPidAlive: () => true, fetchImplementation });
}

function jsonResponse(value: unknown, status = 200, extraHeaders: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { 'content-type': 'application/json', ...extraHeaders },
  });
}

test('missing runtime descriptor is a fixed service-unavailable error', async () => {
  const descriptorPath = path.join(await temp('client-missing'), 'server.json');

  await assert.rejects(
    () => discoverServer({ descriptorPath }),
    (error: unknown) => {
      assert.equal(error instanceof Error && 'code' in error && error.code === 'SERVICE_UNAVAILABLE', true);
      assert.equal(error instanceof Error && error.message, 'Kiokuko server is unavailable');
      assert.equal(error instanceof Error && 'details' in error && JSON.stringify(error.details), '{}');
      assert.equal(error instanceof Error && error.message.includes(descriptorPath), false);
      assert.equal(error instanceof Error && JSON.stringify('details' in error ? error.details : {}).includes(descriptorPath), false);
      return true;
    },
  );
});

test('dead runtime descriptor PID is a fixed service-unavailable error and remains untouched', async () => {
  const directory = await temp('client-stale');
  const descriptorPath = path.join(directory, 'server.json');
  await writeRuntimeDescriptor(descriptorPath, createRuntimeDescriptor({
    databasePath: path.join(directory, 'kiokuko.sqlite3'),
    baseUrl: 'http://127.0.0.1:49152',
    pid: 1234,
  }));
  const before = await readFile(descriptorPath);

  await assert.rejects(
    () => discoverServer({ descriptorPath, isPidAlive: () => false }),
    (error: unknown) => error instanceof Error && 'code' in error && error.code === 'SERVICE_UNAVAILABLE',
  );
  assert.deepEqual(await readFile(descriptorPath), before);
});

test('discovery preserves typed strict descriptor validation without exposing descriptor content', async () => {
  const directory = await temp('client-discovery-invalid');
  const descriptorPath = path.join(directory, 'server.json');
  await writeFile(descriptorPath, JSON.stringify({
    protocolVersion: '1',
    instanceId: '123e4567-e89b-12d3-a456-426614174000',
    pid: process.pid,
    baseUrl: 'http://127.0.0.1:49152',
    databaseFingerprint: `sha256:${'a'.repeat(64)}`,
    startedAt: '2026-08-20T07:00:00.000Z',
    capabilityToken: 'b'.repeat(64),
    unexpected: 'descriptor-content',
  }), { mode: 0o600 });

  await assert.rejects(
    () => discoverServer({ descriptorPath, isPidAlive: () => true }),
    (error: unknown) => {
      assert.equal(error instanceof Error && 'code' in error && error.code === 'VALIDATION_ERROR', true);
      assert.equal(error instanceof Error && error.message.includes('descriptor-content'), false);
      assert.equal(error instanceof Error && 'details' in error && JSON.stringify(error.details).includes('descriptor-content'), false);
      return true;
    },
  );
});

test('live discovery exposes only metadata and cannot reflect credentials through object surfaces', async () => {
  const directory = await temp('client-discovery');
  const descriptorPath = path.join(directory, 'server.json');
  const capabilityToken = 'c'.repeat(64);
  await writeRuntimeDescriptor(descriptorPath, createRuntimeDescriptor({
    databasePath: path.join(directory, 'kiokuko.sqlite3'),
    baseUrl: 'http://127.0.0.1:49152',
    pid: process.pid,
    capabilityToken,
  }));

  const discovered = await discoverServer({ descriptorPath, isPidAlive: () => true });
  const publicRepresentation = `${JSON.stringify(discovered)} ${inspect(discovered)} ${Object.keys(discovered).join(',')}`;
  const ownPropertyNames = Object.getOwnPropertyNames(discovered);
  const ownPropertyDescriptors = Object.getOwnPropertyDescriptors(discovered);
  const prototype = Object.getPrototypeOf(discovered);

  assert.equal(discovered.baseUrl, 'http://127.0.0.1:49152');
  assert.equal(Object.getOwnPropertySymbols(discovered).length, 0);
  assert.equal(ownPropertyNames.includes('capabilityToken'), false);
  assert.equal(ownPropertyNames.some((name) => /authorization|credential|token/i.test(name)), false);
  assert.equal(Object.values(ownPropertyDescriptors).some((descriptor) => typeof descriptor.get === 'function' || typeof descriptor.value === 'function'), false);
  assert.equal(prototype === Object.prototype || prototype === null, true);
  assert.equal(publicRepresentation.includes(capabilityToken), false);
  assert.equal(publicRepresentation.includes('capabilityToken'), false);
});

test('live discovery permits creation of an opaque server client', async () => {
  const directory = await temp('client-create');
  const descriptorPath = path.join(directory, 'server.json');
  const capabilityToken = 'd'.repeat(64);
  await writeRuntimeDescriptor(descriptorPath, createRuntimeDescriptor({
    databasePath: path.join(directory, 'kiokuko.sqlite3'),
    baseUrl: 'http://127.0.0.1:49152',
    pid: process.pid,
    capabilityToken,
  }));

  const client = await createServerClient({ descriptorPath, isPidAlive: () => true });
  const publicRepresentation = `${JSON.stringify(client)} ${inspect(client)} ${Object.keys(client).join(',')}`;

  assert.equal(typeof client.request, 'function');
  assert.equal(publicRepresentation.includes(capabilityToken), false);
  assert.equal(publicRepresentation.includes('authorization'), false);
  assert.equal(publicRepresentation.includes('token'), false);
});

test('request returns only the exact v1 success data and sends authenticated JSON headers', async () => {
  const token = 'e'.repeat(64);
  let receivedAuthorization: string | undefined;
  let receivedAccept: string | undefined;
  let receivedPath: string | undefined;
  const local = await listen((request, response) => {
    receivedAuthorization = request.headers.authorization;
    receivedAccept = request.headers.accept;
    receivedPath = request.url;
    const body = JSON.stringify({ apiVersion: '1', ok: true, operation: 'agent.test', data: { accepted: true } });
    response.writeHead(200, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) });
    response.end(body);
  });
  const directory = await temp('client-request-success');
  const descriptorPath = path.join(directory, 'server.json');
  await writeRuntimeDescriptor(descriptorPath, createRuntimeDescriptor({
    databasePath: path.join(directory, 'kiokuko.sqlite3'),
    baseUrl: local.baseUrl,
    pid: process.pid,
    capabilityToken: token,
  }));

  try {
    const client = await createServerClient({ descriptorPath, isPidAlive: () => true });
    const data = await client.request<{ accepted: boolean }>({
      method: 'GET',
      path: '/api/v1/agent/test',
      operation: 'agent.test',
    });

    assert.deepEqual(data, { accepted: true });
    assert.equal(receivedAuthorization === `Bearer ${token}`, true);
    assert.equal(receivedAccept, 'application/json');
    assert.equal(receivedPath, '/api/v1/agent/test');
  } finally {
    await close(local.server);
  }
});

test('write request snapshots JSON and sends the exact idempotency and content headers', async () => {
  const token = 'f'.repeat(64);
  const idempotencyKey = 'idem-client-write-1';
  let receivedAuthorization: string | undefined;
  let receivedIdempotencyKey: string | undefined;
  let receivedContentType: string | undefined;
  let receivedBody = '';
  const local = await listen((request, response) => {
    receivedAuthorization = request.headers.authorization;
    receivedIdempotencyKey = typeof request.headers['idempotency-key'] === 'string'
      ? request.headers['idempotency-key']
      : undefined;
    receivedContentType = request.headers['content-type'];
    request.setEncoding('utf8');
    request.on('data', (chunk: string) => { receivedBody += chunk; });
    request.on('end', () => {
      const body = JSON.stringify({ apiVersion: '1', ok: true, operation: 'agent.write', data: { accepted: true } });
      response.writeHead(200, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) });
      response.end(body);
    });
  });
  const directory = await temp('client-request-write');
  const descriptorPath = path.join(directory, 'server.json');
  await writeRuntimeDescriptor(descriptorPath, createRuntimeDescriptor({
    databasePath: path.join(directory, 'kiokuko.sqlite3'),
    baseUrl: local.baseUrl,
    pid: process.pid,
    capabilityToken: token,
  }));
  const input = { z: 'snapshot', nested: { b: 2, a: 'before-mutation' } };

  try {
    const client = await createServerClient({ descriptorPath, isPidAlive: () => true });
    const resultPromise = client.request<{ accepted: boolean }>({
      method: 'POST',
      path: '/api/v1/agent/write',
      operation: 'agent.write',
      body: input,
      idempotencyKey,
    });
    input.z = 'after-mutation';
    input.nested.a = 'after-mutation';
    const data = await resultPromise;

    assert.deepEqual(data, { accepted: true });
    assert.equal(receivedAuthorization === `Bearer ${token}`, true);
    assert.equal(receivedIdempotencyKey === idempotencyKey, true);
    assert.equal(receivedContentType, 'application/json');
    assert.equal(receivedBody, '{"nested":{"a":"before-mutation","b":2},"z":"snapshot"}');
  } finally {
    await close(local.server);
  }
});

test('rejects unsafe paths and write queries before invoking fetch', async () => {
  let fetchCalls = 0;
  const client = await clientForFetch('client-path-policy', async () => {
    fetchCalls += 1;
    throw new Error('should not be called');
  });
  const cases = [
    { method: 'GET' as const, path: 'https://example.invalid/api/v1/x' },
    { method: 'GET' as const, path: '//example.invalid/api/v1/x' },
    { method: 'GET' as const, path: '/api/v1/../secret' },
    { method: 'GET' as const, path: '/api/v1/%2e%2e/secret' },
    { method: 'GET' as const, path: '/api/v1/x#fragment' },
    { method: 'GET' as const, path: '/api/v1/x\r\nHeader: injected' },
    { method: 'POST' as const, path: '/api/v1/x?read=true' },
  ];

  for (const input of cases) {
    await assert.rejects(
      () => client.request({ ...input, operation: 'agent.path', ...(input.method === 'POST' ? { idempotencyKey: 'path-test' } : {}) }),
      (error: unknown) => {
        assert.equal(error instanceof Error && 'code' in error && error.code === 'VALIDATION_ERROR', true);
        assert.equal(error instanceof Error && error.message, 'Request is invalid');
        return true;
      },
    );
  }
  assert.equal(fetchCalls, 0);
});

test('requires bounded idempotency keys only for write methods', async () => {
  let fetchCalls = 0;
  const client = await clientForFetch('client-idempotency-policy', async () => {
    fetchCalls += 1;
    throw new Error('should not be called');
  });
  const cases = [
    { method: 'POST' as const, idempotencyKey: undefined },
    { method: 'PUT' as const, idempotencyKey: '' },
    { method: 'PATCH' as const, idempotencyKey: 'bad\r\nkey' },
    { method: 'DELETE' as const, idempotencyKey: 'x'.repeat(257) },
    { method: 'GET' as const, idempotencyKey: 'read-key' },
    { method: 'HEAD' as const, idempotencyKey: 'head-key' },
  ];

  for (const input of cases) {
    await assert.rejects(
      () => client.request({
        method: input.method,
        path: '/api/v1/agent/key',
        operation: 'agent.key',
        ...(input.idempotencyKey === undefined ? {} : { idempotencyKey: input.idempotencyKey }),
      }),
      (error: unknown) => error instanceof Error && 'code' in error && error.code === 'VALIDATION_ERROR',
    );
  }
  assert.equal(fetchCalls, 0);
});

test('rejects non-JSON, cyclic, non-finite, and oversized bodies without echoing input', async () => {
  let fetchCalls = 0;
  const client = await clientForFetch('client-body-policy', async () => {
    fetchCalls += 1;
    throw new Error('should not be called');
  });
  const cyclic: Record<string, unknown> = {};
  cyclic.self = cyclic;
  const malformedArray = ['value'] as unknown[];
  Object.defineProperty(malformedArray, '01', { value: 'non-canonical-index', enumerable: true });
  const cases: unknown[] = [
    { secret: 1n },
    { value: 1n },
    { value: Number.NaN },
    { value: () => 'not-json' },
    { value: new Date('2026-08-20T07:00:00.000Z') },
    cyclic,
    malformedArray,
    { value: 'x'.repeat(2 * 1024 * 1024) },
  ];

  for (const body of cases) {
    await assert.rejects(
      () => client.request({ method: 'POST', path: '/api/v1/agent/body', operation: 'agent.body', body, idempotencyKey: 'body-key' }),
      (error: unknown) => {
        assert.equal(error instanceof Error && 'code' in error && error.code === 'VALIDATION_ERROR', true);
        assert.equal(error instanceof Error && error.message, 'Request is invalid');
        assert.equal(error instanceof Error && 'details' in error && JSON.stringify(error.details), '{}');
        return true;
      },
    );
  }
  assert.equal(fetchCalls, 0);
});

test('rejects malformed, empty, HTML, oversized, and wrong-operation responses as integrity errors', async () => {
  const responses = [
    new Response('<html>response-secret</html>', { status: 200, headers: { 'content-type': 'text/html' } }),
    new Response('', { status: 200, headers: { 'content-type': 'application/json' } }),
    jsonResponse({ apiVersion: '2', ok: true, operation: 'agent.response', data: {} }),
    jsonResponse({ apiVersion: '1', ok: true, operation: 'agent.other', data: {} }),
    jsonResponse({ apiVersion: '1', ok: true, operation: 'agent.response' }),
  ];

  for (const [index, response] of responses.entries()) {
    const client = await clientForFetch(`client-response-integrity-${index}`, async () => response);
    await assert.rejects(
      () => client.request({ method: 'GET', path: '/api/v1/agent/response', operation: 'agent.response' }),
      (error: unknown) => {
        assert.equal(error instanceof Error && 'code' in error && error.code === 'INTEGRITY_ERROR', true);
        assert.equal(error instanceof Error && error.message, 'Server response is invalid');
        assert.equal(error instanceof Error && 'details' in error && JSON.stringify(error.details), '{}');
        assert.equal(error instanceof Error && error.message.includes('response-secret'), false);
        return true;
      },
    );
  }

  const oversized = new Response('x'.repeat(2 * 1024 * 1024 + 1), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
  const oversizedClient = await clientForFetch('client-response-oversized', async () => oversized);
  await assert.rejects(
    () => oversizedClient.request({ method: 'GET', path: '/api/v1/agent/response', operation: 'agent.response' }),
    (error: unknown) => error instanceof Error && 'code' in error && error.code === 'INTEGRITY_ERROR',
  );
});

test('maps known error envelopes without retrying and preserves only safe details', async () => {
  const cases: Array<{ code: string; status: number; message: string; details: Record<string, unknown>; retryAfter?: string }> = [
    { code: 'AUTHENTICATION_ERROR', status: 401, message: 'Authorization is invalid', details: {} },
    { code: 'CONFLICT', status: 409, message: 'Conflict is safe', details: { revision: 3 } },
    { code: 'BACKPRESSURE', status: 429, message: 'Service is busy', details: {}, retryAfter: '7' },
  ];

  for (const [index, input] of cases.entries()) {
    let fetchCalls = 0;
    const client = await clientForFetch(`client-known-error-${index}`, async () => {
      fetchCalls += 1;
      return jsonResponse({
        apiVersion: '1',
        ok: false,
        operation: 'agent.error',
        error: { code: input.code, message: input.message, details: input.details },
      }, input.status, input.retryAfter === undefined ? {} : { 'retry-after': input.retryAfter });
    });
    await assert.rejects(
      () => client.request({
        method: input.code === 'CONFLICT' ? 'POST' : 'GET',
        path: '/api/v1/agent/error',
        operation: 'agent.error',
        ...(input.code === 'CONFLICT' ? { idempotencyKey: 'known-error-key' } : {}),
      }),
      (error: unknown) => {
        assert.equal(error instanceof Error && 'code' in error && error.code === input.code, true);
        assert.equal(error instanceof Error && error.message, input.message);
        const details = error instanceof Error && 'details' in error && error.details !== null
          && typeof error.details === 'object' && !Array.isArray(error.details)
          ? error.details as Record<string, unknown>
          : {};
        assert.equal(JSON.stringify(details).includes('known-error-key'), false);
        if (input.code === 'BACKPRESSURE') assert.equal(details.retryAfterSeconds, 7);
        return true;
      },
    );
    assert.equal(fetchCalls, 1);
  }
});

test('rejects unknown or unsafe error envelopes without returning their content', async () => {
  const responses = [
    jsonResponse({ apiVersion: '1', ok: false, operation: 'agent.error', error: { code: 'UNKNOWN_CODE', message: 'unknown', details: {} } }, 500),
    jsonResponse({ apiVersion: '1', ok: false, operation: 'agent.error', error: { code: 'CONFLICT', message: 'unsafe-error-key', details: {} } }, 409),
    jsonResponse({ apiVersion: '1', ok: false, operation: 'agent.error', error: { code: 'CONFLICT', message: 'unsafe', details: { authorization: 'header-secret' } } }, 409),
    jsonResponse({ apiVersion: '1', ok: false, operation: 'agent.error', error: { code: 'CONFLICT', message: 'unsafe', details: { body: 'request-body-secret' } } }, 409),
  ];

  for (const [index, response] of responses.entries()) {
    const client = await clientForFetch(`client-unsafe-error-${index}`, async () => response);
    await assert.rejects(
      () => client.request({ method: index === 1 ? 'POST' : 'GET', path: '/api/v1/agent/error', operation: 'agent.error', ...(index === 1 ? { idempotencyKey: 'unsafe-error-key' } : {}) }),
      (error: unknown) => {
        assert.equal(error instanceof Error && 'code' in error && error.code === 'INTEGRITY_ERROR', true);
        assert.equal(error instanceof Error && error.message, 'Server response is invalid');
        const details = error instanceof Error && 'details' in error && error.details !== null
          && typeof error.details === 'object'
          ? JSON.stringify(error.details)
          : '';
        assert.equal(details.includes('header-secret'), false);
        assert.equal(details.includes('request-body-secret'), false);
        return true;
      },
    );
  }
});

test('rejects server errors that echo a request-body value', async () => {
  const client = await clientForFetch('client-error-body-echo', async () => jsonResponse({
    apiVersion: '1',
    ok: false,
    operation: 'agent.echo',
    error: {
      code: 'CONFLICT',
      message: 'request-body-secret',
      details: { echo: 'request-body-secret' },
    },
  }, 409));

  await assert.rejects(
    () => client.request({
      method: 'POST',
      path: '/api/v1/agent/echo',
      operation: 'agent.echo',
      body: { secret: 'request-body-secret' },
      idempotencyKey: 'body-echo-key',
    }),
    (error: unknown) => {
      assert.equal(error instanceof Error && 'code' in error && error.code === 'INTEGRITY_ERROR', true);
      assert.equal(error instanceof Error && error.message, 'Server response is invalid');
      return true;
    },
  );
});

test('maps network failures and aborts to fixed service-unavailable without retrying writes', async () => {
  const writeKey = 'network-write-key';
  let networkCalls = 0;
  const networkClient = await clientForFetch('client-network-failure', async () => {
    networkCalls += 1;
    throw new Error('raw network detail with http://127.0.0.1:49152 and network-write-key');
  });
  await assert.rejects(
    () => networkClient.request({ method: 'POST', path: '/api/v1/agent/network', operation: 'agent.network', body: { value: 'request-secret' }, idempotencyKey: writeKey }),
    (error: unknown) => {
      assert.equal(error instanceof Error && 'code' in error && error.code === 'SERVICE_UNAVAILABLE', true);
      assert.equal(error instanceof Error && error.message, 'Kiokuko server is unavailable');
      const details = error instanceof Error && 'details' in error ? JSON.stringify(error.details) : '';
      assert.equal(details, '{}');
      assert.equal(error instanceof Error && error.message.includes('network-write-key'), false);
      assert.equal(error instanceof Error && error.message.includes('127.0.0.1'), false);
      return true;
    },
  );
  assert.equal(networkCalls, 1);

  let abortCalls = 0;
  const abortClient = await clientForFetch('client-abort', async () => {
    abortCalls += 1;
    throw new DOMException('aborted with raw secret', 'AbortError');
  });
  await assert.rejects(
    () => abortClient.request({ method: 'GET', path: '/api/v1/agent/abort', operation: 'agent.abort' }),
    (error: unknown) => error instanceof Error && 'code' in error && error.code === 'SERVICE_UNAVAILABLE',
  );
  assert.equal(abortCalls, 1);
});

test('allows bounded read queries and handles health-only responses without inventing v1 data', async () => {
  const requestedUrls: string[] = [];
  const client = await clientForFetch('client-query-health', async (input) => {
    requestedUrls.push(input);
    if (requestedUrls.length === 1) return jsonResponse({ apiVersion: '1', ok: true, operation: 'agent.list', data: { items: [] } });
    if (requestedUrls.length === 2) return jsonResponse({ ok: true });
    return new Response(null, { status: 204 });
  });

  const list = await client.request<{ items: unknown[] }>({
    method: 'GET',
    path: '/api/v1/agent/list?cursor=opaque-cursor&limit=10',
    operation: 'agent.list',
  });
  assert.deepEqual(list, { items: [] });
  assert.equal(requestedUrls[0], 'http://127.0.0.1:49152/api/v1/agent/list?cursor=opaque-cursor&limit=10');

  const health = await client.request<{ ok: true }>({ method: 'GET', path: '/health/ready', operation: 'health.ready' });
  assert.deepEqual(health, { ok: true });
  const emptyHealth = await client.request({ method: 'GET', path: '/health/ready', operation: 'health.ready' });
  assert.equal(emptyHealth, undefined);
});

test('client foundation has no SQLite import or direct-service fallback', async () => {
  const source = await Promise.all([
    readFile(new URL('../../src/client/runtime-discovery.ts', import.meta.url), 'utf8'),
    readFile(new URL('../../src/client/server-client.ts', import.meta.url), 'utf8'),
  ]);
  const combined = source.join('\n');
  assert.equal(/node:sqlite|better-sqlite|sqlite3|openConnection|directService|direct-service/i.test(combined), false);
});
