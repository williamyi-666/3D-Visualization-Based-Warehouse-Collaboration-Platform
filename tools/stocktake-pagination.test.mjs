import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {createStocktakes} from '../apps/api/stocktake.mjs';

test('盘点历史超过100条可完整翻页，同时间和新增单据不造成遗漏重复',()=>{
  const db=new DatabaseSync(':memory:');
  try {
    db.exec("CREATE TABLE space_node(id TEXT PRIMARY KEY,parent_id TEXT);INSERT INTO space_node VALUES('room',NULL),('rack','room'),('node','rack')");
    const service=createStocktakes(db,{});
    const insert=db.prepare(`INSERT INTO stocktake(id,loc_code,node_id,baseline,counts,movement_mark,state,created_by,updated_by,created_at,updated_at)
      VALUES(?,?,?,'[]','[]',0,?,'{"name":"验收员"}','{"name":"验收员"}',?,?)`);
    const stamp='2026-09-19T00:00:00.000Z';
    for(let i=0;i<105;i++)insert.run('id-'+String(i).padStart(3,'0'),'WH-1-A','node',i===0?'draft':'confirmed',stamp,stamp);
    insert.run('hidden','OTHER-1-A','other','confirmed',stamp,stamp);
    const allowed=loc=>loc==='WH-1-A';
    let page=service.page('WH-1-A',{limit:20},allowed),all=page.records.map(r=>r.id);
    assert.equal(page.has_draft,true); // 草稿不在第一页仍能继续盘点。
    insert.run('newest','WH-1-A','node','confirmed','2026-09-20',stamp);
    while(page.next_before){page=service.page('WH-1-A',{limit:20,before:page.next_before},allowed);all.push(...page.records.map(r=>r.id));}
    assert.equal(all.length,105);assert.equal(new Set(all).size,105);assert.equal(all.at(-1),'id-000');
    assert.ok(!all.includes('hidden'));assert.ok(!all.includes('newest'));
    assert.equal(service.page('WH-1-A',{limit:20},allowed).records[0].id,'newest');
    assert.equal(service.get(all.at(-1),allowed).state,'draft');
    assert.throws(()=>service.page('OTHER-1-A',{},allowed),e=>e.status===403);
    assert.throws(()=>service.page('WH-1-A',{before:'hidden'},allowed),/分页位置无效/);
    for(const limit of [0,51,-1,1.5,'NaN'])assert.throws(()=>service.page('WH-1-A',{limit},allowed),/每页/);
    assert.equal(service.list('WH-1-A',allowed).length,100); // 保留旧接口返回约定。
  } finally {db.close();}
});
