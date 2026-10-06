import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, readFileSync, rmSync, writeFileSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const oracle = await import(pathToFileURL(path.resolve('scripts/lib/normal-workflow/oracle.mjs')).href);
const { releaseGate, SCENARIOS } = await import(pathToFileURL(path.resolve('scripts/lib/normal-workflow/contracts.mjs')).href);
const fixed = 'export function shippingFee(total) { return total >= 5000 ? 0 : 500; }\n';
const reviewModule = await import(pathToFileURL(path.resolve('scripts/lib/normal-workflow/answer-review.mjs')).href);
const checkpoint = (files: any, exitCode: number, sequence: number) => ({files,exitCode,sequence,commandId:`command-${sequence}`,command:'npm test',signal:null,barrier:'exclusive-persist-before-ack',acknowledged:true,treeHash:oracle.treeHash(files),testExecution:true});
const member = 'export function shippingFee(total, member = false) { return member || total >= 5000 ? 0 : 500; }\n';
const regression = "import assert from 'node:assert/strict'; import test from 'node:test'; import { shippingFee } from '../shipping.mjs'; test('exact boundary', () => assert.equal(shippingFee(5000), 0));\n";
const membership = "import assert from 'node:assert/strict'; import test from 'node:test'; import { shippingFee } from '../shipping.mjs'; test('member below threshold', () => assert.equal(shippingFee(4999, true), 0));\n";

function fixture(kind = 'bug') {
  const base = mkdtempSync(path.join(tmpdir(), 'kiokuko-oracle-test-'));
  const root = path.join(base, 'repo');
  oracle.createFixture(root, kind);
  const initial = oracle.snapshot(root);
  const red = { ...initial, 'test/regression.test.mjs': kind === 'feature' ? membership : regression };
  const final = { ...red, 'shipping.mjs': kind === 'feature' ? member : fixed };
  const attempt = { checkpointAuthority: 'executor-barrier-v1', kind, initial, final, instructionsVerified: true, controlsUnchanged: true,
    safe: true, exitCode: 0, logComplete: true, turnCompleted: true,
    checkpoints: [checkpoint(red,1,1),checkpoint(final,0,2)] };
  const evaluate = (changes = {}) => oracle.evaluateAttempt({ ...attempt, ...changes }, path.join(base, `replay-${Math.random()}`));
  return { base, root, initial, red, final, attempt, evaluate, close: () => rmSync(base, { recursive: true, force: true }) };
}

test('initial fixture tests pass but independent oracle detects the 5000 boundary bug', () => {
  const f = fixture();
  try {
    const baseline = oracle.replaySuite(f.initial, path.join(f.base, 'baseline'));
    assert.equal(baseline.exitCode, 0);
    assert.equal(baseline.tests, 2);
    assert.equal(oracle.checkBehavior(f.initial, 'bug', path.join(f.base, 'bad-behavior')).passed, false);
    assert.equal(f.evaluate().classification, 'PASS');
  } finally { f.close(); }
});

test('feature oracle preserves old calls and member/non-member combinations', () => {
  const f = fixture('feature');
  try {
    assert.equal(f.evaluate().classification, 'PASS');
    assert.equal(f.evaluate({ final: { ...f.final, 'shipping.mjs': 'export function shippingFee() { return 0; }' } }).classification, 'FAIL_PRODUCT');
  } finally { f.close(); }
});

test('product code cannot replace oracle intrinsics to manufacture expected values', () => {
  const f = fixture();
  try {
    const forged = { ...f.final, 'shipping.mjs': 'Array.prototype.map = () => [[500,500,500],[500,500,500],[0,0,0],[0,0,0]]; export function shippingFee() { return 999; }' };
    assert.equal(oracle.checkBehavior(forged, 'bug', path.join(f.base, 'intrinsic-forgery')).passed, false);
  } finally { f.close(); }
});

test('product code cannot forge the oracle signing and output machinery', () => {
  const f = fixture();
  try {
    const source = `import { Hmac } from 'node:crypto';
      const payload = '[[500,500,500],[500,500,500],[0,0,0],[0,0,0]]';
      const update = Hmac.prototype.update;
      Hmac.prototype.update = function () { return update.call(this, payload); };
      const write = process.stdout._write.bind(process.stdout);
      process.stdout._write = (chunk, encoding, done) => { const envelope = JSON.parse(chunk.toString()); envelope.payload = payload; write(JSON.stringify(envelope), encoding, done); };
      export function shippingFee() { return 999; }`;
    assert.equal(oracle.checkBehavior({ ...f.final, 'shipping.mjs': source }, 'bug', path.join(f.base, 'stream-forgery')).passed, false);
  } finally { f.close(); }
});

test('oracle rejects no-op verification, absent Red, stale Green, skipped tests and protected edits', () => {
  const f = fixture();
  try {
    for (const changes of [
      { checkpoints: [checkpoint(f.final,0,1)] },
      { checkpoints: [checkpoint(f.red,1,1), checkpoint(f.initial,0,2)] },
      { checkpoints: [checkpoint(f.red,1,1), {...checkpoint(f.final,0,2),testExecution:false}] },
      { final: { ...f.final, 'test/shipping.test.mjs': '' } },
      { final: { ...f.final, 'package.json': '{}' } },
      { final: { ...f.final, 'test/regression.test.mjs': regression.replace('test(', 'test.skip(') } },
      { final: f.initial }, { logComplete: false }, { turnCompleted: false }, { instructionsVerified: false },
      { controlsUnchanged: false }, { safe: false }, { exitCode: null },
    ]) assert.equal(f.evaluate(changes).classification, 'FAIL_PRODUCT', JSON.stringify(changes));
  } finally { f.close(); }
});

