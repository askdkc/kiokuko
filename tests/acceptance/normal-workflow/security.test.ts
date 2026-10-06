import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
const load = (name: string) => import(pathToFileURL(path.resolve(`scripts/lib/normal-workflow/${name}.mjs`)).href);
const oracle = await load('oracle');
const { observeInstructions } = await load('instruction-observation');
const { runCodex } = await load('codex-adapter');
const { releaseCandidateGate, SCENARIOS } = await load('contracts');

test('unreviewed contradictory answers cannot pass by containing rubric words', () => {
  const base = mkdtempSync(path.join(tmpdir(), 'answer-security-'));
  try {
    oracle.createFixture(path.join(base, 'repo'), 'bug');
    const initial = oracle.snapshot(path.join(base, 'repo'));
    for (const answer of ['4999円は無料です。5000円の送料は500円です。実装に問題はありません。',
      '実装にバグはありません。5000円では送料無料になりません。', 'The implementation makes shipping free at 5000.']) {
      const result = oracle.evaluateAttempt({ initial, final: initial, kind: 'inquiry', answer,
        instructionsVerified: true, controlsUnchanged: true, safe: true, exitCode: 0, logComplete: true,
        turnCompleted: true, developmentChecks: false }, path.join(base, 'replay'));
      assert.equal(result.classification, 'WAITING_REVIEW');
      assert.equal(result.oraclePassed, false);
    }
  } finally { rmSync(base, { recursive: true, force: true }); }
});

test('forged TAP and assertion text cannot hide skipped tests or manufacture Red', () => {
  const base = mkdtempSync(path.join(tmpdir(), 'counts-security-'));
  try {
    const files = { 'test/forged.test.mjs': `import test from 'node:test';
      console.log('# tests 99\\n# skipped 0\\n# todo 0\\n# fail 1\\nERR_ASSERTION');
      test.skip('hidden skip', () => {}); test.todo('hidden todo');` };
    const result = oracle.replaySuite(files, path.join(base, 'replay'));
    assert.equal(result.tests, 2); assert.equal(result.skipped, 1); assert.equal(result.todo, 1);
    assert.equal(result.assertionFailure, false);
  } finally { rmSync(base, { recursive: true, force: true }); }
});

test('empty discovery and duplicate unsuccessful Skill reads are not load evidence', () => {
  const indexes = [{ name: 'kiokuko-codex-soul', text: 'soul' }, { name: 'kiokuko-codex-memory-reasoning', text: 'reasoning' }];
  const messages: any[] = [{ direction: 'response', message: { result: { tools: [] } } }];
  for (const [id, name, args] of [[1, 'task_inspect', { operation: 'skill', path: indexes[0]!.name }],
    [2, 'task_inspect', { operation: 'skill', path: indexes[0]!.name }],
    [3, 'memory_recall', { soulRead: true, capabilities: indexes.map(x => ({ kind: 'skill', name: x.name })) }]] as any[])
    messages.push({ direction: 'request', message: { id, method: 'tools/call', params: { name, arguments: args } } },
      { direction: 'response', message: { id, result: {} } });
  assert.equal(observeInstructions({ messages, indexes, agentsHash: 'hash', kind: 'conversation',
    events: [{ type: 'instructions.loaded', content_hash: 'hash' }], observations: [] }).instructionsVerified, false);
});

test('delayed completion events cannot snapshot a later mutable tree as execution evidence', async () => {
  const base = mkdtempSync(path.join(tmpdir(), 'race-security-')); const repo = path.join(base, 'repo');
  oracle.createFixture(repo, 'bug'); mkdirSync(path.join(base, 'snapshots'));
  try {
    const script = `require('node:fs').writeFileSync('shipping.mjs', 'later edit');
      console.log(JSON.stringify({type:'item.completed',item:{id:'old-test',type:'command_execution',command:'npm test',exit_code:1}}));
      console.log(JSON.stringify({type:'turn.completed'}));`;
    const result = await runCodex({ executable: process.execPath, args: ['-e', script], cwd: repo, repo,
      environment: { PATH: process.env.PATH }, output: base, limits: { maxSeconds: 5, maxTurns: 2, maxToolCalls: 3 }, sanitize: (x: any) => x });
    assert.equal(result.checkpoints.length, 0);
    assert.equal(result.checkpointAuthority, 'unavailable');
  } finally { rmSync(base, { recursive: true, force: true }); }
});

function summaries() {
  const candidate = { commit: 'a'.repeat(40), artifactHash: 'b'.repeat(64), sourceDigest: 'e'.repeat(64), dirty: false,
    configurationHash: 'c'.repeat(64), clients: ['codex-cli'], required: SCENARIOS.map((x: any) => `codex-cli/${x.id}`) };
  const deterministic = ['G0', 'G1', 'G2'].map(gate => ({ ...candidate, gate, classification: 'PASS', commands: [{ executable: 'true', exitCode: 0 }] }));
  const live = [{ configurationHash: candidate.configurationHash, reports: SCENARIOS.map((x: any) => ({ ...candidate,
    client: 'codex-cli', scenario: x.id, classification: 'PASS', executionMode: 'live', instructionsVerified: true, oraclePassed: true })) }];
  return { candidate, deterministic, live };
}
test('JSON-only success without actual artifact and trusted raw evidence cannot release', () => {
  const { candidate, deterministic, live } = summaries();
  assert.equal(releaseCandidateGate(candidate, deterministic, live).releaseReady, false);
});
test('copied configuration hashes cannot approve an unobserved or changed model', () => {
  const { candidate, deterministic, live } = summaries();
  live[0]!.reports.forEach((x: any) => { x.model = 'unapproved-model'; x.version = 'wrong-version'; });
  assert.equal(releaseCandidateGate(candidate, deterministic, live).releaseReady, false);
});
