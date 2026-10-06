import {readFileSync} from 'node:fs';
import path from 'node:path';
import {checkpointErrors} from './checkpoints.mjs';
export function executorReceiptErrors(checkpoints,messages,nativeReadonlyObserved) {
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
  return errors;
}
export function collectExecutorReceipts({directory,nativeReadonlyObserved}) {
  try {
    const records=name=>readFileSync(path.join(directory,name),'utf8').trim().split('\n').filter(Boolean).map(JSON.parse);
    const checkpoints=records('executor-checkpoints.jsonl'),executorProtocol=records('executor-protocol.jsonl');
    const errors=executorReceiptErrors(checkpoints,executorProtocol,nativeReadonlyObserved);
    return {checkpointAuthority:errors.length?'unavailable':'executor-barrier-v1',checkpoints,executorProtocol,executorErrors:errors};
  }catch{return {checkpointAuthority:'unavailable',checkpoints:[],executorProtocol:[],executorErrors:['Executor evidence is missing or incomplete']};}
}
