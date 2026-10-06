import assert from 'node:assert/strict';
import test from 'node:test';
import {mkdtempSync,readFileSync,rmSync,mkdirSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
const load=(name:string)=>import(pathToFileURL(path.resolve(`scripts/lib/normal-workflow/${name}.mjs`)).href);
const oracle=await load('oracle');
test('isolated CLI preapproves only the declared local MCP operations while native writes still require rejection',async()=>{
  const {isolatedMcpPolicy}=await load('codex-adapter');
  const config=isolatedMcpPolicy();
  assert.equal(config.approval_policy,'never');
  assert.equal(config['features.multi_agent'],false);
  assert.equal(config['features.multi_agent_v2'],false);
  assert.equal(config['agents.enabled'],false);
  assert.match(config.developer_instructions,/native.*read-only.*MCP.*write access/iu);
  assert.match(config.developer_instructions,/persist.*checkpoint.*response/iu);
  for(const server of ['kiokuko','fixture_executor']) {
    const names=config[`mcp_servers.${server}.enabled_tools`];
    assert.ok(Array.isArray(names) && names.length>0);
    assert.equal(new Set(names).size,names.length);
    assert.equal(config[`mcp_servers.${server}.default_tools_approval_mode`],'prompt');
    for(const name of names) assert.equal(config[`mcp_servers.${server}.tools.${name}.approval_mode`],'approve');
    assert.equal(config[`mcp_servers.${server}.tools.unknown.approval_mode`],undefined);
  }
  assert.ok(config['mcp_servers.kiokuko.enabled_tools'].includes('task_prepare'));
  assert.ok(config['mcp_servers.fixture_executor.enabled_tools'].includes('run_command'));
  assert.equal(config['mcp_servers.kiokuko.enabled_tools'].includes('curator_globalize'),false);
  assert.equal(Object.keys(config).some(key=>key.startsWith('hooks.')),false);
  assert.equal(config.sandbox_mode,undefined);
});
test('exclusive fixture executor persists real Red and Green before immediate or concurrent edits, independent of event delivery',async()=>{
  const base=mkdtempSync(path.join(tmpdir(),'exclusive-executor-'));try {
    const repo=path.join(base,'repo'),output=path.join(base,'protected');oracle.createFixture(repo,'bug');mkdirSync(output);
    const {FixtureExecutor}=await load('fixture-executor');const executor=new FixtureExecutor({repo,output,kind:'bug'});
    await executor.writeFile('test/regression.test.mjs',"import test from 'node:test';import assert from 'node:assert/strict';import {shippingFee} from '../shipping.mjs';test('boundary',()=>assert.equal(shippingFee(5000),0));");
    const redPromise=executor.runCommand('npm test','red');
    const edit=executor.writeFile('shipping.mjs','export function shippingFee(total){return total >= 5000?0:500;}');
    const greenPromise=executor.runCommand('node --test','green');
    const [red,,green]=await Promise.all([redPromise,edit,greenPromise]);
    assert.equal(red.exitCode,1);assert.equal(green.exitCode,0);
    const checkpoints=readFileSync(path.join(output,'executor-checkpoints.jsonl'),'utf8').trim().split('\n').map(line=>JSON.parse(line));
    assert.equal(checkpoints.length,2);assert.match(checkpoints[0].files['shipping.mjs'],/total > 5000/);
    assert.match(checkpoints[1].files['shipping.mjs'],/total >= 5000/);
    assert.equal(checkpoints[0].treeHash,red.treeHash);assert.equal(checkpoints[1].treeHash,green.treeHash);
    assert.ok(checkpoints.every((x:any)=>x.barrier==='exclusive-persist-before-ack' && x.acknowledged));
    for(const point of checkpoints) assert.equal(oracle.replaySuite(point.files,path.join(base,'independent-'+point.commandId)).exitCode,point.exitCode);
    await assert.rejects(executor.runCommand('npm test','red'),/duplicate/i);
    await assert.rejects(executor.writeFile('../escape','no'));
    await assert.rejects(executor.writeFile('README.md','altered'));
  }finally{rmSync(base,{recursive:true,force:true});}
});

test('executor MCP returns real command-bound receipts before response; a complete trace without Red fails',async()=>{
  const {Client}=await import('@modelcontextprotocol/sdk/client/index.js');const {StdioClientTransport}=await import('@modelcontextprotocol/sdk/client/stdio.js');
  const base=mkdtempSync(path.join(tmpdir(),'executor-mcp-'));try {
    const repo=path.join(base,'repo'),output=path.join(base,'protected');oracle.createFixture(repo,'bug');
    const client=new Client({name:'executor-boundary',version:'1'});
    await client.connect(new StdioClientTransport({command:process.execPath,args:[path.resolve('scripts/lib/normal-workflow/fixture-executor-server.mjs'),repo,output],stderr:'pipe'}));
    try {
      assert.match(client.getInstructions() ?? '',/controller.*write access.*native.*read-only/iu);
      assert.match(client.getInstructions() ?? '',/persist.*checkpoint.*response/iu);
      const tools=(await client.listTools()).tools;
      assert.match(tools.find(x=>x.name==='write_file')!.description!,/controller.*write access.*native.*read-only/iu);
      assert.match(tools.find(x=>x.name==='run_command')!.description!,/persist.*checkpoint.*response/iu);
      const result=await client.callTool({name:'run_command',arguments:{command:'npm test'}});assert.notEqual(result.isError,true);
      assert.equal((result.structuredContent as any).exitCode,0);
      const {collectExecutorReceipts}=await load('executor-receipt');
      const initial=oracle.snapshot(repo);
      const receipt=collectExecutorReceipts({directory:output,nativeReadonlyObserved:true,initial,final:initial});assert.equal(receipt.checkpointAuthority,'executor-barrier-v1');
      assert.equal(collectExecutorReceipts({directory:output,nativeReadonlyObserved:false}).checkpointAuthority,'unavailable');
      const attempt=oracle.evaluateAttempt({initial,final:initial,kind:'bug',...receipt,exitCode:0,logComplete:true,turnCompleted:true,instructionsVerified:true,controlsUnchanged:true,safe:true},path.join(base,'no-red'));
      assert.equal(attempt.classification,'FAIL_PRODUCT');assert.ok(attempt.assertions.some((x:any)=>x.id==='observed Red precedes implementation edit' && !x.passed));
    }finally{await client.close();}
  }finally{rmSync(base,{recursive:true,force:true});}
});

test('native sandbox evidence cannot be replaced by configuration or a zero-exit no-op',async()=>{
  const {probeScript,sandboxProbeValid}=await load('native-sandbox');
  const target='/isolated/.probe';const proof={schema:'native-readonly-probe-v1',clientVersion:'0.153.4',argv:['codex','sandbox','-c','sandbox_mode="read-only"','--','node','--input-type=module','--eval',probeScript(target)],target,
    exitCode:13,signal:null,outcome:{denied:true,code:'EPERM'},writeExists:false,treeBefore:'e'.repeat(64),treeAfter:'e'.repeat(64)};
  assert.equal(sandboxProbeValid(proof,'0.153.4'),true);
  for(const changed of [{exitCode:0},{writeExists:true},{treeAfter:'changed'},{argv:['true']},{outcome:{denied:false}},{signal:'SIGKILL'}])
    assert.equal(sandboxProbeValid({...proof,...changed},'0.153.4'),false);
});
