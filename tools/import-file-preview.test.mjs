import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const source=fs.readFileSync(new URL('../apps/web/prototype/app.js',import.meta.url),'utf8');
const handlers=source.slice(source.indexOf("let reviewedImport='';"),source.indexOf('// 最小可用 CSV 解析'));
function setup(){
  const elements=new Map(),readers=[];
  const context=vm.createContext({
    document:{getElementById(id){
      if(!elements.has(id))elements.set(id,{value:'',textContent:'',style:{},events:{},addEventListener(name,fn){this.events[name]=fn;}});
      return elements.get(id);
    }},
    FileReader:class{constructor(){readers.push(this);}readAsText(){}readAsArrayBuffer(){}},
    XLSX:{read(){throw Error('无效工作簿');}},
  });
  vm.runInContext(handlers,context);
  const element=id=>context.document.getElementById(id);
  const choose=name=>element('imp_file').events.change({target:{files:[{name}]}});
  return{context,element,choose,readers};
}

test('更换文件清空旧内容和确认状态，读取失败不能沿用旧库存',()=>{
  const {context,element,choose,readers}=setup();
  vm.runInContext("reviewedImport='old-preview'",context);
  element('imp_text').value='旧库存';element('imp_err').textContent='旧预览';
  choose('broken.xlsx');
  assert.equal(element('imp_text').value,'');
  assert.equal(element('imp_err').textContent,'');
  assert.equal(element('imp_save').textContent,'预览并导入');
  assert.equal(vm.runInContext('reviewedImport',context),'');
  readers[0].result=new ArrayBuffer(1);readers[0].onload();
  assert.match(element('imp_msg').textContent,/Excel 解析失败/);
  assert.equal(element('imp_text').value,'');
});

test('较早文件的迟到读取不能覆盖较新文件或手工输入',()=>{
  const {element,choose,readers}=setup();
  choose('old.csv');choose('new.csv');
  readers[1].result='new';readers[1].onload();
  readers[0].result='old';readers[0].onload();
  assert.equal(element('imp_text').value,'new');
  assert.match(element('imp_msg').textContent,/new.csv/);
  choose('pending.csv');element('imp_text').value='manual';element('imp_text').events.input();
  readers[2].result='late';readers[2].onload();
  assert.equal(element('imp_text').value,'manual');
  assert.equal(element('imp_save').textContent,'预览并导入');
});

test('文件读取错误显示明确提示并保持空输入',()=>{
  const {element,choose,readers}=setup();
  choose('unreadable.csv');readers[0].onerror();
  assert.match(element('imp_msg').textContent,/文件读取失败/);
  assert.equal(element('imp_text').value,'');
});
