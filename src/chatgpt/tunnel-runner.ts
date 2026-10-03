import { execFile, spawn, type ChildProcess } from 'node:child_process';
import { createHash } from 'node:crypto';
import { lstat, mkdir, mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import { promisify } from 'node:util';
import { getRuntimeDirectory } from '../config/paths.js';
import { sanitizeJson } from '../security/sanitize.js';
import { KiokukoError } from '../errors.js';
import { acquireInstanceLock, isPidAlive } from '../server/instance-lock.js';
import { PollDiagnostics, type DiagnosticEvent } from './poll-diagnostics.js';
import { BoundedLogStream } from './log-stream.js';
const execute = promisify(execFile);
export interface TunnelOptions { profile?: string; profileDir?: string; tunnelClient?: string }
function locations(options: TunnelOptions) {
  const profile = options.profile ?? 'kiokuko-chatgpt';
  if (!/^[a-zA-Z0-9_-]{1,128}$/.test(profile)) throw new KiokukoError('USAGE_ERROR', 'Invalid tunnel profile name');
  const profileDir = path.resolve(options.profileDir ?? process.env.TUNNEL_CLIENT_PROFILE_DIR ?? path.join(process.env.XDG_CONFIG_HOME ?? path.join(process.env.HOME ?? '', '.config'), 'tunnel-client'));
  const identity = path.join(profileDir, profile + '.yaml');
  const root = path.join(getRuntimeDirectory(), 'chatgpt');
  const file = path.join(root, createHash('sha256').update(identity).digest('hex') + '.json');
  return { profile, profileDir, identity, root, file };
}
export interface TunnelSnapshot {
  schemaVersion: 1; instanceId: string; supervisorPid: number; pid: number | null; processRunning: boolean;
  version: string; exitCode: number | null; terminationSignal: NodeJS.Signals | null; updatedAt: number; ready: boolean | null; live: boolean | null;
  polling: { state: string; failures: number; category: string | null; lastSuccess: number | null; lastFailure: number | null; retryInMs: number | null; deadlineMs: number | null; attempt: number; durationMs: number | null; requestId: string | null };
  events: DiagnosticEvent[];
}
async function boundedGet(url: string): Promise<{ ok: boolean; body: string }> {
  const response = await fetch(url, { signal: AbortSignal.timeout(2000), redirect: 'error' });
  const reader = response.body?.getReader(); let body = ''; let bytes = 0;
  try { if (reader) for (;;) { const chunk = await reader.read(); if (chunk.done) break; bytes += chunk.value.length; if (bytes > 1024 * 1024) throw new Error('Health response too large'); body += Buffer.from(chunk.value).toString('utf8'); } }
  finally { await reader?.cancel(); }
  return { ok: response.ok, body };
}
async function terminate(child: ChildProcess, signal: NodeJS.Signals): Promise<void> {
  if (!child.pid) return;
  if (process.platform === 'win32') { await execute('taskkill', ['/PID', String(child.pid), '/T', ...(signal === 'SIGKILL' ? ['/F'] : [])]).catch(() => undefined); }
  else { try { process.kill(-child.pid, signal); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error; } }
}
export async function runTunnel(options: TunnelOptions): Promise<void> {
  const loc = locations(options); await mkdir(loc.root, { recursive: true, mode: 0o700 });
  const lock = await acquireInstanceLock(loc.identity, { runtimeDirectory: loc.root });
  const instanceId = lock.instanceId; const diagnostics = new PollDiagnostics();
  let child: ChildProcess | undefined; let temp: string | undefined; let stopping = false;
  let ready: boolean | null = null; let live: boolean | null = null; let version = 'unknown'; let exitCode: number | null = null; let terminationSignal: NodeJS.Signals | null = null; let timer: NodeJS.Timeout | undefined; let killTimer: NodeJS.Timeout | undefined;
  let writes: Promise<void> = Promise.resolve(); let saving = false; let dirty = false; let ended = false; let probing = false;
  const snapshot = (): TunnelSnapshot => ({ schemaVersion: 1, instanceId, supervisorPid: process.pid, pid: child?.pid ?? null,
    processRunning: !ended && child?.pid !== undefined, version, exitCode, terminationSignal, updatedAt: Date.now(), ready, live,
    polling: { state: diagnostics.state, failures: diagnostics.failures, category: diagnostics.category, lastSuccess: diagnostics.lastSuccess, lastFailure: diagnostics.lastFailure,
      retryInMs: diagnostics.retryInMs, deadlineMs: diagnostics.deadlineMs, attempt: diagnostics.attempt, durationMs: diagnostics.durationMs, requestId: diagnostics.requestId }, events: diagnostics.events.slice() });
  const persist = () => {
    dirty = true; if (saving) return; saving = true;
    writes = (async () => {
      while (dirty) {
        dirty = false; const staging = loc.file + '.' + instanceId;
        await writeFile(staging, JSON.stringify(sanitizeJson(snapshot()).value), { mode: 0o600 }); await rename(staging, loc.file);
      }
    })().finally(() => { saving = false; });
    writes.catch(() => { process.exitCode = 1; stop('SIGTERM'); });
  };
  let outputBlocked = false; let outputLost = false;
  process.stderr.on('drain', drained);
  function drained() { outputBlocked = false; if (outputLost) { outputLost = false; emit(diagnostics.unknown(Date.now())); } }
  function emit(event: DiagnosticEvent | undefined) {
    if (!event || event.level === 'DEBUG') return;
    if (outputBlocked) { outputLost = true; return; }
    outputBlocked = !process.stderr.write(JSON.stringify(sanitizeJson(event).value) + '\n');
  }
  function stop(signal: NodeJS.Signals) {
    if (stopping) return; stopping = true; diagnostics.state = 'stopped';
    if (child) { void terminate(child, signal).catch(() => { process.exitCode = 1; }); killTimer = setTimeout(() => { if (child) void terminate(child, 'SIGKILL').catch(() => { process.exitCode = 1; }); }, 10000); }
  }
  const interrupt = () => stop('SIGINT'); const shutdown = () => stop('SIGTERM');
  try {
    const binary = options.tunnelClient ?? 'tunnel-client';
    const result = await execute(binary, ['--version'], { timeout: 2000, maxBuffer: 8192 });
    const match = result.stdout.trim().match(/^(?:tunnel-client\s+)?(\d+\.\d+\.\d+(?:\+[a-zA-Z0-9]+)?)(?: \(git sha: ([a-zA-Z0-9]+)\))?$/);
    version = match ? match[0] : 'unknown';
    temp = await mkdtemp(path.join(loc.root, 'run-')); const healthFile = path.join(temp, 'health-url');
    child = spawn(binary, ['run', '--profile', loc.profile, '--profile-dir', loc.profileDir,
      '--log.format', 'json', '--log.level', 'debug', '--log.file', '', '--log.http-raw-unsafe=false', '--harpoon.capture-payloads=false',
      '--health.listen-addr', '127.0.0.1:0', '--health.unix-socket=', '--health.url-file', healthFile, '--allow-remote-ui=false', '--open-web-ui=false'],
    { stdio: ['ignore', 'pipe', 'pipe'], detached: process.platform !== 'win32' });
    child.once('exit', () => { if (process.platform !== 'win32') void terminate(child!, 'SIGTERM').catch(() => { process.exitCode = 1; }); });
    const closed = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve, reject) => {
      child!.once('error', reject); child!.once('close', (code, signal) => resolve({ code, signal }));
    });
    for (const stream of [child.stdout!, child.stderr!]) {
      const parser = new BoundedLogStream(line => { emit(diagnostics.line(line, Date.now(), performance.now())); persist(); }, () => { emit(diagnostics.unknown(Date.now())); persist(); });
      stream.on('data', (chunk: Buffer) => parser.push(chunk)); stream.once('end', () => parser.end());
    }
    process.on('SIGINT', interrupt); process.on('SIGTERM', shutdown); persist();
    const probe = async () => {
      if (probing || stopping || ended) return; probing = true;
      try {
        const url = new URL((await readFile(healthFile, 'utf8')).trim());
        if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1' || url.username || url.password || !url.port || url.pathname !== '/') throw new Error('Invalid health URL');
        const results = await Promise.all([boundedGet(new URL('/healthz', url).href), boundedGet(new URL('/readyz', url).href), boundedGet(new URL('/metrics', url).href)]);
        if (stopping || ended) return;
        live = results[0]!.ok; ready = results[1]!.ok;
        const metrics = results[2]!;
        const match = metrics.body.match(/^\w*commands_poll_last_successful_timestamp_seconds(?:\{[^\n]*\})?\s+([\d.eE+-]+)\s*$/m);
        if (metrics.ok && match) emit(diagnostics.metrics(Number(match[1]))); else emit(diagnostics.unknown(Date.now()));
      } catch { if (!stopping && !ended) { live = null; ready = null; emit(diagnostics.unknown(Date.now())); } }
      finally { probing = false; if (!ended) persist(); }
    };
    timer = setInterval(() => { void probe(); }, 5000);
    const exit = await closed; ended = true; exitCode = exit.code; terminationSignal = exit.signal;
    if (!stopping && exit.code !== 0) { emit(diagnostics.record(Date.now(), 'WARN', 'upstream_exited')); process.exitCode = exit.code ?? 1; }
    diagnostics.state = 'stopped'; live = false; ready = false; persist(); await writes;
  } finally {
    ended = true; if (timer) clearInterval(timer); if (killTimer) clearTimeout(killTimer);
    process.off('SIGINT', interrupt); process.off('SIGTERM', shutdown); process.stderr.off('drain', drained);
    if (child && child.exitCode === null && child.signalCode === null) await terminate(child, 'SIGKILL');
    if (temp) await rm(temp, { recursive: true, force: true }); await lock.release();
  }
}
export async function tunnelStatus(options: TunnelOptions): Promise<unknown> {
  const file = locations(options).file;
  let stat;
  try { stat = await lstat(file); } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { schemaVersion: 1, processRunning: false, polling: { state: 'stopped' } }; throw error; }
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 1024 * 1024 || (process.platform !== 'win32' && (stat.mode & 0o077))) throw new KiokukoError('SECURITY_REJECTION', 'Unsafe tunnel snapshot');
  const nullableNumber = z.number().finite().nonnegative().nullable();
  const value = z.object({
    schemaVersion: z.literal(1), instanceId: z.string().uuid(), supervisorPid: z.number().int().positive(), pid: z.number().int().positive().nullable(),
    processRunning: z.boolean(), exitCode: z.number().int().nullable(), terminationSignal: z.string().regex(/^SIG[A-Z0-9]+$/).nullable(), version: z.string().max(256).regex(/^(?:unknown|[a-zA-Z0-9.+ ():-]+)$/), updatedAt: z.number().finite(), ready: z.boolean().nullable(), live: z.boolean().nullable(),
    polling: z.object({ state: z.enum(['starting', 'operational', 'degraded', 'unknown', 'stopped']), failures: z.number().int().nonnegative(),
      category: z.enum(['unknown', 'network', 'timeout', 'certificate', 'malformed_response']).or(z.string().regex(/^http_\d{3}$/)).nullable(),
      lastSuccess: nullableNumber, lastFailure: nullableNumber, retryInMs: nullableNumber, deadlineMs: nullableNumber,
      attempt: z.number().int().nonnegative(), durationMs: nullableNumber, requestId: z.string().regex(/^req_[a-zA-Z0-9_-]{1,128}$/).nullable() }),
  }).parse(JSON.parse(await readFile(file, 'utf8')));
  if (value.schemaVersion !== 1 || !Number.isSafeInteger(value.supervisorPid) || value.supervisorPid <= 0 || !value.polling || !Number.isFinite(value.updatedAt)) throw new KiokukoError('VALIDATION_ERROR', 'Invalid tunnel snapshot');
  let owned = false;
  try {
    const lockFile = file.replace(/\.json$/, '.lock'); const info = await lstat(lockFile);
    if (info.isFile() && !info.isSymbolicLink() && info.size <= 512 && (process.platform === 'win32' || (info.mode & 0o077) === 0)) {
      const owner = z.object({ pid: z.number().int().positive(), instanceId: z.string().uuid() }).parse(JSON.parse(await readFile(lockFile, 'utf8')));
      owned = owner.pid === value.supervisorPid && owner.instanceId === value.instanceId;
    }
  } catch { /* Missing or untrusted ownership never establishes a live runtime. */ }
  const alive = owned && value.processRunning && await isPidAlive(value.supervisorPid) && value.pid !== null && await isPidAlive(value.pid);
  const stale = Date.now() - value.updatedAt > 15000 || Date.now() < value.updatedAt;
  // Return only generated diagnostic fields, never arbitrary file content.
  return { schemaVersion: 1, processRunning: alive, stale, pid: value.pid, supervisorPid: value.supervisorPid, version: value.version, exitCode: value.exitCode, terminationSignal: value.terminationSignal,
    updatedAt: value.updatedAt, ready: alive && !stale ? value.ready : null, live: alive && !stale ? value.live : null,
    polling: { ...value.polling, httpPhase: null, connectionReused: null, state: !alive ? 'stopped' : stale ? 'unknown' : value.polling.state } };
}
