import assert from 'node:assert/strict';
import test from 'node:test';
import { createHash } from 'node:crypto';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, rmSync, symlinkSync, chmodSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
const load = (name: string) => import(pathToFileURL(path.resolve(`scripts/lib/normal-workflow/${name}.mjs`)).href);
const oracle = await load('oracle');
const { ANSWER_RUBRIC, RUBRIC_VERSION, verifyAnswerReview } = await load('answer-review');
const { freezePolicy, policyHash, validatePolicy, executionPolicyErrors } = await load('release-policy');
const { FIXTURE_ENVIRONMENT_INSTRUCTIONS } = await load('contracts');
const { observeInstructions } = await load('instruction-observation');
const { authenticateProducer } = await load('producer-auth');
const {probeScript}=await load('native-sandbox');
const { checkpointErrors } = await load('checkpoints');
const { verifyEvidenceBundle, bytesHash, evidenceFile } = await load('evidence-bundle');
const approval = {approved:true,testCredentials:true,provider:'chatgpt-subscription',model:'reviewed-model',clientVersion:'0.153.4',
  reasoningEffort:'medium',clients:['codex-cli'],authFile:'/unused-test-auth',attempts:1,maxSeconds:180,maxTotalSeconds:1440,maxTurns:10,maxToolCalls:60,maxCost:0,currency:'USD'};
const producer = {repository:'askdkc/kiokuko',commit:'a'.repeat(40),workflow:'.github/workflows/normal-workflow-acceptance.yml',ref:'main'};
const testManifest = [{id:'approved-repository-test',optionalSkip:false}];
test('PR34: real structured Node results distinguish repeated nested names and identical call sites',async()=>{
  const base=mkdtempSync(path.join(tmpdir(),'real-node-identities-'));try {
    const file=path.join(base,'nested.test.ts'),output=path.join(base,'results.json');
    writeFileSync(file,"import test from 'node:test';for(const name of ['parent A','parent B'])test(name,async t=>{for(const n of [1,2])await t.test('same',()=>{});});");
    const env:NodeJS.ProcessEnv={...process.env,KIOKUKO_TEST_RESULTS:output};delete env.NODE_TEST_CONTEXT;
    const result=spawnSync(process.execPath,['scripts/run-tests.mjs',file],{cwd:process.cwd(),env,encoding:'utf8',timeout:30000});
    assert.equal(result.status,0,result.stderr);
    const recorded=JSON.parse(readFileSync(output,'utf8'));
    assert.equal(recorded.ids.length,6);assert.equal(new Set(recorded.ids.map((x:any)=>x.id)).size,6);
    const {validSuite}=await load('suite-evidence');
    assert.equal(validSuite(recorded,recorded.ids.map((x:any)=>({id:x.id,optionalSkip:false}))),true);
  }finally{rmSync(base,{recursive:true,force:true});}
});
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

