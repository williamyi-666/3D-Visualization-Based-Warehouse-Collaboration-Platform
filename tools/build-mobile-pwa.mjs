import {readFileSync,writeFileSync,existsSync,statSync} from 'node:fs';
import {resolve,relative,dirname,extname} from 'node:path';
import {fileURLToPath} from 'node:url';
import {createHash} from 'node:crypto';
const root=resolve(dirname(fileURLToPath(import.meta.url)),'..'),base=resolve(root,'apps/web/prototype'),files=new Set();
function visit(file){
  file=resolve(file);if(files.has(file))return;
  if(!file.startsWith(root+'/')&&!file.startsWith(root+'\\'))throw Error('资源超出项目范围');
  if(!existsSync(file))throw Error('缺少离线资源：'+relative(root,file));if(!statSync(file).isFile())return;files.add(file);
  if(!['.mjs','.js','.html','.css','.webmanifest'].includes(extname(file)))return;
  const text=readFileSync(file,'utf8'),refs=[];
  if(['.mjs','.js'].includes(extname(file))){
    for(const hit of text.matchAll(/(?:\bfrom\s*|\bimport\s*\(?\s*|new URL\(\s*)['"]([^'"]+)['"]/g))refs.push(hit[1]);
    for(const hit of text.matchAll(/\bhref\s*=\s*['"](\.\/[^'"]+\.(?:css|js))['"]/g))refs.push(hit[1]);
  }
  if(extname(file)==='.html')for(const hit of text.matchAll(/(?:src|href)="([^"]+)"/g))refs.push(hit[1]);
  for(let ref of refs){
    ref=ref.split('#')[0];
    if(ref.endsWith('/mobile-sw.js'))continue;
    if(ref==='three')ref=relative(dirname(file),resolve(base,'vendor/three.module.js'));
    else if(ref.startsWith('three/addons/'))ref=relative(dirname(file),resolve(base,'vendor/jsm',ref.slice(13)));
    else if(!ref.startsWith('.'))continue;
    // runtime.js由服务端生成，只缓存公开运行配置，不把任何API放入静态缓存。
    if(ref==='../../../runtime.js')continue;
    // 电脑端、管理页和写实上传文件继续在线读取，不扩展离线页面范围。
    if(/\.html(?:\?|$)/.test(ref))continue;
    visit(resolve(dirname(file),ref.split('?')[0]));
  }
}
visit(resolve(base,'mobile.html'));
for(const name of ['mobile-icon-192.png','mobile-icon-512.png','assistant-document.css','assistant.css','warehouse-work.css','stocktake.css','mobile.css'])if(existsSync(resolve(base,name)))visit(resolve(base,name));
const ordered=[...files].sort(),version=createHash('sha256');
version.update(readFileSync(fileURLToPath(import.meta.url)));
for(const file of ordered)version.update(relative(root,file)).update(readFileSync(file));
const urls=ordered.map(file=>relative(base,file).replaceAll('\\','/'));
// 仅白名单静态资源；API、认证、图片上传和全部写入请求均直接交给网络。
const source=`// 由 tools/build-mobile-pwa.mjs 根据手机入口的依赖生成。\nconst VERSION=${JSON.stringify(version.digest('hex').slice(0,16))};\nconst ASSETS=${JSON.stringify(urls)};\nconst ROOT=new URL('./',self.location.href);\nconst PREFIX='spatial-mobile-static:'+ROOT.pathname+':';\nconst CACHE=PREFIX+VERSION;\nconst ALLOWED=new Set(ASSETS.map(path=>new URL(path,ROOT).href));\nconst MOBILE=new URL('mobile.html',ROOT).href;\nconst RUNTIME=new URL('../../../runtime.js',ROOT).href;\nALLOWED.add(RUNTIME);\nself.addEventListener('install',event=>event.waitUntil((async()=>{const cache=await caches.open(CACHE);for(const url of ALLOWED){const response=await fetch(url,{cache:'reload'});if(!response.ok||response.redirected)throw Error('离线资源未就绪');await cache.put(url,response);}})()));\nself.addEventListener('activate',event=>event.waitUntil((async()=>{for(const key of await caches.keys())if(key.startsWith(PREFIX)&&key!==CACHE)await caches.delete(key);await self.clients.claim();})()));\nself.addEventListener('fetch',event=>{const request=event.request,url=new URL(request.url);if(request.method!=='GET'||url.origin!==ROOT.origin)return;const plain=url.origin+url.pathname;if(plain!==MOBILE&&!ALLOWED.has(request.url))return;event.respondWith((async()=>{const cache=await caches.open(CACHE);if(plain===RUNTIME){try{const response=await fetch(request);if(response.ok&&!response.redirected)await cache.put(RUNTIME,response.clone());return response;}catch(error){const saved=await cache.match(RUNTIME);if(saved)return saved;throw error;}}return await cache.match(plain===MOBILE?MOBILE:request.url)||fetch(request);})());});\n`;
writeFileSync(resolve(base,'mobile-sw.js'),source);
console.log(JSON.stringify({resources:urls.length,version:source.match(/VERSION="([^"]+)/)[1]}));
