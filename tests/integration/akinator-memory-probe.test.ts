import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, writeFile, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { AgentGatewayService } from '../../src/gateway/agent-service.js';
import { openConnection } from '../../src/db/connection.js';
import { migrateDatabase } from '../../src/db/migrate.js';
import { resolveProjectWorkspace } from '../../src/memory/workspaces.js';
import { prepareAgentTask, answerAgentTask } from '../../src/akinator/agent-task.js';
import { getAkinatorStateService } from '../../src/akinator/service.js';
import { probeProfileMemory, profileMemoryHints } from '../../src/akinator/memory-probe.js';
import { readMemoryResolution, rebuildProfileMemoryBatch, syncProfileDocument } from '../../src/akinator/profile-memory-store.js';
import { readProfileMemoryMode, parseMemoryResolution, type ProbeMode } from '../../src/akinator/memory-probe-types.js';
import { readRunIntakeLink } from '../../src/akinator/store.js';
import { canonicalJson } from '../../src/serialization/validate.js';
import { exportLedgerArchive, importLedgerArchive } from '../../src/ledger/archive.js';
import { inspectLedger, purgeLedgerTarget } from '../../src/ledger/maintenance.js';
import { KiokukoError } from '../../src/errors.js';

const capabilities = [{ kind: 'skill', name: 'kiokuko-soul' }, { kind: 'skill', name: 'memory-reasoning' }];
const now = '2026-09-13T00:00:00.000Z';
const base = { taskType: 'build' as const, target: null, expected: 'tests pass', constraints: null };
const errorCode = (code: string) => (error: unknown) => error instanceof KiokukoError && error.code === code;
async function fixture(t: { after(fn: () => Promise<void>): void }) {
  const root = await mkdtemp(path.join(tmpdir(), 'kiokuko-probe-'));
  const database = openConnection(':memory:');
  migrateDatabase(database);
  execFileSync('git', ['init', '-q', root]);
  await mkdir(path.join(root, 'src'));
  await writeFile(path.join(root, 'src/feature.ts'), 'export const value = 1;\n');
  const project = await resolveProjectWorkspace(database, root);
  assert.ok(project);
  const scope = { workspace: project.workspace, repositoryId: project.repositoryId, repositoryRoot: project.repositoryRoot };
  t.after(async () => { database.close(); await rm(root, { recursive: true, force: true }); });
  const options = (mode: ProbeMode) => ({ scope, mode, capabilities });
  const gateway = (mode: ProbeMode) => new AgentGatewayService(database, { now: () => now, profileMemory: options(mode) });
  const envelope = (key: string, target: string | null = 'src/feature.ts') => ({ idempotencyKey: key, request: {
    apiVersion: '1', workspace: scope.workspace, client: { kind: 'mcp' },
    task: { title: 'Implement feature', query: 'Implement src/feature.ts', profileHints: { ...base, target } },
    captureProfile: 'minimal', coverage: { run: 'unavailable', tool: 'unavailable', command: 'unavailable', file: 'unavailable', approval: 'unavailable' }, capabilities,
  } });
  const source = () => {
    const service = gateway('off');
    const run = service.openRun(envelope(`source-${crypto.randomUUID()}`));
    service.closeRun({ runId: run.runId, idempotencyKey: 'close', request: { apiVersion: '1', status: 'completed' } });
    return run;
  };
  return { database, root, scope, options, gateway, envelope, source };
}

