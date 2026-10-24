import test from 'node:test';
import assert from 'node:assert/strict';
import {ROUTES,routesFor,stepReady,tipPosition,recommendedRoute,stepFeedback} from '../apps/web/prototype/guided-tour.mjs';

test('操作引导：旧结果、失败查询、仅点击定位和无效草稿不计完成',()=>{
  const entry={searchVersion:3};
  assert.equal(stepReady('search',{integration:true,searchVersion:3,searchReady:true},entry,{searched:true}),false);
  assert.equal(stepReady('search',{integration:true,searchVersion:4,searchReady:false},entry,{searched:true}),false);
  assert.equal(stepReady('search',{integration:true,searchVersion:4,searchReady:true},entry,{searched:true}),true);
  assert.equal(stepReady('locate',{selected:'WH-1-A',located:false},entry,{located:true}),false);
  assert.equal(stepReady('locate',{selected:'WH-1-A',located:true},entry,{located:true}),true);
  assert.equal(stepReady('draft',{layoutOpen:true,layoutDirty:false},entry,{edited:true}),false);
  assert.equal(stepReady('draft',{layoutOpen:true,layoutDirty:true},entry,{edited:true}),true);
  assert.equal(stepReady('close',{layoutOpen:true,layoutDirty:true},entry,{}),false);
  assert.equal(stepReady('close',{layoutOpen:false,layoutDirty:false},entry,{}),true);
  assert.equal(stepReady('rack',{layoutOpen:true,rack:'A'},entry,{}),false);
  assert.equal(stepReady('room',{sceneLoaded:false},entry,{confirmed:true}),false);
  assert.equal(stepReady('details',{},entry,{confirmed:true}),true);
  assert.equal(ROUTES.inventory.length,4);assert.equal(ROUTES.space.length,6);
});

test('引导卡优先避开目标，窄窗口保持在可见范围',()=>{
  const r={left:20,right:120,top:100,bottom:140};
  const p=tipPosition(r,330,320,{width:940,height:720});
  assert.ok(p.left>=r.right || p.top>=r.bottom || p.top+320<=r.top);
  for(const target of [r,{left:300,right:380,top:600,bottom:650},null]) {
    const v=tipPosition(target,330,320,{width:390,height:700});
    assert.ok(v.left>=0 && v.left+330<=390 && v.top>=0 && v.top+320<=700);
  }
});

// 先点击库存结果，再进入第 3 步，或返回该步，不应丢失已完成状态。
test('定位引导接受提前完成的定位，不要求在本步骤重复点击',()=>{
  const located={selected:'WH-2-F1-L01-B01',located:true};
  assert.equal(stepReady('locate',located,located,{}),true);
  assert.equal(stepReady('search',{...located,integration:true,searchVersion:4,searchReady:false},{searchVersion:3},{searched:true}),true);
  assert.equal(stepReady('locate',{selected:null,located:true},{},{}),false);
  assert.equal(stepReady('locate',{selected:'WH-2-F1-L01-B01',located:false},{},{}),false);
});

test('首次配置从仓库和尺寸开始，未设置及未关闭设置窗口不能确认',()=>{
  assert.deepEqual(ROUTES.setup.map(s=>s.id),['setupWarehouse','setupLayout','setupAdd','setupType','setupSize','setupGrid','setupGenerate','setupPlace','setupSave','setupStock']);
  assert.equal(stepReady('warehouse',{site:null},{},{confirmed:true}),false);
  assert.equal(stepReady('warehouse',{site:'WH'},{},{confirmed:true}),true);
  const room={sceneLoaded:true,room:'WH-1',roomWidth:12,roomDepth:8,roomSettingsOpen:false};
  assert.equal(stepReady('dimensions',room,{},{confirmed:true}),true);
  assert.equal(stepReady('dimensions',{...room,roomSettingsOpen:true},{},{confirmed:true}),false);
  assert.equal(stepReady('dimensions',{...room,roomWidth:0},{},{confirmed:true}),false);
  assert.equal(stepReady('cellsDone',{cellsOpen:true},{},{}),false);
});


test('独立模式按权限提供库存路线，切换不污染外部库存说明',()=>{
  const operator=routesFor({standalone:true,canOperate:true});
  assert.equal(operator.operations,undefined);
  const ids=operator.setup.map(s=>s.id);
  assert.equal(ids.length,10);
  assert.match(operator.setup.find(s=>s.id==='setupStock').body,/点击「入库」/);
  assert.ok(!JSON.stringify(operator).includes('正式出入库仍由 ERP/WMS'));
  assert.equal(stepReady('stockInbound',{}, {}, {}),false);
  assert.equal(stepReady('stockInbound',{}, {}, {confirmed:true}),false);
  const viewer=routesFor({standalone:true});
  assert.equal(viewer.operations,undefined);
  assert.ok(!viewer.setup.some(s=>s.id==='stockInbound'));
  assert.match(routesFor().inventory.at(-1).result,/ERP\/WMS/);
  assert.equal(ROUTES.setup.some(s=>s.id==='stockInbound'),false);
});

