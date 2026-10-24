import test from 'node:test';
import assert from 'node:assert/strict';
import {publishWarehouseModel} from '../packages/integration/warehouse-publish.mjs';
const model={kind:'file',name:'cell',alias:'cell',path:'root/cell',description:'owned',displayName:'格位',dataType:1,persistence:false,
  definition:[{name:'occupied',type:'LONG'},{name:'snapshot',type:'STRING',maxLen:16384}]};
const plan={models:[model],values:[{alias:'cell',path:'root/cell',loc_code:'WH-1',occupied:1,snapshot:'{"qty":3}'}]};
test('读回暂时异常可恢复，内容或时间戳不一致不能成功',async()=>{
  let sent,reads=0;
  const result=await publishWarehouseModel(plan,{publish:async(_p,v)=>sent=v,sleep:async()=>{},request:async route=>{
    if(route==='file/cell')return model;
    if(++reads===1)throw Error('平台暂时异常');
    return {cell:sent};
  }});
  assert.equal(result.verified,1);assert.equal(reads,2);
  await assert.rejects(()=>publishWarehouseModel(plan,{publish:async()=>{},sleep:async()=>{},request:async route=>route==='file/cell'?model:{cell:{...sent,snapshot:'错误快照'}}}),/未读回/);
});
test('模型冲突时停止，未经显式注册不写平台',async()=>{
  let writes=0;
  await assert.rejects(()=>publishWarehouseModel(plan,{publish:async()=>writes++,request:async()=>({...model,description:'其他应用'})}),/冲突/);
  await assert.rejects(()=>publishWarehouseModel(plan,{publish:async()=>writes++,request:async()=>{const e=Error('找不到文件');e.code=400;throw e;}}),/找不到/);
  assert.equal(writes,0);
});
test('显式允许更新才修改已有节点名称/父级，更新后必须读回',async()=>{
  const desired={...model,displayName:'新格位',parentAlias:'newParent',path:'newRoot/cell'};
  let actual={...model},patch;
  const request=async(route,body,method)=>{
    if(method==='PUT'){patch=body;actual={...actual,...body,path:'newRoot/cell'};return;}
    return actual;
  };
  await assert.rejects(()=>publishWarehouseModel({models:[desired],values:[]},{request}),/名称或层级/);
  const result=await publishWarehouseModel({models:[desired],values:[]},{request,update:true});
  assert.equal(result.updated,1);assert.equal(patch.parentAlias,'newParent');assert.equal(patch.definition,undefined);
  assert.deepEqual(actual.definition,model.definition);
});
