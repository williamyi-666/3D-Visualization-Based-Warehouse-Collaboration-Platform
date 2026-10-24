import test from 'node:test';
import assert from 'node:assert/strict';
import {groundWarehouseCall} from '../apps/api/assistant-grounding.mjs';

test('建仓参数以原话核对，层列互换和每排修改不能变成总数量修改',()=>{
  const result=groundWarehouseCall('preview_warehouse',{template:'shelf',count:2,perRow:2,rows:3,cols:2,name:'库区名'},'使用轻型货架，布置2架，每排2架，每架2层3列',null);
  assert.deepEqual(result.args,{template:'shelf',count:2,perRow:2,rows:2,cols:3});
  const changed=groundWarehouseCall('preview_warehouse',{template:'shelf',count:1,perRow:1,rows:3,cols:2},'每排改成1架，其他参数不变',{name:'preview_warehouse',input:{count:2}});
  assert.equal(changed.name,'update_request');assert.deepEqual(changed.args,{perRow:1});
  assert.deepEqual(groundWarehouseCall('preview_warehouse',{count:4},'帮我建仓',null).args,{});
  assert.equal(groundWarehouseCall('preview_warehouse',{},'新增两架，每排一架，每架三层六列',null).args.cols,6);
  const opening=groundWarehouseCall('prepare_opening',{query:'6204轴承',qty:20,unit:'套'},'这里有现场轴承6204共20套，帮我建立期初库存');assert.equal(opening.args.name,'现场轴承6204');
  assert.equal(groundWarehouseCall('prepare_stocktake',{actual_qty:18,reason:'用户确认实际数量'},'这里实际18套，请准备盘点单').args.reason,undefined);
});
