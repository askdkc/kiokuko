import { sandboxProbeValid } from './lib/normal-workflow/native-sandbox.mjs';
import { executorReceiptErrors } from './lib/normal-workflow/executor-receipt.mjs';
// Runs after collection has ended and the execution account has been removed.
// Reviews are supplied by an independent operator, never by the execution AI.
import { readFileSync, writeFileSync, mkdirSync, existsSync, mkdtempSync, rmSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { validatePolicy, requiredAttempts, executionPolicyErrors } from './lib/normal-workflow/release-policy.mjs';
import { releaseGate } from './lib/normal-workflow/contracts.mjs';
import { observeInstructions } from './lib/normal-workflow/instruction-observation.mjs';
import { evaluateAttempt, hash, treeHash } from './lib/normal-workflow/oracle.mjs';
import { approvedReviewers } from './lib/normal-workflow/review-authority.mjs';
const {values}=parseArgs({options:{live:{type:'string'},policy:{type:'string'},'policy-hash':{type:'string'},reviews:{type:'string'},'github-review':{type:'boolean'}}});
const read=file=>JSON.parse(readFileSync(file,'utf8'));
const policy=validatePolicy(read(values.policy),values['policy-hash']);
const live=path.resolve(values.live), summary=read(path.join(live,'summary.json'));
if(summary.policyHash!==values['policy-hash']) throw new Error('Collected attempts differ from approved policy');
const reviews=values.reviews && existsSync(values.reviews)?read(values.reviews):[];
if(!Array.isArray(reviews) || new Set(reviews.map(x=>x.id)).size!==reviews.length
  || reviews.some(x=>!requiredAttempts(policy).includes(x.id) || !['inquiry','conversation'].includes(policy.scenarios.find(s=>x.id.endsWith('/'+s.id))?.kind))) throw new Error('Duplicate or unexpected review');
let authority;
if(values['github-review']) {
  if(process.env.GITHUB_SHA!==policy.producer.commit || process.env.GITHUB_REPOSITORY!==policy.producer.repository) throw new Error('Wrong reviewer workflow producer');
  const history=JSON.parse(execFileSync('gh',['api',`repos/${policy.producer.repository}/actions/runs/${process.env.GITHUB_RUN_ID}/approvals`],{encoding:'utf8',timeout:30000}));
  authority={schema:'github-environment-review-v1',runId:process.env.GITHUB_RUN_ID,environment:'normal-workflow-answer-review',reviewers:approvedReviewers(history,policy.reviewers)};
  if(!authority.reviewers.length || reviews.some(x=>!authority.reviewers.includes(x.review?.reviewer))) throw new Error('Review identity has not independently approved the protected environment');
}
const replay=mkdtempSync(path.join(tmpdir(),'kiokuko-final-review-'));
const reports=[];
try {
  for(const id of requiredAttempts(policy)) {
    const [client,scenarioId]=id.split('/'),scenario=policy.scenarios.find(x=>x.id===scenarioId);
    const dir=path.join(live,scenarioId), report={...summary.candidate,client,scenario:scenarioId,executionMode:'live',instructionsVerified:false,oraclePassed:false};
    try {
      if(client!=='codex-cli' || !existsSync(path.join(dir,'attempt.json'))) {reports.push({...report,classification:'NOT_RUN',reason:'No matching real attempt'});continue;}
      const attempt=read(path.join(dir,'attempt.json')),identity=read(path.join(dir,'identity.json'));
      const actual={...attempt,model:identity.model,modelObserved:identity.modelObserved,clientVersion:identity.clientVersion,
        providerObserved:identity.authMode==='chatgpt',clientVersionObserved:!!identity.clientVersion,
        seconds:attempt.seconds ?? (Date.parse(attempt.ended)-Date.parse(attempt.started))/1000,
        maxSeconds:policy.maxSeconds,maxTurns:policy.maxTurns,maxToolCalls:policy.maxToolCalls,maxCost:policy.maxCost,currency:policy.currency};
      if(executionPolicyErrors(policy,actual,scenario,client).length || identity.effort!==policy.reasoningEffort
        || !['candidateBefore','candidateAfter'].every(key=>attempt[key]?.commit===summary.candidate.commit && attempt[key]?.dirty===false
          && attempt[key]?.sourceDigest===summary.candidate.sourceDigest) || attempt.artifactHash!==summary.candidate.artifactHash) throw new Error('Actual execution/source differs from collected policy/candidate');
      if(!['inquiry','conversation'].includes(scenario.kind) && (!sandboxProbeValid(identity.nativeSandboxProbe,policy.clientVersion) || executorReceiptErrors(attempt.checkpoints,attempt.executorProtocol,identity.nativeReadonlyObserved).length)) throw new Error('Native sandbox or exclusive executor receipt proof failed');
      const instructions=read(path.join(dir,'instructions.json')), loader=read(path.join(dir,'instruction-receipt.json'));
      const messages=readFileSync(path.join(dir,'discovery.jsonl'),'utf8').trim().split('\n').filter(Boolean).map(JSON.parse);
      const observed=observeInstructions({messages,indexes:instructions.indexes,agentsHash:hash(instructions.agents),
        events:loader.observed?[{type:'instructions.loaded',content_hash:loader.contentHash}]:[],observations:read(path.join(dir,'hooks.json')),kind:scenario.kind});
      const review=reviews.find(x=>x.id===id)?.review;
      const outcome=evaluateAttempt({...attempt,kind:scenario.kind,memory:scenario.memory,fault:scenario.fault,
        instructionsVerified:observed.instructionsVerified,answerReview:review,reviewers:policy.reviewers},path.join(replay,scenarioId));
      // Write reviewed receipts only after validation; an invalid/unapproved
      // review cannot be smuggled into the sealer as an accepted receipt.
      if(review && ['PASS','FAIL_PRODUCT'].includes(outcome.classification)) writeFileSync(path.join(dir,'answer-review.json'),JSON.stringify(review));
      else if(existsSync(path.join(dir,'answer-review.json'))) rmSync(path.join(dir,'answer-review.json'));
      writeFileSync(path.join(dir,'oracle.json'),JSON.stringify(outcome));
      reports.push({...report,...outcome,instructionsVerified:observed.instructionsVerified});
    }catch(error){reports.push({...report,classification:'FAIL_HARNESS',reason:error.message});}
  }
}finally{rmSync(replay,{recursive:true,force:true});}
const gate=releaseGate(summary.candidate,reports,requiredAttempts(policy));
const waiting=reports.some(x=>x.classification==='WAITING_REVIEW');
const finalized={...summary,reports,liveGate:gate,reviewAuthority:authority,phase:waiting?'WAITING_REVIEW':'FINALIZED',releaseReady:false};
writeFileSync(path.join(live,'summary.json'),JSON.stringify(finalized,null,2));
console.log(JSON.stringify({livePassed:gate.passed,phase:finalized.phase,reports:reports.map(x=>({id:`${x.client}/${x.scenario}`,classification:x.classification,reason:x.reason}))},null,2));
process.exitCode=gate.passed?0:waiting && reports.every(x=>['PASS','WAITING_REVIEW'].includes(x.classification))?2:1;
