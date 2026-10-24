// 外部工具布局导入分发器 —— 按扩展名/内容嗅探路由到对应解析器，统一归一化为 canonical 模板。
// 支持：.json（平台自有模板）/ .dxf（CAD/SketchUp/FreeCAD/BIM 导出）/ .ifc（BIM 语义）
// 未来可在此加 .glb（视觉皮肤，走 three.js GLTFLoader，不进模板）、.skp 等分支。
import { normalizeTemplate, validateTemplate } from './schema.mjs';
import { dxfToTemplate, parseDXF } from './dxf.mjs';
import { ifcToTemplate, parseSTEP } from './ifc.mjs';

export function importLayout(input, filename = '', opts = {}) {
  const text = typeof input === 'string' ? input : (input && input.toString ? input.toString('utf8') : '');
  const lower = (filename || '').toLowerCase();
  let kind = sniff(text, lower);

  let raw;
  if (kind === 'json') {
    raw = JSON.parse(text);
  } else if (kind === 'dxf') {
    raw = dxfToTemplate(text, opts);
  } else if (kind === 'ifc') {
    raw = ifcToTemplate(text, opts);
  } else {
    throw new Error('无法识别的文件格式（支持 .json / .dxf / .ifc）');
  }

  const tpl = normalizeTemplate(raw, opts);
  const v = validateTemplate(tpl);
  if (!v.ok) throw new Error('解析结果校验失败：' + v.errors.join('；'));
  return { kind, template: tpl };
}

function sniff(text, lower) {
  if (lower.endsWith('.json')) return 'json';
  if (lower.endsWith('.dxf')) return 'dxf';
  if (lower.endsWith('.ifc')) return 'ifc';
  const head = text.slice(0, 200).toUpperCase();
  if (head.includes('ISO-10303-21')) return 'ifc';
  if (head.includes('SECTION') && head.includes('EOF')) return 'dxf';
  if (head.trimStart().startsWith('{')) return 'json';
  return 'unknown';
}

// 便于调试：导出各解析器
export { dxfToTemplate, parseDXF, ifcToTemplate, parseSTEP, normalizeTemplate, validateTemplate };
