// Existing tunnel compatibility contract: 0.0.14, official openai/tools formula 127e47c.
// New upstream versions are separate compatibility evidence, not a moving fixture.
import {createHash} from 'node:crypto';
import {mkdir,writeFile,chmod} from 'node:fs/promises';
import {execFileSync} from 'node:child_process';
import path from 'node:path';
const version='0.0.14';
const hashes={'linux-x64':'15bd17e805cad39d412199115bb9e10a978dd35258a114cdf25dd2ae6681c7d3','linux-arm64':'2de3fb879a18edb847e0313592c912f1983685488290a7fdba7ac403e6a4fb0a','darwin-x64':'75e10be774184fb42189e347b16eb6bc9fb0780135d8af714d34e30ce068dc53','darwin-arm64':'b540493c5bdbcdbb755700c8e2e16597e28b1569e425007e0f73111047bd6a64'};
const key=process.platform+'-'+process.arch,expected=hashes[key];if(!expected)throw new Error('Unsupported tunnel fixture platform');
const output=path.resolve(process.argv[2]??'');if(!process.argv[2])throw new Error('Supply an isolated fixture output directory');
await mkdir(output,{recursive:true});const archive=path.join(output,'fixture.zip');
const url=`https://persistent.oaistatic.com/tunnel-client/v${version}/tunnel-client-v${version}-${process.platform}-${process.arch==='x64'?'amd64':'arm64'}.zip`;
const response=await fetch(url,{signal:AbortSignal.timeout(60000)});if(!response.ok)throw new Error('Tunnel fixture download failed');const bytes=Buffer.from(await response.arrayBuffer());
if(bytes.length>100*1024*1024||createHash('sha256').update(bytes).digest('hex')!==expected)throw new Error('Tunnel fixture checksum mismatch');
await writeFile(archive,bytes);execFileSync('unzip',['-q','-o',archive,'-d',output]);const executable=path.join(output,'tunnel-client');await chmod(executable,0o755);
const observed=execFileSync(executable,['--version'],{encoding:'utf8'}).trim();if(!observed.includes(version))throw new Error('Unexpected tunnel fixture version');console.log(JSON.stringify({executable,version:observed,sha256:expected}));
