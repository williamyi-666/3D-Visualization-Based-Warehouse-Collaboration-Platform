import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
import {footprint} from '../packages/three-kit/layout-geometry.mjs';
import {dxfToTemplate,parseDXF} from '../packages/integration/importers/dxf.mjs';

// 调用实际页面导出函数，验证 CAD 足迹及重新导入后的米制尺寸。
test('非正方形货架 DXF 往返保留位置、旋转方向和宽深',()=>{
  const source=readFileSync('apps/web/prototype/app.js','utf8');
  const context=vm.createContext({footprint,r4:n=>Math.round(n*10000)/10000,normOpeningsFE:v=>v});
  vm.runInContext(source.slice(source.indexOf('function templateToDXF('),source.indexOf('// ---- 接线',source.indexOf('function templateToDXF('))),context);
  for(const degrees of [0,30,45,90,-30]) {
    const rack={code:'RACK-A',x:1.2,z:-0.8,w:3,d:0.6,rot:degrees*Math.PI/180};
    const text=context.templateToDXF({room:{width:12,depth:8},furniture:[rack]});
    const actual=parseDXF(text).entities.find(e=>e.layer==='RACK-A').points;
    const expected=footprint(rack);
    actual.forEach((p,i)=>p.forEach((v,j)=>assert.ok(Math.abs(v-expected[i][j])<0.0001)));
    const restored=dxfToTemplate(text).furniture[0];
    for(const key of ['x','z','w','d','rot'])assert.ok(Math.abs(restored[key]-rack[key])<0.001,key+' '+degrees);
  }
});
