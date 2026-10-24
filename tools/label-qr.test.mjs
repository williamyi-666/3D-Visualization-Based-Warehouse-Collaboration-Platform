import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {runInNewContext} from 'node:vm';

const read=path=>readFileSync(new URL(path,import.meta.url),'utf8');
const labelSource=read('../apps/web/labels/index.html');
const drawSource=labelSource.slice(labelSource.indexOf('function drawQR('),labelSource.indexOf('// 不再截断到 24'));
const context={};
runInNewContext(read('../apps/web/labels/vendor/qrcode-generator.js'),context);
runInNewContext(read('../apps/web/prototype/vendor/jsQR.js'),context);
runInNewContext(drawSource,context);

test('单格货品标签过滤库存、空格不回退全部，外部同SKU批次只打印一次',()=>{
  const start=labelSource.indexOf('const showItems =');
  const show=labelSource.slice(start,labelSource.indexOf('const inline =',start));
  const data=[
    {id:'row-a',sku:'SKU-A',source:'ERP',loc_code:'WH-1-A-L01-B01',qty:2},
    {id:'row-b',sku:'SKU-A',source:'ERP',loc_code:'WH-1-A-L01-B01',qty:3},
    {id:'row-c',sku:'SKU-B',source:'ERP',loc_code:'WH-1-A-L01-B02',qty:4},
    {id:'row-d',sku:'SKU-C',source:'ERP',loc_code:'WH-1-A-L01-B01',qty:0}
  ];
  let result;
  const ctx={version:1,renderVersion:1,roomScope:{value:'all'},scopedRoom:'WH-1',mode:'item',loc:'WH-1-A-L01-B01',window:{SPATIAL_RUNTIME:{mode:'integration'}},
    document:{getElementById:()=>({textContent:''})},renderItemSheet:items=>{result=items;},data};
  const scope=labelSource.slice(labelSource.indexOf('const inRoom='),labelSource.indexOf('function setMode('));
  runInNewContext(scope+show+'showItems(data);',ctx);
  assert.equal(result.length,1);assert.equal(result[0].sku,'SKU-A');
  runInNewContext('loc="WH-1-A-L02-B02"; showItems(data);',ctx);
  assert.equal(result.length,0);
  runInNewContext('loc=null; showItems(data);',ctx);
  assert.equal(result.length,3);
  ctx.data.push({id:'other',sku:'SKU-OTHER',loc_code:'WH-2-A-L01-B01',qty:1});
  runInNewContext('roomScope.value="room";showItems(data);',ctx);
  assert.equal(result.length,3);
  runInNewContext('roomScope.value="all";showItems(data);',ctx);
  assert.equal(result.length,4);
  runInNewContext('renderVersion++;showItems([]);',ctx);
  assert.equal(result.length,4,'旧请求晚到时不能清空最新标签');
});

// 使用标签页实际绘制函数产生像素，再交给扫码页使用的解码器；不替代实体打印/相机验收。
for(const code of ['ONBRDQA-1-A-L01-B01','ONBOARD-QA-20260919','b03bae33-3b47-4066-96c4-f0d2aa5c349d']){
  test(`标签生成与扫码解码一致：${code}`,()=>{
    let pixels;
    const canvas={width:0,height:0,getContext(){
      pixels=new Uint8ClampedArray(this.width*this.height*4);
      return {fillStyle:'#ffffff',fillRect(x,y,w,h){
        const white=this.fillStyle==='#ffffff';
        for(let row=y;row<y+h;row++)for(let col=x;col<x+w;col++){
          const offset=(row*canvas.width+col)*4;
          pixels.set(white?[255,255,255,255]:[15,23,42,255],offset);
        }
      }};
    }};
    context.drawQR(canvas,code);
    const decoded=context.jsQR(pixels,canvas.width,canvas.height,{inversionAttempts:'dontInvert'});
    assert.equal(decoded?.data,code);
  });
}
