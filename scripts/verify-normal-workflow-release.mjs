import { readFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { verifyEvidenceBundle, evidenceFile, bytesHash } from './lib/normal-workflow/evidence-bundle.mjs';
import { authenticateProducer } from './lib/normal-workflow/producer-auth.mjs';
import { validatePolicy } from './lib/normal-workflow/release-policy.mjs';
const { values } = parseArgs({options:Object.fromEntries(['artifact','evidence-root','policy','policy-hash','trusted-run','trusted-artifact-id'].map(name => [name,{type:'string'}]))});
let authenticated, replay;
try {
  for (const key of ['artifact','evidence-root','policy','policy-hash','trusted-run','trusted-artifact-id']) if (!values[key]) throw new Error(`Required: --${key}`);
  const policy = validatePolicy(JSON.parse(readFileSync(values.policy,'utf8')),values['policy-hash']);
  authenticated = authenticateProducer({policy,runId:values['trusted-run'],artifactId:values['trusted-artifact-id']});
  // Local/raw evidence must match the independent download's manifest. Leaf
  // content is checked against that manifest below, not against local summaries.
  if (bytesHash(evidenceFile(values['evidence-root'],'manifest.json')) !== bytesHash(evidenceFile(authenticated.root,'manifest.json')))
    throw new Error('Local manifest differs from authenticated producer artifact');
  replay = mkdtempSync(path.join(tmpdir(),'kiokuko-release-replay-'));
  const result = verifyEvidenceBundle({artifact:values.artifact,evidenceRoot:values['evidence-root'],policy,
    approvedPolicyHash:values['policy-hash'],proof:authenticated.proof,replayRoot:replay});
  console.log(JSON.stringify(result,null,2)); process.exitCode = result.releaseReady ? 0 : 1;
} catch (error) { console.log(JSON.stringify({releaseReady:false,reasons:[error.message]},null,2)); process.exitCode=1; }
finally { authenticated?.cleanup(); if (replay) rmSync(replay,{recursive:true,force:true}); }
