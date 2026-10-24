import test from 'node:test';
import assert from 'node:assert/strict';
import {assistantIntent} from '../apps/api/assistant-intent.mjs';
test('切换到实盘、流水、建账时不延续移库，局部修改仍沿用原预览',()=>{
  const pending={name:'prepare_operation'};
  assert.equal(assistantIntent('这个格位实际只有13套，请准备盘点单',pending),'prepare_stocktake');
  assert.equal(assistantIntent('这个格位今天为什么少了货？',pending),'movement_history');
  assert.equal(assistantIntent('这里有垫圈8盒，建立期初库存',pending),'prepare_opening');
  assert.equal(assistantIntent('数量改成5套，目标不变',pending),'prepare_operation');
  assert.equal(assistantIntent('每排改为1架',{name:'preview_warehouse'}),'preview_warehouse');
});
