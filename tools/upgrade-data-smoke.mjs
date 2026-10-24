import assert from 'node:assert/strict';
import {readFileSync,writeFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
if(process.env.SPATIAL_TEST_UPGRADE!=='1')throw Error('仅用于隔离升级测试');
let token;
async function call(path,method='GET',body){
 const r=await fetch('http://127.0.0.1:3000'+path,{method,headers:{'Content-Type':'application/json',...(token?{Authorization:'Bearer '+token}:{})},...(body?{body:JSON.stringify(body)}:{})});
 const value=await r.json();assert.ok(r.ok,`${path}: ${r.status} ${value.error||''}`);return value;
}
for(let i=0;i<30;i++){try{await call('/api/auth/status');break;}catch(e){if(i===29)throw e;await new Promise(r=>setTimeout(r,500));}}
const credentials={username:'upgrade_test',password:'Upgrade-test-2026-only',name:'升级隔离验收'};
const seed=process.argv[2]==='seed';
if(seed)await call('/api/auth/bootstrap','POST',credentials);
token=(await call('/api/auth/login','POST',credentials)).token;
const loc=(await call('/api/cells'))[0].loc_code;
const body={name:'升级保留物料',sku:'UPGRADE-TEST',qty:7,loc_code:loc,request_id:'upgrade-original-in'};
const assets=process.env.SPATIAL_TEST_ASSETS==='1',rack=loc.split('-').slice(0,-2).join('-');
if(assets)body.photo='data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aV1kAAAAASUVORK5CYII=';
if(seed)await call('/api/counter/inbound','POST',body);
if(seed&&assets)await call('/api/node/'+rack+'/asset','POST',{data:readFileSync('/test-rack.glb').toString('base64')});
const snapshot=async()=>{
 const result={items:await call('/api/cells/'+loc+'/items'),history:await call('/api/v1/movements'),user:(await call('/api/auth/me')).user};
 if(assets){result.asset=await call('/api/node/'+rack+'/asset');const r=await fetch('http://127.0.0.1:3000'+result.asset.assetUrl,{headers:{Authorization:'Bearer '+token}});assert.ok(r.ok);result.assetHash=createHash('sha256').update(Buffer.from(await r.arrayBuffer())).digest('hex');}
 return result;
};
const file='/data/upgrade-expected.json';
if(seed){writeFileSync(file,JSON.stringify(await snapshot()));console.log('旧版测试数据已写入');}
else{
 const expected=JSON.parse(readFileSync(file,'utf8')),actual=await snapshot();
 assert.deepEqual(actual.items,expected.items);assert.deepEqual(actual.history,expected.history);assert.equal(actual.user.id,expected.user.id);
 if(assets){assert.deepEqual(actual.asset,expected.asset);assert.equal(actual.assetHash,expected.assetHash);assert.ok(JSON.stringify(await call('/api/scene?room='+loc.split('-').slice(0,-3).join('-'))).includes(body.photo),'照片必须可通过场景接口读取');}
 const retry=await call('/api/counter/inbound','POST',body);assert.equal(retry.replayed,true);
 assert.deepEqual((await snapshot()).items,expected.items);assert.deepEqual((await snapshot()).history,expected.history);
 console.log('通过：账号、库存、流水保留，旧请求重试不重复入账');
}
