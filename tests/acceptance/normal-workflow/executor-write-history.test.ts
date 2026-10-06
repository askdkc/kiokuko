import assert from 'node:assert/strict';
import test from 'node:test';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {StdioClientTransport} from '@modelcontextprotocol/sdk/client/stdio.js';
const load=(name:string)=>import(pathToFileURL(path.resolve(`scripts/lib/normal-workflow/${name}.mjs`)).href);
const oracle=await load('oracle');
const receipts=await load('executor-receipt');
const fixed='export function shippingFee(total) { return total >= 5000 ? 0 : 500; }\n';
const regression="import test from 'node:test';import assert from 'node:assert/strict';import {shippingFee} from '../shipping.mjs';test('new boundary',()=>assert.equal(shippingFee(5000),0));\n";
async function exercise(editBeforeRed:boolean) {
  const base=mkdtempSync(path.join(tmpdir(),'executor-write-history-'));
  const repo=path.join(base,'repo'),output=path.join(base,'evidence');oracle.createFixture(repo,'bug');
  const initial=oracle.snapshot(repo);
  const client=new Client({name:'executor-write-history',version:'1'});
  try {
    await client.connect(new StdioClientTransport({command:process.execPath,args:[path.resolve('scripts/lib/normal-workflow/fixture-executor-server.mjs'),repo,output],stderr:'pipe'}));
    const missing=await client.callTool({name:'run_command',arguments:{command:'node --test test/missing.test.mjs'}});
    assert.equal(missing.isError,true);
    const write=async(name:string,content:string)=>assert.notEqual((await client.callTool({name:'write_file',arguments:{path:name,content}})).isError,true);
    if(editBeforeRed) {await write('shipping.mjs',fixed);await write('shipping.mjs',initial['shipping.mjs']);}
    await write('test/boundary.test.mjs',regression);
    const red=await client.callTool({name:'run_command',arguments:{command:'npm test'}});assert.equal((red.structuredContent as any).exitCode,1);
    await write('shipping.mjs',fixed);
    const green=await client.callTool({name:'run_command',arguments:{command:'npm test'}});assert.equal((green.structuredContent as any).exitCode,0);
    const final=oracle.snapshot(repo);
    const receipt=receipts.collectExecutorReceipts({directory:output,nativeReadonlyObserved:true,initial,final});
    const outcome=oracle.evaluateAttempt({kind:'bug',initial,final,...receipt,exitCode:0,logComplete:true,turnCompleted:true,instructionsVerified:true,controlsUnchanged:true,safe:true},path.join(base,'replay'));
    return {receipt,outcome,initial,final};
  }finally{await client.close();rmSync(base,{recursive:true,force:true});}
}
test('exclusive executor accepts actual Red, then implementation, then Green with every write bound',async()=>{
  const {receipt,outcome}=await exercise(false);
  assert.equal(receipt.checkpointAuthority,'executor-barrier-v1',JSON.stringify(receipt.executorErrors));
  assert.equal(outcome.classification,'PASS',JSON.stringify(outcome));
});
test('exclusive executor rejects implementation edit and revert before the otherwise valid Red',async()=>{
  const {receipt,outcome}=await exercise(true);
  assert.equal(receipt.checkpointAuthority,'unavailable','checkpoint-only evidence concealed a prior implementation edit');
  assert.match(receipt.executorErrors.join('; '),/implementation.*Red|Red.*implementation/iu);
  assert.equal(outcome.classification,'FAIL_HARNESS');
});
test('executor write receipts cannot be omitted, reordered, substituted, or detached from the final tree',async()=>{
  const {receipt,initial,final}=await exercise(false);
  const validate=(messages:any[],bounds={initial,final})=>receipts.executorReceiptErrors(receipt.checkpoints,messages,true,bounds);
  assert.deepEqual(validate(receipt.executorProtocol),[]);
  assert.ok(receipts.executorReceiptErrors(receipt.checkpoints,receipt.executorProtocol,true).length,'unbounded write history must fail closed');
  const writeRequests=receipt.executorProtocol.filter((x:any)=>x.direction==='request' && x.message.params?.name==='write_file');
  const omitted=receipt.executorProtocol.filter((x:any)=>!writeRequests.some((r:any)=>r.message.id===x.message.id));
  assert.ok(validate(omitted).length,'missing writer history must fail');
  const substituted=structuredClone(receipt.executorProtocol);
  substituted.find((x:any)=>x.direction==='request' && x.message.params?.name==='write_file').message.params.arguments.content='unrelated bytes';
  assert.ok(validate(substituted).length,'request bytes must match the saved tree');
  const reordered=structuredClone(receipt.executorProtocol);
  reordered.find((x:any)=>x.direction==='response' && x.message.result?.structuredContent?.path==='shipping.mjs').message.result.structuredContent.sequence=1;
  assert.ok(validate(reordered).length,'operation sequence must be unique');
  assert.ok(validate(receipt.executorProtocol,{initial,final:{...final,'shipping.mjs':initial['shipping.mjs']}}).length,'last mutation must match the saved final tree');
});

