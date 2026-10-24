import test from 'node:test';
import assert from 'node:assert/strict';
import {SETUP_SAMPLE as sample,SETUP_CHAPTERS,SETUP_DEMO_DURATION,setupDemoState} from '../apps/web/prototype/setup-demo-timeline.mjs';

test('模拟填写完成后才生成空间、货架和示例库存，数量与格位一致',()=>{
  assert.equal(setupDemoState(7.9).roomVisible,false);
  const room=setupDemoState(8.5);assert.equal(room.roomVisible,true);
  assert.deepEqual(room.values,{roomName:sample.room,roomWidth:'12',roomDepth:'8',roomHeight:'4'});
  assert.equal(setupDemoState(20.9).rackVisible,false);
  const rack=setupDemoState(21.5);assert.equal(rack.rackVisible,true);
  assert.equal(Number(rack.values.rackRows)*Number(rack.values.rackCols),12);
  const placed=setupDemoState(30.8);assert.equal(placed.x,-2.4);assert.equal(placed.z,-1.2);assert.equal(placed.layoutSaved,true);
  assert.equal(setupDemoState(39.9).stocked,false);
  const stocked=setupDemoState(40.5);assert.equal(stocked.stocked,true);assert.equal(stocked.values.stockLoc,sample.loc);assert.equal(Number(stocked.values.stockQty),sample.qty);
  assert.equal(setupDemoState(44).selected,false);assert.equal(setupDemoState(48.5).selected,true);
});
test('暂停查看各段使用同一时钟，还原后不会残留已保存、库存或定位标记',()=>{
  for(let i=0;i<SETUP_CHAPTERS.length;i++)assert.equal(setupDemoState(SETUP_CHAPTERS[i].preview).chapter,i);
  const start=setupDemoState(0),end=setupDemoState(SETUP_DEMO_DURATION);assert.equal(end.done,true);
  assert.equal(start.roomVisible,false);assert.equal(start.rackVisible,false);assert.equal(start.layoutSaved,false);assert.equal(start.stocked,false);assert.equal(start.selected,false);assert.equal(start.done,false);
  for(const time of [48,8,30,19,0,50,12]){
    const first=setupDemoState(time);setupDemoState(50);assert.deepEqual(setupDemoState(time),first);
  }
});
test('演示拖动连续，50秒停止；首尾与非法进度不会越界',()=>{
  const before=setupDemoState(24),mid=setupDemoState(26.5),after=setupDemoState(29);
  assert.equal(Math.abs(before.x),0);assert.ok(mid.x<0&&mid.x>after.x);assert.equal(after.x,-2.4);
  assert.equal(setupDemoState(-10).seconds,0);assert.equal(setupDemoState(NaN).seconds,0);
  assert.equal(setupDemoState(500).seconds,50);assert.equal(setupDemoState(49.9).done,false);
});