test('首次管理员始终可理解建仓能力，不用样板货架推断用户已会使用',()=>{
  assert.equal(recommendedRoute({sceneLoaded:true,rackCount:3},true,true),'setup');
  assert.equal(recommendedRoute({sceneLoaded:true,rackCount:3},true,false),'setup');
  assert.equal(recommendedRoute({sceneLoaded:true,rackCount:0},true),'setup');
  assert.equal(recommendedRoute({sceneLoaded:true,rackCount:0},false,true),'inventory');
  assert.equal(recommendedRoute({sceneLoaded:true,rackCount:0},false),'inventory');
  const state={sceneLoaded:true,site:'WH',room:'WH-1',roomWidth:12,roomDepth:8,rackCount:1};
  assert.equal(stepReady('setupWarehouse',state,{},{}),false);
  assert.equal(stepReady('setupWarehouse',state,{},{confirmed:true}),true);
  assert.equal(stepReady('setupLayout',{...state,layoutOpen:true},{},{}),true);
  assert.equal(stepReady('setupLayout',{...state,layoutDirty:true},{},{}),false);
  assert.equal(stepReady('setupLayout',state,{},{}),false);
  assert.equal(stepReady('setupStock',{itemCount:0},{},{confirmed:true}),false);
  assert.equal(stepReady('setupStock',{itemCount:1},{},{}),true);
  assert.equal(stepReady('setupStock',{canOperate:false,itemCount:0},{},{confirmed:true}),true);
  assert.equal(stepReady('setupFind',{selected:'a',located:false},{},{}),false);
  assert.equal(stepReady('setupFind',{selected:'a',located:true},{},{}),true);
});

test('引导区分已有条件、刚完成操作与仅阅读说明',()=>{
  assert.match(stepFeedback({id:'setupStock'},{itemCount:1},{itemCount:1},{},true),/已有库存/);
  assert.match(stepFeedback({id:'setupStock'},{itemCount:1},{itemCount:0},{},true),/本步已完成/);
  assert.match(stepFeedback({id:'details'},{},{},{confirmed:true},true),/已了解/);
  assert.match(stepFeedback({id:'setupLayout'},{},{rackCount:2},{},true),/已有保存/);
});

test('摆放指引只接受有效字段、生成成功和明确保存成功',()=>{
  const form={furnOpen:true,furnType:'rack',furnName:'A架',furnWidth:2,furnDepth:1,furnHeight:3,furnRows:3,furnCols:4};
  assert.equal(stepReady('setupSize',form,{},{}),true);
  assert.equal(stepReady('setupSize',{...form,furnName:''},{},{}),false);
  assert.equal(stepReady('setupSize',{...form,furnHeight:0},{},{}),false);
  assert.equal(stepReady('setupSize',{...form,furnType:'floor',furnHeight:0},{},{}),true);
  assert.equal(stepReady('setupGrid',{...form,furnRows:1.5},{},{}),false);
  assert.equal(stepReady('setupGrid',{...form,furnCols:101},{},{}),false);
  assert.equal(stepReady('setupGenerate',{layoutOpen:true,furnOpen:true,draftCount:3},{draftCount:3},{}),false);
  assert.equal(stepReady('setupGenerate',{layoutOpen:true,furnOpen:false,draftCount:3},{draftCount:3},{}),false);
  assert.equal(stepReady('setupGenerate',{layoutOpen:true,furnOpen:false,draftCount:4},{draftCount:3},{}),true);
  assert.equal(stepReady('setupSave',{layoutOpen:false,layoutDirty:false},{},{}),false);
  assert.equal(stepReady('setupSave',{layoutOpen:true,layoutDirty:true},{},{saved:true}),false);
  assert.equal(stepReady('setupSave',{layoutOpen:false,layoutDirty:false},{},{saved:true}),true);
});

test('移除作业练习路线，关闭业务窗口不判定用户学会',()=>{
  const routes=routesFor({standalone:true,canOperate:true});
  assert.equal(routes.operations,undefined);
  assert.equal(stepReady('stockInbound',{selected:'A',businessOpen:false},{},{businessSeen:true}),false);
});
