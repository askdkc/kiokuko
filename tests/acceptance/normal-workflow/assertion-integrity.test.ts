import assert from 'node:assert/strict';
import test from 'node:test';
import {mkdtempSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
const {replaySuite}=await import(pathToFileURL(path.resolve('scripts/lib/normal-workflow/oracle.mjs')).href);
function replay(body:string) {
  const root=mkdtempSync(path.join(tmpdir(),'assertion-integrity-'));
  try {return replaySuite({'test/probe.test.mjs':`import assert from 'node:assert/strict'; import test from 'node:test'; ${body}`},path.join(root,'repo'));}
  finally {rmSync(root,{recursive:true,force:true});}
}
test('fixture cannot replace global String to erase unequal primitive assertion values',()=> {
  const result=replay(`globalThis.String=()=> '0'; test('unequal',()=>assert.equal(1,2));`);
  assert.notEqual(result.exitCode,0);
});
test('fixture cannot replace global Map to collapse assertion object identity',()=> {
  const result=replay(`globalThis.Map=class {has(){return true}get(){return 0}}; test('unequal',()=>assert.deepEqual({x:1},{x:2}));`);
  assert.notEqual(result.exitCode,0);
});
test('fixture cannot erase Set entries by replacing its iterator next',()=> {
  const result=replay(`Object.getPrototypeOf(new Set().values()).next=()=>({done:true}); test('unequal',()=>assert.deepEqual(new Set([1]),new Set([2])));`);
  assert.notEqual(result.exitCode,0);
});
test('fixture test without callback retains native todo semantics',()=> {
  const result=replay(`test('not implemented');`);
  assert.equal(result.todo,1);assert.equal(result.passed,0);
});
test('fixture string skip reason retains native skipped semantics',()=> {
  const result=replay(`test('not run',{skip:'platform unavailable'},()=>assert.equal(1,1));`);
  assert.equal(result.skipped,1);assert.equal(result.passed,0);
});
test('supported positive assertions and ordinary test registration still pass',()=> {
  const result=replay(`test('valid',()=>{assert.deepEqual(new Set([1,2]),new Set([2,1]));assert.equal(1,1);assert.deepEqual({a:undefined},{a:undefined});});`);
  assert.equal(result.exitCode,0);assert.equal(result.passed,1);assert.equal(result.complete,true);
});
