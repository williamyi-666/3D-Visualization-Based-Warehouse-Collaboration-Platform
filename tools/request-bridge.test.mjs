import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';

test('平台API登录重定向转为401，写入不误判成功，正常重定向不受影响',async()=>{
  let response;
  const window={SPATIAL_RUNTIME:{basePath:'/warehouse',provider:'supos'},
    location:{href:'http://localhost:28088/warehouse/apps/web/prototype/index.html',origin:'http://localhost:28088'},
    fetch:async()=>response,open:()=>{}};
  vm.runInNewContext(readFileSync('apps/web/prototype/request-bridge.js','utf8'),{window,Headers,Request,Response,URL});
  const redirected=url=>Object.defineProperties(new Response('<!DOCTYPE html><title>登录</title>',{headers:{'Content-Type':'text/html'}}),{
    redirected:{value:true},url:{value:url}
  });
  for(const input of ['/api/cells','/warehouse/api/items',new Request('http://localhost:28088/warehouse/api/counter/inbound',{method:'POST'})]){
    response=redirected('http://localhost:28088/supos-login');
    const actual=await window.fetch(input,{method:'POST'});
    assert.equal(actual.status,401);assert.equal(actual.ok,false);
    assert.match((await actual.json()).error,/重新登录/);
  }
  response=redirected('http://localhost:28088/keycloak/home/auth/realms/supos/protocol/openid-connect/auth');
  assert.equal((await window.fetch('/api/auth/me')).status,401);
  response=redirected('http://localhost:28088/maintenance');
  assert.equal(await window.fetch('/api/cells'),response);
  response=redirected('http://localhost:28088/supos-login');
  assert.equal(await window.fetch('/uploads/photo.png'),response);
  assert.equal(await window.fetch('https://other.example/api/cells'),response);
});

test('主界面、系统管理和出入库台均加载子路径适配，平台台不读取本地令牌',async()=>{
  const source=readFileSync('apps/web/prototype/request-bridge.js','utf8');
  for(const name of ['index','sync','counter']) {
    const html=readFileSync(`apps/web/prototype/${name}.html`,'utf8');
    assert.ok(html.indexOf('runtime.js')<html.indexOf('request-bridge.js'));
    assert.ok(html.includes('request-bridge.js'));
  }
  let received;
  const window={SPATIAL_RUNTIME:{basePath:'/warehouse',provider:'supos'},fetch:async(input,init)=>{received={input,init};return {status:200};},open:()=>{}};
  const context=vm.createContext({window,Headers,Request,localStorage:{getItem(){throw Error('平台账号不应使用本地令牌');}},location:{hash:''}});
  vm.runInContext(source,context);
  const counter=readFileSync('apps/web/prototype/counter.html','utf8');
  vm.runInContext(counter.slice(counter.indexOf('(function(){'),counter.indexOf('const $ =')),context);
  await window.fetch('/api/counter/inbound',{method:'POST',headers:{'Content-Type':'application/json'},body:'{}'});
  assert.equal(received.input,'/warehouse/api/counter/inbound');
  assert.equal(received.init.headers.get('X-Spatial-Request'),'1');
  assert.equal(received.init.headers.get('Content-Type'),'application/json');
  assert.equal(received.init.headers.has('Authorization'),false);
  await window.fetch('/warehouse/api/cells');assert.equal(received.input,'/warehouse/api/cells');
});