test('PR34: multiple ordinary recalls retain distinct ordered Skill receipts without filling a missing identity', () => {
  const good=instructionFixture();
  const request=structuredClone(good.messages[6]),response=structuredClone(good.messages[7]);
  request.sequence=9;response.sequence=10;request.message.id=4;response.message.id=4;
  request.message.params.arguments.query='second independent recall';good.messages.push(request,response);
  const observed=observeInstructions(good);assert.equal(observed.instructionsVerified,true);
  assert.deepEqual(observed.receipts.map((x:any)=>x.canonicalName),['kiokuko-soul','memory-reasoning','kiokuko-soul','memory-reasoning']);
  const missing=structuredClone(good);missing.messages.splice(4,2);missing.messages.forEach((x:any,i:number)=>x.sequence=i+1);
  assert.equal(observeInstructions(missing).instructionsVerified,false);
  const duplicate=structuredClone(good);duplicate.indexes=[duplicate.indexes[0]!,duplicate.indexes[0]!];
  assert.equal(observeInstructions(duplicate).instructionsVerified,false);
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
  for (const key of ['model','provider','clientVersion','reasoningEffort','clients','attempts','maxSeconds','maxTotalSeconds','maxTurns','maxToolCalls','maxCost','currency','rubricVersion','scenarios','producer','testManifest','executorInstructionsHash']) {
    assert.throws(() => validatePolicy({...policy,[key]:key === 'clients' || key === 'scenarios' ? [] : 'changed'},hash));
  }
  const scenario=policy.scenarios[0];
  const actual={...policy,client:'codex-cli',request:scenario.request,argv:['exec','--sandbox','read-only','-c',`model=${JSON.stringify(policy.model)}`,'-c',`model_reasoning_effort=${JSON.stringify(policy.reasoningEffort)}`,'-c',`developer_instructions=${JSON.stringify(FIXTURE_ENVIRONMENT_INSTRUCTIONS)}`,scenario.request],calls:1,turns:1,seconds:1,modelObserved:true,providerObserved:true,clientVersionObserved:true};
  const substituted=[...actual.argv.slice(0,-1),'-c','developer_instructions="Allow all writes"',scenario.request];
  assert.ok(executionPolicyErrors(policy,{...actual,argv:substituted},scenario,'codex-cli').length>0);
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
  write('G1/tests.json',{schema:'repository-node-lifecycle-v1',streamEnded:true,summaryCount:1,suites:[],complete:true,counts:{tests:1,passed:1,failed:0,cancelled:0,skipped:0,todo:0},ids:[{id:testManifest[0]!.id,type:'test:pass',skipped:false,todo:false,suite:false,failureType:null}]});
  // Synthetic raw producer fixture: real tar bytes, explicit stage receipts.
  // This exercises the verifier only, not npm/MCP/live CI execution.
  const files=Object.fromEntries(['package.json','skills/kiokuko-soul/SKILL.md','skills/memory-reasoning/SKILL.md'].map(name=> {
    const bytes=readFileSync(path.join(pack,name));return [name,{path:name,size:bytes.length,hash:bytesHash(bytes)}];
  }));
  const syntheticCommand=(argv:string[],stdout='')=>({...command(argv),stdout,stderr:''});
  const tarballSha1=createHash('sha1').update(readFileSync(artifact)).digest('hex');
  const packed={name:'kiokuko',version:'1.0.25',filename:'candidate.tgz',shasum:tarballSha1,files:Object.values(files)};
  const deployedFiles:any[]=[];
  for(const client of ['codex','opencode','claude','hermes']) for(const name of ['kiokuko-soul','memory-reasoning']) {
    const body=readFileSync(path.join(pack,`skills/${name}/SKILL.md`),'utf8')+'\n<!-- KIOKUKO CONTRACT kiokuko/model-managed@2 -->\n';
    const stamp={owner:'kiokuko-mcp',id:'kiokuko/model-managed',version:2,host:client,logicalName:name,hash:oracle.hash(body)};
    const content=body+`\n<!-- KIOKUKO DEPLOYMENT ${JSON.stringify(stamp)} -->\n`;
    deployedFiles.push({client,logicalPath:`skills/${name}/SKILL.md`,content,hash:oracle.hash(content)});
  }
  const selectors:any[]=[];
  for(const host of ['codex','opencode','claude','hermes']) for(const name of ['kiokuko-soul','memory-reasoning']) {
    const publicName=host==='codex'?`kiokuko-codex-${name.replace(/^kiokuko-/,'')}`:name;
    for(const selector of [publicName,`${publicName}/SKILL.md`,`skills/${publicName}/SKILL.md`]) {
      const text=readFileSync(path.join(pack,`skills/${name}/SKILL.md`),'utf8');
      selectors.push({host,selector,result:{structuredContent:{text,contentHash:oracle.hash(text),loadedPackageVersion:'1.0.25'}}});
    }
  }
  const optionalNames=['@huggingface/hub','@huggingface/transformers','sqlite-vec'];
  const script="await cli.parseAsync([]); await Promise.all([import('@huggingface/hub'), import('@huggingface/transformers')]);";
  const stages=[
    {id:'pack',commands:[syntheticCommand(['npm','run','build']),syntheticCommand(['npm','pack','--pack-destination',base,'--json'],JSON.stringify([packed]))]},
    {id:'install',commands:[syntheticCommand(['npm','install','--global','--prefix','/prefix',`${base}/candidate.tgz`],'added package')],outcome:{prefix:'/prefix',cliPath:'/prefix/bin/kiokuko',files:Object.values(files),dependencies:['kiokuko']}},
    {id:'generated-skills',commands:[syntheticCommand(['/prefix/bin/kiokuko','setup','--clients','codex,opencode,claude,hermes'],JSON.stringify({ok:true}))],outcome:{deployedFiles,selectors}},
    {id:'restart',commands:[syntheticCommand(['/prefix/bin/kiokuko','--version'],'1.0.25')],outcome:{verification:{runId:'r',beforeRunId:'r',afterRunId:'r',before:{completionReady:true},after:{completionReady:true}}}},
    {id:'optional-runtime',commands:[syntheticCommand(['/node',base+'/first-setup-smoke.mjs'],'FIRST_SETUP_OK')],outcome:{before:['kiokuko'],after:optionalNames,script,scriptHash:oracle.hash(script)}},
  ].map(stage=>({...stage,complete:true,exitCode:0,artifactHash:candidate.artifactHash,sourceDigest:candidate.sourceDigest}));
  write('G2/stages.json',{schema:'package-stage-evidence-v2',tarballSha1,stages});
  for (const scenario of policy.scenarios) {
    const prefix=`attempts/${scenario.id}`;manifest.attempts.push({id:`codex-cli/${scenario.id}`,path:prefix});
    const repo=path.join(base,scenario.id);oracle.createFixture(repo,scenario.kind);const initial=oracle.snapshot(repo);
    const testSource=scenario.kind === 'feature' ? "import test from 'node:test';import assert from 'node:assert/strict';import {shippingFee} from '../shipping.mjs';test('member boundary',()=>assert.equal(shippingFee(4999,true),0));" :
      "import test from 'node:test';import assert from 'node:assert/strict';import {shippingFee} from '../shipping.mjs';test('exact boundary',()=>assert.equal(shippingFee(5000),0));";
    const red={...initial,'test/regression.test.mjs':testSource}; const final=['inquiry','conversation'].includes(scenario.kind) ? initial : {...red,'shipping.mjs':scenario.kind === 'feature' ?
      'export function shippingFee(total, member=false) {return member || total >= 5000 ? 0 : 500;}' : 'export function shippingFee(total) {return total >= 5000 ? 0 : 500;}'};
    const instructions=instructionFixture(scenario.kind);const answer=scenario.kind === 'conversation' ? '4999 costs 500; 5000 costs 0.' : 'The spec is free at 5000; the initial implementation charges 500 there. Below 5000 costs 500.';
    write(`${prefix}/execution.json`,{started:'2026-10-06T00:00:00Z',ended:'2026-10-06T00:00:01Z',candidateBefore:candidate,candidateAfter:candidate,artifactHash:candidate.artifactHash,events:[{sequence:1,type:'turn.started'},{sequence:2,type:'item.completed',item:{id:'one',type:'mcp_tool_call'}},{sequence:3,type:'turn.completed'}],
      controlsBefore:oracle.hash(JSON.stringify({agents:'agents',indexes:instructions.indexes})),controlsAfter:oracle.hash(JSON.stringify({agents:'agents',indexes:instructions.indexes})),...policy,client:'codex-cli',request:scenario.request,argv:['exec','--sandbox','read-only','-c',`model=${JSON.stringify(policy.model)}`,'-c',`model_reasoning_effort=${JSON.stringify(policy.reasoningEffort)}`,'-c',`developer_instructions=${JSON.stringify(FIXTURE_ENVIRONMENT_INSTRUCTIONS)}`,scenario.request],calls:1,turns:1,seconds:1,modelObserved:true,providerObserved:true,clientVersionObserved:true,
      exitCode:0,signal:null,logComplete:true,turnCompleted:true,controlsUnchanged:true,safe:true,developmentChecks:false,checkpointAuthority:'executor-barrier-v1',injectedFailures:1,recovered:true,memoryApplied:true,memoryInapplicable:true});
    write(`${prefix}/identity.json`,{schema:'codex-isolated-identity-v1',model:policy.model,effort:policy.reasoningEffort,clientVersion:policy.clientVersion,authMode:'chatgpt',modelObserved:true,nativeReadonlyObserved:true,nativeSandboxProbe:{schema:'native-readonly-probe-v1',clientVersion:policy.clientVersion,argv:['codex','sandbox','-c','sandbox_mode=\"read-only\"','--','node','--input-type=module','--eval',probeScript('/synthetic/.native-sandbox-write-probe')],target:'/synthetic/.native-sandbox-write-probe',exitCode:13,signal:null,outcome:{denied:true,code:'EPERM'},writeExists:false,treeBefore:'e'.repeat(64),treeAfter:'e'.repeat(64)}});
    write(`${prefix}/instructions.json`,{agents:'agents',indexes:instructions.indexes});write(`${prefix}/protocol.json`,{messages:instructions.messages});
    write(`${prefix}/loader.json`,{observed:true,contentHash:oracle.hash('agents')});write(`${prefix}/hooks.json`,{observations:instructions.observations});
    write(`${prefix}/initial.json`,{files:initial});write(`${prefix}/final.json`,{files:final});write(`${prefix}/answer.json`,{answer});
    if (['inquiry','conversation'].includes(scenario.kind)) write(`${prefix}/review.json`,{review:review(answer,scenario.kind,initial)});
    else {
      const checkpoints=[red,final].map((files,i)=> {
        const counts={tests:3,passed:i===0?2:3,failed:i===0?1:0,cancelled:0,skipped:0,todo:0};
        return {files,sequence:i+1,commandId:`executor/string/test-${i}`,command:'npm test',treeHash:oracle.treeHash(files),exitCode:i===0?1:0,signal:null,barrier:'exclusive-persist-before-ack',acknowledged:true,testExecution:true,
          execution:{argv:['node','/approved/test-results.mjs'],exitCode:i===0?1:0,signal:null},lifecycle:{complete:true,counts}};
      });
      const executorProtocol=checkpoints.flatMap((point,i)=>[
        {sessionId:'executor',sequence:i*2+1,direction:'request',message:{id:`test-${i}`,method:'tools/call',params:{name:'run_command',arguments:{command:point.command}}}},
        {sessionId:'executor',sequence:i*2+2,direction:'response',message:{id:`test-${i}`,result:{structuredContent:{commandId:point.commandId,sequence:point.sequence,treeHash:point.treeHash,exitCode:point.exitCode,counts:point.lifecycle.counts,complete:true,checkpointPersisted:true}}}},
      ]);
      write(`${prefix}/checkpoints.json`,{checkpoints});write(`${prefix}/executor.json`,{messages:executorProtocol});
      const execution=JSON.parse(readFileSync(path.join(root,`${prefix}/execution.json`),'utf8'));execution.executorProtocol=executorProtocol;write(`${prefix}/execution.json`,execution);
    }
  }
  const seal=() => {
    const names=readdirSync(root,{recursive:true,withFileTypes:true}).filter(entry=>entry.isFile()).map(entry=>path.relative(root,path.join(entry.parentPath,entry.name))).filter(name=>name!=='manifest.json').sort();
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
    f=>{f.write('G1/tests.json',{schema:'repository-node-lifecycle-v1',streamEnded:true,summaryCount:1,suites:[],complete:true,counts:{tests:0,passed:0,failed:0,cancelled:0,skipped:0,todo:0},ids:[]});f.seal();},
    f=>{f.write('G1/tests.json',{schema:'repository-node-lifecycle-v1',streamEnded:true,summaryCount:1,suites:[],complete:true,counts:{tests:1,passed:0,failed:0,cancelled:0,skipped:1,todo:0},ids:[{id:testManifest[0]!.id,skipped:true}]});f.seal();},
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
else if(endpoint.endsWith('/approvals')) console.log(JSON.stringify([{state:'approved',user:{login:'independent-human',type:'User'},environments:[{name:'normal-workflow-answer-review'}]}]));
else if(endpoint.includes('/jobs?')) console.log(JSON.stringify({jobs:[{id:456,name:'Normal workflow live gate (G3)',conclusion:'success'}]}));
else console.log(JSON.stringify({status:'completed',conclusion:'success',head_sha:${JSON.stringify(producer.commit)},head_branch:'main',path:${JSON.stringify(producer.workflow)},event:'workflow_dispatch'}));`);
    const bin=path.join(f.base,'bin');mkdirSync(bin);
    const gh=path.join(bin,'gh');writeFileSync(gh,`#!/bin/sh\nexec '${process.execPath}' '${mock}' "$@"\n`);chmodSync(gh,0o755);
    process.env.PATH=`${bin}${path.delimiter}${previousPath ?? ''}`;
    authenticated=authenticateProducer({policy:f.policy,runId:'123',artifactId:'789'});
    assert.equal(f.verify(false,authenticated.proof).releaseReady,true,'synthetic authenticated boundary positive; no real GitHub or model was executed');
    assert.equal(f.verify(false,{manifestHash:bytesHash(readFileSync(path.join(f.root,'manifest.json'))),producer:f.manifest.producer}).releaseReady,false);
    f.write('G1/tests.json',{schema:'repository-node-lifecycle-v1',streamEnded:true,summaryCount:1,suites:[],complete:true,counts:{tests:0,passed:0,failed:0,cancelled:0,skipped:0,todo:0},ids:[]});f.seal();
    assert.equal(f.verify(false,authenticated.proof).releaseReady,false);
  } finally {if(previousPath === undefined) delete process.env.PATH;else process.env.PATH=previousPath;authenticated?.cleanup();f.close();}
});