test('inquiry validates answer and zero edits without requiring development tests', () => {
  const f = fixture();
  try {
    const inquiry = { kind: 'inquiry', final: f.initial, checkpoints: [], developmentChecks: false,
      answer: '仕様では5,000円以上は無料、未満は500円。実装は5,000円ちょうどでも500円になる境界の不一致があります。' };
    const answerReview = { schema:reviewModule.RUBRIC_VERSION, kind:'inquiry', answerHash:oracle.hash(inquiry.answer),
      initialHash:oracle.treeHash(f.initial),specHash:oracle.hash(f.initial['README.md']),reviewer:'approved-human',
      verdict:'PASS',reason:'Correct specification and actual boundary mismatch',criteria:reviewModule.ANSWER_RUBRIC.inquiry.map((criterion: string) => ({criterion,verdict:'PASS'})) };
    Object.assign(inquiry,{answerReview,reviewers:['approved-human']});
    assert.equal(f.evaluate(inquiry).classification, 'PASS');
    assert.equal(f.evaluate({ ...inquiry, developmentChecks: true }).classification, 'FAIL_PRODUCT');
    assert.equal(f.evaluate({ ...inquiry, final: f.final }).classification, 'FAIL_PRODUCT');
    assert.equal(f.evaluate({ ...inquiry, answer: '無料です' }).classification, 'FAIL_HARNESS');
  } finally { f.close(); }
});

test('one injected selector error requires observed recovery; memory requires substantive decisions', () => {
  const f = fixture('feature');
  try {
    assert.equal(f.evaluate({ fault: 'selector-once', injectedFailures: 1, recovered: true }).classification, 'PASS');
    assert.equal(f.evaluate({ fault: 'selector-once', injectedFailures: 1, recovered: false }).classification, 'FAIL_PRODUCT');
    assert.equal(f.evaluate({ memory: 'related', memoryApplied: false }).classification, 'FAIL_PRODUCT');
    assert.equal(f.evaluate({ memory: 'related', memoryApplied: true }).classification, 'PASS');
  } finally { f.close(); }
});

test('snapshot rejects links; oracle cannot read or edit its protected parent', () => {
  const f = fixture();
  try {
    symlinkSync(f.base, path.join(f.root, 'escape'));
    assert.throws(() => oracle.snapshot(f.root), /symlink/);
    const sentinel = path.join(f.base, 'sentinel'); writeFileSync(sentinel, 'unchanged');
    const malicious = { ...f.final, 'shipping.mjs': `import { writeFileSync } from 'node:fs'; writeFileSync(${JSON.stringify(sentinel)}, 'changed'); export function shippingFee() { return 0; }` };
    assert.equal(oracle.checkBehavior(malicious, 'bug', path.join(f.base, 'restricted')).passed, false);
    assert.equal(readFileSync(sentinel, 'utf8'), 'unchanged');
    const forgery = { ...f.final, 'shipping.mjs': `console.log('[[500,500,500],[500,500,500],[0,0,0],[0,0,0]]'); process.exit(0); export function shippingFee() { return 0; }` };
    assert.equal(oracle.checkBehavior(forgery, 'bug', path.join(f.base, 'forged')).passed, false);
  } finally { f.close(); }
});

test('release gate is fail-closed for offline, skip, mismatch, dirty tree, replay and failed retries', () => {
  const candidate = { commit: 'a'.repeat(40), artifactHash: 'b'.repeat(64), dirty: false };
  const required = SCENARIOS.map((scenario: { id: string }) => `codex-cli/${scenario.id}`);
  const reports = SCENARIOS.map((scenario: { id: string }) => ({ ...candidate, client: 'codex-cli', scenario: scenario.id,
    executionMode: 'live', classification: 'PASS', instructionsVerified: true, oraclePassed: true }));
  assert.equal(releaseGate(candidate, reports, required).passed, true);
  assert.equal(releaseGate(candidate, [], required).passed, false);
  assert.equal(releaseGate({ ...candidate, dirty: true }, reports, required).passed, false);
  for (const classification of ['FAIL_PRODUCT', 'FAIL_HARNESS', 'BLOCKED_ENV', 'BLOCKED_AUTH', 'NOT_RUN', 'NOT_APPLICABLE'])
    assert.equal(releaseGate(candidate, [{ ...reports[0], classification }, ...reports.slice(1)], required).passed, false);
  for (const change of [{ executionMode: 'replay' }, { artifactHash: 'c'.repeat(64) }, { commit: 'd'.repeat(40) }, { instructionsVerified: false }])
    assert.equal(releaseGate(candidate, [{ ...reports[0], ...change }, ...reports.slice(1)], required).passed, false);
  assert.equal(releaseGate(candidate, [{ ...reports[0], classification: 'FAIL_PRODUCT' }, ...reports], required).passed, false);
  assert.equal(releaseGate(candidate, reports, []).passed, false);
});
