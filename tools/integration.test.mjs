import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { verifySuposUser } from '../apps/api/platform.mjs';
import { createInventoryView } from '../apps/api/inventory-view.mjs';
import { dispatchBatch } from '../packages/integration/dispatch.mjs';

test('外部库位按来源隔离，缺失映射整批拒绝，引用中的映射不能改绑或删除', () => {
  const sql=new DatabaseSync(':memory:');
  sql.exec("CREATE TABLE space_node(id TEXT,loc_code TEXT,node_type TEXT); INSERT INTO space_node VALUES('1','WH-1-A-L01-B01','cell'),('2','WH-1-B-L01-B01','cell')");
  const view=createInventoryView(sql);
  const a={source:'ERP-A',external_loc_code:'A-01',loc_code:'WH-1-A-L01-B01'};
  view.saveMapping(a); view.saveMapping({...a,source:'ERP-B',loc_code:'WH-1-B-L01-B01'});
  const snap={source:'ERP-A',version:1,rows:[{sku:'PART',name:'零件',qty:10,external_loc_code:'A-01'}]};
  view.receive(snap,'admin'); view.receive({...snap,source:'ERP-B'},'admin');
  assert.deepEqual(view.list().map(r=>r.loc_code),['WH-1-A-L01-B01','WH-1-B-L01-B01']);
  assert.equal(view.apply(snap).applied,false);
  assert.throws(()=>view.apply({...snap,version:2,rows:[...snap.rows,{...snap.rows[0],external_loc_code:'UNKNOWN'}]}),/未配置库位映射/);
  assert.equal(view.list().length,2);
  assert.throws(()=>view.apply({...snap,version:2,rows:[{...snap.rows[0],loc_code:a.loc_code}]}),/只能提供一个/);
  assert.throws(()=>view.saveMapping({...a,loc_code:'WH-1-B-L01-B01'}),/仍引用/);
  const id=view.mappings().find(m=>m.source==='ERP-A').id;
  assert.throws(()=>view.deleteMapping(id),/仍引用/);
  view.apply({...snap,version:2,rows:[]});
  view.saveMapping({...a,loc_code:'WH-1-B-L01-B01'});
  view.deleteMapping(id);
  assert.equal(view.mappings().length,1);
  assert.throws(()=>view.saveMapping({...a,loc_code:'UNKNOWN'}),/不可用的三维格位/);
  sql.close();
});

test('平台身份只接受已验证且启用的账号，普通账号只读', async () => {
  let cookie;
  const options = data => ({ url: 'http://identity/userinfo', fetcher: async (_, opts) => {
    cookie = opts.headers.Cookie;
    return { ok: true, json: async () => ({ data }) };
  }});
  assert.equal(await verifySuposUser('', options({})), null);
  const user = await verifySuposUser('other=secret; supos_community_token=valid', options({ sub: '1', preferredUsername: 'worker', enabled: true }));
  assert.equal(cookie, 'supos_community_token=valid');
  assert.equal(user.role, 'viewer');
  assert.equal(await verifySuposUser(cookie, options({ sub: '1', preferredUsername: 'worker', enabled: false })), null);
  assert.equal((await verifySuposUser(cookie, options({ sub: '1', preferredUsername: 'admin', superAdmin: true }))).role, 'admin');
});

test('库存快照版本幂等、整批校验、批次隔离和只读场景', () => {
  const sql = new DatabaseSync(':memory:');
  sql.exec("CREATE TABLE space_node(id TEXT,loc_code TEXT,node_type TEXT); INSERT INTO space_node VALUES('1','WH-1-A-L01-B01','cell')");
  const view = createInventoryView(sql);
  const row = { sku: 'A', name: '轴承', qty: 10, loc_code: 'WH-1-A-L01-B01', batch_no: 'B1' };
  const snapshot = { source: '模拟ERP', version: 1, rows: [row, { ...row, batch_no: 'B2', qty: 3 }] };
  assert.equal(view.apply(snapshot).count, 2);
  assert.equal(view.apply(snapshot).applied, false);
  assert.throws(() => view.apply({ ...snapshot, rows: [{ ...row, qty: 99 }] }), /冲突/);
  assert.throws(() => view.apply({ ...snapshot, version: 2, rows: [row, { ...row, loc_code: 'UNKNOWN' }] }), /未知库位/);
  assert.equal(view.list().length, 2);
  const scene = view.scene({ furniture: [{ code: 'WH-1-A', items: { 'L01-B01': [{ name: '本地演示物品' }] } }] });
  assert.equal(scene.furniture[0].items['L01-B01'].length, 2);
  assert.equal(scene.furniture[0].items['L01-B01'][0].name, '轴承');
  view.apply({ ...snapshot, version: 2, rows: [] });
  assert.equal(view.apply(snapshot).applied, false);
  assert.deepEqual(view.list(), []);
  sql.close();
});

test('派发必须全部真实确认；无目标、模拟、失败均不标记成功', async () => {
  const sent = [], retry = [], called = [];
  const db = { getPendingOutbox: () => [{ id: 'event-1', event_type: 'inventory.changed', payload_json: '{}' }],
    markOutboxSent: id => sent.push(id), markOutboxRetry: id => retry.push(id) };
  const adapter = result => ({ system: 'test', mapping: { inventory: { changed: {} } }, send: async (_, body) => { called.push(body._idem); return result; } });
  await dispatchBatch(db, []);
  await dispatchBatch(db, [{ ...adapter({ ok: true }), preview: true }]);
  await dispatchBatch(db, [adapter({ ok: true, dry: true })]);
  await dispatchBatch(db, [adapter({ ok: true }), adapter({ ok: false })]);
  assert.deepEqual(sent, []);
  assert.equal(retry.length, 2);
  await dispatchBatch(db, [adapter({ ok: true }), adapter({ ok: true })]);
  assert.deepEqual(sent, ['event-1']);
  assert.ok(called.every(id => id === 'event-1'));
});

test('分组场景保持多来源批次、不混入其他格位、不显示零库存并清空演示数据',()=>{
  const sql=new DatabaseSync(':memory:');
  try {
    sql.exec("CREATE TABLE space_node(id TEXT,loc_code TEXT,node_type TEXT); INSERT INTO space_node VALUES('1','WH-1-A-C1','cell'),('2','WH-2-A-C1','cell')");
    const view=createInventoryView(sql);
    const row={sku:'A',name:'零件',qty:1,loc_code:'WH-1-A-C1'};
    view.apply({source:'ERP-A',version:1,rows:[row,{...row,batch_no:'B2'},{...row,loc_code:'WH-2-A-C1'},{...row,sku:'ZERO',qty:0}]});
    view.apply({source:'ERP-B',version:1,rows:[row]});
    const scene=view.scene({furniture:[{code:'WH-1-A',items:{C1:[],C2:[{name:'演示'}]}}]});
    assert.equal(scene.furniture[0].items.C1.length,3);
    assert.deepEqual(scene.furniture[0].items.C1.map(r=>r.source),['ERP-A','ERP-A','ERP-B']);
    assert.deepEqual(scene.furniture[0].items.C2,[]);
    assert.equal(view.list().length,5);
  }finally{sql.close();}
});
