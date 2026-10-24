// DXF 导入器（R12 / 2000 ASCII，纯文本解析，零依赖，Node+浏览器可用）
//
// 映射规则：
//   DXF 2D 平面 (x,y) → 世界 (X=x, Z=y)
//   房间 = ENTITIES 中面积最大的「闭合多段线」外轮廓
//   家具 = 其余闭合多段线（矩形足迹）或 INSERT 块（按 BLOCKS 轮廓计算包围盒）
//   单位：优先读 HEADER $INSUNITS 自动换算成米；否则用 opts.scale（米/单位，默认 1）
//
// 用法： import { dxfToTemplate } from './dxf.mjs'; const tpl = dxfToTemplate(text, { scale: 0.001 });

const UNIT_SCALE = { 1: 0.0254, 2: 0.3048, 3: 0.0254, 4: 0.001, 5: 0.01, 6: 1, 7: 1e-6, 8: 1e-6, 9: 1852 };

export function dxfToTemplate(text, opts = {}) {
  const dxf = parseDXF(text);
  const scale = opts.scale != null ? opts.scale : (dxf.insunits ? (UNIT_SCALE[dxf.insunits] || 1) : 1);

  // 1) 收集 ENTITIES 中的闭合多段线（房间候选 + 家具足迹）
  const polys = dxf.entities.filter((e) => e.type === 'LWPOLYLINE' || e.type === 'POLYLINE');
  const closed = polys.filter((p) => p.closed && p.points.length >= 3);

  // 2) 房间 = 面积最大的闭合多段线
  let roomPoly = null, roomArea = -1;
  for (const p of closed) {
    const a = polyArea(p.points);
    if (a > roomArea) { roomArea = a; roomPoly = p; }
  }

  // 3) 家具 = INSERT 块 + 其余闭合多段线
  const furnRects = [];
  for (const e of dxf.entities) {
    if (e.type === 'INSERT') {
      const blk = dxf.blocks.get(e.block);
      if (!blk) continue;
      const bb = bbox(blk.points);
      if (!bb) continue;
      const w = (bb.maxX - bb.minX) * e.sx;
      const d = (bb.maxY - bb.minY) * e.sy;
      const cx = (bb.minX + bb.maxX) / 2, cy = (bb.minY + bb.maxY) / 2;
      const [rx, ry] = rotate(cx * e.sx, cy * e.sy, e.rot);
      furnRects.push({
        code: sanitize(e.block || e.layer || ''),
        label: e.block || e.layer || '',
        cx: e.x + rx, cy: e.y + ry,
        w, d, rot: -e.rot,
      });
    }
  }
  for (const p of closed) {
    if (p === roomPoly) continue;
    const bb = bbox(p.points);
    if (!bb) continue;
    const cx = (bb.minX + bb.maxX) / 2, cy = (bb.minY + bb.maxY) / 2;
    const rot = edgeAngle(p.points);
    // 先转回货架本地坐标，再求尺寸，避免旋转后的外包框放大宽深。
    const local = bbox(p.points.map(([x,y]) => rotate(x-cx,y-cy,-rot)));
    const w = local.maxX-local.minX, d = local.maxY-local.minY;
    furnRects.push({
      code: sanitize(p.layer || ''),
      label: p.layer || '家具',
      cx, cy, w, d, rot: -rot,
    });
  }

  // 4) 房间尺寸与中心
  let roomBb, roomCx, roomCy;
  if (roomPoly) {
    roomBb = bbox(roomPoly.points);
    roomCx = (roomBb.minX + roomBb.maxX) / 2;
    roomCy = (roomBb.minY + roomBb.maxY) / 2;
  } else {
    if (!furnRects.length) throw new Error('DXF 中未发现任何闭合多段线或 INSERT 块');
    let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
    for (const f of furnRects) {
      minX = Math.min(minX, f.cx - f.w / 2); maxX = Math.max(maxX, f.cx + f.w / 2);
      minY = Math.min(minY, f.cy - f.d / 2); maxY = Math.max(maxY, f.cy + f.d / 2);
    }
    const pad = 1.0;
    roomBb = { minX: minX - pad, maxX: maxX + pad, minY: minY - pad, maxY: maxY + pad };
    roomCx = (minX + maxX) / 2; roomCy = (minY + maxY) / 2;
  }

  const r_w = (roomBb.maxX - roomBb.minX) * scale;
  const r_d = (roomBb.maxY - roomBb.minY) * scale;

  const furniture = furnRects.map((f, i) => ({
    code: f.code || `FURN-${i + 1}`,
    label: f.label || `家具${i + 1}`,
    x: round((f.cx - roomCx) * scale),
    z: round((f.cy - roomCy) * scale),
    rot: round(f.rot),
    w: round(f.w * scale),
    d: round(f.d * scale),
  }));

  return { room: { width: round(r_w), depth: round(r_d) }, furniture };
}

