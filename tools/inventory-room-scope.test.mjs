import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {runInNewContext} from 'node:vm';

// 执行页面实际使用的函数，验证相似库区编码下搜索及导出范围一致。
const source=readFileSync(new URL('../apps/web/prototype/app.js',import.meta.url),'utf8');
const extract=(start,end)=>source.slice(source.indexOf(start),source.indexOf(end,source.indexOf(start)));
const inventory=[
  {loc_code:'WH-1-A-L01-B01',name:'本库货品',qty:3,sku:'A',unit:'kg'},
  {loc_code:'WH-10-A-L01-B01',name:'十号库货品',qty:7,sku:'B',unit:'kg'},
  {loc_code:'WH-11-A-L01-B01',name:'十一号库货品',qty:9,sku:'C',unit:'kg'},
];
function exportHarness(elements={}) {
  const blobs=new Map();let next=0;
  const element=id=>elements[id]??=( {value:id==='expScope'?'room':'csv',hidden:true,disabled:false,
    addEventListener(){},removeAttribute(name){delete this[name];}} );
  return {element,blob:()=>blobs.get(element('expDownload').href),context:{
    document:{getElementById:element},window:{},Blob,
    URL:{createObjectURL(blob){const url='blob:export-'+next++;blobs.set(url,blob);return url;},revokeObjectURL(url){blobs.delete(url);}}
  }};
}
const exportSource=extract('function csvCell(', 'const exportBtn =');
test('导出等待期间切换库区仍保留原范围，网络失败明确提示且不生成文件',async()=>{
  const pending=[];let notice='';const harness=exportHarness();
  const context={...harness.context,IS_INTEGRATION:false,currentRoomCode:'WH-1',
    apiGetToken:()=>'',toast:value=>{notice=value;},fetch:()=>new Promise(resolve=>pending.push(resolve))};
  runInNewContext(exportSource,context);
  const exporting=context.doExportInventory();context.currentRoomCode='WH-10';
  pending[0]({ok:true,json:async()=>inventory});pending[1]({ok:true,json:async()=>[]});await exporting;
  const csv=await harness.blob().text();assert.match(csv,/WH-1-A/);assert.doesNotMatch(csv,/WH-10-A/);
  assert.equal(harness.element('expResult').hidden,false);
  context.fetch=async()=>{throw Error('network unavailable');};
  await context.doExportInventory();assert.match(notice,/导出失败/);assert.equal(harness.blob(),undefined);
  assert.equal(harness.element('expResult').hidden,true);assert.equal(harness.element('expOk').disabled,false);
});
test('慢搜索不能覆盖新结果，清空或关闭后旧响应不能重新显示',async()=>{
  const pending=[];
  const msg={innerHTML:'',textContent:'',querySelectorAll:()=>[],replaceChildren(){this.innerHTML='';this.textContent='';}};
  const context={document:{getElementById:id=>id==='searchMsg'?msg:{value:'all'}},IS_INTEGRATION:false,
    inventorySearchVersion:0,searchTimer:null,clearTimeout(){},addSearchDismiss(){},esc:String,cellRegistry:[],
    fetch:()=>new Promise(resolve=>pending.push(resolve))};
  runInNewContext(extract('function clearSearchFeedback()', '// 关闭结果')+extract('async function doSearch(q)', '// 按位置码定位'),context);
  const old=context.doSearch('旧货品'),latest=context.doSearch('新货品');
  pending[1]({ok:true,json:async()=>[{name:'新货品',qty:2,unit:'件',loc_code:'WH-1-A-L01-B01'}]});
  await latest;const rendered=msg.innerHTML;assert.match(rendered,/新货品/);
  pending[0]({ok:true,json:async()=>[{name:'旧货品',qty:9,loc_code:'WH-1-A-L01-B02'}]});
  await old;assert.equal(msg.innerHTML,rendered);
  for(const clear of [()=>context.doSearch(''),()=>context.clearSearchFeedback()]){
    const request=context.doSearch('慢请求');const resolve=pending.at(-1);
    await clear();const before=msg.innerHTML;
    resolve({ok:true,json:async()=>[{name:'慢请求',qty:1,loc_code:'WH-1-A-L01-B03'}]});
    await request;assert.equal(msg.innerHTML,before);
  }
});
for(const scope of ['room','all'])test(`搜索和CSV导出不混入相似库区：${scope}`,async()=>{
  const msg={innerHTML:'',querySelectorAll:()=>[]};
  const harness=exportHarness({searchMsg:msg,searchScope:{value:scope}});
  harness.element('expScope').value=scope;
  const context={...harness.context,IS_INTEGRATION:false,currentRoomCode:'WH-1',
    searchTimer:null,inventorySearchVersion:0,addSearchDismiss(){},clearTimeout(){},cellRegistry:[],esc:String,apiGetToken:()=>'',toast(){},fileStamp:()=> 'test',
    fetch:async path=>({ok:true,json:async()=>path==='/api/v1/items'?[]:inventory})};
  await runInNewContext(extract('async function doSearch(q)', '// 按位置码定位')+'\ndoSearch("货品")',context);
  await runInNewContext(exportSource+'\ndoExportInventory()',context);
  const csv=await harness.blob().text();
  for(const value of [msg.innerHTML,csv]){
    assert.ok(value.includes('WH-1-A-L01-B01'));
    assert.equal(value.includes('WH-10-A-L01-B01'),scope==='all');
    assert.equal(value.includes('WH-11-A-L01-B01'),scope==='all');
  }
  assert.equal(csv.trim().split('\n').length,scope==='all'?4:2);
});

for (const online of [true,false]) test(`同格多SKU搜索保留货品数量和单位：${online?'在线':'离线'}`,async()=>{
  const loc='WH-1-A-L01-B01';
  const items=[{name:'同名货品',sku:'SKU-A',qty:5,unit:'件'},{name:'同名货品',sku:'SKU-B',qty:2,unit:'kg'}];
  const msg={innerHTML:'',querySelectorAll:()=>[]};
  const context={document:{getElementById:id=>id==='searchMsg'?msg:{value:'all'}},IS_INTEGRATION:false,
    searchTimer:null,inventorySearchVersion:0,addSearchDismiss(){},clearTimeout(){},esc:String,cellRegistry:[{locCode:loc,items}],
    fetch:async path=>({ok:online,json:async()=>items.filter(i=>decodeURIComponent(path).includes(i.sku)||!decodeURIComponent(path).includes('SKU-')).map(i=>({...i,loc_code:loc}))})};
  const search=extract('async function doSearch(q)', '// 按位置码定位');
  await runInNewContext(search+'\ndoSearch("SKU-A")',context);
  assert.match(msg.innerHTML,/×5 件/);assert.doesNotMatch(msg.innerHTML,/SKU-B|×7/);
  for(const q of ['同名货品',loc]){
    await runInNewContext(search+`\ndoSearch(${JSON.stringify(q)})`,context);
    assert.match(msg.innerHTML,/找到 2 项/);assert.match(msg.innerHTML,/SKU-A/);assert.match(msg.innerHTML,/SKU-B/);
    assert.match(msg.innerHTML,/×5 件/);assert.match(msg.innerHTML,/×2 kg/);assert.doesNotMatch(msg.innerHTML,/×7/);
  }
});
