// Run only in the independently approved supervisor. Sealing adds integrity,
// never authenticity: G4 separately downloads and authenticates the CI artifact.
import { mkdirSync, copyFileSync, readFileSync, readdirSync, lstatSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { validatePolicy } from './lib/normal-workflow/release-policy.mjs';
import { bytesHash } from './lib/normal-workflow/evidence-bundle.mjs';
const { values } = parseArgs({options:Object.fromEntries(['deterministic','live','policy','policy-hash','run-id','job-id','output'].map(name => [name,{type:'string'}]))});
for (const key of Object.keys(values)) if (!values[key]) throw new Error(`Missing ${key}`);
const read = file => JSON.parse(readFileSync(file,'utf8'));
const policy = validatePolicy(read(values.policy),values['policy-hash']);
const root=path.resolve(values.output);mkdirSync(root,{recursive:true});if (readdirSync(root).length) throw new Error('Evidence root must be new/empty');
const runId=values['run-id'],policyDigest=values['policy-hash'];
const write=(relative,data) => { const file=path.join(root,relative);mkdirSync(path.dirname(file),{recursive:true});writeFileSync(file,JSON.stringify({...data,runId,policyHash:policyDigest})); };
const candidate=read(path.join(values.deterministic,'candidate.json'));
for (const [relative,source] of [['G0/command.json','G0/command.json'],['G1/command.json','G1/command.json'],['G1/tests.json','G1/tests.json'],['G2/command.json','G2/command.json'],['G2/stages.json','G2/stages.json']])
  write(relative,read(path.join(values.deterministic,source)));
const summary=read(path.join(values.live,'summary.json'));
if(summary.phase!=='FINALIZED' || summary.liveGate?.passed!==true || summary.reports.some(x=>x.classification!=='PASS')) throw new Error('G3 is not finalized: review/execution remains incomplete');
if (candidate.artifactHash !== summary.candidate.artifactHash || candidate.sourceDigest !== summary.candidate.sourceDigest
  || summary.policyHash !== policyDigest) throw new Error('Live/deterministic source/artifact/policy differs');
const attempts=[];
for (const report of summary.reports) {
  const scenario=policy.scenarios.find(x => x.id === report.scenario);
  const base=path.join(values.live,report.scenario),relative=`attempts/${report.client}/${report.scenario}`;
  attempts.push({id:`${report.client}/${report.scenario}`,path:relative});
  // A blocked or unexecuted attempt stays incomplete; never manufacture evidence.
  if (!lstatOptional(path.join(base,'attempt.json'))) continue;
  const attempt=read(path.join(base,'attempt.json')),identity=read(path.join(base,'identity.json'));
  write(`${relative}/execution.json`,{...attempt,model:identity.model,modelObserved:identity.modelObserved,
    providerObserved:identity.authMode === 'chatgpt',clientVersionObserved:!!identity.clientVersion,
    seconds:(Date.parse(attempt.ended)-Date.parse(attempt.started))/1000,
    maxSeconds:policy.maxSeconds,maxTurns:policy.maxTurns,maxToolCalls:policy.maxToolCalls,maxCost:policy.maxCost,currency:policy.currency});
  write(`${relative}/identity.json`,identity);write(`${relative}/initial.json`,{files:attempt.initial});write(`${relative}/final.json`,{files:attempt.final});
  write(`${relative}/answer.json`,{answer:attempt.answer});write(`${relative}/checkpoints.json`,{checkpoints:attempt.checkpoints});
  write(`${relative}/executor.json`,{messages:attempt.executorProtocol ?? []});
  write(`${relative}/instructions.json`,read(path.join(base,'instructions.json')));
  write(`${relative}/loader.json`,read(path.join(base,'instruction-receipt.json')));write(`${relative}/hooks.json`,{observations:read(path.join(base,'hooks.json'))});
  write(`${relative}/protocol.json`,{messages:readFileSync(path.join(base,'discovery.jsonl'),'utf8').trim().split('\n').filter(Boolean).map(JSON.parse)});
  // Review is supplied after the original answer by an approved independent
  // reviewer. Never generate it from the execution model or invent a verdict.
  if (lstatOptional(path.join(base,'answer-review.json'))) write(`${relative}/review.json`,{review:read(path.join(base,'answer-review.json'))});
}
function lstatOptional(file) {try {return lstatSync(file).isFile();} catch {return false;}}
copyFileSync(path.join(values.deterministic,'candidate.tgz'),path.join(root,'candidate.tgz'));
const files=[];
const visit=directory => {for (const entry of readdirSync(directory,{withFileTypes:true})) {
  if (entry.isSymbolicLink()) throw new Error('Evidence symlink');
  const file=path.join(directory,entry.name);if (entry.isDirectory()) visit(file);else {
    const bytes=readFileSync(file);files.push({path:path.relative(root,file),size:bytes.length,hash:bytesHash(bytes)});
  }
}};visit(root);files.sort((a,b) => a.path.localeCompare(b.path));
writeFileSync(path.join(root,'manifest.json'),JSON.stringify({schema:'normal-workflow-evidence-v1',runId,policyHash:policyDigest,candidate,
  producer:{approved:policy.producer,runId,jobId:values['job-id']},files,attempts},null,2));
console.log(JSON.stringify({output:root,releaseReady:false,reason:'Sealed diagnostic evidence; independent post-run authentication and verification required'}));
