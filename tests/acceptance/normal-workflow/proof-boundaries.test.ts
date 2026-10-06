import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, symlinkSync, chmodSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
const load = (name: string) => import(pathToFileURL(path.resolve(`scripts/lib/normal-workflow/${name}.mjs`)).href);
const oracle = await load('oracle');
const { ANSWER_RUBRIC, RUBRIC_VERSION, verifyAnswerReview } = await load('answer-review');
const { freezePolicy, policyHash, validatePolicy, executionPolicyErrors } = await load('release-policy');
const { observeInstructions } = await load('instruction-observation');
const { authenticateProducer } = await load('producer-auth');
const { checkpointErrors } = await load('checkpoints');
const { verifyEvidenceBundle, bytesHash, evidenceFile } = await load('evidence-bundle');
const approval = {approved:true,testCredentials:true,provider:'chatgpt-subscription',model:'reviewed-model',clientVersion:'0.153.4',
  reasoningEffort:'medium',clients:['codex-cli'],authFile:'/unused-test-auth',attempts:1,maxSeconds:180,maxTotalSeconds:1440,maxTurns:10,maxToolCalls:60,maxCost:0,currency:'USD'};
const producer = {repository:'askdkc/kiokuko',commit:'a'.repeat(40),workflow:'.github/workflows/normal-workflow-acceptance.yml',ref:'main'};
const testManifest = [{id:'approved-repository-test',optionalSkip:false}];
const frozen = () => freezePolicy(approval,{testManifest,producer,reviewers:['independent-human']});
function instructionFixture(kind = 'conversation') {
  const indexes = [ {name:'kiokuko-codex-soul',canonicalName:'kiokuko-soul',bundleText:'soul body',packageVersion:'1.0.25'},
    {name:'kiokuko-codex-memory-reasoning',canonicalName:'memory-reasoning',bundleText:'reasoning body',packageVersion:'1.0.25'} ];
  const messages: any[]=[]; let sequence=0;
  const pair = (id: number, method: string, params: any, result: any) => messages.push(
    {sessionId:'session',sequence:++sequence,direction:'request',message:{id,method,params}},
    {sessionId:'session',sequence:++sequence,direction:'response',message:{id,result}});
  pair(0,'tools/list',{}, {tools:['task_inspect',kind === 'conversation' ? 'memory_recall' : 'task_prepare'].map(name => ({name,inputSchema:{type:'object',properties:{cwd:{type:'string'},path:{type:'string'},operation:{type:'string',enum:['read','files','status','skill']},soulRead:{type:'boolean',const:true},capabilities:{type:'array'},query:{type:'string'},task:{type:'string'},requestId:{type:'string'}}}}))});
  indexes.forEach((index,i) => pair(i+1,'tools/call',{name:'task_inspect',arguments:{operation:'skill',path:`skills/${index.name}/SKILL.md`}},
    {structuredContent:{text:index.bundleText,contentHash:oracle.hash(index.bundleText),loadedPackageVersion:index.packageVersion}}));
  pair(3,'tools/call',{name:kind === 'conversation' ? 'memory_recall' : 'task_prepare',arguments:{soulRead:true,capabilities:indexes.map(index => ({kind:'skill',name:index.name}))}},{structuredContent:kind === 'conversation' ? {items:[],nextAction:'proceed'} : {run:{runId:'fixture-run',status:'active'},nextAction:'proceed'}});
  return {messages,indexes,kind,agentsHash:oracle.hash('agents'),events:[{type:'instructions.loaded',content_hash:oracle.hash('agents')}],
    observations:[{event_name:'UserPromptSubmit',decision:'handled'}]};
}
function review(answer: string, kind: string, initial: any, verdict='PASS') {
  return {schema:RUBRIC_VERSION,kind,answerHash:oracle.hash(answer),initialHash:oracle.treeHash(initial),specHash:oracle.hash(initial['README.md']),
    reviewer:'independent-human',verdict,reason:'Independent human assessed the original answer against each fixed fact',
    criteria:ANSWER_RUBRIC[kind].map((criterion: string) => ({criterion,verdict}))};
}

