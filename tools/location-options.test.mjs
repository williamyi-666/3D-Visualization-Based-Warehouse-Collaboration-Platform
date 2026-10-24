import test from 'node:test';
import assert from 'node:assert/strict';
import {setLocationOptions,setLocationChoices} from '../apps/web/prototype/location-options.mjs';

test('仓库名称和编码中的 HTML 按文本保留，不通过 HTML 解析输出',()=>{
  const doc={createElement(tag){return {tag,ownerDocument:doc,dataset:{},children:[],replaceChildren(...nodes){this.children=nodes;},set innerHTML(_){throw Error('不允许解析动态 HTML');}};}};
  const select=doc.createElement('select'), list=doc.createElement('div');
  const name='<img src=x onerror="alert(1)">仓库 & "东区"';
  const code='WH\" data-test="injected';
  setLocationOptions(select,[{loc_code:code,name}]);
  assert.equal(select.children.length,1);
  assert.equal(select.children[0].tag,'option');
  assert.equal(select.children[0].textContent,name);
  assert.equal(select.children[0].value,code);
  setLocationChoices(list,select.children,code,'site','暂无仓库');
  assert.equal(list.children.length,1);
  assert.equal(list.children[0].tag,'button');
  assert.equal(list.children[0].textContent,name);
  assert.deepEqual(list.children[0].dataset,{site:code});
  assert.equal(list.children[0].className,'lp-item on');
  setLocationChoices(list,[],null,'site','暂无仓库');
  assert.equal(list.children[0].textContent,'暂无仓库');
});
