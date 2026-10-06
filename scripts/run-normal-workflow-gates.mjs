import { spawnSync, execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { fileURLToPath } from 'node:url';
import { sourceFingerprint } from './lib/normal-workflow/source-state.mjs';
import { validatePolicy, policyHash } from './lib/normal-workflow/release-policy.mjs';
const root = fileURLToPath(new URL('../', import.meta.url));
const { values } = parseArgs({ options:Object.fromEntries(['output','policy','policy-hash'].map(key => [key,{type:'string'}])) });
const output = path.resolve(values.output ?? mkdtempSync(path.join(tmpdir(),'kiokuko-normal-gates-')));
if (existsSync(output) && readdirSync(output).length) throw new Error('Gate output must be empty');
mkdirSync(output,{recursive:true});
const policy=values.policy ? validatePolicy(JSON.parse(readFileSync(values.policy,'utf8')),values['policy-hash']) : undefined;
const policyDigest=policy ? policyHash(policy) : null;
const git = args => execFileSync('git',args,{cwd:root,encoding:'utf8',timeout:10000}).trim();
const state = () => ({commit:git(['rev-parse','HEAD']),dirty:!!git(['status','--porcelain','--untracked-files=all']),sourceDigest:sourceFingerprint(root)});
const initial=state(); let previousPassed=true; const records=[];
for (const [gate,id,args] of [['G0','typecheck',['run','typecheck']],['G1','suite',['test']],['G2','install',['run','test:global-install']]]) {
  mkdirSync(path.join(output,gate));
  const started=new Date().toISOString(), before=state();
  let result;
  if (previousPassed) {
    console.log(`Running ${id}`);
    result=spawnSync('npm',args,{cwd:root,encoding:'utf8',timeout:15*60*1000,maxBuffer:32*1024*1024,
      env:{...process.env,KIOKUKO_TEST_RESULTS:gate === 'G1' ? path.join(output,'G1/tests.json') : '',
        KIOKUKO_PACKAGE_REPORT:path.join(output,'G2/package.json'),KIOKUKO_PACKAGE_ARTIFACT:path.join(output,'candidate.tgz')}});
  }
  const after=state(), ended=new Date().toISOString();
  const command={schema:'command-execution-v1',argv:['npm',...args],cwd:root,started,ended,exitCode:result?.status ?? null,signal:result?.signal ?? null,
    before,after,policyHash:policyDigest,environment:{NODE_VERSION:process.version,PLATFORM:process.platform,ARCH:process.arch}};
  writeFileSync(path.join(output,gate,'command.json'),JSON.stringify(command));
  writeFileSync(path.join(output,`${id}.log`),`${result?.stdout ?? ''}\n${result?.stderr ?? ''}`);
  let passed=!!result && result.status === 0 && JSON.stringify(before) === JSON.stringify(after) && after.sourceDigest === initial.sourceDigest;
  if (gate === 'G1') {
    let tests; try { tests=JSON.parse(readFileSync(path.join(output,'G1/tests.json'),'utf8')); } catch { }
    passed &&= tests?.complete === true && tests.counts.tests > 0 && tests.counts.failed === 0 && tests.counts.cancelled === 0 && tests.counts.todo === 0;
    if (policy) passed &&= JSON.stringify(tests?.ids.map(x => x.id).sort()) === JSON.stringify(policy.testManifest.map(x => x.id).sort())
      && tests.ids.every(x => !x.skipped || policy.testManifest.some(expected => expected.id === x.id && expected.optionalSkip));
  }
  if (gate === 'G2') {
    let packaged; try { packaged=JSON.parse(readFileSync(path.join(output,'G2/package.json'),'utf8')); } catch { }
    passed &&= packaged?.sourceDigest === initial.sourceDigest && packaged?.stages?.length === 5;
    writeFileSync(path.join(output,'G2/stages.json'),JSON.stringify(packaged ?? {}));
  }
  const record={...initial,gate,classification:passed ? 'PASS' : result ? 'FAIL_HARNESS' : 'NOT_RUN',command,policyHash:policyDigest,
    authority:'local-diagnostic',tests:gate === 'G0' ? 'N/A' : undefined};
  records.push(record); previousPassed &&= passed;
}
let packaged; try { packaged=JSON.parse(readFileSync(path.join(output,'G2/package.json'),'utf8')); } catch { }
const candidate={...initial,artifactHash:packaged?.artifactHash ?? null,policyHash:policyDigest};
for (const record of records) writeFileSync(path.join(output,`${record.gate}.json`),JSON.stringify({...record,artifactHash:candidate.artifactHash},null,2));
writeFileSync(path.join(output,'candidate.json'),JSON.stringify(candidate,null,2));
console.log(JSON.stringify({output,deterministicPassed:previousPassed,releaseReady:false,candidate},null,2));
process.exitCode=previousPassed ? 0 : 1;
