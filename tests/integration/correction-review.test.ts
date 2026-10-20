import assert from 'node:assert/strict'
import test from 'node:test'
import {mkdtemp,rm} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {pathToFileURL} from 'node:url'
import {Client} from '@modelcontextprotocol/sdk/client/index.js'
import {InMemoryTransport} from '@modelcontextprotocol/sdk/inMemory.js'
import {initializeDatabase} from '../../src/commands/init.js'
import {openConnection} from '../../src/db/connection.js'
import {recordEntry,updateCandidateEntry} from '../../src/memory/entries.js'
import {buildStructuredScope} from '../../src/memory/structured-memory.js'
import {ChatgptRuntimeOwner} from '../../src/mcp/chatgpt-runtime.js'
import {CorrectionRecallBook} from '../../src/mcp/correction-review.js'
import {chatgptPolicyOutputSchema} from '../../src/mcp/chatgpt-contract.js'
const subject=await import(process.env.KIOKUKO_CORRECTION_SERVER?pathToFileURL(process.env.KIOKUKO_CORRECTION_SERVER).href:'../../src/mcp/chatgpt-server.js')

test('real remote MCP binds returned corrections without claiming model delivery or application',async t=>{
  const root=await mkdtemp(join(tmpdir(),'correction-mcp-')),databasePath=join(root,'test.sqlite3')
  await initializeDatabase({databasePath});const db=openConnection(databasePath)
  const correction=recordEntry(db,{workspace:'global',kind:'lesson',title:'Rust compiler compatibility',body:'Do not reject Rust compiler compatibility only because versions differ. Verify actual compiler capabilities.',
    summary:'Verify compiler capabilities instead of arbitrary version-only rejection.',tags:['subject:rust'],scope:buildStructuredScope({visibility:'global',retrievalScope:'global',portableReason:'Compiler capability checks apply across projects.'}),
    provenance:{type:'interaction_capture',reference:'user_correction'},createdBy:'fixture'})
  const owner=new ChatgptRuntimeOwner(databasePath),server=subject.createChatgptMemoryServer(owner),client=new Client({name:'correction-fixture',version:'1'})
  const [c,s]=InMemoryTransport.createLinkedPair();await server.connect(s);await client.connect(c)
  t.after(async()=>{await client.close();await server.close();await owner.close();db.close();await rm(root,{recursive:true,force:true})})
  await client.listTools()
  const p=chatgptPolicyOutputSchema.parse((await client.callTool({name:'memory_policy',arguments:{}})).structuredContent)
  const policy={version:p.policyVersion,digest:p.policyDigest,read:true},decision={kind:'compatibility',target:'scripts/check.mjs',basis:'version_only',requiredVersion:'1.85.0',observedVersion:'1.99.1'}
  const call=async(name:string,args:Record<string,unknown>)=>{const result=await client.callTool({name,arguments:{policy,...args}});assert.notEqual(result.isError,true,JSON.stringify(result));return result.structuredContent as any}
  const absent=await call('memory_correction_check',{decision})
  assert.equal(absent.retrieval,'not_requested');assert.equal(absent.verification,'unverified')
  const recalled=await call('memory_recall',{query:'Rust compiler compatibility',subjects:['rust']})
  assert.equal(recalled.corrections.retrieval,'retrieved');assert.equal(recalled.corrections.modelInput,'unobserved')
  assert.equal(recalled.corrections.sources[0].entryId,correction.id);assert.equal(recalled.corrections.sources[0].revision,correction.revision)
  const recallId=recalled.corrections.recallId
  const unbound=await call('memory_correction_check',{decision})
  assert.equal(unbound.retrieval,'retrieved','omitting a receipt cannot erase server-observed retrieval')
  assert.equal(unbound.binding,'missing');assert.equal(unbound.reason,'recall_receipt_not_bound');assert.deepEqual(unbound.sources,[])
  const conflict=await call('memory_correction_check',{recallId,decision})
  assert.equal(conflict.binding,'bound')
  assert.equal(conflict.state,'contradiction');assert.equal(conflict.modelInput,'unobserved');assert.equal(conflict.verification,'unverified');assert.equal(conflict.authorizationGranted,false)
  assert.equal(conflict.target,decision.target);assert.match(conflict.decisionDigest,/^[a-f0-9]{64}$/)
  for(const basis of ['capability','reproducibility'])assert.equal((await call('memory_correction_check',{recallId,decision:{...decision,basis}})).state,'unverified')
  const completion=await call('memory_correction_check',{recallId,decision:{kind:'completion',target:'scripts/check.mjs',complete:false,basis:'version_only'}})
  assert.equal(completion.reason,'host_verification_unobserved')
  const noMatch=await call('memory_recall',{query:'no-matching-correction-zzzz',subjects:['physics']})
  assert.equal(noMatch.corrections.retrieval,'no_correction')
  assert.equal((await call('memory_correction_check',{recallId:noMatch.corrections.recallId,decision})).retrieval,'no_correction')
  for(const extra of [{applied:true},{modelInput:'delivered'},{sources:recalled.corrections.sources}]){
    const rejected=await client.callTool({name:'memory_correction_check',arguments:{policy,recallId,decision,...extra}})
    assert.equal(rejected.isError,true,'model-supplied delivery/application evidence must be rejected')
  }
  assert.equal(db.prepare('SELECT count(*) AS n FROM entries').get()?.n,1,'MCP diagnostics never save memories')
  updateCandidateEntry(db,{...correction,entryId:correction.id,expectedRevision:correction.revision,body:'New current correction',createdBy:'fixture'})
  assert.equal((await call('memory_correction_check',{recallId,decision})).state,'stale')
})

