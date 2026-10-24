// 从锁文件核对实际安装版本并收集原始许可；不把 SPDX 名称当作许可原文。
import {readFileSync,readdirSync,existsSync,mkdirSync,copyFileSync,writeFileSync} from 'node:fs';
import {join,resolve} from 'node:path';
import {createHash} from 'node:crypto';
const root=resolve(process.argv[2] || '.');
const output=resolve(process.argv[3] || join(root,'third-party'));
const hash=path=>createHash('sha256').update(readFileSync(path)).digest('hex');
const packages=new Map(),locks=[];
for(const base of ['', 'apps/api']) {
 const lockPath=join(root,base,'package-lock.json');
 const lock=JSON.parse(readFileSync(lockPath,'utf8'));
 locks.push({path:join(base,'package-lock.json').replaceAll('\\','/'),sha256:hash(lockPath)});
 for(const [location,entry] of Object.entries(lock.packages)) {
  if(!location || entry.dev)continue;
  const dir=join(root,base,location),packageFile=join(dir,'package.json');
  if(!existsSync(packageFile))throw new Error('依赖未安装：'+dir);
  const pkg=JSON.parse(readFileSync(packageFile,'utf8'));
  if(pkg.version!==entry.version)throw new Error('实际版本与锁文件不一致：'+pkg.name);
  const id=pkg.name+'@'+pkg.version;
  let record=packages.get(id);
  if(!record) {
   const names=readdirSync(dir).filter(n=>/^(licen[cs]e|copying|notice|copyright)([.\-_]|$)/i.test(n));
   if(!names.length) {
    const readme=readdirSync(dir).find(n=>/^readme(\.|$)/i.test(n));
    if(readme && /^#+\s+licen[cs]e\s*$/im.test(readFileSync(join(dir,readme),'utf8')))names.push(readme);
   }
   const licenseFiles=[];
   const dest=join(output,'npm',id.replaceAll('/','__'));
   mkdirSync(dest,{recursive:true});
   for(const name of names) {
    const source=join(dir,name);
    // 许可目录保留原结构；不复制依赖源码或用户配置。
    function copyLicense(from,to,relative) {
     const entries=readdirSync(from,{withFileTypes:true});
     for(const e of entries) {
      if(e.isSymbolicLink())throw new Error('许可文件不接受符号链接');
      const rel=relative+'/'+e.name;
      if(e.isDirectory()){mkdirSync(join(to,e.name),{recursive:true});copyLicense(join(from,e.name),join(to,e.name),rel);}
      else if(e.isFile()){copyFileSync(join(from,e.name),join(to,e.name));licenseFiles.push({path:rel,sha256:hash(join(from,e.name))});}
     }
    }
    const e=readdirSync(dir,{withFileTypes:true}).find(e=>e.name===name);
    const rel='npm/'+id.replaceAll('/','__')+'/'+name;
    if(e.isDirectory()){mkdirSync(join(dest,name),{recursive:true});copyLicense(source,join(dest,name),rel);}
    else if(e.isFile()){copyFileSync(source,join(dest,name));licenseFiles.push({path:rel,sha256:hash(source)});}
   }
   record={name:pkg.name,version:pkg.version,license:pkg.license || entry.license || null,integrity:entry.integrity || null,locations:[],license_files:licenseFiles};
   packages.set(id,record);
  }
  record.locations.push(join(base,location).replaceAll('\\','/'));
 }
}
const result={format:1,scope:'应用两套npm生产依赖；不包含Node/Linux基础镜像和Open supOS平台',locks,packages:[...packages.values()].sort((a,b)=>(a.name+'@'+a.version).localeCompare(b.name+'@'+b.version))};
writeFileSync(join(output,'runtime.json'),JSON.stringify(result,null,2)+'\n');
const missing=result.packages.filter(p=>!p.license_files.length || !p.license);
console.log(JSON.stringify({packages:result.packages.length,installations:result.packages.reduce((n,p)=>n+p.locations.length,0),missing:missing.map(p=>({name:p.name,version:p.version,license:p.license}))},null,2));
if(missing.length)process.exitCode=1;