test('resolve adopts only a verified current path and persists memory provenance without fake answers', async t => {
  const f = await fixture(t); f.source();
  const request = f.envelope('adopt', null);
  const run = f.gateway('resolve').openRun(request);
  assert.equal(run.taskProfile.target, 'src/feature.ts');
  assert.equal(readRunIntakeLink(f.database, { workspace: f.scope.workspace, runId: run.runId }).profileSources.target, 'memory');
  assert.equal(f.database.prepare('SELECT count(*) AS n FROM akinator_answers WHERE session_id = ?').get<{ n: number }>(run.intakeSessionId)?.n, 0);
  const saved = readMemoryResolution(f.database, f.scope.workspace, run.runId)!;
  assert.equal(saved.status, 'complete'); assert.ok(saved.adoptedRunId);
  f.source();
  assert.deepEqual(f.gateway('off').openRun(request), run);
  assert.deepEqual(readMemoryResolution(f.database, f.scope.workspace, run.runId), saved);
  assert.throws(() => f.gateway('resolve').openRun({ ...request, request: { ...request.request, task: { ...request.request.task, query: 'Different task' } } }), errorCode('CONFLICT'));
  assert.equal(inspectLedger(f.database, { workspace: f.scope.workspace }).ok, true);
});

test('off, shadow, missing capability, explicit input and optional constraints preserve intake', async t => {
  const f = await fixture(t); f.source();
  for (const mode of ['off', 'shadow', 'suggest'] as const) {
    const run = f.gateway(mode).openRun(f.envelope(mode, null));
    assert.equal(run.taskProfile.target, null);
    assert.equal(run.currentQuestion?.id, 'target');
  }
  const unavailable = probeProfileMemory(f.database, 'Implement src/feature.ts', base, { ...f.options('resolve'), capabilities: [] });
  assert.equal(unavailable.resolution.reason, 'capability_unavailable');
  assert.equal(unavailable.resolution.metrics.queryCount, 0);
  const complete = probeProfileMemory(f.database, 'Implement src/feature.ts', { ...base, target: 'src/current.ts' }, f.options('resolve'));
  assert.equal(complete.resolution.reason, 'profile_complete');
  assert.equal(complete.resolution.metrics.queryCount, 0);
  assert.equal(complete.profile.target, 'src/current.ts');
  assert.throws(() => readProfileMemoryMode('automatic'), errorCode('VALIDATION_ERROR'));
});

test('MCP prepare/answer exposes bounded suggestions and never treats them as the answer', async t => {
  const f = await fixture(t); f.source();
  const input = { requestId: 'mcp-suggest', task: 'Implement src/feature.ts', cwd: f.root, profileHints: base, capabilities, skillDiscoveryMode: 'off' as const, profileMemoryMode: 'suggest' as const };
  const prepared = await prepareAgentTask(f.database, input);
  assert.equal(prepared.nextAction, 'answer_from_evidence_or_ask_user');
  assert.equal(prepared.intake.profile.target, null);
  assert.equal(prepared.intake.memoryHints?.[0]?.value, 'src/feature.ts');
  assert.equal(prepared.intake.memoryHints?.[0]?.untrusted, true);
  const answered = await answerAgentTask(f.database, { sessionId: prepared.intake.sessionId, runId: prepared.run.runId, questionId: 'target', value: 'src/current.ts', cwd: f.root, capabilities, skillDiscoveryMode: 'off', profileMemoryMode: 'suggest' });
  assert.equal(answered.intake.profile.target, 'src/current.ts');
  const replay = await prepareAgentTask(f.database, input);
  assert.equal(replay.intake.profile.target, 'src/current.ts');
  assert.equal(replay.intake.memoryHints, undefined);
});

