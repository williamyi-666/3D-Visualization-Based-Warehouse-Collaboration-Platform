import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,writeFileSync,readFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {makeBackup,verifyBackup,restoreBackup} from './backup-data.mjs';

test('成套备份恢复：WAL、资产版本隔离、篡改拒绝及禁止覆盖',()=>{
 const root=mkdtempSync(join(tmpdir(),'spatial-backup-test-'));
 let sql;
 try {
  const data=join(root,'data'),uploads=join(root,'uploads'),backup=join(root,'backup');
  mkdirSync(data);mkdirSync(uploads);sql=new DatabaseSync(join(data,'spatial.db'));
  sql.exec("PRAGMA journal_mode=WAL;CREATE TABLE records(id TEXT,payload TEXT);INSERT INTO records VALUES('库存','数量120'),('映射','格位A'),('凭证','hash'),('审计','操作人');");
  writeFileSync(join(uploads,'model.glb'),'第一版模型');
  const syncState=JSON.stringify({context:'候选仓库',plan:{values:[{alias:'deleted-cell',snapshot:'{"deleted":true,"inventory":[]}'}]}});
  writeFileSync(join(data,'uns-warehouse-state.json'),syncState);
  makeBackup(data,uploads,backup);verifyBackup(backup);
  sql.exec("UPDATE records SET payload='数量999' WHERE id='库存'");writeFileSync(join(uploads,'model.glb'),'第二版模型');
  const restored=join(root,'restored'),assets=join(root,'assets');restoreBackup(backup,restored,assets);
  const db=new DatabaseSync(join(restored,'spatial.db'));
  assert.equal(db.prepare("SELECT payload FROM records WHERE id='库存'").get().payload,'数量120');
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM records').get().n,4);db.close();
  assert.equal(readFileSync(join(assets,'model.glb'),'utf8'),'第一版模型');
  assert.equal(readFileSync(join(restored,'uns-warehouse-state.json'),'utf8'),syncState);
  writeFileSync(join(backup,'uns-warehouse-state.json'),'损坏');
  assert.throws(()=>verifyBackup(backup),/校验失败/);
  writeFileSync(join(backup,'uns-warehouse-state.json'),syncState);
  assert.throws(()=>restoreBackup(backup,restored,assets),/目标必须为空/);
  writeFileSync(join(backup,'uploads/model.glb'),'损坏');
  assert.throws(()=>verifyBackup(backup),/校验失败/);
  assert.throws(()=>restoreBackup(backup,join(root,'other'),join(root,'other-assets')),/校验失败/);
 }finally{sql?.close();rmSync(root,{recursive:true,force:true});}
});
