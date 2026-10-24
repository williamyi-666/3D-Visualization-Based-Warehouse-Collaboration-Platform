import test from 'node:test';
import assert from 'node:assert/strict';
import {mountContextHints} from '../apps/web/prototype/context-hints.mjs';
import {counterHelpText} from '../apps/web/prototype/counter-help.mjs';

test('就地提示可收起，按账号记忆，不把别人的偏好带给新账号',()=>{
  const hosts=new Map(),events={},saved=new Map();let user='A';
  const document={
    getElementById:id=>({querySelector:()=>({after(node){hosts.set(id,node);}})}),
    createElement:tag=>({tag,children:[],events:{},append(...nodes){this.children.push(...nodes);},addEventListener(type,fn){this.events[type]=fn;}})
  };
  mountContextHints({account:()=>user,document,window:{addEventListener(type,fn){events[type]=fn;}},storage:{getItem:key=>saved.get(key),setItem:(key,value)=>saved.set(key,value)}});
  const rack=hosts.get('furnModal');assert.equal(rack.open,true);
  rack.open=false;rack.events.toggle();user='B';events['spatial-auth-ready']();assert.equal(rack.open,true);
  user='A';events['spatial-auth-ready']();assert.equal(rack.open,false);
  assert.equal(hosts.get('layoutModal').open,true);
});
test('正式业务提示随格位、货品、目标和数量变化，不把浏览当成提交',()=>{
  const state={mode:'move',loc:'',item:null,to:'',qtyValid:false};
  assert.match(counterHelpText(state),/源格位/);state.loc='A';assert.match(counterHelpText(state),/点击一条货品/);
  state.item='item';assert.match(counterHelpText(state),/目标格位/);state.to='B';assert.match(counterHelpText(state),/填写本次数量/);
  state.qtyValid=true;assert.match(counterHelpText(state),/核对格位/);
});