test('independent semantic review binds original Japanese/English/paraphrased answers and exact rubric facts', () => {
  const initial={'README.md':'approved spec'};
  for (const answer of ['4999円は500円、5000円は無料です。','Shipping is 500 at 4999 and free at 5000.', 'At the threshold there is no shipping fee; one yen below it costs 500.']) {
    const input={answer,kind:'conversation',initialHash:oracle.treeHash(initial),specHash:oracle.hash(initial['README.md']),review:review(answer,'conversation',initial),reviewers:['independent-human']};
    assert.equal(verifyAnswerReview(input).classification,'PASS');
    for (const change of [{answer:answer+' altered'}, {specHash:'other'}, {initialHash:'other'}, {reviewers:[]}, {review:{...input.review,verdict:'UNCERTAIN'}},
      {review:{...input.review,criteria:[]}}, {review:{...input.review,schema:'old-rubric'}}]) assert.equal(verifyAnswerReview({...input,...change}).classification,'FAIL_HARNESS');
  }
  for (const answer of ['4999円は無料です。5000円は500円です。','There is no bug; free at 5000 is implemented.', '5000では無料になりません。', 'Free shipping.']) {
    assert.equal(verifyAnswerReview({answer,kind:'inquiry',initialHash:oracle.treeHash(initial),specHash:oracle.hash(initial['README.md']),
      review:review(answer,'inquiry',initial,'FAIL'),reviewers:['independent-human']}).classification,'FAIL_PRODUCT');
  }
});

test('Skill receipts require paired discovery, canonical identity, package body, unique IDs and completion before registration', () => {
  assert.equal(observeInstructions(instructionFixture()).instructionsVerified,true);
  assert.equal(observeInstructions(instructionFixture('bug')).instructionsVerified,true);
  const mutations: ((f: any) => void)[] = [
    f => {f.messages[1].message.result.tools=[];},
    f => {f.messages[0].message.method='other';},
    f => {delete f.messages[1].message.result.tools[0].inputSchema;},
    f => {f.messages[4].message.params.arguments.path=f.messages[2].message.params.arguments.path;},
    f => {f.messages[3].message.result.isError=true;},
    f => {f.messages[3].message.result.structuredContent.text='wrong body';},
    f => {f.messages[3].message.result.structuredContent.loadedPackageVersion='old';},
    f => {f.messages[3].sessionId='other';},
    f => {f.messages[3].message.id=88;},
    f => {f.messages[4].message.id=1;f.messages[5].message.id=1;},
    f => {f.messages[6].message.params.arguments.capabilities=[];},
    f => {f.messages[7].message.result={};},
    f => {f.messages.splice(3,1);},
    f => {const late=f.messages.splice(4,2); f.messages.push(...late); f.messages.forEach((x:any,i:number) => x.sequence=i+1);},
  ];
  for (const mutate of mutations) {const f=instructionFixture();mutate(f);assert.equal(observeInstructions(f).instructionsVerified,false);}
});

test('isolated lifecycle channel rejects empty/early exit/OS and IPC access; fake JSON and TAP cannot alter counts', () => {
  const root=mkdtempSync(path.join(tmpdir(),'lifecycle-boundaries-'));
  try {
    for (const source of ["import test from 'node:test';console.log('# tests 999\\n# skipped 0');test.skip('skip',()=>{});test.todo('todo');console.log('{\"complete\":true,\"counts\":{\"tests\":0}}');",
      "import test from 'node:test';test.skip('skip',()=>{});test.todo('todo');console.log('# tests 999');"]) {
      const result=oracle.replaySuite({'test/counts.test.mjs':source},path.join(root,`valid-${Math.random()}`));
      assert.equal(result.complete,true);assert.equal(result.tests,2);assert.equal(result.skipped,1);assert.equal(result.todo,1);assert.equal(result.assertionFailure,false);
    }
    for (const source of ['', 'process.exit(0)', "import {serialize} from 'node:v8';", "import fs from 'node:fs';", "import test from 'node:test';test('async',async()=>{});"]) {
      const result=oracle.replaySuite({'test/bad.test.mjs':source},path.join(root,`bad-${Math.random()}`));
      assert.ok(result.exitCode !== 0 || !result.complete);assert.equal(result.assertionFailure,false);
    }
  } finally {rmSync(root,{recursive:true,force:true});}
});

