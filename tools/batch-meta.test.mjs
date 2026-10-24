import test from 'node:test';
import assert from 'node:assert/strict';
import {buildBatchMeta} from '../apps/web/prototype/batch-meta.mjs';
test('批量字段明确区分保持、设置零值及清空',()=>{
 assert.deepEqual(buildBatchMeta({capacity:{mode:'keep',value:'123'},tags:{mode:'keep',value:'旧值'}}),{});
 assert.deepEqual(buildBatchMeta({capacity:{mode:'set',value:'0'},max_load:{mode:'set',value:'0'}}),{capacity:0,max_load:0});
 assert.deepEqual(buildBatchMeta(Object.fromEntries(['capacity','max_load','tags','note'].map(key=>[key,{mode:'clear',value:'旧值'}]))),{capacity:null,max_load:null,tags:[],note:''});
 assert.deepEqual(buildBatchMeta({tags:{mode:'set',value:' 甲，乙, '},note:{mode:'set',value:' 备注 '}},'locked'),{status:'locked',tags:['甲','乙'],note:'备注'});
 for(const value of ['', '-1', '1.5'])assert.throws(()=>buildBatchMeta({capacity:{mode:'set',value}}));
 assert.throws(()=>buildBatchMeta({tags:{mode:'set',value:'，，'}}));
});
