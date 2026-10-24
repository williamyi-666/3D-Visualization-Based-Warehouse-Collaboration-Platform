// 隔离SQLite测试库；不连接或修改部署数据。node --expose-gc tools/measure-inventory-capacity.mjs
import {DatabaseSync} from 'node:sqlite';
import os from 'node:os';
import {performance} from 'node:perf_hooks';
import {createInventoryView} from '../apps/api/inventory-view.mjs';
import {searchInventory} from '../apps/api/inventory-query.mjs';
const samples=12;
function measure(fn) {
  fn();const times=[];let result;
  for(let i=0;i<samples;i++){const start=performance.now();result=fn();times.push(performance.now()-start);}
  times.sort((a,b)=>a-b);
  return {p95_ms:+times[Math.ceil(samples*.95)-1].toFixed(2),response_bytes:Buffer.byteLength(JSON.stringify(result)),samples};
}
const cases=[];
for(const count of [1000,10000,50000])for(const cells of [100,1000]) {
  const sql=new DatabaseSync(':memory:');
  try {
    sql.exec('CREATE TABLE space_node(id INTEGER PRIMARY KEY,loc_code TEXT UNIQUE,node_type TEXT)');
    const insert=sql.prepare("INSERT INTO space_node(loc_code,node_type) VALUES(?,'cell')");
    for(let i=0;i<cells;i++)insert.run('WH-1-A-C'+i);
    const view=createInventoryView(sql);
    view.apply({source:'CAPACITY',version:1,rows:Array.from({length:count},(_,i)=>({sku:'SKU-'+i,name:'测试库存'+i,qty:i%9+1,loc_code:'WH-1-A-C'+(i%cells),unit:'件',status:i%2?'可用':'待检',batch_no:'B'+i%10}))});
    const base=()=>({furniture:[{code:'WH-1-A',items:Object.fromEntries(Array.from({length:cells},(_,i)=>['C'+i,[]]))}]});
    global.gc?.();const heapBefore=process.memoryUsage().heapUsed;
    const search=measure(()=>searchInventory(view.list(),{q:'SKU-'}));
    const paged_search=measure(()=>view.inventoryPage({q:'SKU-',room:'WH-1'}));
    const scene=measure(()=>view.scene(base()));
    const row={inventory_rows:count,cells,search,paged_search,scene,heap_before_bytes:heapBefore,heap_after_bytes:process.memoryUsage().heapUsed,rss_bytes:process.memoryUsage().rss};
    cases.push(row);process.stderr.write(`完成 ${count}库存/${cells}格位\n`);
  }finally{sql.close();}
}
console.log(JSON.stringify({measured_at:new Date().toISOString(),node:process.version,platform:process.platform,arch:process.arch,cpu:os.cpus()[0].model,logical_cpus:os.cpus().length,total_memory_bytes:os.totalmem(),scope:'服务端内存SQLite及序列化结果；不包含HTTP、真实磁盘、浏览器渲染或浏览器内存',cases},null,2));
