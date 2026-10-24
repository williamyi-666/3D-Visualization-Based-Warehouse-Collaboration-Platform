// IFC 导入器（ISO-10303-21 STEP 子集，纯文本解析，零依赖，Node+浏览器可用）
//
// 这是「子集」实现，覆盖最常见的 BIM 导出场景：
//   ✔ 家具摆放：IfcFurniture / IfcBuildingElementProxy（名称含 货架/rack/shelf 等）→ 取 ObjectPlacement 坐标
//   ✔ 房间轮廓：IfcSpace 的 IfcRectangleProfileDef(XDim,YDim)（多数 BIM 的房间足迹）→ 取尺寸
//   ⚠ 未覆盖：复杂参数化墙体几何、斜墙、非矩形房间、旋转家具（rot 暂置 0）
//
// IFC 单位为米，无需 scale。空间坐标 (x,y,z) 映射到世界 (X=x, Z=y)。
//
// 用法： import { ifcToTemplate } from './ifc.mjs'; const tpl = ifcToTemplate(stepText);

export function ifcToTemplate(text, opts = {}) {
  const model = parseSTEP(text);
  const byType = (t) => model.entities.filter((e) => e.type.toUpperCase() === t);

  // ---- 房间：优先 IfcSpace 的矩形足迹 ----
  let room = null;
  for (const sp of byType('IFCSPACE')) {
    const dims = rectProfileDims(model, sp);
    if (dims) {
      const loc = placementLocation(model, sp.params[5]); // ObjectPlacement 在第 6 个属性（0-based 5）
      room = {
        r_w: round(dims.x),
        r_d: round(dims.y),
        cx: loc ? loc[0] : 0,
        cy: loc ? loc[2] : 0,
        name: strVal(sp.params[2]) || '房间',
      };
      break;
    }
  }

  // ---- 家具：IfcFurniture / IfcBuildingElementProxy ----
  const furn = [];
  let auto = 0;
  const collect = (e) => {
    const name = strVal(e.params[2]) || '';
    const loc = placementLocation(model, e.params[5]);
    if (!loc) return;
    const isFloor = /地面|floor|地堆|堆地/i.test(name + ' ' + strVal(e.params[3] || ''));
    furn.push({
      code: sanitize(name) || `FURN-${++auto}`,
      label: name || `家具${auto}`,
      cx: loc[0], cy: loc[2],
      isFloor,
    });
  };
  byType('IFCFURNITURE').forEach(collect);
  byType('IFCBUILDINGELEMENTPROXY').forEach((e) => {
    const n = strVal(e.params[2]) || '';
    if (/货架|rack|shelf|柜|cabinet|架/i.test(n)) collect(e);
  });

  // 房间兜底：用家具包围盒 + 边距
  if (!room) {
    if (!furn.length) throw new Error('IFC 中未发现 IfcSpace 或家具实体');
    let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
    for (const f of furn) {
      minX = Math.min(minX, f.cx - 0.5); maxX = Math.max(maxX, f.cx + 0.5);
      minY = Math.min(minY, f.cy - 0.5); maxY = Math.max(maxY, f.cy + 0.5);
    }
    const pad = 1.0;
    room = { r_w: round((maxX - minX) + pad * 2), r_d: round((maxY - minY) + pad * 2),
      cx: round((minX + maxX) / 2), cy: round((minY + maxY) / 2), name: '房间' };
  }

  const furniture = furn.map((f) => ({
    code: f.code,
    label: f.label,
    x: round(f.cx - room.cx),
    z: round(f.cy - room.cy),
    rot: 0,
    w: f.isFloor ? 2 : 1,
    d: f.isFloor ? 2 : 1,
    ...(f.isFloor ? { type: 'floor' } : {}),
  }));

  return { room: { width: room.r_w, depth: room.r_d }, furniture };
}

// ---------------- STEP / IFC 解析 ----------------
export function parseSTEP(text) {
  const ents = [];
  const re = /#(\d+)=([A-Z0-9_]+)\(([\s\S]*?)\);/g;
  let m;
  while ((m = re.exec(text))) {
    const id = parseInt(m[1], 10);
    const type = m[2];
    const params = parseParams(m[3]);
    ents.push({ id, type, params, raw: m[3] });
  }
  return { entities: ents, byId: new Map(ents.map((e) => [e.id, e])) };
}

