// 拍照生成布局 —— 单元/集成验证
// 覆盖：映射（度→弧度/类型/缺省兜底）、先验尺寸、置信度与备注、自动自检、Mock 端到端、无密钥报错。
import { validateTemplate } from './importers/schema.mjs';

let failed = 0;
function assert(cond, msg) {
  if (cond) console.log('  ok  -', msg);
  else { console.error('  FAIL -', msg); failed++; }
}

// 模块顶层只读一次 env，先固定 MOCK=1 再导入
process.env.PHOTO_VISION_MOCK = '1';
const { photoLayoutToTemplate, importLayoutPhoto, selfCheck } = await import('./photoLayout.mjs');

console.log('[1] photoLayoutToTemplate 映射');
const m = {
  room: { width: 12, depth: 9, height: 3.2 },
  furniture: [
    { label: '货架A', type: 'rack', rows: 5, cols: 6, x: -3, z: 1, rot: 90, rough_w: 1.2, rough_d: 0.6 },
    { label: '柜子', type: 'cabinet', rows: 3, cols: 3, x: 0, z: -2, rot: 0, rough_w: 0.8, rough_d: 0.5 },
    { label: '地面区', type: 'floor', rows: 4, cols: 4, x: 3, z: 2, rot: 0 },
  ],
};
const tpl = photoLayoutToTemplate(m);
assert(validateTemplate(tpl).ok, '模板合规 ' + JSON.stringify(validateTemplate(tpl).errors));
assert(tpl.room.width === 12 && tpl.room.depth === 9 && tpl.room.height === 3.2, 'room 尺寸映射');
assert(tpl.furniture.length === 3, 'furniture 数量=3');
const a = tpl.furniture[0];
assert(a.code === 'A' && a.label === '货架A' && a.type === 'rack', 'rack A 映射');
assert(Math.abs(a.rot - Math.PI / 2) < 1e-6, 'rot 度→弧度 (90°=π/2)');
assert(a.rows === 5 && a.cols === 6, 'rack rows/cols');
assert(a.w === 1.2 && a.d === 0.6, 'rack rough_w/d 映射');
assert(a.open === true, 'rack open=true（规范模板 open 为布尔，与现有导入一致）');
const cab = tpl.furniture[1];
assert(cab.type === 'cabinet' && cab.open === false && cab.w === 0.8 && cab.d === 0.5, 'cabinet 映射(封闭 open=false)');
const fl = tpl.furniture[2];
assert(fl.type === 'floor' && fl.open === true && fl.w === 2 && fl.d === 2, 'floor 默认尺寸');

console.log('[2] 缺省兜底');
const t2 = photoLayoutToTemplate({ room: {}, furniture: [{ label: 'X' }] });
assert(t2.room.width === 10 && t2.room.depth === 8, '缺 room 尺寸→默认 10×8');
assert(t2.furniture[0].type === 'rack' && t2.furniture[0].rows === 3 && t2.furniture[0].cols === 3, '缺 rows/cols→默认');
assert(validateTemplate(t2).ok, 't2 合规');

console.log('[3] 先验尺寸优先（用户填的真值覆盖模型估算）');
const t3 = photoLayoutToTemplate(
  { room: { width: 10, depth: 8 }, furniture: [{ label: '货架A', type: 'rack', rows: 5, cols: 8, x: 0, z: 0, rough_w: 1.5, rough_d: 0.9 }] },
  { hints: { rackW: 1.0, rackD: 0.6, rackRows: 4, rackCols: 6, roomW: 12, roomD: 9, roomH: 3.5 } }
);
assert(t3.room.width === 12 && t3.room.depth === 9 && t3.room.height === 3.5, '先验房间尺寸生效（覆盖模型 10×8）');
assert(t3.furniture[0].w === 1.0 && t3.furniture[0].d === 0.6, '先验货架宽深生效（覆盖模型 1.5×0.9）');
assert(t3.furniture[0].rows === 4 && t3.furniture[0].cols === 6, '先验层数/位数生效（覆盖模型 5×8）');