test('PR34: replay assertions match native Node deep equality, including undefined keys and Sets', () => {
  const base=mkdtempSync(path.join(tmpdir(),'assert-parity-'));
  try {
    for (const [label,expression,expected] of [
      ['undefined-key', 'assert.deepStrictEqual({fee:500,extra:undefined},{fee:500})', false],
      ['different-set', 'assert.deepStrictEqual(new Set([1]),new Set([2]))', false],
      ['same-set', 'assert.deepStrictEqual(new Set([1,2]),new Set([2,1]))', true],
      ['same-object', 'assert.deepStrictEqual({fee:500,extra:undefined},{extra:undefined,fee:500})', true],
      ['loose-deep', "assert.deepEqual({fee:'500'},{fee:500})", true],
      ['strict-deep', "assert.deepStrictEqual({fee:'500'},{fee:500})", false],
    ] as const) {
      const source=`import test from 'node:test'; import assert from 'node:assert'; test('${label}',()=>{${expression};});`;
      const native=path.join(base,`${label}.test.mjs`);writeFileSync(native,source);
      const nativeEnv={...process.env};delete nativeEnv.NODE_TEST_CONTEXT;
      const result=spawnSync(process.execPath,['--test',native],{encoding:'utf8',env:nativeEnv});
      assert.equal(result.status===0,expected,label+' native');
      const replay=oracle.replaySuite({'test/parity.test.mjs':source},path.join(base,label));
      assert.equal(replay.complete,true,label+' complete');
      assert.equal(replay.exitCode===0,expected,label+' replay');
      assert.equal(replay.exitCode===0,result.status===0,label+' parity');
    }
  } finally {rmSync(base,{recursive:true,force:true});}
});