test('stale sources, incomplete projections, competing targets and escaping symlinks cannot resolve', async t => {
  const f = await fixture(t); const source = f.source();
  f.database.prepare('UPDATE akinator_profile_projection_state SET complete = 0').run();
  assert.equal(probeProfileMemory(f.database, 'Implement src/feature.ts', base, f.options('resolve')).profile.target, null);
  let result;
  do { result = rebuildProfileMemoryBatch(f.database, { workspace: f.scope.workspace, batchSize: 1 }); } while (!result.complete);
  assert.equal(probeProfileMemory(f.database, 'Implement src/feature.ts', base, f.options('resolve')).profile.target, 'src/feature.ts');
  const other = f.gateway('off').openRun(f.envelope('other', 'src/other.ts'));
  assert.equal(probeProfileMemory(f.database, 'Implement src/feature.ts', base, f.options('resolve')).profile.target, null);
  f.database.prepare('DELETE FROM ledger_runs WHERE run_id = ?').run(other.runId);
  await rm(path.join(f.root, 'src/feature.ts'));
  await symlink(path.resolve(f.root, '..'), path.join(f.root, 'src/feature.ts'));
  assert.equal(probeProfileMemory(f.database, 'Implement src/feature.ts', base, f.options('resolve')).profile.target, null);
  f.database.prepare('UPDATE akinator_profile_documents SET profile_hash = ? WHERE run_id = ?').run('a'.repeat(64), source.runId);
  assert.equal(probeProfileMemory(f.database, 'Implement src/feature.ts', base, f.options('resolve')).resolution.status, 'incomplete');
});

test('candidate limit is explicit and never permits automatic resolution from a partial result', async t => {
  const f = await fixture(t);
  for (let i = 0; i < 64; i++) f.source();
  assert.equal(probeProfileMemory(f.database, 'src/feature.ts', base, f.options('resolve')).resolution.status, 'incomplete');
  f.source(); f.source();
  const result = probeProfileMemory(f.database, 'Implement src/feature.ts', base, f.options('resolve'));
  assert.equal(result.profile.target, null);
  assert.equal(result.resolution.status, 'incomplete');
  assert.ok(result.resolution.metrics.expandedProfiles <= 64);
  assert.ok(result.resolution.metrics.queryCount <= 3);
  assert.equal(result.resolution.metrics.truncated, true);
});

test('purge clears source projection, FTS and references held by other runs', async t => {
  const f = await fixture(t); const source = f.source();
  const run = f.gateway('suggest').openRun(f.envelope('suggest', null));
  const state = await getAkinatorStateService(f.database, { workspace: f.scope.workspace, sessionId: run.intakeSessionId });
  assert.equal(profileMemoryHints(f.database, run.runId, state, f.options('suggest')).length, 1);
  purgeLedgerTarget(f.database, { workspace: f.scope.workspace, targetType: 'run', targetId: source.runId, actor: 'user', createdAt: now, purgeId: 'purge-source', confirmed: true });
  assert.equal(profileMemoryHints(f.database, run.runId, state, f.options('suggest')).length, 0);
  assert.equal(readMemoryResolution(f.database, f.scope.workspace, run.runId)?.status, 'revoked');
  assert.equal(f.database.prepare('SELECT count(*) AS n FROM akinator_profile_documents').get<{ n: number }>()?.n, 0);
  assert.equal(f.database.prepare("SELECT count(*) AS n FROM akinator_profile_fts WHERE akinator_profile_fts MATCH 'feature'").get<{ n: number }>()?.n, 0);
});

test('v4 archive round-trips resolutions, accepts strict v3, and rejects forged v3 memory sources', async t => {
  const f = await fixture(t); f.source();
  f.gateway('resolve').openRun(f.envelope('resolve', null));
  const archive = exportLedgerArchive(f.database, { workspace: f.scope.workspace });
  assert.ok(archive.counts.memoryResolutions >= 2);
  const fresh = openConnection(':memory:'); migrateDatabase(fresh);
  try {
    assert.equal(importLedgerArchive(fresh, { content: archive.content }).counts.memoryResolutions, archive.counts.memoryResolutions);
    assert.equal(importLedgerArchive(fresh, { content: archive.content }).imported.memoryResolutions, 0);
  } finally { fresh.close(); }
  const lines = archive.content.trim().split('\n').slice(1).map(line => JSON.parse(line));
  lines[0].archiveVersion = 3; delete lines[0].counts.memoryResolutions;
  const old = lines.filter(line => line.type !== 'memory_resolution');
  const encode = () => { const body = old.map(line => canonicalJson(line)).join('\n') + '\n'; return canonicalJson({ type: 'checksum', sha256: createHash('sha256').update(body).digest('hex') }) + '\n' + body; };
  assert.throws(() => importLedgerArchive(undefined, { content: encode(), dryRun: true }), errorCode('VALIDATION_ERROR'));
  for (const line of old) if (line.type === 'run_intake') line.profile_sources_json = line.profile_sources_json.replace('memory', 'client_supplied');
  assert.equal(importLedgerArchive(undefined, { content: encode(), dryRun: true }).counts.memoryResolutions, 0);
});

