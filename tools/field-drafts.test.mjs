import test from 'node:test';
import assert from 'node:assert/strict';
import {createFieldDrafts} from '../apps/web/prototype/field-drafts.mjs';

test('现场草稿可续办，按账号、部署、作业和库区节点隔离',()=>{
  const values=new Map(),storage={getItem:key=>values.get(key)||null,setItem:(key,value)=>values.set(key,value)};
  const create=extra=>createFieldDrafts({userId:'worker-a',roomId:'room-original',kind:'opening',basePath:'/warehouse',storage,...extra});
  const row={node_id:'cell-original',baseline:'version-a',rows:[{name:'轴承',qty:12,unit:'套',sku:'SUP-1'}]};
  create().save('WH-1-A-L01-B01',row);
  assert.deepEqual(create().get('WH-1-A-L01-B01').rows,row.rows);assert.equal(create().list()[0].id,'WH-1-A-L01-B01');
  for(const extra of [{userId:'worker-b'},{roomId:'room-rebuilt'},{kind:'counter-in'},{basePath:'/another-app'}])assert.equal(create(extra).get('WH-1-A-L01-B01'),null);
  create({userId:'worker-b'}).save('WH-1-A-L01-B01',{note:'另一人'});
  create().remove('WH-1-A-L01-B01');assert.equal(create().list().length,0);assert.equal(create({userId:'worker-b'}).list().length,1);
});

test('浏览器存储失败明确报告草稿未保存，不假装已完成库存操作',()=>{
  const drafts=createFieldDrafts({userId:'a',roomId:'b',kind:'opening',basePath:'',storage:{getItem:()=>null,setItem:()=>{throw Error('quota');}}});
  assert.throws(()=>drafts.save('cell',{qty:3}),/草稿未能保存/);
});