test('PR34: duplicate Skill indexes or replayed soul reads cannot replace memory-reasoning', () => {
  const good=instructionFixture();assert.equal(observeInstructions(good).instructionsVerified,true);
  const duplicated=instructionFixture();duplicated.indexes=[duplicated.indexes[0]!,duplicated.indexes[0]!];
  assert.equal(observeInstructions(duplicated).instructionsVerified,false);
  const replay=instructionFixture();replay.indexes=[replay.indexes[0]!,replay.indexes[0]!];
  replay.messages[4].message.params.arguments.path=replay.messages[2].message.params.arguments.path;
  replay.messages[5].message.result=replay.messages[3].message.result;
  assert.equal(observeInstructions(replay).instructionsVerified,false);
  const reversed=instructionFixture();const a=reversed.messages.splice(2,2);reversed.messages.splice(4,0,...a);
  reversed.messages.forEach((x:any,i:number)=>x.sequence=i+1);
  assert.equal(observeInstructions(reversed).instructionsVerified,false,'soul must precede memory-reasoning');
  const f=bundleFixture();try {
    const file='attempts/LIVE-01/instructions.json';const data=JSON.parse(readFileSync(path.join(f.root,file),'utf8'));
    data.indexes=[data.indexes[0],data.indexes[0]];f.write(file,data);f.seal();
    assert.equal(f.verify().evidencePassed,false,'G4 must recheck index identity');
  }finally{f.close();}
});

