// 离线成套备份：调用方先停止应用写入；每份目录独立，恢复只允许空目标。
import { DatabaseSync } from 'node:sqlite';
import { createHash } from 'node:crypto';
import { mkdirSync,readdirSync,copyFileSync,readFileSync,writeFileSync,existsSync,lstatSync } from 'node:fs';
import { join,resolve,sep } from 'node:path';
import { pathToFileURL } from 'node:url';
function files(root,prefix='') {
  return readdirSync(join(root,prefix),{withFileTypes:true}).sort((a,b)=>a.name.localeCompare(b.name)).flatMap(e=>{
    const name=prefix?prefix+'/'+e.name:e.name;
    if(e.isSymbolicLink()) throw new Error('备份不接受符号链接');
    return e.isDirectory()?files(root,name):e.isFile()?[name]:(()=>{throw new Error('不支持的文件类型');})();
  });
}
const digest=path=>createHash('sha256').update(readFileSync(path)).digest('hex');
// 同步删除历史不在SQLite中，恢复时必须随库保留；旧备份无此文件仍可读取。
const companionFiles=['uns-warehouse-state.json'];
function copyTree(source,target) {
  mkdirSync(target,{recursive:true});
  for(const name of files(source)) {const dest=join(target,name);mkdirSync(resolve(dest,'..'),{recursive:true});copyFileSync(join(source,name),dest);}
}
function empty(path) {if(existsSync(path) && (!lstatSync(path).isDirectory() || readdirSync(path).length)) throw new Error('目标必须为空：'+path);}
function databaseCheck(path) {
  const sql=new DatabaseSync(path,{readOnly:true});
  try {if(sql.prepare('PRAGMA integrity_check').get().integrity_check!=='ok')throw new Error('数据库完整性校验失败');}
  finally{sql.close();}
}
export function makeBackup(data,uploads,target) {
  const dbPath=join(data,'spatial.db');
  if(!existsSync(dbPath))throw new Error('源数据库不存在');
  // 数据目录只读取spatial.db，因此可在data/backup下成套保存；uploads会递归复制，禁止嵌套。
  if(resolve(target)===resolve(data) || resolve(target)===resolve(uploads) || resolve(target).startsWith(resolve(uploads)+sep))throw new Error('备份目录不得覆盖数据目录或位于上传目录内');
  if(existsSync(target))throw new Error('备份目录已存在，请使用新目录');
  mkdirSync(target,{recursive:true});
  const sql=new DatabaseSync(dbPath);
  try {sql.exec("VACUUM INTO '"+join(target,'spatial.db').replaceAll("'","''")+"'");} finally{sql.close();}
  databaseCheck(join(target,'spatial.db'));
  for(const name of companionFiles)if(existsSync(join(data,name))) {
    if(!lstatSync(join(data,name)).isFile()||lstatSync(join(data,name)).isSymbolicLink())throw Error('同步状态必须为普通文件');
    copyFileSync(join(data,name),join(target,name));
  }
  if(!existsSync(uploads))throw new Error('上传目录不存在');
  copyTree(uploads,join(target,'uploads'));
  const manifest={format:1,created_at:new Date().toISOString(),files:Object.fromEntries(files(target).map(name=>[name,digest(join(target,name))]))};
  writeFileSync(join(target,'manifest.json'),JSON.stringify(manifest,null,2));return manifest;
}
export function verifyBackup(target) {
  const manifest=JSON.parse(readFileSync(join(target,'manifest.json'),'utf8'));
  if(manifest.format!==1 || !manifest.files?.['spatial.db'])throw new Error('未知或不完整的备份格式');
  const actual=files(target).filter(name=>name!=='manifest.json');
  const names=Object.keys(manifest.files).sort();
  if(JSON.stringify(actual.sort())!==JSON.stringify(names))throw new Error('备份文件清单不一致');
  for(const name of names)if(digest(join(target,name))!==manifest.files[name])throw new Error('备份校验失败：'+name);
  databaseCheck(join(target,'spatial.db'));return manifest;
}
export function restoreBackup(target,data,uploads) {
  verifyBackup(target);empty(data);empty(uploads);
  const paths=[target,data,uploads].map(p=>resolve(p));
  for(let i=0;i<paths.length;i++)for(let j=i+1;j<paths.length;j++)if(paths[i]===paths[j] || paths[i].startsWith(paths[j]+sep) || paths[j].startsWith(paths[i]+sep))throw new Error('恢复路径不得重叠');
  mkdirSync(data,{recursive:true});copyFileSync(join(target,'spatial.db'),join(data,'spatial.db'));
  for(const name of companionFiles)if(existsSync(join(target,name)))copyFileSync(join(target,name),join(data,name));
  copyTree(join(target,'uploads'),uploads);databaseCheck(join(data,'spatial.db'));
}
if(process.argv[1] && import.meta.url===pathToFileURL(resolve(process.argv[1])).href) {
  const [mode,target,data='/source',uploads='/assets']=process.argv.slice(2);
  if(mode==='backup')makeBackup(data,uploads,target);
  else if(mode==='verify')verifyBackup(target);
  else if(mode==='restore')restoreBackup(target,data,uploads);
  else throw new Error('用法：backup-data.mjs backup|verify|restore <备份目录> [数据目录] [上传目录]');
  console.log(mode+' 完成');
}
