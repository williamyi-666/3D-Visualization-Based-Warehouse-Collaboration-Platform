import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {createInventoryView} from '../apps/api/inventory-view.mjs';

test('来源周期：未同步、未配置、正常、超时、失败与恢复；对账和重放不刷新库存年龄',()=>{
  const sql=new DatabaseSync(':memory:');
  try {
    const view=createInventoryView(sql);
    view.saveSourcePolicy({source:'等待ERP',expected_interval_minutes:60});
    assert.equal(view.status()[0].state,'waiting');
    view.receive({source:'ERP',version:1,rows:[]},'test');
    assert.equal(view.status().find(s=>s.source==='ERP').state,'unconfigured');
    view.saveSourcePolicy({source:'ERP',expected_interval_minutes:10});
    const time=Date.parse(view.status().find(s=>s.source==='ERP').received_at);
    const state=now=>view.status(now).find(s=>s.source==='ERP');
    assert.equal(state(time+600000).state,'ok');
    assert.equal(state(time+600001).state,'stale');
    view.receive({source:'ERP',version:1,rows:[]},'test');
    assert.equal(state(time+600001).state,'stale');
    assert.throws(()=>view.receive({source:'ERP',version:2,mode:'reconcile',rows:[]},'test'));
    assert.equal(state(time+600001).state,'stale');
    assert.throws(()=>view.receive({source:'ERP',version:0,rows:[]},'test'));
    assert.equal(state(time+600001).state,'failed');
    assert.equal(state(time+600001).stale,true);
    assert.equal(state(time).version,1);
    assert.equal(Date.parse(state(time).received_at),time);
    view.receive({source:'ERP',version:2,rows:[]},'test');
    assert.equal(state(time).state,'ok');
    assert.equal(state(time).version,2);
    for(const minutes of [-1,0.5,43201,'60'])assert.throws(()=>view.saveSourcePolicy({source:'ERP',expected_interval_minutes:minutes}));
    assert.throws(()=>view.saveSourcePolicy({source:' ',expected_interval_minutes:10}));
    assert.equal(createInventoryView(sql).status(time).find(s=>s.source==='ERP').expected_interval_minutes,10);
  } finally {sql.close();}
});
