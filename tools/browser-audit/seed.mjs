import {DatabaseSync} from 'node:sqlite';
import {createInventoryView} from '/app/apps/api/inventory-view.mjs';
// 只允许专用隔离卷挂载点，禁止对部署数据路径直接运行。
const path=process.argv[2],count=Number(process.argv[3] || 137);
if(path!=='/audit-data/spatial.db')throw Error('只允许隔离测试挂载点');
const sql=new DatabaseSync(path);
try {
 const cells=sql.prepare("SELECT loc_code FROM space_node WHERE node_type='cell' ORDER BY loc_code").all();
 const view=createInventoryView(sql);const prior=view.status().find(s=>s.source==='BROWSER-AUDIT');
 view.receive({source:'BROWSER-AUDIT',version:(prior?.version || 0)+1,rows:Array.from({length:count},(_,i)=>({sku:'AUDIT-'+String(i).padStart(6,'0'),name:'浏览器隔离库存'+i,qty:1,loc_code:cells[i%cells.length].loc_code}))},'isolated-fixture');
 console.log(JSON.stringify({source:'BROWSER-AUDIT',rows:count,cells:cells.length}));
}finally{sql.close();}
