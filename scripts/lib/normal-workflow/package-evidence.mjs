import { createHash } from 'node:crypto';
// Producer and verifier use the same reviewed program bytes. Substrings in
// comments or an unexecuted function cannot prove the optional setup ran.
export const FIRST_SETUP_SCRIPT = `
import assert from 'node:assert/strict';
import { Command } from 'commander';
import { registerEmbeddingsCommands } from './dist/commands/embeddings.js';
import { openConnection } from './dist/db/connection.js';
import { migrateDatabase } from './dist/db/migrate.js';
import { LOCAL_SMALL_PRESET } from './dist/embedding/presets/local-small.js';

const database = openConnection(':memory:');
migrateDatabase(database);
try {
  const cli = new Command().exitOverride();
  registerEmbeddingsCommands(cli, {
    withDatabase: async (operation) => operation(database),
    setupGlobalClients: async () => ({ clients: ['codex'], projectAgentFiles: [] }),
    modelInstaller: async () => ({
      installation: 'installed', directory: process.cwd(),
      relativePath: 'models/embeddings/local-small/smoke',
      totalBytes: LOCAL_SMALL_PRESET.files.reduce((sum, file) => sum + file.size, 0),
      manifestHash: 'a'.repeat(64),
    }),
    provider: {
      profile: { providerKind: 'local-transformers' },
      embed: async () => { throw new Error('empty database must not need vectors'); },
    },
    output: (_json, _operation, data) => assert.equal(data.semanticEnabled, true),
  });
  await cli.parseAsync(['node', 'kiokuko', 'setup', '--clients', 'codex', '--json']);
  await Promise.all([import('@huggingface/hub'), import('@huggingface/transformers')]);
  process.stdout.write('FIRST_SETUP_OK\\n');
} finally {
  database.close();
}
`;
const hash=bytes=>createHash('sha256').update(bytes).digest('hex');
const same=(a,b)=>JSON.stringify(a)===JSON.stringify(b);
const executed=c=>Array.isArray(c.argv) && c.exitCode===0 && c.signal===null && typeof c.stdout==='string' && typeof c.stderr==='string'
  && typeof c.cwd==='string' && Number.isFinite(Date.parse(c.started)) && Date.parse(c.ended)>=Date.parse(c.started);
const cliCommand=(c,cli,args)=>c.argv[0]===cli && args.every((x,i)=>c.argv[i+1]===x);
/** Compare stage execution with bytes actually packed/installed/deployed and
 * successful public MCP responses. Stage flags and executable names alone do
 * not satisfy this contract. Authenticity belongs to the approved producer. */
