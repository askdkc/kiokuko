import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const { approvalErrors, releaseCandidateGate, SCENARIOS } = await import(pathToFileURL(path.resolve('scripts/lib/normal-workflow/contracts.mjs')).href);
const { fixtureTestCommand, runCodex } = await import(pathToFileURL(path.resolve('scripts/lib/normal-workflow/codex-adapter.mjs')).href);
const { createFixture } = await import(pathToFileURL(path.resolve('scripts/lib/normal-workflow/oracle.mjs')).href);
const { captureSanitizer } = await import(pathToFileURL(path.resolve('scripts/lib/normal-workflow/log-safety.mjs')).href);
const { observeInstructions } = await import(pathToFileURL(path.resolve('scripts/lib/normal-workflow/instruction-observation.mjs')).href);
const approved = { approved: true, provider: 'chatgpt-subscription', model: 'explicit-test-model', authFile: '/test-only/auth.json', testCredentials: true,
  clientVersion: '0.148.0', reasoningEffort: 'medium',
  maxCost: 0, currency: 'USD', attempts: 1, maxSeconds: 60, maxTotalSeconds: 480, maxTurns: 10, maxToolCalls: 20, clients: ['codex-cli'] };


test('approval requires explicit client/model/time/turn/tool/cost boundaries; paid API cannot bypass spend control', () => {
  assert.deepEqual(approvalErrors(approved), []);
  for (const change of [{ approved: false }, { testCredentials: false }, { clients: [] }, { clients: ['unknown'] },
    { clients: ['codex-cli', 'codex-cli'] }, { model: '' }, { authFile: '' }, { provider: 'paid-api' }, { maxCost: 1 },
    { attempts: 2 }, { maxTurns: 0 }, { maxToolCalls: Infinity }, { maxSeconds: 601 }, { maxTotalSeconds: 0 }])
    assert.ok(approvalErrors({ ...approved, ...change }).length > 0, JSON.stringify(change));
});

test('command evidence does not accept echo, true, shell branches or unexecuted test names', () => {
  for (const command of ['npm test', 'npm run test', 'node --test test/*.test.mjs', "/bin/zsh -lc 'npm test'"])
    assert.equal(fixtureTestCommand(command), true, command);
  for (const command of ['true', 'echo "node --test"', 'false && node --test', 'node --test; true', 'npm test || true', 'printf pass', 'node --test unrelated.js'])
    assert.equal(fixtureTestCommand(command), false, command);
});

test('capture suppresses exact test credentials and detected secret patterns before persistence', () => {
  const access = 'synthetic-test-credential-value';
  const sanitize = captureSanitizer((value: any) => ({ value, redactions: [] }), { tokens: { access_token: access } });
  assert.deepEqual(sanitize({ text: 'harmless fixture data' }), { text: 'harmless fixture data' });
  assert.throws(() => sanitize({ output: `prefix ${access} suffix` }), /secret_output/);
  const detected = captureSanitizer(() => ({ value: 'redacted', redactions: [{ kind: 'secret_pattern' }] }), {});
  assert.throws(() => detected('anything'), /secret_output/);
});

test('offline real-model gate fails; output preserves NOT_RUN and refuses attempt overwrites', () => {
  const base = mkdtempSync(path.join(tmpdir(), 'kiokuko-offline-runner-'));
  try {
    const output = path.join(base, 'result');
    const args = ['scripts/run-normal-workflow-acceptance.mjs', '--offline', '--require-live', '--output', output];
    const run = spawnSync(process.execPath, args, { encoding: 'utf8', timeout: 15000 });
    assert.equal(run.status, 1, run.stderr);
    const report = JSON.parse(readFileSync(path.join(output, 'summary.json'), 'utf8'));
    assert.equal(report.liveGate.passed, false);
    assert.ok(report.reports.every((result: any) => result.classification === 'NOT_RUN' && result.executionMode === 'offline'));
    assert.ok(report.reports.some((result: any) => result.client === 'codex-desktop'));
    const before = readFileSync(path.join(output, 'summary.json'), 'utf8');
    assert.equal(spawnSync(process.execPath, args, { encoding: 'utf8' }).status, 1);
    assert.equal(readFileSync(path.join(output, 'summary.json'), 'utf8'), before);
  } finally { rmSync(base, { recursive: true, force: true }); }
});

