// GitHub supplies the artifact digest; a manifest's own hash is no authority.
// Proof objects are minted here only after authenticated metadata AND archive
// verification. A JSON file cannot serialize or recreate the WeakMap brand.
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
const receipts = new WeakMap();
export const producerReceipt = proof => proof && receipts.get(proof);
export function authenticateProducer({ policy, runId, artifactId }) {
  const approved = policy.producer;
  if (!/^[\w.-]+\/[\w.-]+$/u.test(approved.repository) || !/^\d+$/u.test(String(runId)) || !/^\d+$/u.test(String(artifactId))) throw new Error('Invalid trusted producer identity');
  const api = endpoint => JSON.parse(execFileSync('gh',['api',`repos/${approved.repository}/${endpoint}`],{encoding:'utf8',timeout:30000,maxBuffer:4*1024*1024}));
  const run = api(`actions/runs/${runId}`), artifact = api(`actions/artifacts/${artifactId}`);
  if (run.status !== 'completed' || run.conclusion !== 'success' || run.head_sha !== approved.commit || run.head_branch !== approved.ref
    || run.path !== approved.workflow || run.event !== 'workflow_dispatch' || artifact.expired || artifact.workflow_run?.id !== Number(runId)
    || artifact.name !== 'normal-workflow-evidence' || !/^sha256:[a-f0-9]{64}$/u.test(artifact.digest ?? '')) throw new Error('Artifact was not produced by the independently approved workflow/ref/run');
  const directory = mkdtempSync(path.join(tmpdir(),'kiokuko-authenticated-evidence-'));
  try {
    const bytes = execFileSync('gh',['api',`repos/${approved.repository}/actions/artifacts/${artifactId}/zip`],{timeout:30000,maxBuffer:256*1024*1024});
    if (`sha256:${createHash('sha256').update(bytes).digest('hex')}` !== artifact.digest) throw new Error('GitHub artifact archive digest mismatch');
    const archive = path.join(directory,'archive.zip'), root = path.join(directory,'evidence');
    writeFileSync(archive,bytes); mkdirSync(root);
    // Extract entries ourselves: no path traversal, links, devices or zip bombs.
    execFileSync('python3',['-c',`import zipfile, pathlib, stat, sys
base=pathlib.Path(sys.argv[2]); total=0; seen=set()
with zipfile.ZipFile(sys.argv[1]) as z:
 for info in z.infolist():
  name=info.filename; p=pathlib.PurePosixPath(name); total+=info.file_size
  if name in seen or '\\\\' in name or p.is_absolute() or '..' in p.parts or total>268435456 or len(seen)>4096: raise ValueError('archive boundary')
  seen.add(name); mode=info.external_attr>>16
  if stat.S_ISLNK(mode) or (stat.S_IFMT(mode) not in (0,stat.S_IFREG,stat.S_IFDIR)): raise ValueError('archive link/device')
  target=base.joinpath(*p.parts)
  if info.is_dir(): target.mkdir(parents=True,exist_ok=True)
  else:
   target.parent.mkdir(parents=True,exist_ok=True); target.write_bytes(z.read(info))
`,archive,root],{timeout:30000});
    const manifestBytes = readFileSync(path.join(root,'manifest.json'));
    const manifest = JSON.parse(manifestBytes);
    if (manifest.runId !== String(runId) || manifest.producer?.runId !== String(runId)
      || JSON.stringify(manifest.producer?.approved) !== JSON.stringify(approved) || !manifest.producer.jobId) throw new Error('Producer manifest/run binding mismatch');
    const jobs = api(`actions/runs/${runId}/jobs?per_page=100`);
    if (!jobs.jobs?.some(job => String(job.id) === String(manifest.producer.jobId) && job.name === 'Normal workflow live gate (G3)' && job.conclusion === 'success')) throw new Error('Producer job is not a successful job of the approved run');
    const proof = Object.freeze({});
    receipts.set(proof,Object.freeze({ manifestHash:createHash('sha256').update(manifestBytes).digest('hex'),producer:manifest.producer }));
    return { proof, root, cleanup:() => rmSync(directory,{recursive:true,force:true}) };
  } catch (error) { rmSync(directory,{recursive:true,force:true}); throw error; }
}
