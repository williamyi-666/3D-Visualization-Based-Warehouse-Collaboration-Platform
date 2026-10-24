// 无依赖验证：手写 DXF 夹具 → 规范模板，断言房间尺寸与家具相对位正确。
import { readFileSync } from 'node:fs';
import { dxfToTemplate } from './dxf.mjs';
import { ifcToTemplate } from './ifc.mjs';
import { normalizeTemplate, validateTemplate } from './schema.mjs';

let fails = 0;
const assert = (cond, msg) => { if (!cond) { console.error('  ✗ ' + msg); fails++; } else console.log('  ✓ ' + msg); };

const dxf = readFileSync(new URL('./sample-warehouse.dxf', import.meta.url), 'utf8');
const raw = dxfToTemplate(dxf, {});
console.log('DXF →', JSON.stringify(raw));
assert(Math.abs(raw.room.width - 10) < 1e-6, '房间宽度 = 10m');
assert(Math.abs(raw.room.depth - 6) < 1e-6, '房间进深 = 6m');
assert(raw.furniture.length === 2, '识别到 2 个家具（不含房间轮廓）');
const r1 = raw.furniture.find((f) => Math.abs(f.x + 3) < 1e-6 && Math.abs(f.z + 1.5) < 1e-6);
assert(r1 && Math.abs(r1.w - 2) < 1e-6 && Math.abs(r1.d - 1) < 1e-6, '货架1 位于 (-3,-1.5)、尺寸 2×1');
const r2 = raw.furniture.find((f) => Math.abs(f.x - 1) < 1e-6 && Math.abs(f.z - 0.5) < 1e-6);
assert(r2 && Math.abs(r2.w - 2) < 1e-6 && Math.abs(r2.d - 1) < 1e-6, '货架2 位于 (1,0.5)、尺寸 2×1');

// 归一化 + 校验
const tpl = normalizeTemplate(raw);
const v = validateTemplate(tpl);
assert(v.ok, 'normalize + validate 通过：' + (v.ok ? 'ok' : v.errors.join('；')));

// IFC 子集：一个极小 STEP，含 1 个 IfcSpace（矩形足迹 8×5）与 1 个 IfcFurniture
const step = `ISO-10303-21;
HEADER;
ENDSEC;
DATA;
#1=IFCCARTESIANPOINT((0.,0.,0.));
#2=IFCAXIS2PLACEMENT3D(#1,$,$);
#3=IFCLOCALPLACEMENT($,#2);
#4=IFCCARTESIANPOINT((4.,2.5,0.));
#5=IFCAXIS2PLACEMENT3D(#4,$,$);
#6=IFCLOCALPLACEMENT($,#5);
#10=IFCRECTANGLEPROFILEDEF(.AREA.,'RM',$,8.,5.);
#11=IFCEXTRUDEDAREASOLID(#10,$,$,5.);
#12=IFCSHAPEREPRESENTATION($,'Body',$,(#11));
#13=IFCPRODUCTDEFINITIONSHAPE($,$,(#12));
#20=IFCSPACE('sp1','',"一号库房",$,$,#3,#13,$,.ELEMENT.);
#30=IFCFURNITURE('fr1','',"A货架",$,$,#6,$,$);
ENDSEC;
END-ISO-10303-21;
`;
const itpl = ifcToTemplate(step);
console.log('IFC →', JSON.stringify(itpl));
assert(Math.abs(itpl.room.width - 8) < 1e-6, 'IFC 房间宽度 = 8m');
assert(Math.abs(itpl.room.depth - 5) < 1e-6, 'IFC 房间进深 = 5m');
assert(itpl.furniture.length === 1, 'IFC 识别到 1 个家具');
assert(itpl.furniture[0].label === 'A货架', 'IFC 家具名称 = A货架');

console.log(fails === 0 ? '\nALL PASS' : `\n${fails} FAILED`);
process.exit(fails === 0 ? 0 : 1);
