import {readFileSync} from 'node:fs';
import path from 'node:path';
import {checkpointErrors} from './checkpoints.mjs';
import {treeHash} from './oracle.mjs';
export function executorReceiptErrors(checkpoints,messages,nativeReadonlyObserved,bounds) {
  const errors=checkpointErrors(checkpoints,'executor-barrier-v1');
  if(nativeReadonlyObserved!==true) errors.push('Native read-only sandbox is not observed');
  const requests=new Map(),seen=new Set(),pairs=[],sessions=new Set();let sequence=0;
  for(const record of messages ?? []) {
    if(!record.sessionId || !Number.isSafeInteger(record.sequence) || record.sequence<=sequence) {errors.push('Executor protocol ordering');continue;}
    sequence=record.sequence;sessions.add(record.sessionId);const m=record.message;if(m?.id===undefined) continue;
    const key=`${record.sessionId}/${typeof m.id}/${m.id}`;
    if(record.direction==='request') {if(seen.has(key)) errors.push('Duplicate executor request');seen.add(key);requests.set(key,record);}
    else if(record.direction==='response') {const request=requests.get(key);requests.delete(key);if(!request || m.error) errors.push('Unmatched executor response');else pairs.push({key,request,response:record});}
    else errors.push('Unknown executor protocol direction');
  }
  if(sessions.size!==1 || requests.size) errors.push('Incomplete executor session');
  const tests=pairs.filter(x=>x.request.message.method==='tools/call' && x.request.message.params?.name==='run_command' && x.response.message.result?.isError!==true);
  if(tests.length!==checkpoints?.length) errors.push('Executor command/receipt inventory differs');
  for(const point of checkpoints ?? []) {
    const pair=tests.find(x=>x.key===point.commandId),result=pair?.response.message.result?.structuredContent;
    if(!pair || pair.request.message.params.arguments?.command!==point.command
      || result?.commandId!==point.commandId || result?.sequence!==point.sequence || result?.treeHash!==point.treeHash
      || result?.exitCode!==point.exitCode || result?.complete!==true || result?.checkpointPersisted!==true
      || JSON.stringify(result.counts)!==JSON.stringify(point.lifecycle?.counts) || point.lifecycle?.complete!==true
      || point.lifecycle.counts.tests<=0 || point.execution?.exitCode!==point.exitCode || point.execution?.signal!==null
      || !point.execution?.argv?.[1]?.endsWith('/test-results.mjs')) errors.push('Executor result is not bound to persisted tree/actual lifecycle');
  }
  const {initial,final}=bounds ?? {};
  if(!initial || !final || typeof initial!=='object' || typeof final!=='object') {
    errors.push('Executor initial/final tree bounds are missing');
    return errors;
  }
  // The queue owns writes as well as tests. Replay each acknowledged mutation
  // from the original tree so a source edit followed by a revert cannot hide
  // between checkpoints, and missing/substituted writer RPCs cannot certify it.
  let files={...initial},operationSequence=0,firstSourceEdit;
  const mutations=pairs.filter(pair=>pair.request.message.method==='tools/call'
    && ['write_file','run_command'].includes(pair.request.message.params?.name)
    && pair.response.message.result?.isError!==true);
  for(const pair of mutations) {
    const request=pair.request.message.params,result=pair.response.message.result?.structuredContent;
    if(!Number.isSafeInteger(result?.sequence) || result.sequence!==operationSequence+1) errors.push('Executor mutation sequence is missing, duplicated or reversed');
    operationSequence=result?.sequence;
    if(request.name==='write_file') {
      const {path:name,content}=request.arguments ?? {};
      if(typeof name!=='string' || typeof content!=='string'
        || !(name==='shipping.mjs' || (/^test\/[A-Za-z0-9_.-]+\.test\.mjs$/u.test(name) && !Object.hasOwn(initial,name)))
        || result?.path!==name) {errors.push('Executor write is outside the approved mutation boundary');continue;}
      if(name==='shipping.mjs' && content!==initial[name]) firstSourceEdit ??= result?.sequence;
      files[name]=content;
      if(result?.treeHash!==treeHash(files)) errors.push('Executor write receipt does not match its requested bytes');
    } else {
      const point=checkpoints.find(point=>point.commandId===pair.key);
      if(!point || treeHash(files)!==point.treeHash) errors.push('Executor checkpoint is detached from its write history');
    }
  }
  if(treeHash(files)!==treeHash(final)) errors.push('Executor write history differs from the final tree');
  if(firstSourceEdit!==undefined) {
    const added=Object.keys(final).filter(name=>/^test\/[^/]+\.test\.mjs$/u.test(name) && !Object.hasOwn(initial,name));
    const red=checkpoints.find(point=>point.files?.['shipping.mjs']===initial['shipping.mjs']
      && point.exitCode!==0 && point.testExecution===true && added.some(name=>point.files[name]===final[name]));
    if(!red || red.sequence>=firstSourceEdit) errors.push('Implementation was edited before the qualifying Red checkpoint');
  }
  return errors;
}
export function collectExecutorReceipts({directory,nativeReadonlyObserved,initial,final}) {
  try {
    const records=name=>readFileSync(path.join(directory,name),'utf8').trim().split('\n').filter(Boolean).map(JSON.parse);
    const checkpoints=records('executor-checkpoints.jsonl'),executorProtocol=records('executor-protocol.jsonl');
    const errors=executorReceiptErrors(checkpoints,executorProtocol,nativeReadonlyObserved,{initial,final});
    return {checkpointAuthority:errors.length?'unavailable':'executor-barrier-v1',checkpoints,executorProtocol,executorErrors:errors};
  }catch{return {checkpointAuthority:'unavailable',checkpoints:[],executorProtocol:[],executorErrors:['Executor evidence is missing or incomplete']};}
}
