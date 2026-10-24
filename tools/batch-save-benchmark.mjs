// 运行 node tools/batch-save-benchmark.mjs；新建临时数据库，仅测内部批量写入与审计，不连接正式服务。
import {mkdtempSync} from 'node:fs';import {tmpdir} from 'node:os';import {join} from 'node:path';
process.env.SPATIAL_DATA_DIR=mkdtempSync(join(tmpdir(),'batch-save-bench-'));
const db=await import('../apps/api/db.mjs');const sql=db.default;
const insert=sql.prepare('INSERT INTO space_node(id,tenant_id,parent_id,loc_code,node_type,name,template) VALUES(?,?,?,?,?,?,?)');
const room=sql.prepare("SELECT * FROM space_node WHERE node_type='room' LIMIT 1").get(),codes=[];
sql.exec('BEGIN');for(let i=0;i<50;i++){const rack='BENCH-'+i;insert.run(rack,room.tenant_id,room.id,rack,'rack',rack,'{}');for(let r=1;r<=10;r++)for(let c=1;c<=10;c++){const code=rack+'-L'+String(r).padStart(2,'0')+'-B'+String(c).padStart(2,'0');codes.push(code);insert.run(code,room.tenant_id,rack,code,'cell',code,'{}');}}sql.exec('COMMIT');
const times=[];for(let i=0;i<6;i++){const start=performance.now();const result=db.setCellsMeta(codes,{note:'批量'+i,status:'normal',tags:['测试']});times.push(Math.round(performance.now()-start));if(result.updated.length!==5000)throw Error('更新数错误');}
console.log(JSON.stringify({count:5000,times,rows:sql.prepare("SELECT count(*) n FROM space_node WHERE note='批量5'").get().n,audit:db.listSpaceOperations()[0].changed_count}));sql.close();