test('checkpoint validation rejects missing/duplicate/reversed IDs, stale hashes and persistence without exclusive ack', () => {
  const files={'shipping.mjs':'unchanged'};
  const point={files,treeHash:oracle.treeHash(files),sequence:1,commandId:'command',command:'npm test',exitCode:1,signal:null,acknowledged:true,barrier:'exclusive-persist-before-ack'};
  assert.deepEqual(checkpointErrors([point],'executor-barrier-v1'),[]);
  for (const [points,authority] of [[[], 'executor-barrier-v1'],[[point], 'unavailable'],[[point,point], 'executor-barrier-v1'],
    [[{...point,treeHash:'stale'}],'executor-barrier-v1'],[[{...point,acknowledged:false}],'executor-barrier-v1'],
    [[{...point,barrier:'receiver-lock'}],'executor-barrier-v1'],[[{...point,exitCode:null}],'executor-barrier-v1']] as any[])
    assert.ok(checkpointErrors(points,authority).length);
});

test('frozen policy covers all clients, exact version/model/provider/reasoning, requests, rubric and every budget', () => {
  const {policy,hash}=frozen();assert.equal(validatePolicy(policy,hash),policy);
  for (const key of ['model','provider','clientVersion','reasoningEffort','clients','attempts','maxSeconds','maxTotalSeconds','maxTurns','maxToolCalls','maxCost','currency','rubricVersion','scenarios','producer','testManifest']) {
    assert.throws(() => validatePolicy({...policy,[key]:key === 'clients' || key === 'scenarios' ? [] : 'changed'},hash));
  }
  const scenario=policy.scenarios[0];
  const actual={...policy,client:'codex-cli',request:scenario.request,argv:['exec','-c',`model=${JSON.stringify(policy.model)}`,'-c',`model_reasoning_effort=${JSON.stringify(policy.reasoningEffort)}`,scenario.request],calls:1,turns:1,seconds:1,modelObserved:true,providerObserved:true,clientVersionObserved:true};
  assert.deepEqual(executionPolicyErrors(policy,actual,scenario,'codex-cli'),[]);
  for (const key of ['model','clientVersion','provider','reasoningEffort','request','maxSeconds','maxTurns','maxToolCalls','modelObserved','providerObserved','clientVersionObserved'])
    assert.ok(executionPolicyErrors(policy,{...actual,[key]:'changed'},scenario,'codex-cli').length,key);
});

