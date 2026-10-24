import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {mkdtempSync,unlinkSync,rmdirSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createWarehouseAccess} from '../apps/api/warehouse-access.mjs';

test('仓库权限升级保留旧范围，角色重启后有效，旧客户端更新范围不撤销角色',()=>{
  const dir=mkdtempSync(join(tmpdir(),'warehouse-access-')),file=join(dir,'access.sqlite');
  let sql=new DatabaseSync(file);
  const identity=access=>{
    const req={user:{id:'supos:existing',username:'existing',name:'已有账号',role:'viewer',provider:'supos'}};
    access.identityMiddleware(req,{},()=>{});
    return req.user;
  };
  try {
    sql.exec("CREATE TABLE space_node(id TEXT,node_type TEXT,loc_code TEXT); INSERT INTO space_node VALUES('site','site','WH'); CREATE TABLE warehouse_access(user_id TEXT PRIMARY KEY,sites TEXT NOT NULL,updated_by TEXT NOT NULL,updated_at TEXT NOT NULL); INSERT INTO warehouse_access VALUES('supos:existing','[]','admin','2026-09-17');");
    let access=createWarehouseAccess(sql);
    assert.deepEqual(access.list()[0].sites,[]);
    assert.equal(identity(access).role,'viewer');
    access.save({user_id:'supos:existing',sites:['WH'],role:'spaceAdmin'},'admin');
    sql.close();sql=new DatabaseSync(file);access=createWarehouseAccess(sql);
    assert.equal(identity(access).role,'spaceAdmin');
    assert.deepEqual(access.list()[0].sites,['WH']);
    access.save({user_id:'supos:existing',sites:[]},'legacy-admin');
    assert.equal(identity(access).role,'spaceAdmin');
    assert.deepEqual(access.list()[0].sites,[]);
    access.remove('supos:existing');
    assert.equal(identity(access).role,'viewer');
    assert.equal(access.list().length,0);
  } finally {sql.close();unlinkSync(file);rmdirSync(dir);}
});
