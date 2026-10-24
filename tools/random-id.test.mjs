import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFileSync} from 'node:fs';
import {webcrypto} from 'node:crypto';
const source=readFileSync('apps/web/prototype/random-id.js','utf8');
test('局域网 HTTP 缺少 randomUUID 时生成标准且不同的 UUID',()=>{
  const context=vm.createContext({crypto:{getRandomValues:webcrypto.getRandomValues.bind(webcrypto)}});
  vm.runInContext(source,context);
  const ids=Array.from({length:1000},()=>context.spatialRandomUUID());
  for(const id of ids)assert.match(id,/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  assert.equal(new Set(ids).size,ids.length);
});
test('安全上下文优先使用原生 UUID',()=>{
  const context=vm.createContext({crypto:{randomUUID:()=> 'native-id'}});
  vm.runInContext(source,context);assert.equal(context.spatialRandomUUID(),'native-id');
});
