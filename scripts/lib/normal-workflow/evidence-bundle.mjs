import { sandboxProbeValid } from './native-sandbox.mjs';
import { executorReceiptErrors } from './executor-receipt.mjs';
import { validPackageStages } from './package-evidence.mjs';
import { validSuite } from './suite-evidence.mjs';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { lstatSync, readFileSync, realpathSync } from 'node:fs';
import path from 'node:path';
import { validatePolicy, requiredAttempts, executionPolicyErrors, policyHash } from './release-policy.mjs';
import { evaluateAttempt, treeHash, hash } from './oracle.mjs';
import { observeInstructions } from './instruction-observation.mjs';
import { producerReceipt } from './producer-auth.mjs';
export const bytesHash = bytes => createHash('sha256').update(bytes).digest('hex');
/** Read regular files below the evidence root without following any link. */
export function evidenceFile(root, relative) {
  if (typeof relative !== 'string' || path.isAbsolute(relative) || relative.includes('\\')
    || relative.split('/').some(part => !part || ['.','..'].includes(part))) throw new Error('Invalid evidence path');
  root = realpathSync(root); let current = root;
  for (const part of relative.split('/')) {
    current = path.join(current,part); if (lstatSync(current).isSymbolicLink()) throw new Error('Evidence symlink rejected');
  }
  const stat = lstatSync(current);
  if (!stat.isFile() || stat.size > 32 * 1024 * 1024) throw new Error('Evidence file boundary');
  return readFileSync(current);
}
function successfulCommand(record, expected, candidate, policyDigest) {
  return record?.schema === 'command-execution-v1' && JSON.stringify(record.argv) === JSON.stringify(expected)
    && record.exitCode === 0 && record.signal === null && typeof record.cwd === 'string' && record.cwd.length > 0
    && record.policyHash === policyDigest && ['before','after'].every(key => record[key]?.commit === candidate.commit
      && record[key]?.dirty === false && record[key]?.sourceDigest === candidate.sourceDigest)
    && Number.isFinite(Date.parse(record.started)) && Date.parse(record.ended) >= Date.parse(record.started)
    && record.environment && Object.keys(record.environment).every(key => ['PATH','NODE_VERSION','PLATFORM','ARCH','npm_config_cache'].includes(key));
}
/** Summary booleans/classifications are never consumed here. Every required
 * record is reopened, hash-bound, and interpreted against independent policy. */