function bundleFixture() {
  const base=mkdtempSync(path.join(tmpdir(),'raw-evidence-boundaries-')); const root=path.join(base,'evidence');mkdirSync(root);
  const pack=path.join(base,'pack/package');mkdirSync(pack,{recursive:true});
  writeFileSync(path.join(pack,'package.json'),JSON.stringify({name:'kiokuko',version:'1.0.25',scripts:{typecheck:'tsc -p tsconfig.json --noEmit',test:'node scripts/run-tests.mjs tests','test:global-install':'node tests/ci/global-install-smoke.mjs'}}));
  for (const [name,body] of [['kiokuko-soul','soul body'],['memory-reasoning','reasoning body']] as [string,string][]) {
    mkdirSync(path.join(pack,'skills',name),{recursive:true});writeFileSync(path.join(pack,'skills',name,'SKILL.md'),body!);
  }
  const artifact=path.join(base,'candidate.tgz');assert.equal(spawnSync('tar',['-czf',artifact,'-C',path.dirname(pack),'package']).status,0);
  const {policy,hash:approvedPolicyHash}=frozen(); const runId='fixture-run';
  const candidate={commit:'b'.repeat(40),dirty:false,sourceDigest:'c'.repeat(64),artifactHash:bytesHash(readFileSync(artifact))};
  const manifest:any={schema:'normal-workflow-evidence-v1',runId,policyHash:approvedPolicyHash,candidate,
    producer:{approved:policy.producer,runId,jobId:'fixture-job'},files:[],attempts:[]};
  const write=(name:string,data:any) => {
    mkdirSync(path.dirname(path.join(root,name)),{recursive:true});writeFileSync(path.join(root,name),JSON.stringify({runId,policyHash:approvedPolicyHash,...data}));
  };
  const command=(argv:string[]) => ({schema:'command-execution-v1',argv,cwd:'/isolated-reviewed-candidate',before:candidate,after:candidate,policyHash:approvedPolicyHash,
    started:'2026-10-06T00:00:00Z',ended:'2026-10-06T00:00:01Z',exitCode:0,signal:null,environment:{NODE_VERSION:'v24.16.0'}});
  write('G0/command.json',command(['npm','run','typecheck']));write('G1/command.json',command(['npm','test']));write('G2/command.json',command(['npm','run','test:global-install']));
  write('G1/tests.json',{complete:true,counts:{tests:1,passed:1,failed:0,cancelled:0,skipped:0,todo:0},ids:[{id:testManifest[0]!.id,skipped:false}]});
  write('G2/stages.json',{stages:['pack','install','generated-skills','restart','optional-runtime'].map(id => ({id,complete:true,exitCode:0,
    artifactHash:candidate.artifactHash,sourceDigest:candidate.sourceDigest,commands:[{argv:['fixture-supervisor',id],exitCode:0,signal:null}]}))});
  for (const scenario of policy.scenarios) {
    const prefix=`attempts/${scenario.id}`;manifest.attempts.push({id:`codex-cli/${scenario.id}`,path:prefix});
    const repo=path.join(base,scenario.id);oracle.createFixture(repo,scenario.kind);const initial=oracle.snapshot(repo);
    const testSource=scenario.kind === 'feature' ? "import test from 'node:test';import assert from 'node:assert/strict';import {shippingFee} from '../shipping.mjs';test('member boundary',()=>assert.equal(shippingFee(4999,true),0));" :
      "import test from 'node:test';import assert from 'node:assert/strict';import {shippingFee} from '../shipping.mjs';test('exact boundary',()=>assert.equal(shippingFee(5000),0));";
    const red={...initial,'test/regression.test.mjs':testSource}; const final=['inquiry','conversation'].includes(scenario.kind) ? initial : {...red,'shipping.mjs':scenario.kind === 'feature' ?
      'export function shippingFee(total, member=false) {return member || total >= 5000 ? 0 : 500;}' : 'export function shippingFee(total) {return total >= 5000 ? 0 : 500;}'};
    const instructions=instructionFixture(scenario.kind);const answer=scenario.kind === 'conversation' ? '4999 costs 500; 5000 costs 0.' : 'The spec is free at 5000; the initial implementation charges 500 there. Below 5000 costs 500.';
    write(`${prefix}/execution.json`,{candidateBefore:candidate,candidateAfter:candidate,artifactHash:candidate.artifactHash,events:[{sequence:1,type:'turn.started'},{sequence:2,type:'item.completed',item:{id:'one',type:'mcp_tool_call'}},{sequence:3,type:'turn.completed'}],
      controlsBefore:oracle.hash(JSON.stringify({agents:'agents',indexes:instructions.indexes})),controlsAfter:oracle.hash(JSON.stringify({agents:'agents',indexes:instructions.indexes})),...policy,client:'codex-cli',request:scenario.request,argv:['exec','-c',`model=${JSON.stringify(policy.model)}`,'-c',`model_reasoning_effort=${JSON.stringify(policy.reasoningEffort)}`,scenario.request],calls:1,turns:1,seconds:1,modelObserved:true,providerObserved:true,clientVersionObserved:true,
      exitCode:0,signal:null,logComplete:true,turnCompleted:true,controlsUnchanged:true,safe:true,developmentChecks:false,checkpointAuthority:'executor-barrier-v1',injectedFailures:1,recovered:true,memoryApplied:true,memoryInapplicable:true});
    write(`${prefix}/identity.json`,{schema:'codex-isolated-identity-v1',model:policy.model,effort:policy.reasoningEffort,clientVersion:policy.clientVersion,authMode:'chatgpt',modelObserved:true});
    write(`${prefix}/instructions.json`,{agents:'agents',indexes:instructions.indexes});write(`${prefix}/protocol.json`,{messages:instructions.messages});
    write(`${prefix}/loader.json`,{observed:true,contentHash:oracle.hash('agents')});write(`${prefix}/hooks.json`,{observations:instructions.observations});
    write(`${prefix}/initial.json`,{files:initial});write(`${prefix}/final.json`,{files:final});write(`${prefix}/answer.json`,{answer});
    if (['inquiry','conversation'].includes(scenario.kind)) write(`${prefix}/review.json`,{review:review(answer,scenario.kind,initial)});
    else write(`${prefix}/checkpoints.json`,{checkpoints:[red,final].map((files,i) => ({files,sequence:i+1,commandId:`command-${i}`,command:'npm test',
      treeHash:oracle.treeHash(files),exitCode:i === 0 ? 1 : 0,signal:null,barrier:'exclusive-persist-before-ack',acknowledged:true,testExecution:true}))});
  }
  const seal=() => {
    const names=spawnSync('rg',['--files',root],{encoding:'utf8'}).stdout.trim().split('\n').map(name => path.relative(root,name)).filter(name => name !== 'manifest.json').sort();
    manifest.files=names.map(name => {const bytes=readFileSync(path.join(root,name));return {path:name,size:bytes.length,hash:bytesHash(bytes)};});
    writeFileSync(path.join(root,'manifest.json'),JSON.stringify(manifest));
  };
  seal();
  const verify=(fixture=true,proof: any=undefined) => verifyEvidenceBundle({artifact,evidenceRoot:root,policy,approvedPolicyHash,proof,replayRoot:path.join(base,`replay-${Math.random()}`),fixture});
  return {base,root,artifact,manifest,policy,approvedPolicyHash,verify,seal,write,close:()=>rmSync(base,{recursive:true,force:true})};
}