test('an injected save failure rolls back the entire fresh run', async t => {
  const f = await fixture(t); f.source();
  const before = f.database.prepare('SELECT count(*) AS n FROM ledger_runs').get();
  f.database.exec("CREATE TRIGGER reject_resolution BEFORE INSERT ON akinator_memory_resolutions BEGIN SELECT RAISE(ABORT, 'injected failure'); END");
  assert.throws(() => f.gateway('resolve').openRun(f.envelope('rollback', null)), /injected failure/);
  assert.deepEqual(f.database.prepare('SELECT count(*) AS n FROM ledger_runs').get(), before);
});

test('scope and capability gates prevent cross-project profile exposure before search', async t => {
  const f = await fixture(t); f.source();
  const otherRoot = await mkdtemp(path.join(tmpdir(), 'kiokuko-probe-other-'));
  t.after(() => rm(otherRoot, { recursive: true, force: true }));
  execFileSync('git', ['init', '-q', otherRoot]);
  const other = await resolveProjectWorkspace(f.database, otherRoot); assert.ok(other);
  const scoped = probeProfileMemory(f.database, 'src/feature.ts', base, { ...f.options('suggest'),
    scope: { workspace: other.workspace, repositoryId: other.repositoryId, repositoryRoot: other.repositoryRoot },
  });
  assert.equal(scoped.resolution.candidates.length, 0);
  for (const catalog of [undefined, [{ kind: 'skill', name: 'kiokuko-soul' }], [...capabilities, { kind: 'invalid', name: 'broken' }]]) {
    const result = probeProfileMemory(f.database, 'src/feature.ts', base, { ...f.options('resolve'), capabilities: catalog });
    assert.equal(result.resolution.metrics.queryCount, 0);
    assert.equal(result.profile.target, null);
  }
  assert.throws(() => probeProfileMemory(f.database, 'src/feature.ts', base, { ...f.options('resolve'), scope: { ...f.scope, repositoryId: other.repositoryId } }), errorCode('CONFLICT'));
});

test('projection updates remove old FTS terms and rebuild resumes with canonical sources', async t => {
  const f = await fixture(t); const source = f.source();
  f.database.prepare("UPDATE akinator_sessions SET task_text = 'newword', profile_json = json_set(profile_json, '$.target', 'src/newword.ts') WHERE id = ?").run(source.intakeSessionId);
  f.database.exec('BEGIN IMMEDIATE');
  try { syncProfileDocument(f.database, f.scope.workspace, source.runId); f.database.exec('COMMIT'); }
  catch (error) { f.database.exec('ROLLBACK'); throw error; }
  assert.equal(f.database.prepare("SELECT count(*) AS n FROM akinator_profile_fts WHERE akinator_profile_fts MATCH 'feature'").get<{ n: number }>()?.n, 0);
  assert.equal(f.database.prepare("SELECT count(*) AS n FROM akinator_profile_fts WHERE akinator_profile_fts MATCH 'newword'").get<{ n: number }>()?.n, 1);
  const first = rebuildProfileMemoryBatch(f.database, { workspace: f.scope.workspace, restart: true, batchSize: 1 });
  assert.equal(first.complete, false);
  assert.equal(rebuildProfileMemoryBatch(f.database, { workspace: f.scope.workspace, batchSize: 1 }).complete, true);
  assert.equal(f.database.prepare("SELECT count(*) AS n FROM akinator_profile_trigram WHERE akinator_profile_trigram MATCH 'newword'").get<{ n: number }>()?.n, 1);
});