test('read receipts expire, remain connection-local and have a bounded count',async()=>{
  const root=await mkdtemp(join(tmpdir(),'correction-receipts-')),databasePath=join(root,'test.sqlite3')
  await initializeDatabase({databasePath});const db=openConnection(databasePath)
  try{
    let now=0;const book=new CorrectionRecallBook(()=>now),decision={kind:'completion',target:'check.mjs',basis:'unverified'}
    const first=book.remember(db,{query:'none'},[])
    assert.equal(book.check(db,first.recallId,decision).retrieval,'no_correction')
    assert.throws(()=>new CorrectionRecallBook().check(db,first.recallId,decision),{code:'CONFLICT'})
    now=30*60*1000+1
    assert.throws(()=>book.check(db,first.recallId,decision),{code:'CONFLICT'})
    const bounded=book.remember(db,{query:'old'},[])
    for(let i=0;i<64;i++)book.remember(db,{query:String(i)},[])
    assert.throws(()=>book.check(db,bounded.recallId,decision),{code:'CONFLICT'})
    assert.equal(book.check(undefined,undefined,decision).retrieval,'no_correction')
    assert.equal(book.check(undefined,undefined,decision).binding,'missing')
  }finally{db.close();await rm(root,{recursive:true,force:true})}
})

test('a failed actual recall remains unavailable when the caller omits its receipt',async t=>{
  const root=await mkdtemp(join(tmpdir(),'correction-mcp-unavailable-')),owner=new ChatgptRuntimeOwner(join(root,'missing.sqlite3'))
  const server=subject.createChatgptMemoryServer(owner),client=new Client({name:'failure-fixture',version:'1'}),[c,s]=InMemoryTransport.createLinkedPair()
  await server.connect(s);await client.connect(c);await client.listTools()
  t.after(async()=>{await client.close();await server.close();await owner.close();await rm(root,{recursive:true,force:true})})
  const p=chatgptPolicyOutputSchema.parse((await client.callTool({name:'memory_policy',arguments:{}})).structuredContent),policy={version:p.policyVersion,digest:p.policyDigest,read:true}
  const failed=await client.callTool({name:'memory_recall',arguments:{policy,query:'Rust compiler compatibility'}})
  assert.equal(failed.isError,true);assert.equal(JSON.parse((failed.content as Array<{text:string}>)[0]!.text).code,'SERVICE_UNAVAILABLE')
  const checked=await client.callTool({name:'memory_correction_check',arguments:{policy,decision:{kind:'completion',target:'check.mjs',complete:false,basis:'unverified'}}})
  assert.notEqual(checked.isError,true);assert.equal((checked.structuredContent as any).retrieval,'unavailable');assert.equal((checked.structuredContent as any).binding,'missing');assert.equal((checked.structuredContent as any).verification,'unverified')
})
