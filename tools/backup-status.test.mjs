import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,writeFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createBackupMonitor} from '../apps/api/backup-status.mjs';

test('备份状态保存成功、失败保留最近成功、重启可见且配置和状态文件错误可见',()=>{
  const root=mkdtempSync(join(tmpdir(),'backup-status-'));
  try {
    let fail=false;
    const run=()=>{if(fail)throw new Error('模拟磁盘写入失败');return {bundle:join(root,'bundle-test')};};
    const monitor=createBackupMonitor(root,root,{run});
    assert.equal(monitor.status().last_result,'none');
    monitor.execute();const success=monitor.status().last_success_at;
    assert.equal(monitor.status().last_result,'success');
    assert.equal(monitor.status().bundle,'bundle-test');
    fail=true;assert.throws(()=>monitor.execute(),/写入失败/);
    assert.equal(monitor.status().last_result,'failed');
    assert.equal(monitor.status().last_success_at,success);
    assert.equal(createBackupMonitor(root,root,{run}).status().last_result,'failed');
    assert.equal(createBackupMonitor(root,root,{intervalMs:NaN}).status().enabled,false);
    assert.equal(createBackupMonitor(root,root,{keep:0}).status().enabled,false);
    writeFileSync(join(root,'backup-status.json'),'invalid');
    assert.match(createBackupMonitor(root,root).status().persistence_error,/读取失败/);
    mkdirSync(join(root,'backup-status.json.tmp'));
    fail=false;const blocked=createBackupMonitor(root,root,{run});blocked.execute();
    assert.equal(blocked.status().last_result,'success');
    assert.match(blocked.status().persistence_error,/保存失败/);
  } finally {rmSync(root,{recursive:true,force:true});}
});
