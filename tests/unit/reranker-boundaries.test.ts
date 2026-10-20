import assert from 'node:assert/strict';
import { spawn, spawnSync, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { LocalRerankerRuntime } from '../../src/reranker/runtime.js';

const runtimeUrl = new URL('../../src/reranker/runtime.ts', import.meta.url).href;
const fixture = async (source: string) => {
  const directory = await mkdtemp(join(tmpdir(), 'reranker-boundaries-'));
  const path = join(directory, 'worker.mjs');
  await writeFile(path, source);
  return { directory, path };
};
const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };

for (const phase of ['initialization', 'inference']) {
  for (const value of [null, [], 1, 'ready', { type: 'unknown' }, { type: 'scores', id: -1, scores: [] }, { type: 'scores', id: 999, scores: [] }, { type: 'ready', id: 1 }]) {
    test(`malformed ${phase} envelope survives host: ${JSON.stringify(value)}`, async () => {
      const output = JSON.stringify(JSON.stringify(value) + '\n');
      const f = await fixture(`import { createInterface } from 'node:readline';
        ${phase === 'inference' ? `process.stdout.write('{"type":"ready"}\\n'); createInterface({ input: process.stdin }).once('line', () => process.stdout.write(${output}));` : `process.stdout.write(${output}); setInterval(() => {}, 1000);`}`);
      try {
        const result = spawnSync(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', `
          import { LocalRerankerRuntime } from ${JSON.stringify(runtimeUrl)};
          const runtime = new LocalRerankerRuntime({ workerPath: ${JSON.stringify(f.path)}, modelDirectory: 'unused', timeoutMs: 2000 });
          try { await runtime.score([{query:'q',document:'d'}]); process.exitCode=9; }
          catch (e) { if(e.code !== 'INTEGRITY_ERROR') throw e; }
          finally { await runtime.close(); }
          console.log('host-survived');
        `], { encoding: 'utf8', timeout: 6000 });
        assert.equal(result.status, 0, result.stderr);
        assert.match(result.stdout, /host-survived/);
      } finally { await rm(f.directory, { recursive: true, force: true }); }
    });
  }
}

test('duplicate ready after initialization is rejected rather than ignored', async () => {
  const f = await fixture(`import { createInterface } from 'node:readline'; process.stdout.write('{"type":"ready"}\\n'); createInterface({input:process.stdin}).once('line',()=>process.stdout.write('{"type":"ready"}\\n'));`);
  const runtime = new LocalRerankerRuntime({ workerPath: f.path, modelDirectory:'unused', timeoutMs: 1000 });
  try { await assert.rejects(runtime.score([{query:'q',document:'d'}]), { code:'INTEGRITY_ERROR' }); }
  finally { await runtime.close(); await rm(f.directory, {recursive:true,force:true}); }
});

for (const initialize of [false, true]) {
  test(`close awaits retired SIGTERM-resistant child after ${initialize ? 'inference' : 'initialization'} timeout`, async () => {
    const f = await fixture(`process.on('SIGTERM',()=>{}); ${initialize ? `process.stdout.write('{"type":"ready"}\\n');` : ''} setInterval(()=>{},1000);`);
    const children: ChildProcessWithoutNullStreams[] = [];
    const runtime = new LocalRerankerRuntime({ workerPath:f.path, modelDirectory:'unused', timeoutMs:200,
      spawn: ((...args: Parameters<typeof spawn>) => { const child = spawn(...args) as ChildProcessWithoutNullStreams; children.push(child); return child; }) as typeof spawn });
    try {
      await assert.rejects(runtime.score([{query:'q',document:'d'}]), {code:'SERVICE_UNAVAILABLE'});
      assert.ok(alive(children[0]!.pid!));
      const closing = runtime.close();
      const repeated = runtime.close();
      await repeated;
      assert.equal(alive(children[0]!.pid!), false, 'repeated close must wait for actual exit');
      await closing;
      assert.equal(repeated, closing, 'all callers must share the actual exit barrier');
    } finally {
      // Only our own disposable fixtures can need cleanup on the red baseline.
      for (const child of children) if (child.pid && alive(child.pid)) child.kill('SIGKILL');
      await runtime.close(); await rm(f.directory,{recursive:true,force:true});
    }
  });
}

test('active abort permits queued replacement; retiring child output cannot corrupt new generation', async () => {
  const f = await fixture(`import { createInterface } from 'node:readline';
    process.on('SIGTERM',()=>{ process.stdout.write('null\\n'); setTimeout(()=>process.stdout.write('{"type":"ready"}\\n'),30); });
    process.stdout.write('{"type":"ready"}\\n');
    createInterface({input:process.stdin}).on('line',line=>{const x=JSON.parse(line); if(x.pairs[0].document==='next') setTimeout(()=>process.stdout.write(JSON.stringify({type:'scores',id:x.id,scores:[{score:7}]})+'\\n'),100);});`);
  const runtime = new LocalRerankerRuntime({ workerPath:f.path,modelDirectory:'unused',timeoutMs:4000 });
  const controller = new AbortController();
  const first = runtime.score([{query:'q',document:'wait'}],{signal:controller.signal});
  const rejected = assert.rejects(first,{code:'SERVICE_UNAVAILABLE'});
  const next = runtime.score([{query:'q',document:'next'}]);
  setTimeout(()=>controller.abort(),100);
  try { await rejected; assert.deepEqual(await next,[{score:7}]); }
  finally { await runtime.close(); await rm(f.directory,{recursive:true,force:true}); }
});

test('queued abort removes only that job and leaves active worker usable', async () => {
  const workerPath = new URL('../fixtures/reranker-worker-fixture.mjs', import.meta.url);
  const runtime = new LocalRerankerRuntime({ workerPath:fileURLToPath(workerPath),modelDirectory:'delay-100',timeoutMs:2000 });
  const controller = new AbortController();
  const first = runtime.score([{query:'q',document:'first'}]);
  const queued = runtime.score([{query:'q',document:'queued'}],{signal:controller.signal});
  const rejected = assert.rejects(queued,{code:'SERVICE_UNAVAILABLE'});
  controller.abort();
  try { await rejected; assert.deepEqual(await first,[{score:5}]); assert.deepEqual(await runtime.score([{query:'q',document:'next'}]),[{score:4}]); }
  finally { await runtime.close(); }
});
