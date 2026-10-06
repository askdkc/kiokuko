import { readFileSync, writeFileSync } from 'node:fs';
import { parseArgs } from 'node:util';
import { freezePolicy } from './lib/normal-workflow/release-policy.mjs';
const { values } = parseArgs({options:Object.fromEntries(['approval','test-manifest','producer','reviewers','output'].map(name => [name,{type:'string'}]))});
const read = name => JSON.parse(readFileSync(values[name],'utf8'));
const frozen = freezePolicy(read('approval'),{testManifest:read('test-manifest'),producer:read('producer'),reviewers:read('reviewers')});
writeFileSync(values.output,JSON.stringify(frozen.policy,null,2),{flag:'wx',mode:0o444});
console.log(JSON.stringify({policyHash:frozen.hash,output:values.output}));
