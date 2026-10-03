import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, writeFile, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createServer } from 'node:http';
import type { Socket } from 'node:net';
import { once } from 'node:events';
const exec = promisify(execFile);
const cli = path.resolve('src/bin/kiokuko.ts');
async function wait<T>(read: () => Promise<T>, check: (value: T) => boolean, ms = 15000): Promise<T> {
  const until = Date.now() + ms;
  for (;;) { const value = await read(); if (check(value)) return value; if (Date.now() > until) throw new Error('Observation deadline'); await new Promise(r => setTimeout(r, 50)); }
}
test('managed CLI status, duplicate ownership, signal forwarding and credential-free diagnostics', { timeout: 20000 }, async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'kiokuko-runner-'));
  const fake = path.join(dir, 'tunnel-client');
  await writeFile(fake, `#!/usr/bin/env node
if (process.argv.includes('--version')) { console.log('0.0.14+0f870e5 (git sha: 0f870e5)'); process.exit(0); }
const log = msg => console.log(JSON.stringify({component:'controlplane',level:'WARN',msg,error:'read: connection reset by peer',retry_in_ms:200}));
log('poll failed; backing off'); log('poll failed; backing off'); log('poll failed; backing off');
process.on('SIGTERM',()=>process.exit(0)); setInterval(()=>{},1000);
`, { mode: 0o700 });
  const env = { ...process.env, KIOKUKO_DATA_DIR: dir };
  const args = ['--import', 'tsx', cli, 'chatgpt', 'run', '--tunnel-client', fake, '--profile-dir', dir];
  const child = spawn(process.execPath, args, { env, stdio: ['ignore', 'pipe', 'pipe'] });
  let output = ''; child.stderr.on('data', b => output += b);
  const closed = once(child, 'close');
  try {
    const status = async () => JSON.parse((await exec(process.execPath, ['--import', 'tsx', cli, 'chatgpt', 'status', '--profile-dir', dir, '--json'], { env })).stdout);
    const current = await wait(status, s => s.polling.failures === 3);
    assert.equal(current.polling.state, 'degraded'); assert.equal(current.processRunning, true);
    assert.equal(output.split('\n').filter(s => s.includes('poll_failed')).length, 1);
    await assert.rejects(exec(process.execPath, args, { env, timeout: 3000 }));
    child.kill('SIGTERM'); await closed;
    assert.equal((await status()).processRunning, false);
    assert.ok(!(await readdir(path.join(dir, 'chatgpt'))).some(p => p.endsWith('.lock')));
  } finally { child.kill('SIGKILL'); await rm(dir, { recursive: true, force: true }); }
});
const realBinary = process.env.KIOKUKO_TUNNEL_CLIENT;
test('unmodified tunnel-client retries HTTP/transport failures without a new process', { skip: !realBinary, timeout: 60000 }, async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'kiokuko-real-tunnel-'));
  let mode: number | 'reset' | 'stall' | 'malformed' = 204; let polls = 0; let failed = false; let lastSuccessSocket: Socket | undefined; let reusedReset = false;
  const requests: number[] = [];
  const server = createServer((req, res) => {
    if (!req.url?.includes('/poll')) { res.setHeader('content-type', 'application/json'); res.end('{"id":"tunnel_22222222222222222222222222222222"}'); return; }
    polls++; requests.push(Date.now());
    if (!failed && mode !== 204 && mode !== 200) {
      failed = true;
      if (mode === 'reset') { reusedReset = req.socket === lastSuccessSocket; res.writeHead(200, { 'content-length': '100' }); res.write('{'); setTimeout(() => req.socket.resetAndDestroy(), 20); return; }
      if (mode === 'stall') return;
      if (mode === 'malformed') { res.end('invalid JSON'); return; }
      res.writeHead(mode, { 'Retry-After': mode === 429 ? '1' : '0' }); res.end('{}'); return;
    }
    lastSuccessSocket = req.socket;
    setTimeout(() => { if (mode === 200) { res.writeHead(200); res.end('{"commands":[]}'); } else { res.writeHead(204); res.end(); } }, 50);
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening'); const port = (server.address() as {port:number}).port;
  await writeFile(path.join(dir, 'kiokuko-chatgpt.yaml'), 'control_plane:\n  tunnel_id: tunnel_22222222222222222222222222222222\n');
  const env = { ...process.env, KIOKUKO_DATA_DIR: dir, CONTROL_PLANE_BASE_URL: `http://127.0.0.1:${port}`,
    CONTROL_PLANE_API_KEY: 'sk-local-fixture-000000000000000000000000', CONTROL_PLANE_POLL_TIMEOUT: '100ms', CONTROL_PLANE_POLL_DEADLINE_GUARDRAIL: '100ms',
    MCP_COMMAND: `${process.execPath} --import tsx ${cli} mcp --profile chatgpt-memory`, HTTP_PROXY: '', HTTPS_PROXY: '' };
  // Policy tool does not require DB; startup does, so use the repository's init command in this disposable data directory.
  await exec(process.execPath, ['--import', 'tsx', cli, 'init'], { env });
  let child = spawn(process.execPath, ['--import', 'tsx', cli, 'chatgpt', 'run', '--profile-dir', dir, '--tunnel-client', realBinary!], { env });
  let stderr = ''; child.stderr?.on('data', b => stderr += b); child.stdout?.resume(); let closed = once(child, 'close');
  const snapshot = async () => { try { const files = await readdir(path.join(dir, 'chatgpt')); const f = files.find(p => p.endsWith('.json')); return f ? JSON.parse(await readFile(path.join(dir, 'chatgpt', f), 'utf8')) : null; } catch { return null; } };
  try {
    const first = await wait(snapshot, s => s?.polling.state === 'operational'); const pid = first.pid;
    for (const next of [200, 'reset', 'stall', 401, 403, 429, 503, 'malformed'] as const) {
      mode = next; failed = false; const baseline = polls;
      await wait(snapshot, s => polls > baseline + 2 && s?.polling.state === 'operational');
      assert.equal((await snapshot()).pid, pid);
    }
    assert.equal(reusedReset, true, 'reset must exercise a reused connection');
    mode = 204; server.closeAllConnections(); await new Promise<void>(r => server.close(() => r()));
    await wait(snapshot, s => s?.polling.state === 'degraded' && s?.polling.category === 'network');
    server.listen(port, '127.0.0.1'); await once(server, 'listening');
    await wait(snapshot, s => s?.polling.state === 'operational'); assert.equal((await snapshot()).pid, pid);
    mode = 429; failed = false; await wait(snapshot, s => s?.polling.category === 'http_429');
    const failureTime = requests.at(-1)!; await wait(snapshot, s => s?.polling.state === 'operational');
    assert.ok(requests.some(t => t - failureTime >= 900));
    mode = 429; failed = false; await wait(snapshot, s => s?.polling.category === 'http_429');
    const cancelledAt = Date.now(); child.kill('SIGTERM'); await closed; assert.ok(Date.now() - cancelledAt < 3000);
    mode = 'stall'; failed = false;
    child = spawn(process.execPath, ['--import', 'tsx', cli, 'chatgpt', 'run', '--profile-dir', dir, '--tunnel-client', realBinary!], { env });
    child.stderr?.on('data', b => stderr += b); child.stdout?.resume(); closed = once(child, 'close');
    await wait(snapshot, () => failed); const requestCancelledAt = Date.now(); child.kill('SIGTERM'); await closed;
    assert.ok(Date.now() - requestCancelledAt < 3000);
    assert.ok(!stderr.includes('sk-local-fixture'));
    console.log(JSON.stringify({ binary: realBinary, version: first.version, scenarios: ['200', '204', 'reset', 'deadline', '401', '403', '429', '503', 'malformed', 'backoff cancellation', 'request cancellation', 'disconnect/reconnect'], childPid: pid }));
  } finally { child.kill('SIGKILL'); server.closeAllConnections(); await new Promise<void>(r => server.close(() => r())); await rm(dir, { recursive: true, force: true }); }
});
test('unresponsive owned child is force-terminated after the bounded shutdown grace', { timeout: 20000, skip: process.platform === 'win32' }, async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'kiokuko-stubborn-tunnel-'));
  const fake = path.join(dir, 'tunnel-client');
  await writeFile(fake, `#!/usr/bin/env node
if(process.argv.includes('--version')) { console.log('0.0.14'); process.exit(0); }
process.on('SIGTERM',()=>{}); console.log(JSON.stringify({level:'INFO',msg:'started'})); setInterval(()=>{},1000);
`, { mode: 0o700 });
  const env = { ...process.env, KIOKUKO_DATA_DIR: dir };
  const child = spawn(process.execPath, ['--import', 'tsx', cli, 'chatgpt', 'run', '--tunnel-client', fake, '--profile-dir', dir], { env });
  child.stdout?.resume(); child.stderr?.resume(); const closed = once(child, 'close');
  const read = async () => { try { const result = await exec(process.execPath, ['--import', 'tsx', cli, 'chatgpt', 'status', '--profile-dir', dir, '--json'], { env }); return JSON.parse(result.stdout); } catch { return null; } };
  try {
    const status = await wait(read, s => s?.processRunning === true);
    await new Promise(r => setTimeout(r, 300)); const start = Date.now(); child.kill('SIGTERM'); await closed;
    assert.ok(Date.now() - start < 14000); assert.throws(() => process.kill(status.pid, 0), /ESRCH/);
  } finally { child.kill('SIGKILL'); await rm(dir, { recursive: true, force: true }); }
});
