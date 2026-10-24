import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {createInventoryView} from '../apps/api/inventory-view.mjs';

test('同步历史覆盖100条之外，筛选统计准确，翻页期间新增记录不挤动结果',()=>{
  const sql=new DatabaseSync(':memory:');
  try {
    const view=createInventoryView(sql);
    const insert=sql.prepare('INSERT INTO external_inventory_sync_log(source,version,actor,result,row_count,message,created_at,request_json,kind) VALUES(?,?,?,?,?,?,?,?,?)');
    for(let i=1;i<=130;i++)insert.run(i%2?"ERP'东":'ERP西',String(i),'tester',i%3===0?'failed':i%3===1?'different':'applied',1,'test',new Date(Date.UTC(2026,8,16,0,0,i)).toISOString(),i%3===0?'{}':null,'snapshot');
    const first=view.historyPage();
    assert.equal(first.total,130);assert.equal(first.pages,6);assert.equal(first.rows.length,25);
    assert.equal(first.failed,43);assert.equal(first.different,44);
    const second=view.historyPage({page:2,through_id:first.through_id});
    insert.run('新来源','131','tester','applied',1,'new','2026-09-17T00:00:00.000Z',null,'snapshot');
    assert.deepEqual(view.historyPage({page:2,through_id:first.through_id}),second);
    const ids=[];
    for(let page=1;page<=first.pages;page++)ids.push(...view.historyPage({page,through_id:first.through_id}).rows.map(row=>row.id));
    assert.equal(ids.length,130);assert.equal(new Set(ids).size,130);assert.equal(ids.at(-1),1);
    const filtered=view.historyPage({source:"ERP'东",result:'retryable',from:'2026-09-16T00:00:00Z',to:'2026-09-17T00:00:00Z',page_size:100});
    assert.equal(filtered.total,22);assert.equal(filtered.failed,22);
    assert.ok(filtered.rows.every(row=>row.retryable && row.source==="ERP'东" && !('request_json' in row)));
    assert.equal(view.historyPage({source:"' OR 1=1 --"}).total,0);
    assert.equal(view.historyPage({from:'2026-09-17T00:00:00Z'}).total,1);
    assert.equal(view.historyPage().total,131);
    assert.throws(()=>view.historyPage({result:'unknown'}),/筛选/);
    assert.throws(()=>view.historyPage({page_size:10000}),/分页/);
    assert.throws(()=>view.historyPage({from:'bad'}),/日期/);
    assert.throws(()=>view.historyPage({from:'2026-09-18',to:'2026-09-17'}),/开始日期/);
  } finally {sql.close();}
});
