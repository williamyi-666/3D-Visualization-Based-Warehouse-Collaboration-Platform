import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createAssistantTools} from '../apps/api/assistant-tools.mjs';
import {createWarehouseWork} from '../apps/api/warehouse-work.mjs';
import {createStocktakes} from '../apps/api/stocktake.mjs';

test('助手工具只读取真实数据和生成可核对草稿',async()=>{
  const dir=mkdtempSync(join(tmpdir(),'assistant-tools-'));process.env.SPATIAL_DATA_DIR=dir;
  const db=await import('../apps/api/db.mjs'),sql=db.default;
  createStocktakes(sql,{tenant:db.TENANT,logMovement:db.logMovement,emit:db.emit});
  const work=createWarehouseWork(sql,{db}),room=db.createRoomNode({name:'助手试点',w:12,d:8,h:4});
  const a=db.createRack({name:'A架',roomCode:room.loc_code,rows:2,cols:2,x:-1,z:0}),b=db.createRack({name:'B架',roomCode:room.loc_code,rows:2,cols:2,x:1,z:0});
  const from=a.furn_code+'-L01-B01',other=a.furn_code+'-L01-B02',to=b.furn_code+'-L01-B01';
  const first=db.inbound({name:'深沟球轴承6204',sku:'BRG-6204',qty:10,unit:'套',loc_code:from});db.inbound({name:'深沟球轴承6204',sku:'BRG-6204',qty:5,unit:'套',loc_code:other});
  const tools=createAssistantTools({db,work,readInventory:()=>db.listInventory()});
  const actor={id:'operator',role:'operator'},req={body:{room:room.loc_code},user:actor};
  const before=db.listInventory();
  try {
    const found=await tools.run('find_stock',{query:'6204'},req);assert.equal(found.total,2);assert.deepEqual(found.rows.map(r=>r.qty).sort((a,b)=>a-b),[5,10]);
    assert.equal((await tools.run('find_stock',{query:'6204深沟球轴承'},req)).total,2);
    assert.equal((await tools.run('find_stock',{query:'6204 深沟球轴承'},req)).total,2);
    assert.equal((await tools.run('find_stock',{query:'不锈钢深沟球轴承6204'},req)).total,0);
    const ambiguous=await tools.run('prepare_operation',{operation:'move',query:'6204',qty:3,unit:'套',from_hint:'A架',to_hint:'B架'},req);
    assert.equal(ambiguous.ready,false);assert.equal(ambiguous.choices.length,2);assert.equal(ambiguous.destinations.length,4);
    const input={operation:'move',query:'6204',item_id:first.item_id,from_loc:from,to_loc:to,qty:3,unit:'套'};
    const ready=await tools.run('prepare_operation',input,req);assert.equal(ready.ready,true);assert.equal(ready.draft.from_loc,from);assert.equal(ready.draft.to_loc,to);
    assert.equal((await tools.run('prepare_operation',{...input,qty:11},req)).ready,false);
    assert.equal((await tools.run('prepare_operation',{...input,qty:undefined},req)).ready,false);
    assert.equal((await tools.run('prepare_operation',{...input,unit:'件'},req)).ready,false);
    assert.equal((await tools.run('prepare_operation',{...input,to_loc:from},req)).ready,false);
    await assert.rejects(tools.run('prepare_operation',input,{...req,user:{id:'viewer',role:'viewer'}}),error=>error.status===403);
    const restricted={...req,canAccessLocation:code=>code===room.loc_code||code.startsWith(room.loc_code+'-')};
    assert.equal((await tools.run('find_stock',{query:'备用轴承'},restricted)).total,0);
    await assert.rejects(tools.run('find_stock',{query:'轴承'},{...restricted,body:{room:'WH-1'}}),error=>error.status===403);
    work.savePolicy(room.loc_code,{count_days:7,thresholds:[{item_id:first.item_id,minimum:20}]});
    const counts=await tools.run('list_tasks',{kind:'count'},req),all=await tools.run('list_tasks',{kind:'all'},req);
    assert.ok(counts.rows.length);assert.ok(counts.rows.every(r=>['count','draft'].includes(r.kind)));assert.ok(all.rows.some(r=>r.kind==='low'));
    await assert.rejects(tools.run('delete_all',{},req),/不支持/);
    assert.deepEqual(db.listInventory(),before);
  }finally{sql.close();rmSync(dir,{recursive:true,force:true});}
});