test('PR34: G2 rejects all-true and correctly named no-op commands without corresponding outcomes', () => {
  for (const argv of [['true'],['npm','pack','--pack-destination','/missing','--json']]) {
    const f=bundleFixture();try {
      const data=JSON.parse(readFileSync(path.join(f.root,'G2/stages.json'),'utf8'));
      data.stages.forEach((s:any)=>s.commands.forEach((c:any)=>c.argv=argv));
      f.write('G2/stages.json',data);f.seal();assert.equal(f.verify().evidencePassed,false,JSON.stringify(argv));
    }finally{f.close();}
  }
});

test('PR34: G1 recomputes results from official leaf completion events, not successful summary', () => {
  for (const event of [
    {id:testManifest[0]!.id,type:'test:fail',skipped:false,todo:false,suite:false},
    {id:testManifest[0]!.id,type:'test:pass',skipped:false,todo:true,suite:false},
    {id:testManifest[0]!.id,type:'unknown',skipped:false,todo:false,suite:false},
  ]) {
    const f=bundleFixture();try {
      f.write('G1/tests.json',{schema:'repository-node-lifecycle-v1',streamEnded:true,summaryCount:1,suites:[],complete:true,counts:{tests:1,passed:1,failed:0,cancelled:0,skipped:0,todo:0},ids:[event]});
      f.seal();assert.equal(f.verify().evidencePassed,false,event.type+' todo='+event.todo);
    }finally{f.close();}
  }
});