test('malformed resolution JSON and cancellation fail before a fresh adoption is saved', async t => {
  const f = await fixture(t); const source = f.source();
  const resolution = readMemoryResolution(f.database, f.scope.workspace, source.runId)!;
  assert.throws(() => parseMemoryResolution({ ...resolution, unexpected: true }), errorCode('INTEGRITY_ERROR'));
  assert.throws(() => parseMemoryResolution({ ...resolution, metrics: { ...resolution.metrics, elapsedMs: Infinity } }), errorCode('INTEGRITY_ERROR'));
  const before = f.database.prepare('SELECT count(*) AS n FROM ledger_runs').get();
  const controller = new AbortController(); controller.abort();
  const service = new AgentGatewayService(f.database, { profileMemory: { ...f.options('resolve'), signal: controller.signal } });
  assert.throws(() => service.openRun(f.envelope('aborted', null)), { name: 'AbortError' });
  assert.deepEqual(f.database.prepare('SELECT count(*) AS n FROM ledger_runs').get(), before);
});

test('multiple current paths and truncated input cannot narrow the current scope to one historical target', async t => {
  const f = await fixture(t); f.source();
  await writeFile(path.join(f.root, 'src/other.ts'), 'export {};\n');
  assert.equal(probeProfileMemory(f.database, 'Update src/feature.ts and src/other.ts', base, f.options('resolve')).profile.target, null);
  assert.equal(probeProfileMemory(f.database, 'Update src/feature.ts and create src/new.ts', base, f.options('resolve')).profile.target, null);
  for (const task of ['src/feature.ts ' + 'x'.repeat(16_384), 'src/feature.ts ' + Array.from({ length: 40 }, (_, i) => `word${i}`).join(' ')]) {
    const result = probeProfileMemory(f.database, task, base, f.options('resolve'));
    assert.equal(result.resolution.status, 'incomplete');
    assert.equal(result.profile.target, null);
  }
});

test('changed source task and mismatched resolution intake fail canonical revalidation', async t => {
  const f = await fixture(t); const source = f.source();
  f.database.prepare("UPDATE akinator_sessions SET task_text = 'Changed task' WHERE id = ?").run(source.intakeSessionId);
  assert.equal(probeProfileMemory(f.database, 'src/feature.ts', base, f.options('resolve')).resolution.status, 'incomplete');
  const other = f.gateway('off').openRun(f.envelope('other-session', null));
  f.database.prepare('DELETE FROM akinator_memory_resolutions WHERE run_id = ?').run(other.runId);
  f.database.prepare('UPDATE akinator_memory_resolutions SET session_id = ? WHERE run_id = ?').run(other.intakeSessionId, source.runId);
  assert.throws(() => readMemoryResolution(f.database, f.scope.workspace, source.runId), errorCode('INTEGRITY_ERROR'));
});

test('purged evidence cannot return as a hint through another memory-enriched run', async t => {
  const f = await fixture(t); const source = f.source();
  const adopted = f.gateway('resolve').openRun(f.envelope('adopted', null));
  f.gateway('off').closeRun({ runId: adopted.runId, idempotencyKey: 'close', request: { apiVersion: '1', status: 'completed' } });
  purgeLedgerTarget(f.database, { workspace: f.scope.workspace, targetType: 'run', targetId: source.runId, actor: 'user', createdAt: now, purgeId: 'purge-root', confirmed: true });
  const run = f.gateway('suggest').openRun(f.envelope('after-purge', null));
  const state = await getAkinatorStateService(f.database, { workspace: f.scope.workspace, sessionId: run.intakeSessionId });
  assert.equal(readMemoryResolution(f.database, f.scope.workspace, adopted.runId)?.status, 'revoked');
  assert.equal(profileMemoryHints(f.database, run.runId, state, f.options('suggest')).length, 0);
});
