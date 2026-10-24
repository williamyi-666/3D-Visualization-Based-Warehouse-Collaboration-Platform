import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {startErpSyncLab} from './erp-sync-lab.mjs';

test('模拟ERP完整联调：入出移库、断网补传、回执丢失、映射修复、对账和盘点回传',async()=>{
  if(process.env.SPATIAL_TEST_ERP!=='1')throw Error('请在隔离容器设置 SPATIAL_TEST_ERP=1');
  const dir=mkdtempSync(join(tmpdir(),'erp-sync-acceptance-')),lab=await startErpSyncLab(dir);
  const quantities=value=>[lab.locA,lab.locB].map(loc=>value.inventory.find(r=>r.loc_code===loc)?.qty||0);
  try{
    assert.deepEqual(quantities(await lab.state()),[100,0]);
    assert.equal((await lab.machineRequest('/api/v1/inventory')).status,401);
    assert.equal((await lab.machineRequest('/api/integration/credentials')).status,401);
    assert.equal((await lab.machineRequest('/api/integration/snapshot',{source:'OTHER',version:1,rows:[]})).status,403);
    assert.deepEqual(quantities(await lab.action('in',{qty:20})),[120,0]);
    assert.deepEqual(quantities(await lab.action('out',{qty:5})),[115,0]);
    assert.deepEqual(quantities(await lab.action('move',{qty:15})),[100,15]);
    await lab.action('offline');const offline=await lab.action('out',{qty:10});assert.deepEqual(quantities(offline),[100,15]);assert.equal(offline.queue.find(r=>r.state!=='sent').state,'pending');
    const restored=await lab.action('online');assert.deepEqual(quantities(restored),[90,15]);assert.ok(restored.queue.every(r=>r.state==='sent'));
    const lost=await lab.action('lose-ack',{qty:2});assert.deepEqual(quantities(lost),[92,15]);assert.ok(lost.queue.some(r=>r.state==='pending'));
    const retried=await lab.action('retry');assert.deepEqual(quantities(retried),[92,15]);assert.ok(retried.queue.every(r=>r.state==='sent'));
    assert.deepEqual(quantities(await lab.action('mapping-error')),[92,15]);assert.equal((await lab.state()).sourceStatus[0].state,'failed');
    assert.deepEqual(quantities(await lab.action('fix-mapping')),[93,15]);assert.equal((await lab.state()).sourceStatus[0].state,'ok');
    assert.equal((await lab.action('reconcile-difference')).difference_count,1);assert.deepEqual(quantities(await lab.state()),[93,15]);assert.equal((await lab.action('reconcile')).matched,true);
    const waiting=await lab.action('stocktake-send');assert.equal(waiting.stocktake.state,'waiting_sync');assert.deepEqual(quantities(waiting),[93,15]);assert.equal(waiting.uniqueReceipts,1);assert.equal(waiting.receiptCalls,2);
    const done=await lab.action('stocktake-return');assert.equal(done.stocktake.state,'confirmed');assert.deepEqual(quantities(done),[92,15]);
    const events=await lab.api('/api/integration/events?loc_code='+lab.locA);assert.equal(new Set(events.rows.map(r=>r.event_id)).size,events.rows.length);
    assert.equal((await lab.action('stale')).sourceStatus[0].state,'stale');
    assert.equal((await lab.request('/api/counter/inbound',{loc:lab.locA,qty:999})).status,403);
    assert.equal((await lab.request('/api/v1/inventory',undefined,'GET',null)).status,401);
    console.log(JSON.stringify({simulation:true,inboundOutboundMove:true,durableRetry:true,lostAcknowledgementSafe:true,mappingRepair:true,reconcile:true,stocktakeReceiptDoesNotChangeStock:true,stocktakeReturnConfirmed:true}));
  }finally{await lab.close();rmSync(dir,{recursive:true,force:true});}
});