test('PR34: genuine first-setup output permits npm progress before its final completion marker',()=>{
  const f=bundleFixture();try {
    const record=JSON.parse(readFileSync(path.join(f.root,'G2/stages.json'),'utf8'));
    record.stages.find((x:any)=>x.id==='optional-runtime').commands[0].stdout='\nadded 64 packages in 17s\nFIRST_SETUP_OK\n';
    f.write('G2/stages.json',record);f.seal();assert.equal(f.verify().evidencePassed,true);
  }finally{f.close();}
});

test('PR34: optional runtime cannot use true with an unchanged successful output and claimed artifacts',()=>{
  const f=bundleFixture();try {
    const record=JSON.parse(readFileSync(path.join(f.root,'G2/stages.json'),'utf8'));
    record.stages.find((x:any)=>x.id==='optional-runtime').commands[0].argv[0]='true';
    f.write('G2/stages.json',record);f.seal();assert.equal(f.verify().evidencePassed,false);
  }finally{f.close();}
});

test('PR34: optional undefined capture fields use JSON serialization without dropping secret checks',async()=>{
  const {captureSanitizer}=await load('log-safety');
  const {sanitizeJson}=await import('../../../src/security/sanitize.js');
  const sanitize=captureSanitizer(sanitizeJson,{});
  assert.deepEqual(sanitize({exitCode:0,failure:undefined}),{exitCode:0});
  assert.throws(()=>sanitize({output:'sk-'+'x'.repeat(32)}),/secret_output/);
});


test('PR34: lifecycle rejects duplicate, missing, unfinished and contradictory events; only named skip is allowed', async () => {
  const {validSuite}=await load('suite-evidence');
  const good={schema:'repository-node-lifecycle-v1',complete:true,streamEnded:true,summaryCount:1,suites:[],counts:{tests:1,passed:1,failed:0,cancelled:0,skipped:0,todo:0},
    ids:[{id:'one',type:'test:pass',skipped:false,todo:false,suite:false,failureType:null}]};
  const manifest=[{id:'one',optionalSkip:false}];assert.equal(validSuite(good,manifest),true);
  for(const mutation of [{ids:[...good.ids,...good.ids]},{ids:[]},{streamEnded:false},{summaryCount:0},{summaryCount:2},
    {counts:{...good.counts,tests:2}},{ids:[{...good.ids[0],id:'unknown'}]},{ids:[{...good.ids[0],type:'test:fail'}]},
    {ids:[{...good.ids[0],todo:true}]},{suites:[{type:'test:fail',todo:false,skipped:false}]}]) assert.equal(validSuite({...good,...mutation},manifest),false);
  const skipped={...good,counts:{...good.counts,passed:0,skipped:1},ids:[{...good.ids[0],skipped:true}]};
  assert.equal(validSuite(skipped,manifest),false);assert.equal(validSuite(skipped,[{id:'one',optionalSkip:true}]),true);
  assert.equal(validSuite({...skipped,ids:[{...skipped.ids[0],failureType:'cancelledByParent'}]},[{id:'one',optionalSkip:true}]),false);
});

