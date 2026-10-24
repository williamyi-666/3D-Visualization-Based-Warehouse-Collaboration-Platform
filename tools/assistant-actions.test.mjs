import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createAssistantTools} from '../apps/api/assistant-tools.mjs';
import {createWarehouseWork} from '../apps/api/warehouse-work.mjs';
import {createStocktakes} from '../apps/api/stocktake.mjs';
import {planQuickBuild} from '../packages/three-kit/quick-build.mjs';

test('业务助手复用真实建仓、建账、推荐、盘点和流水规则，所有预览不写库存',async()=>{
  const dir=mkdtempSync(join(tmpdir(),'assistant-actions-'));process.env.SPATIAL_DATA_DIR=dir;
  const db=await import('../apps/api/db.mjs'),sql=db.default;
  createStocktakes(sql,{tenant:db.TENANT,logMovement:db.logMovement,emit:db.emit});
  const work=createWarehouseWork(sql,{db}),room=db.createRoomNode({name:'智能助手业务验证',w:12,d:8,h:4});
  const tools=createAssistantTools({db,work,readInventory:()=>db.listInventory()});
  const admin={id:'admin',role:'admin'},operator={id:'op',role:'operator'},req={body:{room:room.loc_code,context:{}},user:admin};
  try{
    const incomplete=await tools.run('preview_warehouse',{},req);assert.equal(incomplete.ready,false);assert.equal(incomplete.plan,null);
    const args={template:'shelf',count:2,perRow:2,rows:2,cols:3,w:1.2,h:1.8,d:0.5,aisle:1.2,gap:0.3};
    const preview=await tools.run('preview_warehouse',args,req);assert.equal(preview.ready,true);assert.equal(preview.plan.cellCount,12);assert.equal(db.getLayout(room.loc_code).furniture.length,0);
    await assert.rejects(tools.run('preview_warehouse',args,{...req,user:operator}),error=>error.status===403);
    const generated=db.quickBuildRacks({...args,roomCode:room.loc_code,revision:preview.plan.revision,request_id:'build-agent-fixture'},planQuickBuild);
    const loc=generated.created[0]+'-L01-B01',empty=generated.created[0]+'-L01-B02';req.body.context.loc_code=loc;
    const before=db.listInventory();
    const opening=await tools.run('prepare_opening',{query:'测试轴承6204',qty:20,unit:'套'},req);assert.equal(opening.ready,true);assert.equal(opening.loc_code,loc);assert.equal(opening.row.sku,'');assert.deepEqual(db.listInventory(),before);
    work.establish({loc_code:loc,baseline:opening.baseline,rows:[opening.row],request_id:'opening-agent-fixture'},operator);
    const item=db.getCellItems(loc)[0],saved=db.listInventory();
    assert.equal((await tools.run('prepare_opening',{query:'测试轴承6204',qty:18,unit:'套'},req)).ready,false);
    const reuse=await tools.run('prepare_opening',{query:item.sku,qty:4,unit:'套',loc_code:empty},req);assert.equal(reuse.ready,true);assert.equal(reuse.row.item_id,item.item_id);
    const move=await tools.run('prepare_operation',{operation:'move',qty:3,unit:'套',to_hint:empty},req);assert.equal(move.ready,true);assert.equal(move.draft.item_id,item.item_id);assert.equal(move.draft.from_loc,loc);
    const count=await tools.run('prepare_stocktake',{actual_qty:18,unit:'套'},req);assert.equal(count.ready,true);assert.equal(count.row.difference,-2);
    assert.equal((await tools.run('prepare_stocktake',{actual_qty:0,unit:'套'},req)).row.difference,-20);
    assert.equal((await tools.run('prepare_stocktake',{actual_qty:18,unit:'箱'},req)).ready,false);
    const recommendation=await tools.run('recommend_location',{qty:3,unit:'套'},req);assert.equal(recommendation.ready,true);assert.equal(recommendation.candidates[0].loc_code,loc);assert.match(recommendation.candidates[0].reasons.join(''),/相同SKU/);assert.ok(recommendation.candidates[0].warnings.length);
    const history=await tools.run('movement_history',{query:'6204',period:'all'},req);assert.equal(history.total,1);assert.equal(history.rows[0].move_type,'opening');assert.equal(history.rows[0].qty,20);
    assert.equal(history.summary[0].incoming,20);assert.equal(history.summary[0].net,20);
    const externalTools=createAssistantTools({db,work,integrationMode:true,readInventory:()=>[{id:'external-row-1',source:'ERP',name:'外部轴承',sku:'ERP-6204',qty:10,unit:'套',loc_code:loc},{id:'external-row-2',source:'ERP',name:'外部螺母',sku:'ERP-NUT',qty:5,unit:'件',loc_code:loc}]});
    const externalCount=await externalTools.run('prepare_stocktake',{query:'ERP-6204',actual_qty:8,unit:'套'},req);assert.equal(externalCount.ready,true);assert.equal(externalCount.row.item_id,'external-row-1');assert.equal(externalCount.row.difference,-2);assert.equal(externalCount.external,true);
    assert.equal((await externalTools.run('prepare_stocktake',{actual_qty:8},req)).ready,false);
    assert.equal((await tools.run('movement_history',{query:'不存在的货品',period:'all'},req)).total,0);
    for(const name of ['prepare_opening','recommend_location','prepare_stocktake'])await assert.rejects(tools.run(name,{qty:2,actual_qty:2},{...req,user:{id:'viewer',role:'viewer'}}),error=>error.status===403);
    const restricted={...req,canAccessLocation:code=>code===room.loc_code||code.startsWith(room.loc_code+'-')};assert.ok((await tools.run('movement_history',{period:'all'},restricted)).rows.every(row=>!row.from_loc||row.from_loc.startsWith(room.loc_code+'-')));
    assert.deepEqual(db.listInventory(),saved);
  }finally{sql.close();rmSync(dir,{recursive:true,force:true});}
});
