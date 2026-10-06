// Trusted Node test entry point. Untrusted fixture modules never run in Node's
// host realm and never receive process, a host function, an IPC stream or env.
import test from 'node:test';
import { AssertionError } from 'node:assert';
import { readFileSync, realpathSync, existsSync } from 'node:fs';
import path from 'node:path';
import { createContext, SourceTextModule } from 'node:vm';
const file = realpathSync(process.argv[2]);
const root = realpathSync(process.argv[3]);
const context = createContext(Object.create(null), { codeGeneration: { strings: false, wasm: false } });
const registry = new SourceTextModule(`
  for (const value of [Object,Array,Function,Promise,WeakSet,Error,Number,String,RegExp]) { Object.freeze(value.prototype); Object.freeze(value); }
  const stringify = JSON.stringify, push = Function.call.bind(Array.prototype.push);
  const records = [], failures = new WeakSet(), has = Function.call.bind(WeakSet.prototype.has);
  const add = Function.call.bind(WeakSet.prototype.add);
  function fail(message) { const error = new Error(message); add(failures, error); throw error; }
  const equal = (a,b) => { if (!Object.is(a,b)) fail('assert.equal failed'); };
  const deepEqual = (a,b) => { if (stringify(a) !== stringify(b)) fail('assert.deepEqual failed'); };
  const ok = value => { if (!value) fail('assert.ok failed'); };
  export const assert = Object.freeze(Object.assign(ok, {equal, strictEqual:equal, deepEqual, deepStrictEqual:deepEqual, ok,
    notEqual:(a,b) => { if (Object.is(a,b)) fail('assert.notEqual failed'); }, fail }));
  export function register(name, options, fn) {
    if (typeof options === 'function') { fn=options; options={}; }
    if (typeof name !== 'string' || (fn !== undefined && typeof fn !== 'function')) throw new Error('unsupported fixture test');
    push(records, {name, fn, skip:options?.skip === true, todo:options?.todo === true});
  }
  register.skip = (name,fn) => register(name,{skip:true},fn);
  register.todo = (name,fn) => register(name,{todo:true},fn);
  Object.freeze(register);
  export const describe = () => stringify(records.map(({name,skip,todo}) => ({name,skip,todo})));
  export function invoke(index) {
    try { const result = records[index].fn?.();
      if (result !== undefined && result !== null && typeof result === 'object' && typeof result.then === 'function')
        return stringify({ok:false, unsupported:true});
      return stringify({ok:true});
    } catch (error) { return stringify({ok:false, assertion:has(failures,error)}); }
  }
`, { context });
await registry.link(() => { throw new Error('No helper imports'); }); await registry.evaluate({ timeout: 1000 });
const testModule = new SourceTextModule(`import {register} from 'private'; export {register as default, register as test};`, { context });
const assertModule = new SourceTextModule(`import {assert} from 'private'; export default assert; export const {equal,strictEqual,deepEqual,deepStrictEqual,ok,notEqual,fail}=assert;`, { context });
for (const helper of [testModule, assertModule]) { await helper.link(() => registry); await helper.evaluate(); }
const shipping = new SourceTextModule(existsSync(path.join(root, 'shipping.mjs')) ? readFileSync(path.join(root, 'shipping.mjs'), 'utf8') : '', { context });
await shipping.link(() => { throw new Error('Shipping must be standalone'); });
const entry = new SourceTextModule(readFileSync(file, 'utf8'), { context });
await entry.link(specifier => {
  if (specifier === 'node:test') return testModule;
  if (['node:assert/strict', 'node:assert'].includes(specifier)) return assertModule;
  if (specifier === '../shipping.mjs') return shipping;
  throw new Error('Unsupported fixture import; no OS or IPC access is available');
});
await entry.evaluate({ timeout: 1000 });
const descriptions = JSON.parse(registry.namespace.describe());
if (!descriptions.length) throw new Error('No fixture tests registered');
for (const [index, descriptor] of descriptions.entries()) {
  test(descriptor.name, { skip: descriptor.skip, todo: descriptor.todo }, () => {
    const result = JSON.parse(registry.namespace.invoke(index));
    if (result.unsupported) throw new Error('Unsupported asynchronous fixture test');
    if (!result.ok) {
      if (result.assertion) throw new AssertionError({ message: 'Fixture assertion failed' });
      throw new Error('Fixture threw an unexpected error');
    }
  });
}
