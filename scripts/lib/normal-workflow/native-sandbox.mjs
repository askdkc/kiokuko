import {spawnSync} from 'node:child_process';
import {existsSync} from 'node:fs';
import path from 'node:path';
import {snapshot,treeHash} from './oracle.mjs';
export const probeScript=target=>`import {writeFileSync} from 'node:fs';try{writeFileSync(${JSON.stringify(target)},'native-write-probe');process.exitCode=0;}catch(error){if(!['EPERM','EACCES'].includes(error.code))throw error;console.log(JSON.stringify({denied:true,code:error.code}));process.exitCode=13;}`;
export function probeNativeSandbox({executable,repo,environment,clientVersion}) {
  const target=path.join(repo,'.native-sandbox-write-probe');if(existsSync(target)) throw new Error('Probe target must not exist');
  const before=treeHash(snapshot(repo));
  const args=['sandbox','-c','sandbox_mode="read-only"','--',process.execPath,'--input-type=module','--eval',probeScript(target)];
  const result=spawnSync(executable,args,{cwd:repo,env:environment,encoding:'utf8',timeout:10000,maxBuffer:64000});
  let outcome;try{outcome=JSON.parse(result.stdout.trim());}catch{}
  return {schema:'native-readonly-probe-v1',clientVersion,argv:[executable,...args],target,exitCode:result.status,signal:result.signal,
    outcome,writeExists:existsSync(target),treeBefore:before,treeAfter:treeHash(snapshot(repo))};
}
export function sandboxProbeValid(proof,clientVersion) {
  const args=proof?.argv;
  return proof?.schema==='native-readonly-probe-v1' && proof.clientVersion===clientVersion && proof.exitCode===13 && proof.signal===null
    && proof.outcome?.denied===true && ['EPERM','EACCES'].includes(proof.outcome.code) && proof.writeExists===false
    && /^[a-f0-9]{64}$/u.test(proof.treeBefore??'') && proof.treeAfter===proof.treeBefore
    && Array.isArray(args) && args.length===9 && args[1]==='sandbox' && args[2]==='-c' && args[3]==='sandbox_mode="read-only"'
    && args[4]==='--' && args[6]==='--input-type=module' && args[7]==='--eval' && args[8]===probeScript(proof.target);
}