test('PR34: collected answers wait for independent review, then finalize and seal a successful positive workflow', () => {
  const f=bundleFixture();try {
    const live=path.join(f.base,'live'),deterministic=path.join(f.base,'deterministic');mkdirSync(live);mkdirSync(deterministic);
    const reports:any[]=[], reviews:any[]=[];
    const read=(name:string)=>JSON.parse(readFileSync(path.join(f.root,name),'utf8'));
    for(const scenario of f.policy.scenarios) {
      const dir=path.join(live,scenario.id);mkdirSync(dir);
      const source=`attempts/${scenario.id}`, execution=read(`${source}/execution.json`);
      const attempt={...execution,initial:read(`${source}/initial.json`).files,final:read(`${source}/final.json`).files,
        answer:read(`${source}/answer.json`).answer,checkpoints:['inquiry','conversation'].includes(scenario.kind)?[]:read(`${source}/checkpoints.json`).checkpoints};
      for(const [file,data] of [['attempt.json',attempt],['identity.json',read(`${source}/identity.json`)],['instructions.json',read(`${source}/instructions.json`)],
        ['instruction-receipt.json',read(`${source}/loader.json`)],['hooks.json',read(`${source}/hooks.json`).observations]] as [string,any][]) writeFileSync(path.join(dir,file),JSON.stringify(data));
      writeFileSync(path.join(dir,'discovery.jsonl'),read(`${source}/protocol.json`).messages.map((x:any)=>JSON.stringify(x)).join('\n')+'\n');
      reports.push({...f.manifest.candidate,client:'codex-cli',scenario:scenario.id,classification:'WAITING_REVIEW',executionMode:'live'});
      if(['inquiry','conversation'].includes(scenario.kind)) reviews.push({id:`codex-cli/${scenario.id}`,review:read(`${source}/review.json`).review});
    }
    const policy=path.join(f.base,'policy.json'),reviewFile=path.join(f.base,'reviews.json');writeFileSync(policy,JSON.stringify(f.policy));
    writeFileSync(path.join(live,'summary.json'),JSON.stringify({candidate:f.manifest.candidate,policyHash:f.approvedPolicyHash,reports}));
    const invoke=()=>spawnSync(process.execPath,['scripts/finalize-normal-workflow-acceptance.mjs','--live',live,'--policy',policy,'--policy-hash',f.approvedPolicyHash,'--reviews',reviewFile],{encoding:'utf8'});
    writeFileSync(reviewFile,JSON.stringify([]));const waiting=invoke();assert.equal(waiting.status,2,waiting.stderr);
    assert.equal(JSON.parse(readFileSync(path.join(live,'summary.json'),'utf8')).reports[0].classification,'WAITING_REVIEW');
    writeFileSync(reviewFile,JSON.stringify(reviews));const finalized=invoke();assert.equal(finalized.status,0,finalized.stderr);
    const summary=JSON.parse(readFileSync(path.join(live,'summary.json'),'utf8'));assert.equal(summary.liveGate.passed,true);assert.ok(summary.reports.every((x:any)=>x.classification==='PASS'));
    for(const file of ['G0/command.json','G1/command.json','G1/tests.json','G2/command.json','G2/stages.json']) {
      mkdirSync(path.dirname(path.join(deterministic,file)),{recursive:true});writeFileSync(path.join(deterministic,file),JSON.stringify(read(file)));
    }
    writeFileSync(path.join(deterministic,'candidate.json'),JSON.stringify(f.manifest.candidate));writeFileSync(path.join(deterministic,'candidate.tgz'),readFileSync(f.artifact));
    writeFileSync(path.join(live,'candidate.tgz'),readFileSync(f.artifact));
    const sealed=path.join(f.base,'sealed');
    const result=spawnSync(process.execPath,['scripts/seal-normal-workflow-evidence.mjs','--deterministic',deterministic,'--live',live,'--policy',policy,
      '--policy-hash',f.approvedPolicyHash,'--run-id','fixture-run','--job-id','fixture-job','--output',sealed],{encoding:'utf8'});
    assert.equal(result.status,0,result.stderr);
    const verified=verifyEvidenceBundle({artifact:f.artifact,evidenceRoot:sealed,policy:f.policy,approvedPolicyHash:f.approvedPolicyHash,fixture:true,replayRoot:path.join(f.base,'final-replay')});
    assert.equal(verified.evidencePassed,true,JSON.stringify(verified));assert.equal(verified.releaseReady,false,'synthetic workflow positive is not real CI/CLI');
    for(const changed of [{review:{...reviews[0].review,reviewer:'execution-ai'}},{review:{...reviews[0].review,answerHash:'altered'}},
      {review:{...reviews[0].review,verdict:'UNCERTAIN'}},{review:{...reviews[0].review,schema:'old'}}]) {
      writeFileSync(reviewFile,JSON.stringify([{...reviews[0],...changed},...reviews.slice(1)]));assert.equal(invoke().status,1);
    }
  }finally{f.close();}
});

