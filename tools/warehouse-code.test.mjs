import test from 'node:test';import assert from 'node:assert/strict';import vm from 'node:vm';import {readFileSync} from 'node:fs';
import {parseWarehouseCode} from '../apps/web/prototype/warehouse-code.mjs';
test('仓储码：库位、SKU、同源深链及真实二维码解码',()=>{
 const origin='http://localhost:28088';
 assert.deepEqual(parseWarehouseCode('WH-2-A-L01-B01',origin),{loc:'WH-2-A-L01-B01'});
 assert.deepEqual(parseWarehouseCode('sku:BEARING-6204',origin),{sku:'BEARING-6204'});
 assert.deepEqual(parseWarehouseCode('BEARING-6204',origin),{sku:'BEARING-6204'});
 assert.deepEqual(parseWarehouseCode(origin+'/warehouse/apps/web/prototype/index.html?sku=A&source=ERP',origin),{sku:'A',source:'ERP'});
 assert.throws(()=>parseWarehouseCode('https://other.example/?loc=WH-1-A',origin),/不是当前/);
 assert.throws(()=>parseWarehouseCode('javascript:alert(1)',origin),/不支持/);
 const context=vm.createContext({});vm.runInContext(readFileSync('apps/web/labels/vendor/qrcode-generator.js','utf8'),context);vm.runInContext(readFileSync('apps/web/prototype/vendor/jsQR.js','utf8'),context);
 const qr=context.qrcode(0,'M');qr.addData('WH-2-A-L01-B01');qr.make();
 const count=qr.getModuleCount(),scale=6,size=(count+8)*scale,pixels=new Uint8ClampedArray(size*size*4).fill(255);
 for(let r=0;r<count;r++)for(let c=0;c<count;c++)if(qr.isDark(r,c))for(let y=0;y<scale;y++)for(let x=0;x<scale;x++){
  const i=(((r+4)*scale+y)*size+(c+4)*scale+x)*4;pixels[i]=pixels[i+1]=pixels[i+2]=0;
 }
 const code=context.jsQR(pixels,size,size);assert.equal(code.data,'WH-2-A-L01-B01');assert.equal(parseWarehouseCode(code.data,origin).loc,'WH-2-A-L01-B01');
});
