import test from 'node:test';
import assert from 'node:assert/strict';
import {createStocktakeUI} from '../apps/web/prototype/stocktake-ui.mjs';

// 小型DOM替身仅检查事件与状态，不替代真实浏览器验收。
class Element {
  constructor(tag){this.tag=tag;this.children=[];this.style={};this.disabled=false;this.textContent='';this.classList={add(){},remove(){}};}
  append(...children){for(const child of children){child.parent=this;this.children.push(child);}}
  replaceChildren(...children){for(const child of this.children)child.parent=null;this.children=[];this.append(...children);}
  setAttribute(){}
  focus(){}
  get isConnected(){return this.tag==='body'||!!this.parent?.isConnected;}
  querySelectorAll(selector){return this.children.flatMap(child=>[...(selector.split(',').includes(child.tag)?[child]:[]),...child.querySelectorAll(selector)]);}
}
test('盘点成功响应丢失后重新加载刷新库存，刷新失败仍保留已确认状态',async()=>{
  const original={document:globalThis.document,window:globalThis.window,fetch:globalThis.fetch,Option:globalThis.Option};
  const body=new Element('body');
  globalThis.document={body,createElement:tag=>new Element(tag),activeElement:null,addEventListener(){}};
  globalThis.window=new EventTarget();
  globalThis.Option=class extends Element{constructor(text){super('option');this.textContent=text;}};
  let record={id:'qa',loc_code:'WH-1-A-L01-B01',state:'draft',revision:2,reason:'验收',updated_by:{name:'tester'},updated_at:'2026-09-27T00:00:00Z',baseline:[{item_id:'a',name:'测试品',qty:7,unit:'件'}],counts:[{item_id:'a',name:'测试品',qty:6,book_qty:7,unit:'件'}]};
  let writes=0,refreshes=0,refreshFails=false;
  globalThis.fetch=async(_url,options={})=>{
    if(_url==='/api/auth/me')return {status:200,ok:true,json:async()=>({user:{id:'operator',role:'operator'}})};
    if(options.method==='POST'){writes++;record={...record,state:'confirmed',revision:3};return {status:502,ok:false,json:async()=>({})};}
    return {status:200,ok:true,json:async()=>structuredClone(record)};
  };
  const click=async text=>{const b=body.querySelectorAll('button').find(b=>b.textContent===text);assert.ok(b,text);assert.equal(b.disabled,false,text);await b.onclick();};
  try{
    const ui=createStocktakeUI({confirm:async()=>true,onChanged:async()=>{refreshes++;if(refreshFails)throw Error('离线');}});
    await ui.open(record.loc_code,{canOperate:true},{recordId:'qa'});
    await click('确认调账');
    assert.ok(body.querySelectorAll('p').some(p=>p.textContent.includes('调账结果待确认')));
    await click('重新加载');
    assert.equal(refreshes,1);assert.equal(writes,1);
    assert.ok(body.querySelectorAll('input').every(input=>input.disabled));
    assert.equal(body.querySelectorAll('button').some(b=>b.textContent==='确认调账'),false);
    assert.ok(body.querySelectorAll('p').some(p=>p.textContent==='盘点已确认，库存已更新。'));
    refreshFails=true;await click('重新加载');
    assert.equal(writes,1);assert.equal(refreshes,2);
    assert.ok(body.querySelectorAll('p').some(p=>p.textContent.includes('盘点已确认')&&p.textContent.includes('视图尚未刷新')));
  }finally{Object.assign(globalThis,original);}
});