// ---------------- DXF 文本解析（带 reader 闭包） ----------------
export function parseDXF(text) {
  const lines = text.split(/\r\n|\r|\n/).map((l) => l.trimEnd());
  let i = 0;
  const peekCode = () => parseInt(lines[i], 10);
  const next = () => lines[i++];
  const readPair = () => {
    if (i >= lines.length) return null;
    const code = parseInt(lines[i], 10);
    const val = lines[i + 1];
    i += 2;
    return [code, val];
  };
  // 读取一个实体主体：收集 10/20/30 顶点与常见组码，遇到下一个 0 组结束
  const readEntityBody = (kind) => {
    const body = {};
    let count = 0;
    const pts = [];
    while (i < lines.length) {
      if (peekCode() === 0) break;
      const code = parseInt(lines[i], 10);
      const val = lines[i + 1];
      i += 2;
      if (code === 10) { pts.push([parseFloat(val), 0]); count++; }
      else if (code === 20 && count) { pts[count - 1][1] = parseFloat(val); }
      else if (code === 30 && count) { /* z 忽略（2D） */ }
      else body[code] = val;
    }
    if (pts.length) body.points = pts;
    return body;
  };

  const blocks = new Map();
  const entities = [];
  let insunits = 0;
  let curSection = null;

  while (i < lines.length) {
    if (peekCode() !== 0) { i++; continue; }   // 对齐保护：跳过非 0 组码（正常不应触发）
    const type = (lines[i + 1] || '').toUpperCase();
    i += 2;   // 消费 "0" 组码 + 实体类型
    if (type === 'EOF') break;

    if (type === 'SECTION') {
      const t = readPair();
      curSection = t && t[1] ? t[1].toUpperCase() : null;
      continue;
    }
    if (type === 'ENDSEC') { curSection = null; continue; }

    if (curSection === 'HEADER') {
      if (type === '$INSUNITS') {
        const p = readPair();
        if (p && p[0] === 70) insunits = parseInt(p[1], 10);
      } else { readPair(); }
      continue;
    }

    if (curSection === 'BLOCKS') {
      if (type === 'BLOCK') {
        const blk = readEntityBody('BLOCK');
        const name = blk[2] || '';
        const pts = [];
        while (i < lines.length) {
          if (peekCode() !== 0) { i++; continue; }
          const et = next().toUpperCase();
          if (et === 'ENDBLK') break;
          if (et === 'LWPOLYLINE') {
            const body = readEntityBody('LWPOLYLINE');
            if (body.points && body.points.length) pts.push(...body.points);
          } else if (et === 'POLYLINE') {
            readPair();
            while (i < lines.length) {
              if (peekCode() !== 0) { i++; continue; }
              const vt = next().toUpperCase();
              if (vt === 'SEQEND' || vt === 'ENDBLK') break;
              if (vt === 'VERTEX') {
                const vb = readEntityBody('VERTEX');
                if (vb.points) pts.push(...vb.points);
              } else readPair();
            }
          } else if (et === 'INSERT') {
            const ib = readEntityBody('INSERT');
            const sub = blocks.get(ib[2] || '');
            if (sub) pts.push(...sub.points);
          } else readPair();
        }
        blocks.set(name, { points: pts });
        continue;
      }
      readPair();
      continue;
    }

    if (curSection === 'ENTITIES') {
      if (type === 'LWPOLYLINE') {
        const b = readEntityBody('LWPOLYLINE');
        if (b.points && b.points.length) entities.push({ type: 'LWPOLYLINE', layer: b[8] || '', closed: !!(parseInt(b[70] || '0', 10) & 1), points: b.points });
      } else if (type === 'POLYLINE') {
        const flags = readPair();
        const closed = flags && flags[0] === 70 && (parseInt(flags[1], 10) & 1);
        const pts = [];
        while (i < lines.length) {
          if (peekCode() !== 0) { i++; continue; }
          const vt = next().toUpperCase();
          if (vt === 'SEQEND') break;
          if (vt === 'VERTEX') {
            const vb = readEntityBody('VERTEX');
            if (vb.points) pts.push(...vb.points);
          } else readPair();
        }
        if (pts.length) entities.push({ type: 'POLYLINE', layer: '', closed: !!closed, points: pts });
      } else if (type === 'INSERT') {
        const b = readEntityBody('INSERT');
        entities.push({ type: 'INSERT', block: b[2] || '', layer: b[8] || '',
          x: num(b[10]), y: num(b[20]), z: num(b[30]),
          rot: rad(num(b[50])), sx: num(b[41]) || 1, sy: num(b[42]) || 1, sz: num(b[43]) || 1 });
      } else {
        readPair();
      }
      continue;
    }

    readPair();
  }

  return { insunits, blocks, entities };
}

// ---------------- 几何小工具 ----------------
function bbox(pts) {
  if (!pts || !pts.length) return null;
  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
  for (const [x, y] of pts) { minX = Math.min(minX, x); maxX = Math.max(maxX, x); minY = Math.min(minY, y); maxY = Math.max(maxY, y); }
  return { minX, maxX, minY, maxY };
}
function polyArea(pts) {
  let a = 0;
  for (let k = 0; k < pts.length; k++) {
    const [x1, y1] = pts[k];
    const [x2, y2] = pts[(k + 1) % pts.length];
    a += x1 * y2 - x2 * y1;
  }
  return Math.abs(a) / 2;
}
function edgeAngle(pts) {
  if (pts.length < 2) return 0;
  const [x1, y1] = pts[0];
  const [x2, y2] = pts[1];
  return Math.atan2(y2 - y1, x2 - x1);
}
function rotate(x, y, ang) {
  const c = Math.cos(ang), s = Math.sin(ang);
  return [x * c - y * s, x * s + y * c];
}
function num(v) { const n = parseFloat(v); return Number.isFinite(n) ? n : 0; }
function rad(deg) { return (deg * Math.PI) / 180; }
function round(n) { return Math.round(n * 1000) / 1000; }
function sanitize(s) {
  s = String(s || '').trim();
  if (!s) return '';
  return s.replace(/[^\w一-龥-]/g, '_').slice(0, 24);
}
