import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';

const html=readFileSync('apps/web/prototype/counter.html','utf8');
test('从出库切到移库沿用源格位、货品和数量，已有移库填写不被覆盖',()=>{
  for(const existing of ['', 'USER-SOURCE']){
    const nodes=new Map(),tabs=['in','out','move'].map(t=>({dataset:{tab:t},classList:{add(){},remove(){}},setAttribute(){}})),loads=[];
    const $=id=>{if(!nodes.has(id))nodes.set(id,{value:'',classList:{toggle(){}},closest(){return this;}});return nodes.get(id);};
    $('moveFrom').value=existing;$('outQty').value='2';
    const context=vm.createContext({$,document:{querySelectorAll:()=>tabs},locValid:true,locCode:'A',outSelItem:'ITEM',moveFromCode:existing,
      loadCellItems(){},clearOutItems(){},setMoveState(){},loadMoveItems(...args){loads.push(args);}});
    const start=html.indexOf("document.querySelectorAll('.tab').forEach(tab=>tab.onclick");
    vm.runInContext(html.slice(start,html.indexOf('// Esc 从内向外退出',start)),context);tabs[2].onclick();
    assert.equal($('moveFrom').value,existing||'A');
    assert.equal(loads[0][0],existing||'A');
    if(existing)assert.equal(loads[0][1],true);
    else {assert.equal(loads[0][2].item,'ITEM');assert.equal(loads[0][2].qty,'2');}
  }
});
