import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';
import {sendInventory} from './send-inventory.mjs';

test('独立 HTTP 实例：鉴权、CSRF、只读约束与快照到场景闭环', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'spatial-http-test-'));
  const identity = createServer((req, res) => {
    const cookie = req.headers.cookie;
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ data: ['supos_community_token=admin', 'supos_community_token=viewer', 'supos_community_token=spaceAdmin'].includes(cookie)
      ? { sub: cookie, preferredUsername: 'tester', enabled: true, superAdmin: cookie.endsWith('=admin') } : null }));
  });
  identity.listen(0, '127.0.0.1'); await once(identity, 'listening');
  const child = spawn(process.execPath, ['apps/api/server.mjs'], { env: { ...process.env, PORT: '0',
    SPATIAL_DATA_DIR: dir, SPATIAL_UPLOAD_DIR: join(dir, 'uploads'), SPATIAL_MODE: 'integration',
    SPATIAL_AUTH_PROVIDER: 'supos', SPATIAL_SPACE_ADMIN_IDS:'supos_community_token=spaceAdmin', SPATIAL_PUBLIC_ORIGIN: 'http://test.local',
    SUPOS_USERINFO_URL: `http://127.0.0.1:${identity.address().port}/userinfo`,
    SUPOS_MQTT_URL: '', SUPOS_DRYRUN: '', OUTBOUND_BASE_URL: '', DB_DRIVER: 'sqlite' } });
  try {
    // 通过启动日志获取实际端口，避免占用原服务端口。
    const port = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('服务启动超时')), 10000);
      child.stdout.on('data', b => { const m = String(b).match(/running at http:\/\/localhost:(\d+)/); if (m) { clearTimeout(timer); resolve(m[1]); } });
      child.once('exit', code => { clearTimeout(timer); reject(new Error('服务退出 ' + code)); });
    });
    const call = (path, method = 'GET', role, body, origin = 'http://test.local') => fetch(`http://127.0.0.1:${port}${path}`, {
      method, headers: { 'Content-Type': 'application/json', Cookie: role ? 'supos_community_token=' + role : '',
        Origin: origin, 'X-Spatial-Request': '1' }, body: body ? JSON.stringify(body) : undefined });
    // 正常维护请求先读取页面同源的版本；缺版本/旧版本另用原始 call 验证。
    const metaCall = async(path,method,role,body) => {
      const codes=path==='/api/cells/meta'?body.codes:[decodeURIComponent(path.split('/')[3])];
      const revisions={};
      for(const code of codes){
        const room=code.split('-').slice(0,-3).join('-');
        const scene=await(await call('/api/scene?room='+encodeURIComponent(room),'GET','admin')).json();
        const rack=scene.furniture?.find(f=>f.code===code.split('-').slice(0,-2).join('-'));
        revisions[code]=rack?.cellMeta?.[code.split('-').slice(-2).join('-')]?.revision || 'missing';
      }
      return call(path,method,role,path==='/api/cells/meta'?{...body,revisions}:{...body,revision:revisions[codes[0]]});
    };
    assert.equal((await call('/api/integration/source-policy','PUT','viewer',{source:'ERP',expected_interval_minutes:60})).status,403);
    assert.equal((await call('/api/integration/source-policy','PUT','admin',{source:'ERP',expected_interval_minutes:-1})).status,400);
    assert.equal((await call('/api/integration/source-policy','PUT','admin',{source:'ERP',expected_interval_minutes:60})).status,200);
    assert.equal((await call('/api/admin/backup/status','GET','viewer')).status,403);
    const backupStatus=await call('/api/admin/backup/status','GET','admin');
    assert.equal(backupStatus.status,200);
    assert.equal((await backupStatus.json()).enabled,true);
    const inventoryPage=await call('/api/integration/inventory/page','GET','viewer');
    assert.equal(inventoryPage.status,200);assert.equal((await inventoryPage.json()).rows.length,0);
    assert.equal((await call('/api/integration/inventory/page?page_size=201','GET','viewer')).status,400);
    const snap = { source: 'HTTP模拟ERP', version: 1, rows: [{ sku: 'TEST', name: '轴承', qty: 8, loc_code: 'WH-1-A-L01-B01' }] };
    assert.equal((await call('/api/v1/inventory')).status, 401);
    for(const path of ['/API/v1/inventory','/Api/scene','/API/sites'])assert.equal((await call(path)).status,404,path);
    assert.equal((await call('/API/site','POST',undefined,{code:'BYPASS'})).status,404);
    assert.equal((await call('/api/integration/facets')).status,401);
    assert.equal((await call('/api/integration/snapshot', 'POST', 'viewer', snap)).status, 403);
    assert.equal((await call('/api/integration/snapshot', 'POST', 'admin', snap, 'http://other.local')).status, 403);
    assert.equal((await call('/api/integration/snapshot', 'POST', 'admin', snap)).status, 200);
    assert.deepEqual(await (await call('/api/integration/facets','GET','viewer')).json(),{source:[snap.source],status:['可用'],unit:['件']});
    const business={source:snap.source,mode:'events',events:[{event_id:'HTTP-1',type:'inbound',loc_code:snap.rows[0].loc_code,sku:'TEST',name:'轴承',qty:8,occurred_at:'2026-09-16T08:00:00Z'}]};
    assert.equal((await call('/api/integration/snapshot','POST','viewer',business)).status,403);
    assert.equal((await call('/api/integration/snapshot','POST','admin',business)).status,200);
    assert.equal((await call('/api/integration/events?loc_code='+snap.rows[0].loc_code)).status,401);
    const timeline=await(await call('/api/integration/events?loc_code='+snap.rows[0].loc_code,'GET','viewer')).json();
    assert.equal(timeline.total,1);assert.equal(timeline.rows[0].source,snap.source);
    const scene = await (await call('/api/scene', 'GET', 'viewer')).json();
    assert.equal(scene.furniture[0].capacityPerCell,null);
    assert.equal(scene.furniture[0].items['L01-B01'][0].qty, 8);
    const bindingPath='/api/cell/WH-1-A-L01-B02/sku-binding';
    const binding=await(await call(bindingPath,'GET','spaceAdmin')).json();
    const bindingBody={mode:'sku',source:snap.source,sku:snap.rows[0].sku,revision:binding.revision};
    assert.equal((await call(bindingPath,'PUT','viewer',bindingBody)).status,403);
    assert.equal((await call(bindingPath,'PUT','spaceAdmin',bindingBody,'http://other.local')).status,403);
    assert.equal((await call(bindingPath,'PUT','spaceAdmin',bindingBody)).status,200);
    const placed=await(await call('/api/v1/inventory','GET','viewer')).json();
    assert.equal(placed.find(r=>r.sku===bindingBody.sku).loc_code,'WH-1-A-L01-B02');
    assert.equal((await call(bindingPath,'PUT','spaceAdmin',bindingBody)).status,409);
    const bound=await(await call(bindingPath,'GET','spaceAdmin')).json();
    assert.equal((await call(bindingPath,'PUT','spaceAdmin',{mode:'location',revision:bound.revision})).status,200);
    const pendingSnap={source:'PENDING-TEST',version:1,rows:[{placement:'sku',warehouse_code:'WH',sku:'PENDING',name:'待分配测试',qty:3,unit:'件'}]};
    assert.equal((await call('/api/integration/snapshot','POST','admin',pendingSnap)).status,200);
    const pendingPage=()=>call('/api/integration/inventory/page?assignment=unassigned&warehouse=WH','GET','viewer').then(r=>r.json());
    assert.equal((await pendingPage()).total,1);
    const pendingBinding=await(await call(bindingPath,'GET','spaceAdmin')).json();
    assert.equal((await call(bindingPath,'PUT','spaceAdmin',{mode:'sku',source:'PENDING-TEST',sku:'PENDING',revision:pendingBinding.revision})).status,200);
    assert.equal((await pendingPage()).total,0);
    assert.equal((await call(bindingPath,'PUT','spaceAdmin',{mode:'location',revision:pendingBinding.revision+1})).status,200);
    assert.equal((await pendingPage()).rows[0].loc_code,null);
    assert.equal((await call('/api/integration/snapshot','POST','admin',{...pendingSnap,version:2,rows:[]})).status,200);
    const cellPath='/api/cell/WH-1-A-L01-B01/meta';
    assert.equal((await call(cellPath,'PUT','admin',{note:'无版本'})).status,428);
    const stale=scene.furniture[0].cellMeta['L01-B01'].revision;
    assert.equal((await call(cellPath,'PUT','admin',{note:'先保存',revision:stale})).status,200);
    assert.equal((await call(cellPath,'PUT','admin',{note:'旧草稿',revision:stale})).status,409);
    assert.equal((await call('/api/cells/meta','POST','admin',{codes:['WH-1-A-L01-B01'],meta:{note:'无版本'}})).status,428);
    const metadata={name:'轴承格位',label_mode:'name_sku',capacity:100,max_load:200,status:'locked',tags:['重点'],note:'空间属性测试'};
    assert.equal((await metaCall(cellPath,'PUT','viewer',metadata)).status,403);
    assert.equal((await metaCall('/api/cells/meta','POST','viewer',{codes:['WH-1-A-L01-B01'],meta:metadata})).status,403);
    assert.equal((await metaCall(cellPath,'PUT','admin',metadata)).status,200);
    assert.equal((await metaCall(cellPath,'PUT','spaceAdmin',{note:'空间角色'})).status,200);
    assert.equal((await call('/api/integration/credentials','GET','spaceAdmin')).status,403);
    assert.equal((await call('/api/items','POST','spaceAdmin',{name:'不能写库存'})).status,403);
    assert.equal((await metaCall(cellPath,'PUT','admin',metadata)).status,200);
    const png='data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aL1sAAAAASUVORK5CYII=';
    assert.equal((await call('/api/cell/WH-1-A-L01-B01/photo','POST','viewer',{photo:png})).status,403);
    assert.equal((await call('/api/cell/WH-1-A-L01-B01/photo','POST','spaceAdmin',{photo:png})).status,200);
    const photoPath='/api/cell/WH-1-A-L01-B01/photo';
    assert.equal((await call(photoPath,'DELETE','viewer',{index:0,photo:png})).status,403);
    assert.equal((await call(photoPath,'DELETE','spaceAdmin',{index:0,photo:'过期图片'})).status,409);
    assert.equal((await call(photoPath,'DELETE','spaceAdmin',{index:0,photo:png},'http://other.local')).status,403);
    const removedPhoto=await call(photoPath,'DELETE','spaceAdmin',{index:0,photo:png});
    assert.equal(removedPhoto.status,200);assert.deepEqual((await removedPhoto.json()).photos,[]);
    assert.equal((await call(photoPath,'DELETE','spaceAdmin',{index:0,photo:png})).status,409);
    assert.equal((await call(photoPath,'POST','spaceAdmin',{photo:png})).status,200);
    assert.equal((await call('/api/node/WH-1-A/asset','POST','viewer',{data:'AAAA'})).status,403);
    assert.equal((await call('/api/node/WH-1-A/asset','POST','admin',{data:'AAAA'})).status,400);
    const json=JSON.stringify({asset:{version:'2.0'},scenes:[{nodes:[]}],scene:0});
    const chunk=Buffer.from(json.padEnd(Math.ceil(Buffer.byteLength(json)/4)*4,' '));
    const glb=Buffer.alloc(20+chunk.length);glb.write('glTF');glb.writeUInt32LE(2,4);glb.writeUInt32LE(glb.length,8);glb.writeUInt32LE(chunk.length,12);glb.writeUInt32LE(0x4e4f534a,16);chunk.copy(glb,20);
    const uploaded=await call('/api/node/WH-1-A/asset','POST','spaceAdmin',{data:glb.toString('base64')});
    assert.equal(uploaded.status,200);
    const asset=(await uploaded.json()).asset;
    assert.deepEqual(Buffer.from(await(await call(asset.assetUrl,'GET','viewer')).arrayBuffer()),glb);
    assert.equal((await call('/api/node/WH-1-A/asset','DELETE','admin')).status,200);
    const importedRoom=await(await call('/api/rooms','POST','spaceAdmin',{name:'导入测试',w:10,d:8})).json();
    const imported={roomId:importedRoom.id,room:{width:10,depth:8,height:4},replace:true,furniture:[{code:'IMPORT-A',label:'导入货架',x:0,z:0,rot:0,w:2,h:2,d:1,rows:2,cols:3,type:'rack',merges:{L01:[[1,2]]},cellNames:{'L01-B01':'导入格位'}}]};
    assert.equal((await call('/api/layout','POST','viewer',imported)).status,403);
    assert.equal((await call('/api/layout','POST','spaceAdmin',imported)).status,428);
    imported.revision=(await(await call('/api/layout?room='+importedRoom.id,'GET','spaceAdmin')).json()).revision;
    assert.equal((await call('/api/layout','POST','spaceAdmin',imported)).status,200);
    assert.equal((await call('/api/layout','POST','spaceAdmin',imported)).status,409);
    const importResult=await(await call('/api/layout?room='+importedRoom.id,'GET','viewer')).json();
    assert.equal(importResult.furniture.length,1);
    assert.equal(importResult.furniture[0].cellNames['L01-B01'],'导入格位');
    assert.deepEqual(importResult.furniture[0].merges,{L01:[[1,2]]});
    assert.equal((await call('/api/integration/space-history?page=1','GET','admin')).status,200);


    assert.equal((await metaCall(cellPath,'PUT','admin',{capacity:-1})).status,400);
    assert.equal((await metaCall(cellPath,'PUT','admin',{qty:999})).status,400);
    assert.equal((await metaCall('/api/cells/meta','POST','admin',{codes:['WH-1-A-L01-B01','missing'],meta:{note:'不得部分更新'}})).status,400);
    let edited=await (await call('/api/scene','GET','viewer')).json();
    assert.deepEqual((({revision,...meta})=>meta)(edited.furniture[0].cellMeta['L01-B01']),metadata);
    assert.equal(edited.furniture[0].items['L01-B01'][0].qty,8);
    assert.equal((await metaCall('/api/cells/meta','POST','admin',{codes:['WH-1-A-L01-B01','WH-1-A-L01-B02'],meta:{note:'批量备注'}})).status,200);
    assert.equal((await metaCall(cellPath,'PUT','admin',{capacity:null,max_load:null,tags:[],note:''})).status,200);
    edited=await (await call('/api/scene','GET','viewer')).json();
    assert.deepEqual((({revision,...meta})=>meta)(edited.furniture[0].cellMeta['L01-B01']),{name:'轴承格位',label_mode:'name_sku',capacity:null,max_load:null,status:'locked',tags:[],note:''});
    assert.equal(edited.furniture[0].cellMeta['L01-B02'].note,'批量备注');
    const metaHistory=await(await call('/api/integration/space-history','GET','admin')).json();
    assert.equal(metaHistory[0].action,'setCellMeta');
    assert.equal(metaHistory[0].changed_count,1);
    const metaAudit=await(await call('/api/integration/space-history/'+metaHistory[0].id,'GET','admin')).json();
    assert.equal(metaAudit.before[0].capacity,100);
    assert.equal(metaAudit.after[0].capacity,null);


    assert.equal(scene.furniture[0].capacityPerCell,null);
    assert.equal(scene.furniture[0].items['L01-B01'][0].snapshot_version,1);
    assert.ok(!Number.isNaN(Date.parse(scene.furniture[0].items['L01-B01'][0].received_at)));
    assert.equal((await(await call('/api/search?status='+encodeURIComponent('待检'),'GET','viewer')).json()).length,0);
    assert.equal((await(await call('/api/search?unit='+encodeURIComponent('件'),'GET','viewer')).json()).length,1);

    assert.equal((await call('/api/v1/items', 'POST', 'admin', {})).status, 403);
    assert.equal((await call('/data/spatial.db')).status, 404);
    assert.equal((await call('/api/integration/credentials', 'POST', 'viewer', {name:'test',source:snap.source})).status, 403);
    const issued = await call('/api/integration/credentials', 'POST', 'admin', {name:'自动化测试',source:snap.source});
    assert.equal(issued.status, 200);
    const credential = await issued.json();
    const machine = (path, body) => fetch(`http://127.0.0.1:${port}${path}`, { method: body ? 'POST' : 'GET',
      headers: {'Content-Type':'application/json',Authorization:'Bearer '+credential.token}, body:body ? JSON.stringify(body):undefined });
    const delivered=await sendInventory({baseUrl:`http://127.0.0.1:${port}`,token:credential.token,payload:{...snap,version:2}});
    assert.equal(delivered.applied,true);assert.equal(delivered.version,2);
    assert.equal((await machine('/api/integration/snapshot', {...snap,source:'另一ERP',version:3})).status, 403);
    assert.equal((await machine('/api/v1/inventory')).status, 401);
    assert.equal((await machine('/api/integration/credentials')).status, 401);
    assert.equal((await machine('/api/integration/snapshot', {...snap,version:3,rows:[{...snap.rows[0],loc_code:'UNKNOWN'}]})).status, 400);
    assert.equal((await call('/api/integration/history/page','GET','viewer')).status,403);
    assert.equal((await call('/api/integration/history/detail/1','GET','viewer')).status,403);
    assert.equal((await call('/api/integration/history/detail/99999','GET','admin')).status,404);
    assert.equal((await call('/api/integration/history/page?page_size=999','GET','admin')).status,400);
    const page=await (await call('/api/integration/history/page?result=retryable','GET','admin')).json();
    assert.equal(page.total,1);assert.equal(page.rows[0].result,'failed');
    const history=await (await call('/api/integration/history','GET','admin')).json();
    assert.equal(history[0].result,'failed');
    assert.equal(history[1].result,'applied');
    const listed=await (await call('/api/integration/credentials','GET','admin')).json();
    assert.equal(listed.some(t=>'token' in t || 'token_hash' in t),false);
    const mapping={source:snap.source,external_loc_code:'ERP-A-01',loc_code:'WH-1-A-L01-B01'};
    assert.equal((await call('/api/integration/locations','POST','viewer',mapping)).status,403);
    assert.equal((await machine('/api/integration/locations',mapping)).status,401);
    assert.equal((await call('/api/integration/locations','POST','admin',mapping)).status,200);
    const mapped={...snap,version:3,rows:[{sku:'TEST',name:'轴承',qty:15,external_loc_code:'ERP-A-01'}]};
    assert.equal((await machine('/api/integration/snapshot',mapped)).status,200);
    const mappedScene=await(await call('/api/scene','GET','viewer')).json();
    assert.equal(mappedScene.furniture[0].items['L01-B01'][0].external_loc_code,'ERP-A-01');
    const hits=await(await call('/api/search?q=ERP-A-01','GET','viewer')).json();
    assert.equal(hits[0].loc_code,mapping.loc_code);
    const mappings=await(await call('/api/integration/locations','GET','admin')).json();
    assert.equal((await call('/api/integration/locations/'+mappings[0].id,'DELETE','admin')).status,400);
    // 空间配置独立于外部库存；拒绝引用节点的结构性改动，且不产生部分修改。
    const layout=await(await call('/api/layout','GET','admin')).json();
    const rack=layout.furniture.find(f=>f.code==='WH-1-A');
    assert.equal((await call('/api/rack/WH-1-A','PUT','viewer',{x:1})).status,403);
    assert.equal((await call('/api/rack/WH-1-A','PUT','admin',{x:rack.x+0.1})).status,200);
    assert.equal((await call('/api/furniture/WH-1-A','DELETE','admin')).status,409);
    assert.equal((await call('/api/rack/WH-1-A','PUT','admin',{name:'不应保存',rows:1})).status,409);
    assert.equal((await call('/api/rack/WH-1-A/merges','PUT','admin',{merges:{L01:[[1,2]]}})).status,409);
    assert.equal((await call('/api/rooms/'+layout.roomId,'DELETE','admin')).status,409);
    assert.equal((await call('/api/layout','POST','admin',{...layout,replace:true,room:{...layout.room,width:99},furniture:[]})).status,409);
    const unchanged=await(await call('/api/layout','GET','admin')).json();
    assert.equal(unchanged.room.width,layout.room.width);
    assert.equal(unchanged.furniture.find(f=>f.code==='WH-1-A').label,rack.label);
    assert.equal((await call('/api/layout','POST','admin',unchanged)).status,200);
    const cellEdit={merges:{L01:[[1,2]]},names:{'L01-B01':'合并格位'}};
    assert.equal((await call('/api/rack/WH-1-A/cells','PUT','viewer',cellEdit)).status,403);
    assert.equal((await call('/api/rack/WH-1-A/cells','PUT','spaceAdmin',cellEdit)).status,409);
    assert.equal((await call('/api/rack/WH-1-C/cells','PUT','spaceAdmin',cellEdit)).status,200);
    const capacityScene=await(await call('/api/scene','GET','spaceAdmin')).json();
    const capacityRack=capacityScene.furniture.find(f=>f.code==='WH-1-C');
    const capacityEdit={...cellEdit,capacities:{'L01-B01':200},capacityRevision:capacityRack.capacityRevision};
    assert.equal((await call('/api/rack/WH-1-C/cells','PUT','viewer',capacityEdit)).status,403);
    assert.equal((await call('/api/rack/WH-1-C/cells','PUT','spaceAdmin',{...capacityEdit,capacities:{'L01-B01':1.5}})).status,400);
    assert.equal((await call('/api/rack/WH-1-C/cells','PUT','spaceAdmin',capacityEdit)).status,200);
    assert.equal((await call('/api/rack/WH-1-C/cells','PUT','spaceAdmin',capacityEdit)).status,409);
    const capacitySaved=await(await call('/api/scene','GET','spaceAdmin')).json();
    assert.equal(capacitySaved.furniture.find(f=>f.code==='WH-1-C').cellMeta['L01-B01'].capacity,200);
    assert.equal((await call('/api/rack/WH-1-C/cells','PUT','spaceAdmin',{names:{}})).status,400);
    const created=await(await call('/api/rack','POST','admin',{name:'空货架测试',rows:2,cols:2})).json();
    assert.ok(created.furn_code);
    assert.equal((await call('/api/rack/'+created.furn_code,'PUT','admin',{rows:3,cols:3})).status,200);
    const mappingOnly={source:'映射保护测试',external_loc_code:'EMPTY',loc_code:created.furn_code+'-L01-B01'};
    assert.equal((await call('/api/integration/locations','POST','admin',mappingOnly)).status,200);
    assert.equal((await call('/api/rack/'+created.furn_code,'DELETE','admin')).status,409);
    const allMappings=await(await call('/api/integration/locations','GET','admin')).json();
    const emptyMapping=allMappings.find(m=>m.source===mappingOnly.source);
    assert.equal((await call('/api/integration/locations/'+emptyMapping.id,'DELETE','admin')).status,200);
    const editable=await(await call('/api/layout','GET','admin')).json();
    const emptyRack=editable.furniture.find(f=>f.code===created.furn_code); emptyRack.rows=4;
    assert.equal((await call('/api/layout','POST','admin',editable)).status,200);
    const savedLayout=await(await call('/api/layout','GET','admin')).json();
    assert.equal(savedLayout.furniture.find(f=>f.code===created.furn_code).rows,4);
    assert.equal((await call('/api/rack/'+created.furn_code+'/merges','PUT','admin',{merges:{L01:[[1,2]]}})).status,200);
    assert.equal((await call('/api/integration/locations','POST','admin',{...mappingOnly,loc_code:created.furn_code+'-L01-B02'})).status,400);
    assert.equal((await machine('/api/integration/snapshot',{...snap,version:4,rows:[{...snap.rows[0],loc_code:created.furn_code+'-L01-B02'}]})).status,400);
    const preserved=await(await call('/api/v1/inventory','GET','viewer')).json();
    assert.equal(preserved[0].qty,15);
    assert.equal((await call('/api/rack/'+created.furn_code,'DELETE','admin')).status,200);
    const operations=await(await call('/api/integration/space-history','GET','admin')).json();
    assert.ok(operations.length>0);
    assert.equal((await call('/api/integration/space-history','GET','viewer')).status,403);
    assert.equal((await machine('/api/integration/space-history')).status,401);
    const detail=await(await call('/api/integration/space-history/'+operations[0].id,'GET','admin')).json();
    assert.equal(detail.actor_id,'supos:supos_community_token=admin');
    assert.ok(detail.before.length>0);
    const delta={mode:'delta',source:snap.source,message_id:'http-1',base_version:3,version:4,changes:[{op:'upsert',...mapped.rows[0],qty:12}]};
    assert.equal((await machine('/api/integration/snapshot',delta)).status,200);
    assert.equal((await(await machine('/api/integration/snapshot',delta)).json()).replayed,true);
    assert.equal((await machine('/api/integration/snapshot',{...delta,message_id:'http-stale'})).status,409);
    const failures=await(await call('/api/integration/history','GET','admin')).json();
    const retryPath='/api/integration/retry/'+failures[0].id;
    assert.equal((await call(retryPath,'POST','viewer',{})).status,403);
    assert.equal((await machine(retryPath,{})).status,401);
    assert.equal((await call(retryPath,'POST','admin',{})).status,409);
    const check={mode:'reconcile',source:snap.source,version:4,rows:[{...mapped.rows[0],qty:12}]};
    assert.equal((await(await machine('/api/integration/snapshot',check)).json()).matched,true);
    assert.equal((await machine('/api/integration/snapshot',{...check,source:'其他来源'})).status,403);
    // 地面区复用标准LOC契约：不同排库存可查可定位，引用保护与货架一致。
    const floorResponse=await call('/api/rack','POST','admin',{name:'地面区联调',type:'floor',rows:4,cols:3,geom:{w:6,d:4}});
    assert.equal(floorResponse.status,201);
    const floor=await floorResponse.json();
    assert.match(floor.furn_code,/-F[0-9]+$/);
    const floorLoc=floor.furn_code+'-L04-B03';
    const floorSource='地面区模拟ERP';
    assert.equal((await call('/api/integration/locations','POST','admin',{
      source:floorSource,external_loc_code:'GROUND-12',loc_code:floorLoc
    })).status,200);
    assert.equal((await call('/api/integration/snapshot','POST','admin',{
      source:floorSource,version:1,rows:[{sku:'PALLET-01',name:'托盘料',qty:7,unit:'托',batch_no:'GROUND-BATCH',status:'待检',external_loc_code:'GROUND-12'}]
    })).status,200);
    const floorScene=await(await call('/api/scene','GET','viewer')).json();
    const floorSpec=floorScene.furniture.find(f=>f.code===floor.furn_code);
    assert.equal(floorSpec.type,'floor');
    assert.equal(floorSpec.height,0.05);
    assert.equal(floorSpec.rows,4);
    assert.equal(floorSpec.items['L04-B03'][0].qty,7);
    assert.equal(floorSpec.items['L04-B03'][0].unit,'托');
    const floorHits=await(await call('/api/search?'+new URLSearchParams({q:'PALLET-01',source:floorSource,status:'待检',unit:'托',batch_no:'GROUND-BATCH'}),'GET','viewer')).json();
    assert.equal(floorHits.length,1);
    assert.equal(floorHits[0].loc_code,floorLoc);
    assert.equal((await call('/api/rack/'+floor.furn_code,'PUT','admin',{rows:2})).status,409);
    assert.equal((await call('/api/rack/'+floor.furn_code,'DELETE','admin')).status,409);
    assert.equal((await call('/api/rack/'+floor.furn_code,'PUT','viewer',{x:1})).status,403);
    // 按真实空间父子关系授权，校验读取、导出、模型、默认目标和批量写入。
    const site2=await(await call('/api/site','POST','admin',{code:'TEST2',name:'隔离仓库'})).json();
    const room2=(await(await call('/api/rooms?site=TEST2','GET','admin')).json())[0];
    const rack2=await(await call('/api/rack','POST','admin',{roomCode:room2.loc_code,name:'隔离架',rows:1,cols:1,geom:{w:2,d:1,h:2}})).json();
    const loc2=rack2.furn_code+'-L01-B01';
    assert.equal((await call('/api/integration/snapshot','POST','admin',{source:'隔离ERP',version:1,rows:[{sku:'SECRET',name:'隔离库存',qty:1,loc_code:loc2}]})).status,200);
    const grant=async(role,sites)=>call('/api/integration/warehouse-access','PUT','admin',{user_id:'supos:supos_community_token='+role,sites});
    assert.equal((await call('/api/integration/warehouse-access','PUT','viewer',{user_id:'supos:x',sites:['WH']})).status,403);
    assert.equal((await grant('viewer',['不存在'])).status,400);
    assert.equal((await grant('viewer',['TEST2'])).status,200);
    assert.equal((await grant('spaceAdmin',['TEST2'])).status,200);
    const ownScene=await(await call('/api/scene','GET','viewer')).json();assert.equal(ownScene.roomCode,room2.loc_code);
    for(const path of ['/api/scene?room=WH-1','/api/layout?room=WH-1','/api/rooms?site=WH','/api/cells/WH-1-A-L01-B01/items','/api/integration/events?loc_code=WH-1-A-L01-B01','/api/node/WH-1-A/asset','/api/items/by-code?code=TEST','/api/aliases'])assert.equal((await call(path,'GET','viewer')).status,403,path);
    for(const path of ['/api/v1/inventory','/api/v1/items','/api/search']){
      const rows=await(await call(path,'GET','viewer')).json();assert.equal(rows.length,1);assert.equal(rows[0].loc_code,loc2);
    }
    assert.equal((await(await call('/api/integration/inventory/page','GET','viewer')).json()).total,1);
    assert.deepEqual((await(await call('/api/integration/facets','GET','viewer')).json()).source,['隔离ERP']);
    assert.deepEqual((await(await call('/api/sites','GET','viewer')).json()).map(s=>s.loc_code),['TEST2']);
    for(const path of ['/api/rooms','/api/cells'])assert.ok((await(await call(path,'GET','viewer')).json()).every(n=>n.loc_code.startsWith('TEST2-')));
    for(const path of ['/api/locations/tree','/api/v1/locations/tree'])assert.deepEqual((await(await call(path,'GET','viewer')).json()).map(n=>n.loc_code),['TEST2']);
    assert.equal((await metaCall('/api/cell/'+loc2+'/meta','PUT','spaceAdmin',{note:'允许修改'})).status,200);
    assert.equal((await metaCall('/api/cells/meta','POST','spaceAdmin',{codes:[loc2,'WH-1-A-L01-B01'],meta:{note:'不得部分写入'}})).status,403);
    const afterBatch=await(await call('/api/scene','GET','viewer')).json();assert.equal(afterBatch.furniture[0].cellMeta['L01-B01'].note,'允许修改');
    for(const [path,method,body] of [['/api/site','POST',{name:'不能新增仓库'}],['/api/rack/WH-1-A','PUT',{name:'禁止'}],['/api/room','POST',{id:'WH-1',name:'禁止'}],['/api/rooms','POST',{siteCode:'WH'}],['/api/rack','POST',{roomCode:'WH-1'}],['/api/layout','POST',{roomId:'WH-1',furniture:[]}],['/api/rack/WH-1-A/clone','POST',{positions:[]}],['/api/rooms/WH-1','DELETE',{}]])assert.equal((await call(path,method,'spaceAdmin',body)).status,403,path);
    assert.equal((await call('/api/rack/WH-1-C/cells','PUT','spaceAdmin',cellEdit)).status,403);
    assert.equal((await call(photoPath,'DELETE','spaceAdmin',{index:0,photo:png})).status,403);
    const defaultRoom=await(await call('/api/rooms','POST','spaceAdmin',{name:'范围内新库区'})).json();assert.match(defaultRoom.loc_code,/^TEST2-/);
    const secretAsset=await(await call('/api/node/'+rack2.furn_code+'/asset','POST','spaceAdmin',{data:glb.toString('base64')})).json();
    assert.equal((await call(secretAsset.asset.assetUrl,'GET','viewer')).status,200);
    await grant('viewer',['WH']);assert.equal((await call(secretAsset.asset.assetUrl,'GET','viewer')).status,403);
    await grant('viewer',[]);assert.deepEqual(await(await call('/api/sites','GET','viewer')).json(),[]);assert.equal((await call('/api/scene','GET','viewer')).status,403);
    await grant('admin',[]);assert.equal((await call('/api/scene?room=WH-1','GET','admin')).status,200);
    assert.equal((await call('/api/integration/warehouse-access/'+encodeURIComponent('supos:supos_community_token=viewer'),'DELETE','admin')).status,200);
    assert.equal((await call('/api/scene?room=WH-1','GET','viewer')).status,200);
    assert.equal((await call('/api/integration/credentials/'+credential.id,'DELETE','admin')).status,200);
    assert.equal((await machine('/api/integration/snapshot', {...snap,version:3})).status,401);

    assert.equal((await call('/api/integration/access-users','GET','viewer')).status,403);
    const directory=await(await call('/api/integration/access-users','GET','admin')).json();
    assert.ok(directory.some(user=>user.id==='supos:supos_community_token=viewer'));
    const setAccess=(target,role)=>call('/api/integration/warehouse-access','PUT','admin',{user_id:'supos:supos_community_token='+target,sites:['TEST2'],role});
    assert.equal((await setAccess('viewer','admin')).status,400);
    assert.equal((await setAccess('unknown','spaceAdmin')).status,400);
    assert.equal((await setAccess('admin','viewer')).status,400);
    assert.equal((await setAccess('viewer','spaceAdmin')).status,200);
    assert.equal((await(await call('/api/auth/me','GET','viewer')).json()).user.role,'spaceAdmin');
    assert.equal((await metaCall('/api/cell/'+loc2+'/meta','PUT','viewer',{note:'授予空间维护后可写'})).status,200);
    assert.equal((await call('/api/integration/credentials','GET','viewer')).status,403);
    assert.equal((await metaCall('/api/cell/WH-1-A-L01-B01/meta','PUT','viewer',{note:'仍不可跨库'})).status,403);
    assert.equal((await setAccess('viewer','viewer')).status,200);
    assert.equal((await metaCall('/api/cell/'+loc2+'/meta','PUT','viewer',{note:'撤回后不可写'})).status,403);
    assert.equal((await setAccess('spaceAdmin','viewer')).status,200);
    assert.equal((await(await call('/api/auth/me','GET','spaceAdmin')).json()).user.role,'viewer');
    assert.equal((await setAccess('spaceAdmin',null)).status,200);
    assert.equal((await(await call('/api/auth/me','GET','spaceAdmin')).json()).user.role,'spaceAdmin');
  } finally {
    child.kill(); await once(child, 'exit');
    identity.close();
    rmSync(dir, { recursive: true, force: true }); // 仅删除本测试 mkdtemp 创建的目录。
  }
});