console.log('[4] 置信度与备注回填');
const r4 = await importLayoutPhoto({
  image: 'data:image/jpeg;base64,AAAA',
  hints: {},
});
assert(r4.kind === 'photo', 'Mock kind=photo');
assert(r4.template.furniture.length === 3, 'Mock 返回 3 件');
assert(validateTemplate(r4.template).ok, 'Mock 模板合规');
assert(r4.template.furniture[0].confidence === 'high', 'Mock A confidence=high');
assert(r4.template.furniture[2].confidence === 'low', 'Mock C confidence=low');
assert(String(r4.template.furniture[2].note || '').includes('遮挡'), 'Mock C 带 note（被遮挡）');
assert(r4.lowConfidence === 1, 'lowConfidence=1');
assert(Array.isArray(r4.warnings), 'warnings 为数组');

console.log('[5] 自动自检 selfCheck');
const clean = selfCheck({ room: { width: 10, depth: 8 }, furniture: [
  { code: 'A', x: -2.5, z: 0, w: 1.2, d: 0.6, rows: 4, cols: 6 },
  { code: 'B', x: 2.5, z: 0, w: 1.2, d: 0.6, rows: 4, cols: 6 },
] });
assert(clean.length === 0, '正常布局无告警');
const oob = selfCheck({ room: { width: 10, depth: 8 }, furniture: [
  { code: 'A', x: 20, z: 0, w: 1.2, d: 0.6, rows: 4, cols: 6 },
] });
assert(oob.some((w) => /超出房间边界/.test(w.text)), '越界被检出：' + (oob[0] && oob[0].text));
const ovl = selfCheck({ room: { width: 10, depth: 8 }, furniture: [
  { code: 'A', x: 0, z: 0, w: 1.2, d: 0.6, rows: 4, cols: 6 },
  { code: 'B', x: 0.1, z: 0, w: 1.2, d: 0.6, rows: 4, cols: 6 },
] });
assert(ovl.some((w) => /重叠/.test(w.text)), '重叠被检出：' + (ovl[0] && ovl[0].text));
const empty = selfCheck({ room: { width: 10, depth: 8 }, furniture: [] });
assert(empty.length === 1 && empty[0].level === 'error', '空布局报错级告警');
const weird = selfCheck({ room: { width: 10, depth: 8 }, furniture: [
  { code: 'A', x: 0, z: 0, w: 1.2, d: 0.6, rows: 30, cols: 6 },
] });
assert(weird.some((w) => /层数/.test(w.text)), '异常层数被检出');
assert(r4.warnings.length === 0, 'Mock 布局自检通过（无越界/重叠）');

console.log('[6] 多图与单图入参兼容');
const r6a = await importLayoutPhoto({ images: ['data:image/jpeg;base64,AAAA', 'data:image/jpeg;base64,BBBB'] });
assert(r6a.template.furniture.length === 3, 'images[] 多图可用');
const r6b = await importLayoutPhoto({ image: 'data:image/jpeg;base64,AAAA' });
assert(r6b.template.furniture.length === 3, 'image 单图仍兼容');
let threwEmpty = false;
try { await importLayoutPhoto({}); } catch (e) { threwEmpty = /需提供/.test(e.message); }
assert(threwEmpty, '无图抛「需提供 image 或 images」');

console.log('[7] 无密钥且非 Mock → 清晰报错');
process.env.PHOTO_VISION_MOCK = '0';
delete process.env.PHOTO_VISION_API_KEY;
const mod2 = await import('./photoLayout.mjs?nocache=1');
let threw = false;
try { await mod2.importLayoutPhoto({ image: 'data:image/jpeg;base64,AAAA' }); }
catch (e) { threw = /未配置视觉模型/.test(e.message); console.log('  抛出:', e.message); }
assert(threw, '无密钥非 Mock 抛出「未配置视觉模型」');

console.log(failed ? `\n❌ ${failed} 项失败` : '\n✅ 全部拍照生成测试通过');
process.exit(failed ? 1 : 0);