test('G4 reopens a real tarball and raw records; synthetic positive is evidence-only and never live release proof', () => {
  const f=bundleFixture();try {const result=f.verify();assert.equal(result.evidencePassed,true,JSON.stringify(result));assert.equal(result.releaseReady,false);assert.equal(f.verify(false).releaseReady,false);}finally {f.close();}
});

test('G4 rejects raw mutations, missing files, forged summaries, other runs, no-op commands, zero/all-skipped counts and duplicate attempts', () => {
  const mutations:((f:any)=>void)[]=[
    f=>writeFileSync(f.artifact,'changed bytes'),f=>rmSync(path.join(f.root,'G0/command.json')),
    f=>writeFileSync(path.join(f.root,'G0/command.json'),'{}'),
    f=>{f.write('G0/command.json',{argv:['true'],exitCode:0});f.seal();},
    f=>{f.write('G1/tests.json',{complete:true,counts:{tests:0,passed:0,failed:0,cancelled:0,skipped:0,todo:0},ids:[]});f.seal();},
    f=>{f.write('G1/tests.json',{complete:true,counts:{tests:1,passed:0,failed:0,cancelled:0,skipped:1,todo:0},ids:[{id:testManifest[0]!.id,skipped:true}]});f.seal();},
    f=>{f.manifest.candidate.dirty=true;f.seal();},f=>{f.manifest.candidate.sourceDigest='d'.repeat(64);f.seal();},
    f=>{f.manifest.attempts.push(f.manifest.attempts[0]);f.seal();},f=>{f.manifest.attempts.pop();f.seal();},
    f=>{f.write('G0/command.json',{runId:'other-run'});f.seal();},
    f=>{f.manifest.files[0].path='../escape';writeFileSync(path.join(f.root,'manifest.json'),JSON.stringify(f.manifest));},
    f=>{rmSync(path.join(f.root,'G0/command.json'));symlinkSync(path.join(f.root,'G1/command.json'),path.join(f.root,'G0/command.json'));},
    f=>{f.write('attempts/LIVE-01/identity.json',{schema:'codex-isolated-identity-v1',model:'changed'});f.seal();},
  ];
  for (const mutate of mutations) {const f=bundleFixture();try {mutate(f);assert.equal(f.verify().evidencePassed,false);}finally {f.close();}}
  const f=bundleFixture();try {assert.throws(()=>evidenceFile(f.root,'../escape'));const missing=spawnSync(process.execPath,['scripts/verify-normal-workflow-release.mjs','--artifact',f.artifact,'--evidence-root',f.root],{encoding:'utf8'});assert.equal(missing.status,1);}finally {f.close();}
});


