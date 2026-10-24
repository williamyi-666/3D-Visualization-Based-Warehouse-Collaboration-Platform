import test from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import {mkdtempSync,realpathSync,rmSync,readFileSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,relative,isAbsolute} from 'node:path';
import vm from 'node:vm';
import {webcrypto} from 'node:crypto';

test('平台Cookie与独立库存组合：数量守恒、流水、只读与来源校验',async()=>{
  const root=realpathSync(tmpdir()),dir=mkdtempSync(join(root,'warehouse-standalone-http-'));
  const identity=createServer((req,res)=>{
    const role=req.headers.cookie?.split('=')[1];
    res.setHeader('Content-Type','application/json');
    res.end(JSON.stringify({data:['admin','viewer'].includes(role)?{sub:role,preferredUsername:role,enabled:true,superAdmin:role==='admin'}:null}));
  });
  identity.listen(0,'127.0.0.1');await once(identity,'listening');
  const child=spawn(process.execPath,['apps/api/server.mjs'],{env:{...process.env,PORT:'0',SPATIAL_DATA_DIR:dir,SPATIAL_UPLOAD_DIR:join(dir,'uploads'),SPATIAL_MODE:'standalone',SPATIAL_AUTH_PROVIDER:'supos',SPATIAL_BASE_PATH:'/warehouse',SPATIAL_PUBLIC_ORIGIN:'http://test.local',SUPOS_USERINFO_URL:`http://127.0.0.1:${identity.address().port}`,SUPOS_MQTT_URL:'',SUPOS_WAREHOUSE_SITE:'',SUPOS_UNS_EVENT_ALIAS:'',OUTBOUND_BASE_URL:'',DB_DRIVER:'sqlite'}});
  try {
    const port=await new Promise((resolve,reject)=>{
      const timer=setTimeout(()=>reject(Error('启动超时')),15000);
      child.stdout.on('data',b=>{const m=String(b).match(/running at http:\/\/localhost:(\d+)/);if(m){clearTimeout(timer);resolve(m[1]);}});
      child.once('exit',code=>{clearTimeout(timer);reject(Error('服务退出 '+code));});
    });
    const call=(path,method='GET',body,role='admin',origin='http://test.local')=>fetch(`http://127.0.0.1:${port}${path}`,{method,headers:{Cookie:role?'supos_community_token='+role:'',Origin:origin,'X-Spatial-Request':'1','Content-Type':'application/json'},...(body?{body:JSON.stringify(body)}:{})});
    const read=async path=>{const r=await call(path);assert.equal(r.status,200);return r.json();};
    assert.equal((await read('/api/auth/status')).mode,'standalone');
    assert.equal((await read('/api/access/status')).warehouseSync.state,'disabled');
    assert.equal((await read('/api/auth/me')).user.provider,'supos');
    assert.match(await(await call('/runtime.js')).text(),/"mode":"standalone"/);
    assert.equal((await call('/api/cells','GET',null,'')).status,401);
    const cells=await read('/api/cells'),from=cells[0].loc_code,to=cells[1].loc_code;
    const body={name:'HTTP测试物料',sku:'HTTP-COUNTER',qty:10,loc_code:from};
    assert.equal((await call('/api/counter/inbound','POST',body,'viewer')).status,403);
    assert.equal((await call('/api/counter/inbound','POST',body,'admin','http://other.local')).status,403);
    const added=await call('/api/counter/inbound','POST',body);assert.equal(added.status,201);
    const item=(await added.json()).item_id;
    assert.equal((await call('/api/counter/outbound','POST',{loc_code:from,item_id:item,qty:0})).status,400);
    const out=await call('/api/counter/outbound','POST',{loc_code:from,item_id:item,qty:2});assert.equal(out.status,200);
    const move=await call('/api/counter/move','POST',{from_loc:from,to_loc:to,item_id:item,qty:3});assert.equal(move.status,200);
    const result=await move.json();assert.equal(result.from_remain,5);assert.equal(result.to_total,3);
    const rows=(await read('/api/v1/movements')).movements.filter(m=>m.item_id===item);
    assert.equal(rows.length,3);
    assert.deepEqual(rows.map(m=>m.move_type),['inbound','outbound','move']);
    assert.equal((await read('/api/cells/'+to+'/items')).find(i=>i.item_id===item).qty,3);
    // 同时扣减不能透支；同一请求同时重试只记一笔。
    const concurrentBody={name:'并发校验',sku:'CONCURRENT',qty:5,loc_code:from,request_id:'concurrent-in'};
    const inboundResults=await Promise.all(Array.from({length:5},()=>call('/api/counter/inbound','POST',concurrentBody)));
    const receipts=await Promise.all(inboundResults.map(r=>r.json()));
    assert.equal(receipts.filter(r=>r.replayed).length,4);
    const concurrentItem=receipts[0].item_id;
    const withdrawals=await Promise.all(Array.from({length:4},(_,i)=>call('/api/counter/outbound','POST',{loc_code:from,item_id:concurrentItem,qty:2,request_id:'concurrent-out-'+i})));
    assert.equal(withdrawals.filter(r=>r.status===200).length,2);
    assert.equal(withdrawals.filter(r=>r.status===400).length,2);
    assert.equal((await read('/api/cells/'+from+'/items')).find(i=>i.item_id===concurrentItem).qty,1);
    assert.equal((await read('/api/v1/movements')).movements.filter(m=>m.item_id===concurrentItem).length,3);
    // 多个真实HTTP请求同时确认同一张有差异盘点单，只能调账一次。
    let concurrentCount=await(await call('/api/stocktakes','POST',{loc_code:from})).json();
    const savedCount=await call('/api/stocktakes/'+concurrentCount.id,'PUT',{
      revision:concurrentCount.revision,
      counts:concurrentCount.baseline.map(row=>({item_id:row.item_id,qty:row.qty+(row.item_id===concurrentItem?2:0)})),
      reason:'并发确认HTTP验收'
    });
    assert.equal(savedCount.status,200);concurrentCount=await savedCount.json();
    const finishPath='/api/stocktakes/'+concurrentCount.id+'/finish';
    const finishBody={action:'confirm',revision:concurrentCount.revision};
    const confirmations=await Promise.all(Array.from({length:5},()=>call(finishPath,'POST',finishBody)));
    assert.ok(confirmations.every(r=>r.status===200));
    const confirmed=await Promise.all(confirmations.map(r=>r.json()));
    assert.equal(confirmed.filter(r=>r.replayed).length,4);
    assert.ok(confirmed.every(r=>r.state==='review'));
    assert.equal((await read('/api/cells/'+from+'/items')).find(i=>i.item_id===concurrentItem).qty,1);
    const approvals=await Promise.all(Array.from({length:5},()=>call(finishPath,'POST',{action:'approve',revision:confirmed[0].revision})));
    assert.ok(approvals.every(r=>r.status===200));const approved=await Promise.all(approvals.map(r=>r.json()));
    assert.ok(approved.every(r=>r.state==='confirmed'));assert.equal(approved.filter(r=>r.replayed).length,4);
    assert.equal((await read('/api/cells/'+from+'/items')).find(i=>i.item_id===concurrentItem).qty,3);
    const countHistory=(await read('/api/v1/movements')).movements.filter(m=>m.item_id===concurrentItem);
    assert.equal(countHistory.length,4);assert.equal(countHistory.filter(m=>m.move_type==='stocktake').length,1);
    // 另一张有差异单首次确认后丢弃响应，再读取原单并重试。
    let lostCount=await(await call('/api/stocktakes','POST',{loc_code:from})).json();
    lostCount=await(await call('/api/stocktakes/'+lostCount.id,'PUT',{
      revision:lostCount.revision,reason:'响应丢失HTTP验收',
      counts:lostCount.baseline.map(row=>({item_id:row.item_id,qty:row.qty-(row.item_id===concurrentItem?1:0)}))
    })).json();
    const lostPath='/api/stocktakes/'+lostCount.id+'/finish';
    lostCount=await(await call(lostPath,'POST',{action:'confirm',revision:lostCount.revision})).json();assert.equal(lostCount.state,'review');
    const lostBody={action:'approve',revision:lostCount.revision};
    const dropped=await call(lostPath,'POST',lostBody);assert.equal(dropped.status,200);await dropped.arrayBuffer();
    assert.equal((await read('/api/stocktakes/'+lostCount.id)).state,'confirmed');
    const afterLost=await read('/api/v1/movements');
    assert.equal(afterLost.movements.filter(m=>m.item_id===concurrentItem).length,5);
    assert.equal((await read('/api/cells/'+from+'/items')).find(i=>i.item_id===concurrentItem).qty,2);
    const retryCount=await call(lostPath,'POST',lostBody);assert.equal(retryCount.status,200);
    assert.equal((await retryCount.json()).replayed,true);
    assert.deepEqual(await read('/api/v1/movements'),afterLost);
    assert.equal((await read('/api/cells/'+from+'/items')).find(i=>i.item_id===concurrentItem).qty,2);
    const importRows=[{name:'HTTP导入单位',sku:'HTTP-IMPORT',qty:0.5,unit:'kg',loc_code:from}];
    const previewResponse=await call('/api/import','POST',{rows:importRows,preview:true});
    assert.equal(previewResponse.status,200);assert.equal((await previewResponse.json()).rows[0].unit,'kg');
    assert.ok(!(await read('/api/cells/'+from+'/items')).some(row=>row.sku==='HTTP-IMPORT'));
    const importResponse=await call('/api/import','POST',{rows:importRows,request_id:'http-import'});
    assert.equal(importResponse.status,201);assert.equal((await importResponse.json()).imported,1);
    const importRetry=await call('/api/import','POST',{rows:importRows,request_id:'http-import'});
    assert.equal((await importRetry.json()).replayed,true);
    assert.equal((await read('/api/cells/'+from+'/items')).find(row=>row.sku==='HTTP-IMPORT').qty,0.5);
    // 将真实HTTP成功响应丢弃，再重建前端环境；恢复必须复用原请求且不重复入账。
    const writeSource=readFileSync('apps/web/prototype/counter-write.js','utf8');
    async function lostResponseRecovery(path,body){
      const storage=new Map();
      const front=(drop,role='admin')=>{
        const window={SPATIAL_RUNTIME:{basePath:'/warehouse'},localStorage:{getItem:k=>storage.get(k),setItem:(k,v)=>storage.set(k,v)},
          fetch:async(url,init={})=>{
            const response=await call(url,init.method||'GET',init.body?JSON.parse(init.body):undefined,role);
            if(drop&&url===path){assert.ok(response.ok,await response.clone().text());await response.text();throw Error('测试：服务端提交后响应丢失');}
            return response;
          }};
        const context=vm.createContext({window,crypto:webcrypto});
        vm.runInContext(readFileSync('apps/web/prototype/random-id.js','utf8'),context);
        vm.runInContext(writeSource,context);return window;
      };
      await assert.rejects(front(true).fetch(path,{method:'POST',body:JSON.stringify(body)}),/响应丢失/);
      const stockBefore=await read('/api/v1/inventory');
      const historyBefore=await read('/api/v1/movements?limit=500');
      await assert.rejects(front(false,'').CounterWrites.list(),/请先登录/);
      assert.equal((await front(false,'viewer').CounterWrites.list()).length,0);
      const restored=front(false),pending=await restored.CounterWrites.list();
      assert.equal(pending.length,1);assert.equal(pending[0].path,path);
      const response=await restored.CounterWrites.retry(path);
      assert.ok(response.ok);assert.equal((await response.json()).replayed,true);
      assert.equal((await restored.CounterWrites.list()).length,0);
      assert.deepEqual(await read('/api/v1/inventory'),stockBefore);
      assert.deepEqual(await read('/api/v1/movements?limit=500'),historyBefore);
    }
    await lostResponseRecovery('/api/items',{name:'恢复普通录入',sku:'RECOVER-ITEM',unit:'kg',qty:0.25,loc_code:from});
    await lostResponseRecovery('/api/import',{rows:[{name:'恢复导入',sku:'RECOVER-IMPORT',unit:'kg',qty:0.5,loc_code:from}]});
    await lostResponseRecovery('/api/counter/inbound',{name:'恢复入库',sku:'RECOVER-IN',unit:'kg',qty:2,loc_code:from});
    const recoveredItem=(await read('/api/cells/'+from+'/items')).find(r=>r.sku==='RECOVER-IN').item_id;
    await lostResponseRecovery('/api/counter/outbound',{loc_code:from,item_id:recoveredItem,qty:0.5});
    await lostResponseRecovery('/api/counter/move',{from_loc:from,to_loc:to,item_id:recoveredItem,qty:0.5});
    assert.equal((await read('/api/cells/'+from+'/items')).find(r=>r.item_id===recoveredItem).qty,1);
    assert.equal((await read('/api/cells/'+to+'/items')).find(r=>r.item_id===recoveredItem).qty,0.5);
    // 第二仓库用于验证跨仓操作与查询隔离，全部数据位于本测试临时目录。
    assert.equal((await call('/api/site','POST',{code:'OTHER',name:'另一仓库'})).status,201);
    const otherRoom=(await read('/api/rooms?site=OTHER'))[0];
    const rackResponse=await call('/api/rack','POST',{roomCode:otherRoom.loc_code,name:'隔离架',rows:1,cols:1});
    assert.equal(rackResponse.status,201);
    const other=(await rackResponse.json()).furn_code+'-L01-B01';
    await call('/api/counter/inbound','POST',{name:'不可见物料',sku:'SECRET',qty:5,loc_code:other});
    const grant=async role=>{const r=await call('/api/integration/warehouse-access','PUT',{user_id:'supos:viewer',sites:['WH'],role});assert.equal(r.status,200);};
    await grant('operator');
    for(const endpoint of ['events','revision'])assert.equal((await call('/api/scene/'+endpoint+'?room='+otherRoom.loc_code,'GET',null,'viewer')).status,403);
    assert.equal((await call('/api/scene/revision','GET',null,'')).status,401);
    assert.equal((await call('/api/scene/revision?room=WH-1','GET',null,'viewer')).status,200);
    assert.equal((await(await call('/api/auth/me','GET',null,'viewer')).json()).user.role,'operator');
    const scopedRows=[{name:'授权短码导入',sku:'SCOPED-IMPORT',qty:1,loc:'L01-B01',rack:from.replace(/-L\d+-B\d+$/,'')}];
    const scopedPreview=await call('/api/import','POST',{rows:scopedRows,preview:true},'viewer');
    assert.equal(scopedPreview.status,200);assert.equal((await scopedPreview.json()).rows[0].loc_code,from);
    assert.equal((await call('/api/import','POST',{rows:scopedRows,request_id:'scoped-short-import'},'viewer')).status,201);
    assert.equal((await(await call('/api/import','POST',{rows:scopedRows,request_id:'scoped-short-import'},'viewer')).json()).replayed,true);
    assert.equal((await call('/api/import','POST',{rows:[{...scopedRows[0],loc:other}]},'viewer')).status,403);
    const ambiguous=await call('/api/import','POST',{rows:[{...scopedRows[0],rack:'',loc:'L01-B01'}],preview:true},'viewer');
    assert.equal(ambiguous.status,400);assert.ok(!JSON.stringify(await ambiguous.json()).includes('OTHER'));
    const nonCell=await(await call('/api/import','POST',{rows:[{...scopedRows[0],loc:'WH'}],preview:true})).json();
    assert.equal(nonCell.imported,0);assert.equal(nonCell.errors.length,1);
    const countResponse=await call('/api/stocktakes','POST',{loc_code:from},'viewer');
    assert.equal(countResponse.status,201);const countRecord=await countResponse.json();
    assert.equal((await call('/api/stocktakes','POST',{loc_code:other},'viewer')).status,403);
    assert.equal((await call('/api/stocktakes?loc_code='+other,'GET',null,'viewer')).status,403);
    const otherCount=await(await call('/api/stocktakes','POST',{loc_code:other})).json();
    assert.equal((await call('/api/stocktakes/'+otherCount.id,'GET',null,'viewer')).status,403);
    const pageResponse=await call('/api/stocktakes?loc_code='+from+'&limit=1','GET',null,'viewer');
    assert.equal(pageResponse.status,200);
    const countPage=await pageResponse.json();
    assert.equal(countPage.records.length,1);assert.equal(countPage.records[0].id,countRecord.id);
    assert.equal(countPage.has_draft,true);assert.equal(countPage.next_before,countRecord.id);
    assert.equal((await call('/api/stocktakes?loc_code='+other+'&limit=20','GET',null,'viewer')).status,403);
    assert.equal((await call('/api/stocktakes?loc_code='+from+'&limit=20&before='+otherCount.id,'GET',null,'viewer')).status,400);
    assert.equal((await call('/api/stocktakes?loc_code='+from+'&limit=0','GET',null,'viewer')).status,400);
    assert.equal((await call('/api/stocktakes/'+otherCount.id+'/finish','POST',{action:'cancel',revision:otherCount.revision},'viewer')).status,403);
    assert.equal((await call('/api/stocktakes/'+countRecord.id+'/finish','POST',{action:'cancel',revision:countRecord.revision},'viewer')).status,200);
    assert.equal((await call('/api/counter/inbound','POST',{...body,qty:1},'viewer')).status,201);
    assert.equal((await call('/api/counter/inbound','POST',{...body,loc_code:other},'viewer')).status,403);
    assert.equal((await call('/api/counter/move','POST',{item_id:item,from_loc:from,to_loc:other,qty:1},'viewer')).status,403);
    assert.equal((await call('/api/counter/move','POST',{item_id:item,from_loc:other,to_loc:from,qty:1},'viewer')).status,403);
    assert.equal((await call('/api/rack','POST',{roomCode:otherRoom.loc_code},'viewer')).status,403);
    assert.equal((await call('/api/rack','POST',{name:'不能改空间'},'viewer')).status,403);
    for(const path of ['/api/v1/inventory','/api/search?q=不可见','/api/v1/items']) {
      const response=await call(path,'GET',null,'viewer');assert.equal(response.status,200);
      assert.ok(!JSON.stringify(await response.json()).includes('不可见物料'));
    }
    assert.equal((await call('/api/items/by-code?code=SECRET','GET',null,'viewer')).status,404);
    assert.equal((await call('/api/cell/'+other+'/history','GET',null,'viewer')).status,403);
    const history=await(await call('/api/v1/movements','GET',null,'viewer')).json();
    assert.ok(!JSON.stringify(history).includes('不可见物料'));
    await grant('spaceAdmin');
    assert.equal((await call('/api/stocktakes','POST',{loc_code:from},'viewer')).status,403);
    assert.equal((await call('/api/counter/inbound','POST',body,'viewer')).status,403);
    const status=await(await call('/api/access/status','GET',null,'viewer')).json();
    assert.equal(status.canManage,true);assert.equal(status.canOperate,false);
    assert.equal(status.warehouseSync,null); // 不在授权仓库范围的同步状态不暴露。
    await grant('viewer');
    assert.equal((await call('/api/counter/inbound','POST',body,'viewer')).status,403);
    // 串联真实权限接口与页面导出函数，检查生成内容；不替代浏览器下载验收。
    const exportSource=readFileSync('apps/web/prototype/app.js','utf8');
    const exportFunction=exportSource.slice(exportSource.indexOf('function csvCell('),exportSource.indexOf('const exportBtn ='));
    const sheetContext={};
    vm.runInNewContext(readFileSync('apps/web/prototype/vendor/xlsx.full.min.js','utf8'),sheetContext);
    const XLSX=sheetContext.XLSX;
    const permitted=await(await call('/api/v1/inventory','GET',null,'viewer')).json();
    const permittedItems=await(await call('/api/v1/items','GET',null,'viewer')).json();
    assert.ok(permitted.length>0);
    assert.ok((await read('/api/v1/inventory')).some(row=>row.name==='不可见物料'));
    for(const format of ['csv','xlsx']){
      let generated,notice='',cancelSave=false,savedPath;
      const elements=new Map(),blobs=new Map();
      const element=id=>{if(!elements.has(id))elements.set(id,{value:id==='expScope'?'all':format,disabled:false,hidden:true,textContent:'',classList:{add(){}},listeners:{},addEventListener(type,fn){this.listeners[type]=fn;},removeAttribute(name){delete this[name];}});return elements.get(id);};
      const context={IS_INTEGRATION:false,currentRoomCode:'WH-1',XLSX,Blob,Uint8Array,
        document:{getElementById:element},
        URL:{createObjectURL(blob){const url='blob:test-'+blobs.size;blobs.set(url,blob);return url;},revokeObjectURL(url){blobs.delete(url);}},
        window:{showSaveFilePicker:async options=>{
          if(cancelSave)throw Object.assign(new Error('cancel'),{name:'AbortError'});
          savedPath=join(dir,options.suggestedName);
          return {name:options.suggestedName,createWritable:async()=>({write:async blob=>writeFileSync(savedPath,Buffer.from(await blob.arrayBuffer())),close:async()=>{}})};
        }},
        apiGetToken:()=>'',toast:value=>{notice=value;},
        fetch:path=>call(path,'GET',null,'viewer')};
      await vm.runInNewContext(exportFunction+'\ndoExportInventory()',context);
      generated={filename:element('expDownload').download,blob:blobs.get(element('expDownload').href)};
      assert.ok(generated.blob,notice);assert.ok(generated.filename.endsWith('.'+format));
      assert.equal(element('expResult').hidden,false);
      assert.match(element('expStatus').textContent,/文件已生成/);
      cancelSave=true;await element('expSaveAs').onclick();
      assert.match(element('expStatus').textContent,/已取消保存/);
      assert.equal(element('expSaveAs').disabled,false);
      cancelSave=false;await element('expSaveAs').onclick();
      assert.match(element('expStatus').textContent,/已保存到所选位置/);
      assert.deepEqual(readFileSync(savedPath),Buffer.from(await generated.blob.arrayBuffer()));
      element('expDownload').onclick();assert.match(element('expStatus').textContent,/已请求浏览器下载/);
      element('expScope').listeners.change();assert.equal(element('expResult').hidden,true);
      assert.equal(blobs.size,0);assert.equal(element('expDownload').href,undefined);
      const workbook=format==='csv'
        ?XLSX.read(await generated.blob.text(),{type:'string',raw:true})
        :XLSX.read(new Uint8Array(await generated.blob.arrayBuffer()),{type:'array'});
      const rows=XLSX.utils.sheet_to_json(workbook.Sheets[workbook.SheetNames[0]]);
      assert.equal(rows.length,permitted.length);
      assert.ok(rows.every(row=>row['库位'].startsWith('WH-')));
      assert.ok(!JSON.stringify(rows).includes('SECRET'));
      assert.ok(!JSON.stringify(rows).includes('不可见物料'));
      for(const [index,row] of permitted.entries()){
        const sku=row.sku||permittedItems.find(item=>item.id===row.item_id)?.sku||'';
        const exported=rows[index];
        assert.equal(exported['库位'],row.loc_code);
        assert.equal(exported['物品名称'],row.name);
        assert.equal(exported.SKU||'',sku);
        assert.equal(Number(exported['数量']),row.qty);
      }
    }
    // 未授权记录先写入且排序靠前，不能占掉查询页的名额。
    const historyBase=(await read('/api/v1/movements?limit=500')).next_after;
    for(let i=0;i<55;i++)await call('/api/counter/inbound','POST',{name:'PAGE-A-'+i,sku:'PAGE-HIDDEN-'+i,qty:1,loc_code:other});
    for(let i=0;i<7;i++)await call('/api/counter/inbound','POST',{name:'PAGE-Z-'+i,sku:'PAGE-VISIBLE-'+i,qty:1,loc_code:from});
    const hits=await(await call('/api/search?q=PAGE-','GET',null,'viewer')).json();
    assert.equal(hits.length,7);assert.ok(hits.every(r=>r.name.startsWith('PAGE-Z-')));
    let cursor=historyBase,visible=[];
    for(let page=0;page<4;page++){
      const response=await call('/api/v1/movements?limit=3&after='+cursor,'GET',null,'viewer');
      assert.equal(response.status,200);const result=await response.json();
      visible.push(...result.movements);cursor=result.next_after;
      if(result.count<3)break;
    }
    assert.equal(visible.length,7);assert.equal(new Set(visible.map(r=>r.id)).size,7);
    assert.ok(visible.every(r=>r.item_name.startsWith('PAGE-Z-')));
  } finally {
    if(child.exitCode===null){const exited=once(child,'exit');child.kill();await exited;}
    identity.close();
    const rel=relative(root,realpathSync(dir));assert.ok(rel&&!rel.startsWith('..')&&!isAbsolute(rel));
    rmSync(dir,{recursive:true,force:true});
  }
});