test('PR34: a successfully collected inquiry without a review is explicitly incomplete', () => {
  const root=mkdtempSync(path.join(tmpdir(),'pending-review-'));try {
    oracle.createFixture(path.join(root,'repo'),'inquiry');const initial=oracle.snapshot(path.join(root,'repo'));
    const result=oracle.evaluateAttempt({kind:'inquiry',initial,final:initial,answer:'The spec is free at 5000; implementation incorrectly charges 500.',
      exitCode:0,logComplete:true,turnCompleted:true,controlsUnchanged:true,instructionsVerified:true,safe:true,developmentChecks:false},path.join(root,'replay'));
    assert.equal(result.classification,'WAITING_REVIEW');assert.equal(result.oraclePassed,false);
  }finally{rmSync(root,{recursive:true,force:true});}
});


test('PR34: Proxy traps and caught unsupported assertion operations never become a successful comparison', () => {
  const base=mkdtempSync(path.join(tmpdir(),'proxy-assertion-'));
  try {
    const expressions=[
      "const value=new Proxy({fee:500},{get(t,key){return key==='fee'?501:Reflect.get(t,key)}});assert.deepStrictEqual(value,{fee:500});",
      "try{new Proxy({fee:500},{})}catch{};assert.equal(1,1);",
      "try{assert.throws(()=>{})}catch{};assert.equal(1,1);",
      "const value={};Object.defineProperty(value,'valueOf',{value:()=>501});assert.equal(value,'[object Object]');",
    ];
    for(const [i,expression] of expressions.entries()) {
      const source=`import test from 'node:test';import assert from 'node:assert';test('unsupported operation',()=>{${expression}});`;
      const native=path.join(base,`${i}.test.mjs`);writeFileSync(native,source);
      const env={...process.env};delete env.NODE_TEST_CONTEXT;
      assert.equal(spawnSync(process.execPath,['--test',native],{env}).status,i===0 || i===3?1:0);
      const replay=oracle.replaySuite({'test/proxy.test.mjs':source},path.join(base,`replay-${i}`));
      assert.notEqual(replay.exitCode,0);assert.equal(replay.unsupported,true);assert.equal(replay.assertionFailure,false);
    }
  }finally{rmSync(base,{recursive:true,force:true});}
});

test('PR34: assertion bridge keeps cycles, Maps, Dates and unsupported types honest', () => {
  const base=mkdtempSync(path.join(tmpdir(),'assert-types-'));try {
    for(const [label,body] of [
      ['map', 'assert.deepStrictEqual(new Map([[1,500]]),new Map([[1,500]]));'],
      ['cycle', 'const a={fee:500};a.self=a;const b={fee:500};b.self=b;assert.deepStrictEqual(a,b);'],
      ['date', 'assert.deepStrictEqual(new Date(1234),new Date(1234));'],
    ]) {
      const source=`import test from 'node:test';import assert from 'node:assert/strict';test('${label}',()=>{${body}});`;
      const replay=oracle.replaySuite({'test/types.test.mjs':source},path.join(base,label!));assert.equal(replay.exitCode,0);
    }
    for(const body of ['assert.deepStrictEqual(new (class Custom{})(), {});','assert.deepStrictEqual({get fee(){return 500;}},{fee:500});',
      'assert.deepStrictEqual(Symbol.for("a"),Symbol.for("a"));','assert.deepStrictEqual(new Uint8Array([1]),new Uint8Array([1]));']) {
      const source=`import test from 'node:test';import assert from 'node:assert/strict';test('unsupported',()=>{${body}});`;
      const replay=oracle.replaySuite({'test/types.test.mjs':source},path.join(base,`unsupported-${Math.random()}`));
      assert.notEqual(replay.exitCode,0);assert.equal(replay.unsupported,true);assert.equal(replay.assertionFailure,false);
    }
  }finally{rmSync(base,{recursive:true,force:true});}
});

test('PR34: protected review authority requires actual approved human identity in the review environment', async () => {
  const {approvedReviewers}=await load('review-authority');
  const item={state:'approved',user:{login:'independent-human',type:'User'},environments:[{name:'normal-workflow-answer-review'}]};
  assert.deepEqual(approvedReviewers([item],['independent-human']),['independent-human']);
  for(const change of [{state:'pending'},{user:{login:'execution-ai',type:'Bot'}},{environments:[{name:'collection'}]}])
    assert.deepEqual(approvedReviewers([{...item,...change}],['independent-human']),[]);
});