test('authenticated producer archive binds raw manifest; recomputing local hashes cannot reuse its receipt', () => {
  const f=bundleFixture();const previousPath=process.env.PATH;let authenticated:any;
  try {
    f.manifest.runId='123';f.manifest.producer.runId='123';f.manifest.producer.jobId='456';
    for (const leaf of f.manifest.files) {
      const file=path.join(f.root,leaf.path);const data=JSON.parse(readFileSync(file,'utf8'));data.runId='123';writeFileSync(file,JSON.stringify(data));
    }
    f.seal();
    const archive=path.join(f.base,'archive.zip');
    const zipped=spawnSync('python3',['-c',`import pathlib,zipfile,sys
root=pathlib.Path(sys.argv[1])
with zipfile.ZipFile(sys.argv[2],'w') as z:
 for file in root.rglob('*'):
  if file.is_file(): z.write(file,file.relative_to(root))`,f.root,archive]);assert.equal(zipped.status,0);
    const mock=path.join(f.base,'mock-gh.mjs');
    writeFileSync(mock,`import {readFileSync} from 'node:fs';
const endpoint=process.argv.at(-1);
if(endpoint.endsWith('/zip')) process.stdout.write(readFileSync(${JSON.stringify(archive)}));
else if(endpoint.includes('actions/artifacts/')) console.log(JSON.stringify({expired:false,name:'normal-workflow-evidence',workflow_run:{id:123},digest:${JSON.stringify('sha256:'+bytesHash(readFileSync(archive)))}}));
else if(endpoint.includes('/jobs?')) console.log(JSON.stringify({jobs:[{id:456,name:'Normal workflow live gate (G3)',conclusion:'success'}]}));
else console.log(JSON.stringify({status:'completed',conclusion:'success',head_sha:${JSON.stringify(producer.commit)},head_branch:'main',path:${JSON.stringify(producer.workflow)},event:'workflow_dispatch'}));`);
    const bin=path.join(f.base,'bin');mkdirSync(bin);
    const gh=path.join(bin,'gh');writeFileSync(gh,`#!/bin/sh\nexec '${process.execPath}' '${mock}' "$@"\n`);chmodSync(gh,0o755);
    process.env.PATH=`${bin}${path.delimiter}${previousPath ?? ''}`;
    authenticated=authenticateProducer({policy:f.policy,runId:'123',artifactId:'789'});
    assert.equal(f.verify(false,authenticated.proof).releaseReady,true,'synthetic authenticated boundary positive; no real GitHub or model was executed');
    assert.equal(f.verify(false,{manifestHash:bytesHash(readFileSync(path.join(f.root,'manifest.json'))),producer:f.manifest.producer}).releaseReady,false);
    f.write('G1/tests.json',{complete:true,counts:{tests:0,passed:0,failed:0,cancelled:0,skipped:0,todo:0},ids:[]});f.seal();
    assert.equal(f.verify(false,authenticated.proof).releaseReady,false);
  } finally {if(previousPath === undefined) delete process.env.PATH;else process.env.PATH=previousPath;authenticated?.cleanup();f.close();}
});