export function verifyEvidenceBundle({ artifact, evidenceRoot, policy, approvedPolicyHash, proof, replayRoot, fixture = false }) {
  const reasons = []; let manifest;
  try {
    validatePolicy(policy, approvedPolicyHash);
    const manifestBytes = evidenceFile(evidenceRoot,'manifest.json'); manifest = JSON.parse(manifestBytes);
    const receipt = producerReceipt(proof);
    if (!fixture && (!receipt || receipt.manifestHash !== bytesHash(manifestBytes)
      || JSON.stringify(receipt.producer) !== JSON.stringify(manifest.producer))) throw new Error('Authenticated approved producer receipt required');
    if (manifest.schema !== 'normal-workflow-evidence-v1' || !manifest.runId || manifest.policyHash !== approvedPolicyHash
      || JSON.stringify(manifest.producer?.approved) !== JSON.stringify(policy.producer)) throw new Error('Producer/run/policy binding mismatch');
    const candidate = manifest.candidate;
    if (!/^[a-f0-9]{40}$/u.test(candidate?.commit ?? '') || !/^[a-f0-9]{64}$/u.test(candidate?.sourceDigest ?? '') || candidate.dirty !== false
      || lstatSync(artifact).isSymbolicLink() || !lstatSync(artifact).isFile() || candidate.artifactHash !== bytesHash(readFileSync(artifact))) throw new Error('Actual artifact or clean source candidate mismatch');
    const bundled = name => execFileSync('tar',['-xOf',path.resolve(artifact),`package/${name}`],{encoding:'utf8',timeout:10000,maxBuffer:1024*1024});
    const packageMetadata = JSON.parse(bundled('package.json'));
    const packageVersion = packageMetadata.version;
    const scripts = packageMetadata.scripts;
    if (scripts?.typecheck !== 'tsc -p tsconfig.json --noEmit' || scripts?.test !== 'node scripts/run-tests.mjs tests'
      || scripts?.['test:global-install'] !== 'node tests/ci/global-install-smoke.mjs') throw new Error('Known command names were replaced by no-op package scripts');
    const coreBundles = Object.fromEntries(['kiokuko-soul','memory-reasoning'].map(name => [name,bundled(`skills/${name}/SKILL.md`)]));
    const leaves = new Map();
    for (const leaf of manifest.files ?? []) {
      if (leaves.has(leaf.path)) throw new Error('Duplicate evidence leaf');
      const bytes = evidenceFile(evidenceRoot,leaf.path);
      if (bytes.length !== leaf.size || bytesHash(bytes) !== leaf.hash) throw new Error('Missing or altered raw evidence leaf');
      leaves.set(leaf.path,bytes);
    }
    if (!manifest.files?.length) throw new Error('Raw evidence manifest is empty');
    const read = name => {
      if (!leaves.has(name)) throw new Error(`Unlisted raw record: ${name}`);
      const data = JSON.parse(leaves.get(name));
      if (data.runId !== manifest.runId || data.policyHash !== approvedPolicyHash) throw new Error('Raw record belongs to another run/policy');
      return data;
    };
    if (!successfulCommand(read('G0/command.json'),['npm','run','typecheck'],candidate,approvedPolicyHash)) throw new Error('G0 command/source proof failed');
    if (!successfulCommand(read('G1/command.json'),['npm','test'],candidate,approvedPolicyHash)
      || !validSuite(read('G1/tests.json'),policy.testManifest)) throw new Error('G1 lifecycle/test inventory proof failed');
    const archiveTypes=execFileSync('tar',['-tvzf',path.resolve(artifact)],{encoding:'utf8',timeout:10000,maxBuffer:1024*1024}).trim().split('\n');
    if(archiveTypes.length>4096 || archiveTypes.some(line=>!['-','d'].includes(line[0]))) throw new Error('Package links or special files rejected');
    const artifactNames=execFileSync('tar',['-tzf',path.resolve(artifact)],{encoding:'utf8',timeout:10000,maxBuffer:1024*1024}).trim().split('\n').filter(x=>!x.endsWith('/'));
    if(new Set(artifactNames).size!==artifactNames.length || artifactNames.some(x=>!x.startsWith('package/') || x.split('/').some(p=>p==='..'))) throw new Error('Invalid package inventory');
    const artifactFiles=Object.fromEntries(artifactNames.map(name=>{const bytes=execFileSync('tar',['-xOf',path.resolve(artifact),name],{timeout:10000,maxBuffer:4*1024*1024});return [name.slice(8),{hash:bytesHash(bytes),size:bytes.length,text:name.startsWith('package/skills/')?bytes.toString('utf8'):undefined}];}));
    const packageResult = read('G2/stages.json');
    if (!validPackageStages(packageResult,candidate,artifactFiles,packageMetadata) || packageResult.tarballSha1!==createHash('sha1').update(readFileSync(artifact)).digest('hex')
      || !successfulCommand(read('G2/command.json'),['npm','run','test:global-install'],candidate,approvedPolicyHash)) throw new Error('G2 package stage proof failed');
    const attempts = manifest.attempts ?? []; const required = requiredAttempts(policy);
    if (attempts.length !== required.length || new Set(attempts.map(x => x.id)).size !== attempts.length
      || attempts.some(x => !required.includes(x.id))) throw new Error('Missing, duplicate or unexpected attempts');
    let totalSeconds = 0;
    for (const item of attempts) {
      const execution = read(`${item.path}/execution.json`);
      if (execution.artifactHash !== candidate.artifactHash || !['candidateBefore','candidateAfter'].every(key =>
        execution[key]?.commit === candidate.commit && execution[key]?.dirty === false && execution[key]?.sourceDigest === candidate.sourceDigest))
        throw new Error('Live attempt artifact/source provenance differs from candidate');
      const identity = read(`${item.path}/identity.json`);
      if (identity.schema !== 'codex-isolated-identity-v1' || identity.model !== execution.model
        || identity.clientVersion !== execution.clientVersion || identity.effort !== execution.reasoningEffort
        || identity.authMode !== 'chatgpt' || identity.modelObserved !== true) throw new Error('Actual client/model/provider identity proof absent');
      const scenario = policy.scenarios.find(x => `${execution.client}/${x.id}` === item.id);
      if (!scenario || executionPolicyErrors(policy,execution,scenario,execution.client).length) throw new Error('Actual execution violates frozen policy');
      if (execution.exitCode !== 0 || execution.signal !== null || execution.logComplete !== true || execution.turnCompleted !== true)
        throw new Error('Incomplete client execution');
      const events = execution.events;
      if (!Array.isArray(events) || !events.length || events.some((event,i) => !Number.isSafeInteger(event.sequence) || (i > 0 && event.sequence <= events[i-1].sequence))
        || !events.some(event => event.type === 'turn.completed')) throw new Error('Raw client event completion missing');
      const actualCalls = new Set(events.filter(event => ['item.started','item.completed'].includes(event.type) && event.item?.type !== 'agent_message' && event.item?.id).map(event => event.item.id)).size;
      if (actualCalls !== execution.calls || events.filter(event => event.type === 'turn.started').length !== execution.turns) throw new Error('Raw resource counts differ');
      totalSeconds += execution.seconds;
      const instructions = read(`${item.path}/instructions.json`);
      for (const index of instructions.indexes ?? []) {
        if (index.name === 'kiokuko-codex-soul') Object.assign(index,{canonicalName:'kiokuko-soul',bundleText:coreBundles['kiokuko-soul'],packageVersion});
        if (index.name === 'kiokuko-codex-memory-reasoning') Object.assign(index,{canonicalName:'memory-reasoning',bundleText:coreBundles['memory-reasoning'],packageVersion});
      }
      const protocol = read(`${item.path}/protocol.json`);
      const loader = read(`${item.path}/loader.json`);
      if (loader.observed !== true || loader.contentHash !== hash(instructions.agents)) throw new Error('AGENTS loader receipt absent');
      const observed = observeInstructions({ messages:protocol.messages, events:[{type:'instructions.loaded',content_hash:loader.contentHash}],
        indexes:instructions.indexes, agentsHash:hash(instructions.agents), observations:read(`${item.path}/hooks.json`).observations, kind:scenario.kind });
      const {runId:controlRunId,policyHash:controlPolicyHash,...installedControls} = instructions;
      const initial = read(`${item.path}/initial.json`).files, final = read(`${item.path}/final.json`).files;
      const review = ['inquiry','conversation'].includes(scenario.kind) ? read(`${item.path}/review.json`).review : undefined;
      if(review && !fixture && !receipt.reviewers.includes(review.reviewer)) throw new Error('Answer reviewer is not an authenticated environment approver');
      const checkpoints = ['inquiry','conversation'].includes(scenario.kind) ? [] : read(`${item.path}/checkpoints.json`).checkpoints;
      if(!['inquiry','conversation'].includes(scenario.kind) && (!sandboxProbeValid(identity.nativeSandboxProbe,policy.clientVersion) || executorReceiptErrors(checkpoints,read(`${item.path}/executor.json`).messages,identity.nativeReadonlyObserved).length)) throw new Error('Native sandbox or exclusive executor receipt proof failed');
      const evaluated = evaluateAttempt({ ...execution, initial, final, checkpoints, answer:read(`${item.path}/answer.json`).answer,
        answerReview:review, reviewers:policy.reviewers, kind:scenario.kind, fault:scenario.fault, memory:scenario.memory,
        safe:!execution.failure, controlsUnchanged:execution.controlsBefore === hash(JSON.stringify(installedControls)) && execution.controlsAfter === execution.controlsBefore,
        instructionsVerified:observed.instructionsVerified }, path.join(replayRoot,item.id.replaceAll('/','-')));
      if (evaluated.classification !== 'PASS') reasons.push(`${item.id}: ${evaluated.classification}: ${evaluated.assertions?.filter(x => !x.passed).map(x => x.id).join(', ') ?? evaluated.reason}`);
    }
    if (totalSeconds > policy.maxTotalSeconds) throw new Error('Total approved runtime exceeded');
  } catch (error) { reasons.push(error.message); }
  return { evidencePassed:reasons.length === 0, releaseReady:!fixture && reasons.length === 0, reasons,
    authority:fixture ? 'synthetic-verifier-fixture' : 'authenticated-producer', policyHash:policyHash(policy) };
}
