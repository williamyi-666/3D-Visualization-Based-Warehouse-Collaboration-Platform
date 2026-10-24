// 规范 LOC 布局模板 schema —— 所有外部工具（CAD/BIM/SketchUp/FreeCAD…）导入后都归一化到此结构，
// 与 apps/web/prototype/app.js 的「布局模板导入/导出」格式完全一致，可直接载入布局编辑器。
//
// 约定（与 spaceGenerator.js / db.mjs 对齐）：
//   room.width = 房间 X 向宽度（米），room.depth = Z 向进深（米），room.height = 层高（米）
//   furniture[].x / .z = 相对房间中心的偏移（米），.rot = 绕竖直轴旋转（弧度，= rotationY）
//   furniture[].w / .h / .d = 宽 / 高 / 深（米）；rows/cols = 货架格位行列；type = rack|cabinet|floor
//
// 此模块零依赖、纯 ES，可在 Node 与浏览器中同时运行。

export const DEFAULTS = {
  roomHeight: 2.6,
  rackHeight: 2.0,
  rackRows: 3,
  rackCols: 3,
  floorHeight: 0.1,
  floorRows: 4,
  floorCols: 4,
};

/** 把任意外部解析结果归一化为合规模板，缺失字段补默认值。 */
export function normalizeTemplate(input, opts = {}) {
  const out = { room: {}, furniture: [] };
  const src = input || {};

  // ---- room ----
  const r = src.room || {};
  const rw = num(r.width ?? r.r_w);
  const rd = num(r.depth ?? r.r_d);
  if (!rw || !rd) throw new Error('模板缺少房间尺寸（width / depth）');
  out.room = {
    width: rw,
    depth: rd,
    height: num(r.height ?? r.r_h) || DEFAULTS.roomHeight,
  };
  // 门/窗：外部若带则透传，否则留 null（保持现有房间门窗口不被破坏由调用方 Object.assign 决定）
  if (r.door != null) out.room.door = r.door;
  if (r.window != null) out.room.window = r.window;

  // ---- furniture ----
  const list = Array.isArray(src.furniture) ? src.furniture : [];
  let auto = 0;
  for (const f of list) {
    if (!f) continue;
    const type = pickType(f.type, f);
    const base = {
      code: str(f.code) || `FURN-${++auto}`,
      label: str(f.label) || str(f.code) || `家具${auto}`,
      x: num(f.x) || 0,
      z: num(f.z) || 0,
      rot: num(f.rot) || 0,
      w: num(f.w ?? f.width) || 1,
      d: num(f.d ?? f.depth) || 1,
    };
    if (type === 'floor') {
      base.type = 'floor';
      base.h = num(f.h ?? f.height) || DEFAULTS.floorHeight;
      base.rows = intOr(f.rows, DEFAULTS.floorRows);
      base.cols = intOr(f.cols, DEFAULTS.floorCols);
      base.open = f.open != null ? !!f.open : 1;
    } else {
      base.type = type; // rack | cabinet
      base.h = num(f.h ?? f.height) || DEFAULTS.rackHeight;
      base.rows = intOr(f.rows, DEFAULTS.rackRows);
      base.cols = intOr(f.cols, DEFAULTS.rackCols);
      base.open = f.open != null ? !!f.open : 1;
    }
    out.furniture.push(base);
  }
  return out;
}

/** 校验（用于 UI 载入前把关），返回 { ok, errors[] } */
export function validateTemplate(tpl) {
  const errors = [];
  if (!tpl || !tpl.room) errors.push('缺少 room');
  else {
    if (!(tpl.room.width > 0)) errors.push('room.width 无效');
    if (!(tpl.room.depth > 0)) errors.push('room.depth 无效');
  }
  if (!Array.isArray(tpl.furniture) || !tpl.furniture.length) errors.push('furniture 为空');
  else {
    tpl.furniture.forEach((f, i) => {
      if (!(f.w > 0) || !(f.d > 0)) errors.push(`furniture[${i}] 尺寸无效`);
      if (!f.code) errors.push(`furniture[${i}] 缺 code`);
    });
  }
  return { ok: errors.length === 0, errors };
}

// ---------- 小工具 ----------
function num(v) {
  if (v == null || v === '') return 0;
  const n = typeof v === 'number' ? v : parseFloat(String(v).replace(',', '.'));
  return Number.isFinite(n) ? n : 0;
}
function str(v) {
  if (v == null) return '';
  return String(v).trim();
}
function intOr(v, d) {
  const n = num(v);
  return n > 0 ? Math.round(n) : d;
}
function pickType(t, f) {
  const s = String(t || f.type || '').toLowerCase();
  if (s.includes('floor') || s.includes('地面')) return 'floor';
  if (s.includes('cab') || s.includes('柜')) return 'cabinet';
  return 'rack';
}