test('executor cannot erase an implementation edit and revert by dropping their paired RPC records',async()=>{
  const {receipt,initial,final}=await exercise(true);
  const edits=receipt.executorProtocol.filter((x:any)=>x.direction==='request' && x.message.params?.name==='write_file'
    && x.message.params.arguments.path==='shipping.mjs').slice(0,2);
  const omitted=receipt.executorProtocol.filter((x:any)=>!edits.some((r:any)=>r.message.id===x.message.id));
  assert.ok(receipts.executorReceiptErrors(receipt.checkpoints,omitted,true,{initial,final}).length,
    'source edit and revert leave the same tree, but their operation sequence gap must remain detectable');
});

test('explanation fixture exposes only reads and rejects write/revert or development commands',async()=>{
  const base=mkdtempSync(path.join(tmpdir(),'executor-readonly-'));
  const repo=path.join(base,'repo'),output=path.join(base,'evidence');oracle.createFixture(repo,'inquiry');
  const initial=oracle.snapshot(repo);
  const client=new Client({name:'executor-readonly',version:'1'});
  try {
    await client.connect(new StdioClientTransport({command:process.execPath,args:[path.resolve('scripts/lib/normal-workflow/fixture-executor-server.mjs'),repo,output,'--read-only'],stderr:'pipe'}));
    assert.deepEqual((await client.listTools()).tools.map(x=>x.name).sort(),['list_files','read_file']);
    assert.match(client.getInstructions() ?? '',/read-only/iu);
    assert.equal((await client.callTool({name:'read_file',arguments:{path:'shipping.mjs'}})).isError,undefined);
    for(const request of [{name:'write_file',arguments:{path:'shipping.mjs',content:fixed}},
      {name:'write_file',arguments:{path:'shipping.mjs',content:initial['shipping.mjs']}},
      {name:'run_command',arguments:{command:'npm test'}}]) {
      await client.callTool(request).then(result=>assert.equal(result.isError,true),()=>{});
    }
    assert.deepEqual(oracle.snapshot(repo),initial);
    const {isolatedMcpPolicy}=await load('codex-adapter');
    const config=isolatedMcpPolicy({readOnly:true});
    assert.deepEqual(config['mcp_servers.fixture_executor.enabled_tools'],['list_files','read_file']);
    assert.equal(config['mcp_servers.fixture_executor.tools.write_file.approval_mode'],undefined);
    assert.equal(config['mcp_servers.fixture_executor.tools.run_command.approval_mode'],undefined);
    const {FixtureExecutor}=await load('fixture-executor');
    const executor=new FixtureExecutor({repo,output:path.join(base,'direct'),readOnly:true});
    assert.equal(await executor.readFile('shipping.mjs'),initial['shipping.mjs']);
    await assert.rejects(executor.writeFile('shipping.mjs',fixed),/read-only/iu);
    await assert.rejects(executor.runCommand('npm test','no-development'),/read-only/iu);
  }finally{await client.close();rmSync(base,{recursive:true,force:true});}
});
