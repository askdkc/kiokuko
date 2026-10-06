import { spawnSync, execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { fileURLToPath } from 'node:url';
import { sourceFingerprint } from './lib/normal-workflow/source-state.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const { values } = parseArgs({ options: { output: { type: 'string' } } });
const output = path.resolve(values.output ?? mkdtempSync(path.join(tmpdir(), 'kiokuko-normal-gates-')));
if (existsSync(output) && readdirSync(output).length) throw new Error('Gate output must be empty');
mkdirSync(output, { recursive: true });
const git = args => execFileSync('git', args, { cwd: root, encoding: 'utf8', timeout: 10000 });
const sourceDigest = sourceFingerprint(root);
const commit = git(['rev-parse', 'HEAD']).trim();
const commands = [];
let passed = true;
for (const [id, args] of [['typecheck', ['run', 'typecheck']], ['suite', ['test']], ['install', ['run', 'test:global-install']]]) {
  if (!passed) break;
  console.log(`Running ${id}`);
  const result = spawnSync('npm', args, { cwd: root, encoding: 'utf8', timeout: 15 * 60 * 1000, maxBuffer: 16 * 1024 * 1024,
    env: { ...process.env, KIOKUKO_PACKAGE_REPORT: path.join(output, 'G2.json'), KIOKUKO_PACKAGE_ARTIFACT: path.join(output, 'candidate.tgz') } });
  writeFileSync(path.join(output, `${id}.log`), `${result.stdout ?? ''}\n${result.stderr ?? ''}`);
  commands.push({ executable: `npm ${args.join(' ')}`, exitCode: result.status, signal: result.signal });
  passed = result.status === 0;
  if (id === 'suite') {
    // The default collector must actually include the new acceptance oracle.
    passed &&= /initial fixture tests pass but independent oracle detects/u.test(result.stdout)
      && /release candidate requires matching G0-G3 evidence/u.test(result.stdout);
  }
}
passed &&= sourceFingerprint(root) === sourceDigest;
const packaged = existsSync(path.join(output, 'G2.json')) ? JSON.parse(readFileSync(path.join(output, 'G2.json'), 'utf8')) : {};
const candidate = { commit, artifactHash: packaged.artifactHash ?? null, sourceDigest,
  dirty: git(['status', '--porcelain', '--untracked-files=all']).trim() !== '' };
for (const gate of ['G0', 'G1']) writeFileSync(path.join(output, `${gate}.json`), JSON.stringify({ ...candidate, gate,
  classification: passed ? 'PASS' : 'FAIL_HARNESS', commands }, null, 2));
writeFileSync(path.join(output, 'candidate.json'), JSON.stringify(candidate, null, 2));
console.log(JSON.stringify({ output, deterministicPassed: passed, releaseReady: false, candidate }, null, 2));
process.exitCode = passed ? 0 : 1;
