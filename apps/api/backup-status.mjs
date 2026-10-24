import {readFileSync,writeFileSync,renameSync,existsSync} from 'node:fs';
import {join,basename} from 'node:path';
import {backupBusinessState} from './backup.mjs';

// 记录同一套备份逻辑的执行结果，不创建第二套备份或在线恢复入口。
export function createBackupMonitor(data,uploads,{keep=28,intervalMs=21600000,run=backupBusinessState}={}) {
  const path=join(data,'backup-status.json');
  let state={last_attempt_at:null,last_success_at:null,last_result:'none',error:null,bundle:null}, persistenceError=null;
  if(existsSync(path)) {
    try {state={...state,...JSON.parse(readFileSync(path,'utf8'))};}
    catch {persistenceError='备份状态文件读取失败，请检查服务端文件权限或文件内容';}
  }
  const configError=!Number.isInteger(keep)||keep<1?'BACKUP_KEEP 必须为正整数':!Number.isInteger(intervalMs)||intervalMs<1000||intervalMs>2147483647?'BACKUP_INTERVAL_MS 必须为1000至2147483647的整数毫秒':null;
  function persist() {
    try {writeFileSync(path+'.tmp',JSON.stringify(state));renameSync(path+'.tmp',path);persistenceError=null;}
    catch {persistenceError='备份状态保存失败，当前结果仅在本次运行中可见，请检查数据目录写入权限';}
  }
  function execute() {
    state.last_attempt_at=new Date().toISOString();
    try {
      if(configError)throw new Error(configError);
      const result=run(data,uploads,keep);
      state={...state,last_success_at:new Date().toISOString(),last_result:'success',error:null,bundle:basename(result.bundle)};
      persist();return result;
    } catch(error) {
      state={...state,last_result:'failed',error:String(error.message).slice(0,500)};
      persist();throw error;
    }
  }
  function status() {
    return {...state,persistence_error:persistenceError,enabled:!configError,config_error:configError,interval_ms:configError?null:intervalMs,keep:configError?null:keep};
  }
  return {execute,status};
}