export function validPackageStages(report,candidate,artifactFiles,metadata) {
  try {
    const names=['pack','install','generated-skills','restart','optional-runtime'];
    if(report.schema!=='package-stage-evidence-v2' || !same(report.stages?.map(x=>x.id),names)) return false;
    for(const stage of report.stages) if(stage.complete!==true || stage.exitCode!==0 || stage.artifactHash!==candidate.artifactHash
      || stage.sourceDigest!==candidate.sourceDigest || !stage.commands?.length || !stage.commands.every(executed)) return false;
    const stage=name=>report.stages.find(x=>x.id===name);
    const pack=stage('pack'),install=stage('install'),generated=stage('generated-skills'),restart=stage('restart'),optional=stage('optional-runtime');
    const packed=pack.commands.find(c=>c.argv[0]==='npm' && c.argv[1]==='pack' && c.argv[2]==='--pack-destination' && c.argv[4]==='--json' && c.argv.length===5);
    if(!packed || !pack.commands.some(c=>same(c.argv,['npm','run','build']))) return false;
    const npmPack=JSON.parse(packed.stdout);
    if(npmPack.length!==1 || npmPack[0].name!==metadata.name || npmPack[0].version!==metadata.version
      || npmPack[0].shasum!==report.tarballSha1 || !same(npmPack[0].files.map(x=>x.path).sort(),Object.keys(artifactFiles).sort())
      || npmPack[0].files.some(x=>artifactFiles[x.path].size!==x.size)) return false;
    const o=install.outcome;
    if(!o || !same(o.files?.map(x=>x.path).sort(),Object.keys(artifactFiles).sort())
      || o.files.some(x=>x.hash!==artifactFiles[x.path].hash || x.size!==artifactFiles[x.path].size)
      || o.cliPath!==`${o.prefix}/bin/kiokuko`
      || !install.commands.some(c=>same(c.argv,['npm','install','--global','--prefix',o.prefix,`${packed.argv[3]}/${npmPack[0].filename}`]) && c.stdout.trim().length>0)) return false;
    const optionalNames=['@huggingface/hub','@huggingface/transformers','sqlite-vec'];
    if(!Array.isArray(o.dependencies) || optionalNames.some(x=>o.dependencies.includes(x))) return false;
    const skillFiles=Object.keys(artifactFiles).filter(x=>x.startsWith('skills/'));
    const skillNames=[...new Set(skillFiles.map(x=>x.split('/')[1]))];
    if(!skillFiles.length || !generated.outcome?.deployedFiles || generated.outcome.deployedFiles.length!==skillFiles.length*4) return false;
    const deployed=new Set();
    for(const item of generated.outcome.deployedFiles) {
      const key=`${item.client}/${item.logicalPath}`;
      if(deployed.has(key) || !['codex','opencode','claude','hermes'].includes(item.client) || !skillFiles.includes(item.logicalPath)) return false;
      deployed.add(key);
      let body=artifactFiles[item.logicalPath].text;
      if(item.client==='codex') {
        const pattern=new RegExp(`(?<![A-Za-z0-9_-])(?:${skillNames.sort((a,b)=>b.length-a.length).join('|')})(?![A-Za-z0-9_-])`,'g');
        body=body.replace(pattern,name=>`kiokuko-codex-${name.replace(/^kiokuko-/,'')}`);
      }
      body+='\n<!-- KIOKUKO CONTRACT kiokuko/model-managed@2 -->\n';
      const stamp={owner:'kiokuko-mcp',id:'kiokuko/model-managed',version:2,host:item.client,logicalName:item.logicalPath.split('/')[1],hash:hash(body)};
      const expected=body+`\n<!-- KIOKUKO DEPLOYMENT ${JSON.stringify(stamp)} -->\n`;
      if(item.content!==expected || item.hash!==hash(expected)) return false;
    }
    if(!generated.commands.some(c=>cliCommand(c,o.cliPath,['setup','--clients','codex,opencode,claude,hermes']) && JSON.parse(c.stdout).ok===true)) return false;
    const selectors=generated.outcome.selectors;
    if(!Array.isArray(selectors) || !selectors.length) return false;
    for(const host of ['codex','opencode','claude','hermes']) for(const name of skillNames) {
      const publicName=host==='codex'?`kiokuko-codex-${name.replace(/^kiokuko-/,'')}`:name;
      for(const selector of [publicName,`${publicName}/SKILL.md`,`skills/${publicName}/SKILL.md`]) {
        if(!selectors.some(x=>x.host===host && x.selector===selector && x.result?.isError!==true
          && x.result?.structuredContent?.text===artifactFiles[`skills/${name}/SKILL.md`]?.text
          && x.result.structuredContent.contentHash===artifactFiles[`skills/${name}/SKILL.md`]?.hash
          && x.result.structuredContent.loadedPackageVersion===metadata.version)) return false;
      }
    }
    if(!restart.commands.some(c=>same(c.argv,[o.cliPath,'--version']) && c.stdout.trim()===metadata.version)) return false;
    const persistence=restart.outcome?.verification;
    if(persistence?.before?.completionReady !== true || persistence.after?.completionReady !== true
      || typeof persistence.runId !== 'string' || !persistence.runId.trim()
      || persistence.runId!==persistence.beforeRunId || persistence.runId!==persistence.afterRunId) return false;
    if(!optional.outcome || optionalNames.some(x=>!optional.outcome.after?.includes(x) || optional.outcome.before?.includes(x))) return false;
    if(!optional.commands.some(c=>c.argv.length===2 && /(?:^|[\\/])node(?:\.exe)?$/u.test(c.argv[0]) && c.argv[1].endsWith('/first-setup-smoke.mjs') && c.stdout.trim().split(/\r?\n/u).at(-1)==='FIRST_SETUP_OK'
      && optional.outcome.script===FIRST_SETUP_SCRIPT && hash(FIRST_SETUP_SCRIPT)===optional.outcome.scriptHash)) return false;
    return true;
  }catch{return false;}
}
