import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';

const source=readFileSync(new URL('../apps/web/prototype/interface-entry.js',import.meta.url),'utf8');
const directory='/warehouse-rc/apps/web/prototype/',key='spatial-interface:'+directory;
function visit({page='index.html',query='',ua='Mozilla/5.0 (Windows NT 10.0; Win64; x64)',touch=0,saved,storage=new Map()}={}){
  let redirected;
  if(saved)storage.set(key,saved);
  const window={location:{href:'http://warehouse.local:38131'+directory+page+query,replace:value=>{redirected=value;}},navigator:{userAgent:ua,maxTouchPoints:touch},localStorage:{getItem:k=>storage.get(k),setItem:(k,v)=>storage.set(k,v)}};
  vm.runInNewContext(source,{window,URL});return {window,storage,redirected};
}
test('手机访问统一入口自动进入作业页，保留库区与格位，不把自动识别存为手动选择',()=>{
  const result=visit({query:'?room=WH-2&loc=WH-2-B-L01-B01',ua:'Mozilla/5.0 (Linux; Android 14) Mobile'}),target=new URL(result.redirected);
  assert.equal(target.pathname,directory+'mobile.html');assert.equal(target.searchParams.get('loc'),'WH-2-B-L01-B01');assert.equal(target.searchParams.get('room'),'WH-2');assert.equal(result.storage.size,0);
});
test('电脑窄窗口和带触控的Windows电脑保持电脑版，iPad进入作业页',()=>{
  assert.equal(visit().redirected,undefined);assert.equal(visit({touch:10}).redirected,undefined);
  assert.ok(visit({ua:'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15)',touch:5}).redirected.endsWith('/mobile.html'));
});
test('手动切换优先于设备识别并记住选择，两种界面不会循环跳转',()=>{
  const phone=visit({query:'?ui=desktop',ua:'iPhone'});assert.equal(phone.redirected,undefined);assert.equal(phone.storage.get(key),'desktop');
  assert.equal(visit({ua:'iPhone',storage:phone.storage}).redirected,undefined);
  const desktop=visit({page:'mobile.html',query:'?ui=mobile'});assert.equal(desktop.redirected,undefined);assert.equal(desktop.storage.get(key),'mobile');
  assert.ok(visit({storage:desktop.storage}).redirected.endsWith('/mobile.html'));
  assert.equal(visit({page:'mobile.html',storage:desktop.storage}).redirected,undefined);
});
test('切换链接带上当前格位，取消选中时去掉旧格位；不写入账号或令牌',()=>{
  const {window}=visit({query:'?loc=OLD'});
  const selected=new URL(window.SpatialInterface.url('mobile',{loc:'WH-2-B-L01-B01',room:'WH-2'}));
  assert.equal(selected.searchParams.get('ui'),'mobile');assert.equal(selected.searchParams.get('loc'),'WH-2-B-L01-B01');
  const cleared=new URL(window.SpatialInterface.url('desktop',{loc:'',room:'WH-2'}));assert.equal(cleared.searchParams.has('loc'),false);
});
