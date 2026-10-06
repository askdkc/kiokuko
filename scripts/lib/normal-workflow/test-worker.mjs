// Trusted Node test entry point. Untrusted fixture modules never run in Node's
// host realm and never receive process, a host function, an IPC stream or env.
import test from 'node:test';
import { AssertionError } from 'node:assert';
import { readFileSync, realpathSync, existsSync } from 'node:fs';
import path from 'node:path';
import { compareSerialized, SERIALIZER } from './assertion-codec.mjs';
import { createContext, SourceTextModule, SyntheticModule } from 'node:vm';
const file = realpathSync(process.argv[2]);
const root = realpathSync(process.argv[3]);
const context = createContext(Object.create(null), { codeGeneration: { strings: false, wasm: false } });
const bridgeFunction = Object.freeze(Object.setPrototypeOf(compareSerialized, null));
const bridge = new SyntheticModule(['compare'], function() { this.setExport('compare', bridgeFunction); }, {context});
await bridge.link(() => { throw new Error('No bridge imports'); }); await bridge.evaluate();
const registry = new SourceTextModule(`
  import {compare} from 'bridge';
  // Keep private intrinsic bindings: freezing a constructor does not prevent
  // fixture code from replacing its writable global binding.
  const {Object,Array,Function,Promise,WeakSet,WeakMap,Map,Set,Date,Error,Number,String,RegExp,JSON,Reflect}=globalThis;
  // Collection iteration must not be redirected to omit unequal entries.
  for (const iterator of [new Set().values(),new Map().entries(),[][Symbol.iterator]()]) {
    let prototype=Object.getPrototypeOf(iterator);
    while(prototype && prototype !== Object.prototype) {Object.freeze(prototype);prototype=Object.getPrototypeOf(prototype);}
  }
  for (const value of [Object,Array,Function,Promise,WeakSet,WeakMap,Map,Set,Date,Error,Number,String,RegExp,JSON,Reflect]) { Object.freeze(value.prototype); Object.freeze(value); }
  const stringify = JSON.stringify, push = Function.call.bind(Array.prototype.push);
  const records = [], unsupported = new WeakSet(), failures = new WeakSet(), has = Function.call.bind(WeakSet.prototype.has);
  const add = Function.call.bind(WeakSet.prototype.add);
  const NativeProxy=Proxy;
  let unsupportedUsed=false, registrationUnsupported=false;
  function unsupportedOperation(message) {
    unsupportedUsed=true;
    const error=new Error(message);add(unsupported,error);throw error;
  }
  function unavailableProxy() { return unsupportedOperation('Unsupported Proxy operation'); }
  Object.defineProperty(unavailableProxy,'revocable',{value:unavailableProxy});
  Object.defineProperty(globalThis,'Proxy',{value:Object.freeze(unavailableProxy),writable:false,configurable:false});
  function fail(message) { const error = new Error(message); add(failures, error); throw error; }
  ${SERIALIZER}
  function buildAssert(strictMode) {
    const methods={};
    for(const method of ['equal','strictEqual','notEqual','notStrictEqual','deepEqual','deepStrictEqual','notDeepEqual','notDeepStrictEqual','ok','fail']) {
      methods[method]=(...args)=> {
        let outcome;
        try {outcome=compare(serialize(method,strictMode,args));} catch {outcome='unsupported';}
        if(outcome === 'assertion') fail('Fixture assertion failed');
        if(outcome !== 'pass') unsupportedOperation('Unsupported assertion operation');
      };
    }
    return new NativeProxy(Object.freeze(Object.assign(methods.ok,methods)),{
      get(target,key) {
        if(!Object.hasOwn(methods,key)) return unsupportedOperation('Unsupported assertion member');
        return methods[key];
      }
    });
  }
  export const assert=buildAssert(false), strictAssert=buildAssert(true);
  export function register(name, options, fn) {
    if (typeof options === 'function') { fn=options; options={}; }
    if (typeof name !== 'string' || (fn !== undefined && typeof fn !== 'function')) throw new Error('unsupported fixture test');
    push(records, {name, fn, skip:!!options?.skip, todo:!!options?.todo || fn === undefined});
  }
  register.skip = (name,fn) => register(name,{skip:true},fn);
  register.todo = (name,fn) => register(name,{todo:true},fn);
  Object.freeze(register);
  export const describe = () => {
    registrationUnsupported=unsupportedUsed;
    return stringify(records.map(({name,skip,todo}) => ({name,skip,todo})));
  };
  export function invoke(index) {
    unsupportedUsed=registrationUnsupported;
    if(unsupportedUsed) return stringify({ok:false,unsupported:true});
    try { const result = records[index].fn?.();
      if (result !== undefined && result !== null && typeof result === 'object' && typeof result.then === 'function')
        return stringify({ok:false, unsupported:true});
      return stringify({ok:!unsupportedUsed,unsupported:unsupportedUsed});
    } catch (error) { return stringify({ok:false, assertion:has(failures,error),unsupported:unsupportedUsed || has(unsupported,error)}); }
  }
`, { context });
await registry.link(specifier => { if(specifier === 'bridge') return bridge; throw new Error('No helper imports'); }); await registry.evaluate({ timeout: 1000 });
const testModule = new SourceTextModule(`import {register} from 'private'; export {register as default, register as test};`, { context });
const makeAssertModule = name => new SourceTextModule(`import {${name} as assert} from 'private'; export default assert; export const {equal,strictEqual,deepEqual,deepStrictEqual,ok,notEqual,notStrictEqual,notDeepEqual,notDeepStrictEqual,fail}=assert;`, { context });
const assertModule = makeAssertModule('assert'), strictModule = makeAssertModule('strictAssert');
for (const helper of [testModule, assertModule, strictModule]) { await helper.link(() => registry); await helper.evaluate(); }
const shipping = new SourceTextModule(existsSync(path.join(root, 'shipping.mjs')) ? readFileSync(path.join(root, 'shipping.mjs'), 'utf8') : '', { context });
await shipping.link(() => { throw new Error('Shipping must be standalone'); });
const entry = new SourceTextModule(readFileSync(file, 'utf8'), { context });
await entry.link(specifier => {
  if (specifier === 'node:test') return testModule;
  if (specifier === 'node:assert') return assertModule;
  if (specifier === 'node:assert/strict') return strictModule;
  if (specifier === '../shipping.mjs') return shipping;
  throw new Error('Unsupported fixture import; no OS or IPC access is available');
});
await entry.evaluate({ timeout: 1000 });
const descriptions = JSON.parse(registry.namespace.describe());
if (!descriptions.length) throw new Error('No fixture tests registered');
for (const [index, descriptor] of descriptions.entries()) {
  test(descriptor.name, { skip: descriptor.skip, todo: descriptor.todo }, () => {
    const result = JSON.parse(registry.namespace.invoke(index));
    if (result.unsupported) {const error=new Error('Unsupported fixture assertion or asynchronous test');error.code='ERR_FIXTURE_UNSUPPORTED';throw error;}
    if (!result.ok) {
      if (result.assertion) throw new AssertionError({ message: 'Fixture assertion failed' });
      throw new Error('Fixture threw an unexpected error');
    }
  });
}
