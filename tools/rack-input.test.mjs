import test from 'node:test';import assert from 'node:assert/strict';
import {rackInputError} from '../apps/web/prototype/rack-input.mjs';
test('货架输入拒绝非法尺寸及层列，不静默回退默认值',()=>{
 const valid={w:1.2,h:8,d:2.4,rows:20,cols:30};assert.equal(rackInputError(valid),'');
 for(const key of ['w','h','d'])for(const value of [0,-1,NaN,Infinity])assert.match(rackInputError({...valid,[key]:value}),/有效数值/);
 for(const key of ['rows','cols'])for(const value of [0,1.5,101,NaN])assert.match(rackInputError({...valid,[key]:value}),/1至100/);
 assert.equal(rackInputError({...valid,h:0.05,rows:100,cols:100}),'');
});
