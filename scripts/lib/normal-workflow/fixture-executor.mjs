import { writeFileSync, mkdirSync, readFileSync, openSync, writeSync, fsyncSync, closeSync } from 'node:fs';
import path from 'node:path';
import { snapshot, replaySuite, treeHash } from './oracle.mjs';
import { fixtureTestCommand } from './codex-adapter.mjs';
// All writers to the fixture must use this owner. The CLI's native tools must
// run under an independently observed read-only sandbox; without that boundary
// this executor is not authority over other writers.
export class FixtureExecutor {
  #tail=Promise.resolve(); #sequence=0; #commandAttempt=0; #ids=new Set(); #initial; #readOnly;
  constructor({repo,output,readOnly=false}) {this.repo=repo;this.output=output;this.#readOnly=readOnly;this.#initial=snapshot(repo);mkdirSync(output,{recursive:true});}
  #exclusive(operation) {
    const pending=this.#tail.then(operation);this.#tail=pending.catch(()=>{});return pending;
  }
  readFile(name) {return this.#exclusive(()=> {
    const files=snapshot(this.repo);if(!(name in files)) throw new Error('File is outside fixture');return files[name];
  });}
  listFiles() {return this.#exclusive(()=>Object.keys(snapshot(this.repo)).sort());}
  writeFile(name,content) {return this.#exclusive(()=> {
    if(this.#readOnly) throw new Error('Fixture controller is read-only');
    if(typeof content!=='string' || Buffer.byteLength(content)>256000 || typeof name!=='string'
      || !(name==='shipping.mjs' || (/^test\/[A-Za-z0-9_.-]+\.test\.mjs$/u.test(name) && !(name in this.#initial)))) throw new Error('Write is outside source/additive-test boundary');
    // snapshot rejects symlinks/special files before any mutation.
    snapshot(this.repo);mkdirSync(path.dirname(path.join(this.repo,name)),{recursive:true});writeFileSync(path.join(this.repo,name),content);
    return {path:name,treeHash:treeHash(snapshot(this.repo)),sequence:++this.#sequence};
  });}
  runCommand(command,commandId) {return this.#exclusive(()=> {
    if(this.#readOnly) throw new Error('Fixture controller is read-only');
    if(!fixtureTestCommand(command)) throw new Error('Unsupported command: only standalone npm test or node --test fixture commands');
    if(typeof commandId!=='string' || !commandId || this.#ids.has(commandId)) throw new Error('Duplicate or missing executor command identity');
    this.#ids.add(commandId);const files=snapshot(this.repo);
    let selected=Object.keys(files).filter(name=>/^test\/[^/]+\.test\.mjs$/u.test(name)).sort();
    const direct=command.trim().replace(/^\/bin\/(?:sh|bash|zsh) -lc (['"])([^'"\n]+)\1$/u,'$2');
    if(direct.startsWith('node --test ') && !direct.includes('*')) selected=direct.slice('node --test '.length).split(/\s+/u);
    if(!selected.length || selected.some(name=>!(name in files))) throw new Error('Missing fixture test selection');
    const result=replaySuite(files,path.join(this.output,`execution-${++this.#commandAttempt}`),selected);
    if(!result.complete || result.unsupported || result.signal!==null || !Number.isInteger(result.exitCode)) throw new Error('Incomplete or unsupported trusted test execution');
    const sequence=++this.#sequence;
    const checkpoint={files,sequence,commandId,command,exitCode:result.exitCode,signal:null,testExecution:true,
      treeHash:treeHash(files),barrier:'exclusive-persist-before-ack',acknowledged:true,execution:result.execution,lifecycle:result.lifecycle};
    const fd=openSync(path.join(this.output,'executor-checkpoints.jsonl'),'a',0o600);
    try {writeSync(fd,JSON.stringify(checkpoint)+'\n');fsyncSync(fd);}finally{closeSync(fd);}
    const directory=openSync(this.output,'r');try{fsyncSync(directory);}finally{closeSync(directory);}
    // Queue ownership is released only after persistence. A delayed JSON event
    // or an already queued edit cannot change the saved Red/Green tree.
    return {commandId,sequence,treeHash:checkpoint.treeHash,exitCode:result.exitCode,counts:result.lifecycle.counts,
      complete:true,checkpointPersisted:true,output:result.lifecycle.results.flatMap(x=>x.events)};
  });}
}
