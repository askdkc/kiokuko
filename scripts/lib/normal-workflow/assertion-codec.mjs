import assert from 'node:assert';
import strict from 'node:assert/strict';
// The VM sends only a bounded primitive string. No untrusted object, getter,
// prototype or exception crosses into the host assertion implementation.
export function compareSerialized(text) {
  try {
    if (typeof text !== 'string' || text.length > 256000) return 'unsupported';
    const { method, strictMode, graph, roots } = JSON.parse(text);
    if (!['equal','strictEqual','notEqual','notStrictEqual','deepEqual','deepStrictEqual','notDeepEqual','notDeepStrictEqual','ok','fail'].includes(method)
      || !Array.isArray(graph) || graph.length > 1000 || !Array.isArray(roots)) return 'unsupported';
    const nodes = graph.map(item => {
      switch(item.type) {
        case 'object': return item.nullPrototype ? Object.create(null) : {};
        case 'array': return new Array(item.length);
        case 'set': return new Set();
        case 'map': return new Map();
        case 'date': return new Date(Number(item.value));
        case 'regexp': return new RegExp(item.source,item.flags);
        default: throw new Error('Unsupported type');
      }
    });
    const decode = value => {
      switch(value[0]) {
        case 'ref': if (!Number.isSafeInteger(value[1]) || value[1] < 0 || value[1] >= nodes.length) throw new Error(); return nodes[value[1]];
        case 'undefined': return undefined;
        case 'null': return null;
        case 'string': if(typeof value[1] !== 'string') throw new Error(); return value[1];
        case 'boolean': if(typeof value[1] !== 'boolean') throw new Error(); return value[1];
        case 'number': return value[1] === 'NaN' ? NaN : value[1] === '-0' ? -0 : value[1] === 'Infinity' ? Infinity : value[1] === '-Infinity' ? -Infinity : Number(value[1]);
        case 'bigint': return BigInt(value[1]);
        default: throw new Error('Unsupported value');
      }
    };
    graph.forEach((item,i) => {
      const node=nodes[i];
      if(item.type === 'set') item.values.forEach(v=>node.add(decode(v)));
      if(item.type === 'map') item.entries.forEach(([k,v])=>node.set(decode(k),decode(v)));
      if(item.type === 'regexp') node.lastIndex=decode(item.lastIndex);
      for (const [key,value] of item.properties) {
        if(typeof key !== 'string') throw new Error();
        Object.defineProperty(node,key,{value:decode(value),enumerable:true,writable:true,configurable:true});
      }
    });
    try { (strictMode ? strict : assert)[method](...roots.map(decode)); return 'pass'; }
    catch (error) { return error.code === 'ERR_ASSERTION' ? 'assertion' : 'unsupported'; }
  } catch { return 'unsupported'; }
}
// Capture/freeze intrinsic operations before fixture code is evaluated. Only
// ordinary data is supported; accessors, symbols, functions and custom classes
// are explicit harness failures rather than silently equal serialized values.
export const SERIALIZER = `
  const proto=Object.getPrototypeOf, own=Reflect.ownKeys, descriptor=Object.getOwnPropertyDescriptor;
  const setValues=Function.call.bind(Set.prototype.values), mapEntries=Function.call.bind(Map.prototype.entries);
  const dateValue=Function.call.bind(Date.prototype.getTime);
  const regexpSource=Function.call.bind(descriptor(RegExp.prototype,'source').get), regexpFlags=Function.call.bind(descriptor(RegExp.prototype,'flags').get);
  function serialize(method,strictMode,args) {
    const graph=[], seen=new Map();
    function encode(value) {
      if(value === null) return ['null'];
      const type=typeof value;
      if(type === 'undefined') return ['undefined'];
      if(type === 'string' || type === 'boolean') return [type,value];
      if(type === 'number') return ['number',Object.is(value,-0)?'-0':String(value)];
      if(type === 'bigint') return ['bigint',String(value)];
      if(type !== 'object') throw new Error('Unsupported assertion value');
      if(seen.has(value)) return ['ref',seen.get(value)];
      if(graph.length >= 1000) throw new Error('Assertion graph limit');
      const p=proto(value), properties=[]; let item;
      if(p === Object.prototype || p === null) item={type:'object',nullPrototype:p === null,properties};
      else if(p === Array.prototype) item={type:'array',length:value.length,properties};
      else if(p === Set.prototype) item={type:'set',values:[],properties};
      else if(p === Map.prototype) item={type:'map',entries:[],properties};
      else if(p === Date.prototype) item={type:'date',value:String(dateValue(value)),properties};
      else if(p === RegExp.prototype) item={type:'regexp',source:regexpSource(value),flags:regexpFlags(value),lastIndex:null,properties};
      else throw new Error('Unsupported assertion prototype');
      const index=graph.length;seen.set(value,index);push(graph,item);
      for(const key of own(value)) {
        if(typeof key !== 'string') throw new Error('Unsupported symbol property');
        const d=descriptor(value,key);
        if(d.get || d.set) throw new Error('Unsupported assertion accessor');
        if(!d.enumerable && !(item.type === 'array' && key === 'length')
          && !(item.type === 'regexp' && key === 'lastIndex')) throw new Error('Unsupported non-enumerable assertion property');
        if(d.enumerable) push(properties,[key,encode(d.value)]);
      }
      if(item.type === 'regexp') item.lastIndex=encode(value.lastIndex);
      if(item.type === 'set') for(const v of setValues(value)) push(item.values,encode(v));
      if(item.type === 'map') for(const [k,v] of mapEntries(value)) push(item.entries,[encode(k),encode(v)]);
      return ['ref',index];
    }
    return stringify({method,strictMode,roots:args.map(encode),graph});
  }
`;
