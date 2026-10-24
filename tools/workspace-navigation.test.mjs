import test from 'node:test';
import assert from 'node:assert/strict';
import {workspaceCapabilities,workspaceMenu} from '../apps/web/prototype/workspace-navigation.mjs';
import {recommendedRoute,routesFor} from '../apps/web/prototype/guided-tour.mjs';

test('四类角色菜单与引导一致，不将独立模式当作管理权限',()=>{
  const matrix=[
    ['admin',true,true,true,'setup'],
    ['operator',false,true,false,'inventory'],
    ['viewer',false,false,false,'inventory'],
    ['spaceAdmin',true,false,false,'setup']
  ];
  for(const [role,manage,operate,admin,route] of matrix){
    const access=workspaceCapabilities({user:{role}}),menu=workspaceMenu(access);
    assert.deepEqual(access,{canManage:manage,canOperate:operate,canAdmin:admin});
    assert.equal(menu.layoutBtn,manage);assert.equal(menu.assetBtn,manage);
    assert.equal(menu.ioBtn,operate);assert.equal(menu.transferImport,operate);assert.equal(menu.adminBtn,admin);
    assert.equal(recommendedRoute({rackCount:4},access.canManage,access.canOperate),route);
    assert.equal(recommendedRoute({rackCount:0},access.canManage,access.canOperate),manage?'setup':route);
  }
  assert.deepEqual(workspaceCapabilities(),{canManage:false,canOperate:false,canAdmin:false});
});

test('平台入口遵循已验证的空间与库存授权，ERP模式不提供本地库存作业',()=>{
  const operator=workspaceCapabilities({user:{role:'admin'},platform:true,spaceEditable:false,access:{canOperate:true,canAdmin:false}});
  assert.deepEqual(operator,{canManage:false,canOperate:true,canAdmin:false});
  const external=workspaceCapabilities({user:{role:'operator'},platform:true,integration:true,spaceEditable:true,access:{canOperate:true,canAdmin:false}});
  assert.deepEqual(external,{canManage:true,canOperate:false,canAdmin:false});
  assert.equal(routesFor({standalone:true,canOperate:false}).operations,undefined);
  assert.equal(recommendedRoute({rackCount:2},external.canManage,external.canOperate),'setup');
});