// 解析参数串 → JS 值（ref/string/number/enum/list）
function parseParams(str) {
  let i = 0;
  const skipWs = () => { while (i < str.length && /\s/.test(str[i])) i++; };
  function parseValue() {
    skipWs();
    const c = str[i];
    if (c === '(') {
      i++; const arr = [];
      skipWs();
      if (str[i] === ')') { i++; return arr; }
      while (true) {
        arr.push(parseValue());
        skipWs();
        if (str[i] === ',') { i++; continue; }
        if (str[i] === ')') { i++; break; }
        break;
      }
      return arr;
    }
    if (c === '#') {
      let j = i + 1; while (j < str.length && /[0-9]/.test(str[j])) j++;
      const id = parseInt(str.slice(i + 1, j), 10); i = j; return { ref: id };
    }
    if (c === "'" || c === '"') {
      const q = c;
      let j = i + 1; let s = '';
      while (j < str.length) {
        if (q === "'" && str[j] === "'" && str[j + 1] === "'") { s += "'"; j += 2; continue; }
        if (q === '"' && str[j] === '"' && str[j + 1] === '"') { s += '"'; j += 2; continue; }
        if (str[j] === q) { j++; break; }
        s += str[j]; j++;
      }
      i = j; return s;
    }
    if (c === '$') { i++; return null; }
    if (c === '*') { i++; return { derived: true }; }
    if (c === '.') {
      let j = i + 1; while (j < str.length && str[j] !== '.') j++;
      const e = str.slice(i + 1, j); i = j + 1; return { enum: e };
    }
    // number
    let j = i; while (j < str.length && /[0-9eE+\-.]/.test(str[j])) j++;
    const num = parseFloat(str.slice(i, j)); i = j; return num;
  }
  const out = [];
  skipWs();
  while (i < str.length) {
    out.push(parseValue());
    skipWs();
    if (str[i] === ',') { i++; continue; }
    break;
  }
  return out;
}

// ---------------- IFC 语义辅助 ----------------
function resolve(model, ref) {
  if (ref && typeof ref === 'object' && ref.ref != null) return model.byId.get(ref.ref);
  return null;
}
function strVal(v) {
  if (v == null) return '';
  if (typeof v === 'string') return v;
  if (v && v.enum) return v.enum;
  return '';
}
function placementLocation(model, ref) {
  let e = resolve(model, ref);
  let x = 0, y = 0, z = 0;
  const seen = new Set();
  while (e && e.type.toUpperCase() === 'IFCLOCALPLACEMENT' && !seen.has(e.id)) {
    seen.add(e.id);
    const rel = resolve(model, e.params[1]); // RelativePlacement（属性索引 1）
    if (rel && rel.type.toUpperCase() === 'IFCAXIS2PLACEMENT3D') {
      const coords = resolve(model, rel.params[0]); // Location: IfcCartesianPoint
      if (coords && Array.isArray(coords.params[0])) {
        const c = coords.params[0];
        x += num(c[0]); y += num(c[1]); z += num(c[2]);
      }
    }
    e = resolve(model, e.params[0]); // PlacementRel
  }
  return [x, y, z];
}
// 取参数列表中第一个非空数组（兼容 IFC2X3 / IFC4 的属性顺序差异）
function firstArray(p) {
  if (!p || !Array.isArray(p)) return null;
  for (const v of p) if (Array.isArray(v) && v.length) return v;
  return null;
}
function rectProfileDims(model, space) {
  // space.Representation → Representations[] → Items[] → IfcExtrudedAreaSolid.SweptArea → IfcRectangleProfileDef(XDim,YDim)
  const rep = resolve(model, space.params[6]);
  const reps = firstArray(rep ? rep.params : null);
  if (!reps) return null;
  for (const r of reps) {
    const shape = resolve(model, r);
    const items = firstArray(shape ? shape.params : null);
    if (!items) continue;
    for (const it of items) {
      const item = resolve(model, it);
      if (item && item.type.toUpperCase() === 'IFCEXTRUDEDAREASOLID') {
        const swept = resolve(model, item.params[0]);
        if (swept && swept.type.toUpperCase() === 'IFCRECTANGLEPROFILEDEF') {
          return { x: num(swept.params[3]), y: num(swept.params[4]) };
        }
      }
    }
  }
  return null;
}
function num(v) { const n = parseFloat(v); return Number.isFinite(n) ? n : 0; }
function round(n) { return Math.round(n * 1000) / 1000; }
function sanitize(s) {
  s = String(s || '').trim();
  if (!s) return '';
  return s.replace(/[^\w一-龥-]/g, '_').slice(0, 24);
}
