import assert from 'node:assert/strict';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createHuggingFaceModelDownloader } from '../../src/embedding/model-download.js';
import { LOCAL_SMALL_PRESET } from '../../src/embedding/presets/local-small.js';
import { installLocalModel } from '../../src/embedding/model-installation.js';

const preset = { ...LOCAL_SMALL_PRESET, files: [{ path: 'config.json', size: 3, sha256: 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad' }] };
const deferred = () => { let resolve!: () => void; const promise = new Promise<void>((r) => { resolve = r; }); return { promise, resolve }; };

for (const stage of ['metadata-request', 'web-body', 'xet-token', 'xet-reconstruction-body'] as const) {
  test(`caller abort reaches actual Hub SDK ${stage} and prevents installation`, { timeout: 5000 }, async (t) => {
    const directory = await mkdtemp(path.join(tmpdir(), 'kiokuko-download-abort-'));
    t.after(() => rm(directory, { recursive: true, force: true }));
    const caller = new AbortController(); const entered = deferred(); const transportAborted = deferred();
    const unique = encodeURIComponent(directory);
    let calls = 0; let progress = 0; let suppliedSignal: AbortSignal | null | undefined;
    const stall = (signal: AbortSignal | null | undefined, body: boolean): Promise<Response> => {
      suppliedSignal = signal; entered.resolve();
      const onAbort = (reject: (reason: unknown) => void) => {
        const handler = () => { transportAborted.resolve(); reject(signal?.reason); };
        if (signal?.aborted) handler(); else signal?.addEventListener('abort', handler, { once: true });
      };
      if (!body) return new Promise((_resolve, reject) => onAbort(reject));
      return Promise.resolve(new Response(new ReadableStream({ start(controller) { onAbort((reason) => controller.error(reason)); } })));
    };
    t.mock.method(globalThis, 'fetch', async (_input: RequestInfo | URL, init?: RequestInit) => {
      calls++;
      if (stage === 'metadata-request') return stall(init?.signal, false);
      if (calls === 1) return new Response('', { headers: stage === 'web-body'
        ? { 'Content-Range': 'bytes 0-0/3', ETag: 'fixture' }
        : { 'Content-Type': 'application/vnd.xet-fileinfo+json', 'X-Linked-Size': '3', 'X-Xet-Hash': 'a'.repeat(64), ETag: 'fixture', Link: `<https://fixture.invalid/${unique}/token>; rel="xet-auth", <https://fixture.invalid/v1/reconstructions/${unique}>; rel="xet-reconstruction-info"` } });
      if (stage === 'web-body') return stall(init?.signal, true);
      if (stage === 'xet-token') return stall(init?.signal, false);
      if (calls === 2) return Response.json({ accessToken: 'test-only', casUrl: 'https://fixture.invalid', exp: Math.floor(Date.now() / 1000) + 1000 });
      return stall(init?.signal, true);
    });
    const pending = installLocalModel(preset, { env: { ...process.env, KIOKUKO_DATA_DIR: directory }, signal: caller.signal, onProgress: () => { progress++; } });
    const rejection = assert.rejects(pending, { code: 'SERVICE_UNAVAILABLE' });
    await entered.promise;
    assert.ok(suppliedSignal, 'actual SDK transport must receive an AbortSignal');
    caller.abort();
    await rejection;
    await transportAborted.promise;
    assert.equal(progress, 0);
    const paths = await readdir(directory, { recursive: true });
    assert.ok(!paths.some((name) => name.endsWith('config.json') || name.endsWith('manifest.json') || name.endsWith(preset.revision)), 'no model publication or staged artifact');
  });
}

for (const abortSource of ['caller', 'request', 'init'] as const) {
  test(`custom fetch preserves ${abortSource} cancellation`, async (t) => {
    const directory = await mkdtemp(path.join(tmpdir(), 'kiokuko-signals-'));
    t.after(() => rm(directory, { recursive: true, force: true }));
    const signals = { caller: new AbortController(), request: new AbortController(), init: new AbortController() };
    let observed: AbortSignal | null | undefined;
    t.mock.method(globalThis, 'fetch', async (_input: RequestInfo | URL, init?: RequestInit) => { observed = init?.signal; return new Response('abc'); });
    const downloader = createHuggingFaceModelDownloader({ downloadFile: async (params) => {
      assert.ok(params.fetch);
      await params.fetch(new Request('https://fixture.invalid', { signal: signals.request.signal }), { signal: signals.init.signal });
      signals[abortSource].abort();
      assert.equal(observed?.aborted, true);
      return new Blob(['abc']);
    } });
    if (abortSource === 'caller') await assert.rejects(downloader.download(preset, directory, { signal: signals.caller.signal }), { code: 'SERVICE_UNAVAILABLE' });
    else await downloader.download(preset, directory, { signal: signals.caller.signal });
  });
}

test('pre-aborted downloads make no request', async (t) => {
  const directory = await mkdtemp(path.join(tmpdir(), 'kiokuko-preabort-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  let calls = 0; const controller = new AbortController(); controller.abort();
  const downloader = createHuggingFaceModelDownloader({ downloadFile: async () => { calls++; return new Blob(['abc']); } });
  await assert.rejects(downloader.download(preset, directory, { signal: controller.signal }), { code: 'SERVICE_UNAVAILABLE' });
  assert.equal(calls, 0);
});

for (const stage of ['request', 'body'] as const) {
  test(`abort promptly rejects a noncooperating ${stage} promise`, { timeout: 2000 }, async (t) => {
    const directory = await mkdtemp(path.join(tmpdir(), 'kiokuko-noncooperating-'));
    t.after(() => rm(directory, { recursive: true, force: true }));
    const caller = new AbortController(); const entered = deferred();
    let release!: () => void;
    const wait = new Promise<void>((resolve) => { release = resolve; });
    t.after(release);
    class SlowBlob extends Blob {
      override async arrayBuffer(): Promise<ArrayBuffer> { entered.resolve(); await wait; return super.arrayBuffer(); }
    }
    const downloader = createHuggingFaceModelDownloader({ downloadFile: async () => {
      if (stage === 'request') { entered.resolve(); await wait; }
      return new SlowBlob(['abc']);
    } });
    const pending = downloader.download(preset, directory, { signal: caller.signal });
    const rejection = assert.rejects(pending, { code: 'SERVICE_UNAVAILABLE' });
    await entered.promise; caller.abort(); await rejection;
    assert.deepEqual(await readdir(directory), []);
  });
}

test('abort at the final progress callback prevents publication and clears staging', async (t) => {
  const directory = await mkdtemp(path.join(tmpdir(), 'kiokuko-final-abort-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const caller = new AbortController();
  const downloader = createHuggingFaceModelDownloader({ downloadFile: async () => new Blob(['abc']) });
  await assert.rejects(installLocalModel(preset, { env: { KIOKUKO_DATA_DIR: directory }, downloader, signal: caller.signal, onProgress: () => caller.abort() }), { code: 'SERVICE_UNAVAILABLE' });
  const paths = await readdir(directory, { recursive: true });
  assert.ok(!paths.some((name) => name.endsWith('config.json') || name.endsWith(preset.revision)));
});

test('installer rejects a downloader that aborts just before returning a complete staged model', async (t) => {
  const directory = await mkdtemp(path.join(tmpdir(), 'kiokuko-publish-abort-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const caller = new AbortController();
  const real = createHuggingFaceModelDownloader({ downloadFile: async () => new Blob(['abc']) });
  const downloader = { download: async (...args: Parameters<typeof real.download>) => { const result = await real.download(...args); caller.abort(); return result; } };
  await assert.rejects(installLocalModel(preset, { env: { KIOKUKO_DATA_DIR: directory }, downloader, signal: caller.signal }), { code: 'SERVICE_UNAVAILABLE' });
  const paths = await readdir(directory, { recursive: true });
  assert.ok(!paths.some((name) => name.endsWith('config.json') || name.endsWith(preset.revision)));
});
