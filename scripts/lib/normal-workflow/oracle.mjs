import { checkpointErrors } from './checkpoints.mjs';
import { verifyAnswerReview } from './answer-review.mjs';
import { createHash, createHmac, randomBytes } from 'node:crypto';
import { cpSync, lstatSync, mkdirSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const fixture = fileURLToPath(new URL('../../../tests/fixtures/normal-workflow/', import.meta.url));
export const hash = text => createHash('sha256').update(text).digest('hex');
export const treeHash = files => hash(JSON.stringify(Object.entries(files).sort(([a], [b]) => a.localeCompare(b))));

export function createFixture(root, kind) {
  cpSync(fixture, root, { recursive: true });
  if (kind === 'feature') writeFileSync(path.join(root, 'shipping.mjs'), 'export function shippingFee(total) { return total >= 5000 ? 0 : 500; }\n');
}

/** Bounded fixture-only snapshot; links and special files cannot expand access. */
export function snapshot(root) {
  const files = {};
  const visit = (name = '') => {
    for (const entry of readdirSync(path.join(root, name), { withFileTypes: true })) {
      if (name === '' && ['.git', '.codex'].includes(entry.name)) continue;
      const relative = name ? `${name}/${entry.name}` : entry.name;
      const stat = lstatSync(path.join(root, relative));
      if (stat.isSymbolicLink()) throw new Error('Fixture symlink is outside the acceptance contract');
      if (stat.isDirectory()) { visit(relative); continue; }
      if (!stat.isFile() || stat.size > 256000 || Object.keys(files).length >= 128) throw new Error('Fixture snapshot limit exceeded');
      files[relative] = readFileSync(path.join(root, relative), 'utf8');
    }
  };
  visit(); return files;
}

function materialize(root, files) {
  mkdirSync(root, { recursive: true });
  for (const [name, text] of Object.entries(files)) {
    if (!name || name.split(/[\\/]/u).some(part => !part || part === '.' || part === '..') || path.isAbsolute(name)) throw new Error('Invalid snapshot path');
    mkdirSync(path.dirname(path.join(root, name)), { recursive: true });
    writeFileSync(path.join(root, name), text);
  }
}

/** Execute independently in a disposable replay tree, never in the agent tree. */
export function replaySuite(files, root) {
  materialize(root, files);
  root = realpathSync(root);
  const tests = Object.keys(files).filter(name => /^test\/[^/]+\.test\.mjs$/u.test(name)).sort();
  const report = path.join(path.dirname(root), `${path.basename(root)}-lifecycle.json`);
  const supervisor = fileURLToPath(new URL('./test-results.mjs', import.meta.url));
  const child = spawnSync(process.execPath, [supervisor, root, report, ...tests.map(name => path.join(root, name))], {
    cwd: root, encoding: 'utf8', timeout: 15000, maxBuffer: 1024 * 1024,
    env: { PATH: process.env.PATH, HOME: root, NODE_NO_WARNINGS: '1' },
  });
  let result;
  try { result = JSON.parse(readFileSync(report, 'utf8')); } catch { /* Missing channel is a harness failure. */ }
  const complete = child.signal === null && result?.complete === true;
  return { exitCode: child.status, signal: child.signal, complete, ...result?.counts,
    assertionFailure: result?.results.some(file => file.events.some(event => event.type === 'test:fail' && event.assertion)) === true,
    lifecycle: result, output: `${child.stdout ?? ''}\n${child.stderr ?? ''}` };

}

/** Expected values are fixed by the public fixture spec, not by product code. */
export function checkBehavior(files, kind, root) {
  materialize(root, files);
  root = realpathSync(root);
  const key = randomBytes(32).toString('hex');
  const script = `import { readFileSync } from 'node:fs';
    import { createHmac } from 'node:crypto';
    import { createContext, SourceTextModule } from 'node:vm';
    const key = readFileSync(0, 'utf8');
    const stringify = JSON.stringify, sign = createHmac, finite = Number.isFinite;
    const write = process.stdout.write.bind(process.stdout);
    // No host object or function crosses into the fixture's realm. Product code
    // cannot access the oracle's intrinsics, signing key or output machinery.
    const context = createContext(Object.create(null), { codeGeneration: { strings: false, wasm: false } });
    const module = new SourceTextModule(readFileSync('./shipping.mjs', 'utf8'), { context });
    await module.link(() => { throw new Error('Fixture shipping module must be standalone'); });
    await module.evaluate({ timeout: 1000 });
    const shippingFee = module.namespace.shippingFee;
    const totals = [0, 4999, 5000, 5001];
    const actual = totals.map(total => [shippingFee(total), shippingFee(total, false), shippingFee(total, true)]);
    if (!actual.every(row => row.every(value => typeof value === 'number' && finite(value)))) throw new Error('Shipping fee must be a finite number');
    for (const row of [...actual, actual]) Object.defineProperty(row, 'toJSON', { value: null });
    const payload = stringify(actual);
    const signature = sign('sha256', key).update(payload).digest('hex');
    write(stringify({ payload, signature }));`;
  const child = spawnSync(process.execPath, ['--experimental-vm-modules', '--permission', `--allow-fs-read=${root}`, `--allow-fs-write=${root}`,
    '--input-type=module', '--eval', script], {
    cwd: root, encoding: 'utf8', timeout: 5000, maxBuffer: 64000, input: key,
    env: { PATH: process.env.PATH, HOME: root },
  });
  const expected = [500, 500, 0, 0].map(fee => [fee, fee, kind === 'feature' ? 0 : fee]);
  let actual;
  try {
    const envelope = JSON.parse(child.stdout.trim());
    if (envelope.signature === createHmac('sha256', key).update(envelope.payload).digest('hex')) actual = JSON.parse(envelope.payload);
  } catch { /* Early process.exit or forged stdout cannot pass the external oracle. */ }
  return { passed: child.status === 0 && JSON.stringify(actual) === JSON.stringify(expected), exitCode: child.status, actual, expected };
}

export function evaluateAttempt(attempt, replayRoot) {
  const assertions = [];
  const require = (id, passed) => assertions.push({ id, passed: passed === true });
  if (attempt.blocked) return { classification: attempt.blocked, assertions, oraclePassed: false };
  const { initial, final, checkpoints = [], kind } = attempt;
  const approvedInitial = snapshot(fixture);
  if (kind === 'feature') approvedInitial['shipping.mjs'] = 'export function shippingFee(total) { return total >= 5000 ? 0 : 500; }\n';
  if (!Object.entries(approvedInitial).every(([name,text]) => initial[name] === text))
    return { classification:'FAIL_HARNESS', oraclePassed:false, assertions, reason:'Initial fixture/spec differs from reviewed fixture' };
  if (!['inquiry','conversation'].includes(kind) && checkpointErrors(checkpoints,attempt.checkpointAuthority).length > 0)
    return { classification:'FAIL_HARNESS', assertions, oraclePassed:false, reason:'Execution-bound checkpoint authority unavailable' };
  require('instructions loaded and capabilities discovered', attempt.instructionsVerified);
  require('client ended successfully with complete event log', attempt.exitCode === 0 && attempt.logComplete === true && attempt.turnCompleted === true);
  require('installed controls were not edited', attempt.controlsUnchanged);
  require('no safety or resource limit exceeded', attempt.safe === true);
  const changed = [...new Set([...Object.keys(initial), ...Object.keys(final)])].filter(name => initial[name] !== final[name]);
  if (kind === 'inquiry' || kind === 'conversation') {
    require('explanation did not edit the fixture', changed.length === 0);
    const answer = attempt.answer ?? '';
    const reviewed = verifyAnswerReview({ answer, kind, initialHash:treeHash(initial), specHash:hash(initial['README.md'] ?? ''),
      review:attempt.answerReview, reviewers:attempt.reviewers });
    if (reviewed.classification === 'FAIL_HARNESS') return { ...reviewed, oraclePassed:false, assertions };
    require('independent answer review', reviewed.passed);
    assertions.push({ id:'answer review receipt', passed:reviewed.passed, evidence:reviewed });
    require('inquiry did not require development checks', attempt.developmentChecks === false);
  } else {
    require('protected initial files are byte-identical', Object.keys(initial).filter(name => name !== 'shipping.mjs').every(name => final[name] === initial[name]));
    require('only source and additive tests changed', changed.every(name => name === 'shipping.mjs' || (/^test\/[^/]+\.test\.mjs$/u.test(name) && !(name in initial))));
    require('implementation changed', final['shipping.mjs'] !== initial['shipping.mjs']);
    const added = Object.keys(final).filter(name => /^test\/[^/]+\.test\.mjs$/u.test(name) && !(name in initial));
    require('a regression test was added', added.length > 0);
    // Find an observed failed test completion before the first implementation edit.
    let red;
    for (const checkpoint of checkpoints) {
      if (checkpoint.files['shipping.mjs'] !== initial['shipping.mjs']) break;
      if (checkpoint.exitCode !== 0 && Number.isInteger(checkpoint.exitCode) && checkpoint.testExecution === true
        && added.some(name => checkpoint.files[name] === final[name])) { red = checkpoint; break; }
    }
    require('observed Red precedes implementation edit', !!red);
    if (red) {
      const baseline = replaySuite(initial, path.join(replayRoot, 'baseline'));
      const redResult = replaySuite(red.files, path.join(replayRoot, 'red'));
      // The same tests must pass after the requested behavior alone is implemented.
      const corrected = { ...red.files, 'shipping.mjs': kind === 'feature'
        ? 'export function shippingFee(total, member = false) { return member || total >= 5000 ? 0 : 500; }\n'
        : 'export function shippingFee(total) { return total >= 5000 ? 0 : 500; }\n' };
      const targeted = replaySuite(corrected, path.join(replayRoot, 'targeted'));
      require('Red is a new assertion on the requested behavior', baseline.complete && redResult.complete && targeted.complete && baseline.exitCode === 0 && baseline.tests > 0
        && redResult.exitCode !== 0 && redResult.assertionFailure && redResult.failed > 0
        && targeted.exitCode === 0 && targeted.tests > baseline.tests && targeted.skipped === 0 && targeted.todo === 0);
      assertions.push({ id: 'Red replay', passed: redResult.exitCode !== 0, evidence: redResult });
    }
    const green = replaySuite(final, path.join(replayRoot, 'green'));
    if (!green.complete) return { classification:assertions.some(assertion => !assertion.passed) ? 'FAIL_PRODUCT' : 'FAIL_HARNESS', oraclePassed:false, assertions, reason:'Incomplete trusted test lifecycle' };
    require('Green contains nonempty existing and new tests', green.complete && green.exitCode === 0 && green.tests >= 3 && green.skipped === 0 && green.todo === 0);
    require('observed Green describes final tree', checkpoints.some(checkpoint => checkpoint.exitCode === 0
      && treeHash(checkpoint.files) === treeHash(final) && checkpoint.testExecution === true));
    const behavior = checkBehavior(final, kind, path.join(replayRoot, 'behavior'));
    require('independent boundary and compatibility oracle', behavior.passed);
    assertions.push({ id: 'Green replay', passed: green.exitCode === 0, evidence: green });
    assertions.push({ id: 'behavior oracle', passed: behavior.passed, evidence: behavior });
  }
  if (attempt.fault) require('one injected selector failure followed by legal recovery', attempt.injectedFailures === 1 && attempt.recovered === true);
  if (attempt.memory === 'related') require('related constraint influenced a compatibility decision and test', attempt.memoryApplied === true);
  if (attempt.memory === 'irrelevant') require('irrelevant lesson was inapplicable', attempt.memoryInapplicable === true);
  const passed = assertions.every(assertion => assertion.passed);
  return { classification: passed ? 'PASS' : 'FAIL_PRODUCT', oraclePassed: passed, assertions, changedPaths: changed };
}

export function removeReplay(root) { rmSync(root, { recursive: true, force: true }); }