test('invalid approval remains BLOCKED_AUTH without installing or running a model', () => {
  const base = mkdtempSync(path.join(tmpdir(), 'kiokuko-blocked-runner-'));
  try {
    const file = path.join(base, 'approval.json'); writeFileSync(file, JSON.stringify({ ...approved, approved: false }));
    const output = path.join(base, 'result');
    const run = spawnSync(process.execPath, ['scripts/run-normal-workflow-acceptance.mjs', '--approval', file, '--output', output], { encoding: 'utf8', timeout: 15000 });
    assert.equal(run.status, 1, run.stderr);
    const report = JSON.parse(readFileSync(path.join(output, 'summary.json'), 'utf8'));
    assert.ok(report.reports.every((result: any) => result.classification === 'BLOCKED_AUTH'));
  } finally { rmSync(base, { recursive: true, force: true }); }
});

test('client adapter rejects missing client and incomplete logs without fabricating snapshots', async () => {
  const base = mkdtempSync(path.join(tmpdir(), 'kiokuko-client-adapter-'));
  const repo = path.join(base, 'repo'); createFixture(repo, 'bug');
  const common = { cwd: repo, repo, environment: { PATH: process.env.PATH }, output: base,
    limits: { maxSeconds: 5, maxTurns: 1, maxToolCalls: 2 }, sanitize: (value: any) => value };
  try {
    const missing = await runCodex({ ...common, executable: path.join(base, 'absent'), args: [] });
    assert.equal(missing.failure, 'client_unavailable'); assert.equal(missing.logComplete, false);
    const incomplete = await runCodex({ ...common, executable: process.execPath, args: ['-e', 'process.stdout.write("not-json")'] });
    assert.equal(incomplete.failure, 'incomplete_event'); assert.equal(incomplete.turnCompleted, false);
  } finally { rmSync(base, { recursive: true, force: true }); }
});

test('client adapter counts completed-only tools, deduplicates start/completion and enforces the call cap', async () => {
  const base = mkdtempSync(path.join(tmpdir(), 'kiokuko-call-cap-'));
  const repo = path.join(base, 'repo'); createFixture(repo, 'bug'); mkdirSync(path.join(base, 'snapshots'));
  const events = [
    { type: 'item.started', item: { id: 'one', type: 'mcp_tool_call' } },
    { type: 'item.completed', item: { id: 'one', type: 'mcp_tool_call' } },
    { type: 'item.completed', item: { id: 'two', type: 'mcp_tool_call' } },
  ];
  try {
    const script = `process.stdout.write(${JSON.stringify(events.map(event => JSON.stringify(event)).join('\n') + '\n')}); setInterval(() => {}, 1000);`;
    const result = await runCodex({ executable: process.execPath, args: ['-e', script], cwd: repo, repo, environment: { PATH: process.env.PATH }, output: base,
      limits: { maxSeconds: 5, maxTurns: 1, maxToolCalls: 1 }, sanitize: (value: any) => value });
    assert.equal(result.failure, 'tool_call_limit'); assert.equal(result.calls, 2); assert.equal(result.logComplete, false);
  } finally { rmSync(base, { recursive: true, force: true }); }
});

test('summary-only matching G0-G3 reports remain diagnostic and cannot release', () => {
  const candidate = { commit: 'a'.repeat(40), artifactHash: 'b'.repeat(64), dirty: false, configurationHash: 'c'.repeat(64),
    clients: ['codex-cli'],
    required: SCENARIOS.map((scenario: any) => `codex-cli/${scenario.id}`) };
  const deterministic = ['G0', 'G1', 'G2'].map(gate => ({ ...candidate, gate, classification: 'PASS', commands: [{ executable: 'matching verifier', exitCode: 0 }] }));
  const summaries = [{ configurationHash: candidate.configurationHash, reports: SCENARIOS.map((scenario: any) => ({ ...candidate,
    client: 'codex-cli', scenario: scenario.id, classification: 'PASS', executionMode: 'live', instructionsVerified: true, oraclePassed: true })) }];
  assert.equal(releaseCandidateGate(candidate, deterministic, summaries).releaseReady, false);
  assert.equal(releaseCandidateGate(candidate, deterministic.slice(1), summaries).releaseReady, false);
  assert.equal(releaseCandidateGate(candidate, deterministic, [{ ...summaries[0], configurationHash: 'd'.repeat(64) }]).releaseReady, false);
  assert.equal(releaseCandidateGate(candidate, [{ ...deterministic[0], commands: [] }, ...deterministic.slice(1)], summaries).releaseReady, false);
  assert.equal(releaseCandidateGate(candidate, deterministic, []).releaseReady, false);
  assert.equal(releaseCandidateGate({ ...candidate, required: [candidate.required[0]] }, deterministic, summaries).releaseReady, false);
});
