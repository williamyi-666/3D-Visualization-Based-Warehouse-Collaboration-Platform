// packages/three-kit/spaceGenerator.js
// 框架无关的参数化空间生成器：房间 / 家具 / 格位。
// 后续 MVP 会把它封装进 React-three-fiber 的 <Space /> 组件，这里保持纯 three.js 以便复用与单测。
import * as THREE from 'three';
import {skuCapacity} from './sku-capacity.mjs';
// 同 SKU 的多个批次只显示一次；多个货品保留数量提示。
export function cellDisplayLabel(mode,items,fallback) {
  if(mode==='code' || !mode)return fallback;
  const products=[...new Map(items.filter(i=>Number(i.qty)>0).map(i=>[i.sku || i.erp_code || i.name,i])).values()];
  const labels=products.map(i=>{
    const name=String(i.name || '').trim(),sku=String(i.sku || i.erp_code || '').trim();
    return mode==='name'?name:mode==='sku'?sku:[name,sku].filter(Boolean).join(' · ');
  }).filter(Boolean);
  return labels.length ? labels[0]+(labels.length>1?' + 另'+(labels.length-1)+'种':'') : fallback;
}


// 远景空闲格位只画合批轮廓；Mesh仍参与拾取，近景/悬停/选中恢复表面。
const hiddenSurfaceMatrix=new THREE.Matrix4().makeScale(0,0,0);
export function updateCellSurface(entry,cameraPosition,active=false) {
  const near=cameraPosition.distanceToSquared(entry.center)<=144;
  const visible=active || entry.items.length>0 || entry.status!=='normal' || entry.over || near;
  const surface=entry.surfaceBatch;
  const batched=!!surface && surface.batch.visible && visible && !active && !near;
  entry.mesh.material.visible=visible && !batched;
  if(surface && surface.shown!==batched){
    surface.batch.setMatrixAt(surface.index,batched?surface.matrix:hiddenSurfaceMatrix);
    surface.batch.instanceMatrix.needsUpdate=true;surface.shown=batched;
  }
}

// 占用率 -> 颜色（与计划文档「色彩语义」一致）
export const OCCUPANCY_COLORS = {
  empty: 0xd9d9d9, // 空：浅灰
  unknown: 0x60a5fa, // 有货但容量待确认，或多个 SKU 混放
  low: 0x9ed99a,   // 较低：绿
  half: 0xf2c14e,  // 半满：琥珀
  full: 0xe2574c,  // 满：红
};

export function occupancyColor(ratio) {
  if (ratio == null) return OCCUPANCY_COLORS.unknown;
  if (ratio <= 0) return OCCUPANCY_COLORS.empty;
  if (ratio < 0.8) return OCCUPANCY_COLORS.low;
  if (ratio < 1) return OCCUPANCY_COLORS.half;
  return OCCUPANCY_COLORS.full;
}

const LABEL_FONT = (px) => `bold ${px}px "Segoe UI", "Microsoft YaHei", Arial, sans-serif`;

// 把标牌文字画到给定 canvas 上（蓝底白字圆牌）。改名时复用同一张 canvas 重绘，避免反复创建纹理。
function drawRackLabel(canvas, text) {
  const S = canvas.width;
  const ctx = canvas.getContext('2d');
  ctx.clearRect(0, 0, S, S);
  const t = String(text == null ? '' : text).trim();
  // 圆形底板
  ctx.fillStyle = 'rgba(37, 99, 235, 0.95)';
  ctx.beginPath();
  ctx.arc(S / 2, S / 2, S * 0.46, 0, Math.PI * 2);
  ctx.fill();
  // 白色描边
  ctx.lineWidth = S * 0.05;
  ctx.strokeStyle = 'rgba(255, 255, 255, 0.9)';
  ctx.stroke();
  if (!t) return;
  // 在圆内留白方框中排字，同时约束宽度、总高度，避免两行文字越过圆弧。
  ctx.fillStyle = '#ffffff';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'alphabetic';
  const safeSize = S * 0.56;
  const chars = Array.from(t), mid = Math.ceil(chars.length / 2);
  const candidates = [[t], [chars.slice(0, mid).join(''), chars.slice(mid).join('')].filter(Boolean)];
  const metrics = value => {
    const m = ctx.measureText(value);
    return {width:Math.max(m.width, (m.actualBoundingBoxLeft || 0) + (m.actualBoundingBoxRight || 0)),
      ascent:m.actualBoundingBoxAscent, descent:m.actualBoundingBoxDescent};
  };
  let lines = [], sizes = [], gap = 0;
  for (let fs = Math.floor(S * 0.46); fs >= 14; fs--) {
    ctx.font = LABEL_FONT(fs);
    gap = fs * 0.15;
    for (const candidate of candidates) {
      const measured = candidate.map(metrics);
      const totalHeight = measured.reduce((sum,m)=>sum+m.ascent+m.descent,0) + gap*(candidate.length-1);
      if (measured.every(m=>m.width<=safeSize) && totalHeight<=safeSize) {
        lines=candidate; sizes=measured; break;
      }
    }
    if (lines.length) break;
  }
  // 极长名称省略显示，完整名称仍保留在货架属性中。
  if (!lines.length) {
    ctx.font=LABEL_FONT(14); gap=3;
    lines=candidates[1].map(line=>{
      const letters=Array.from(line);
      while (letters.length && metrics(letters.join('')+'…').width>safeSize) letters.pop();
      return letters.join('')+'…';
    });
    sizes=lines.map(metrics);
  }
  const totalHeight=sizes.reduce((sum,m)=>sum+m.ascent+m.descent,0)+gap*(lines.length-1);
  let y=(S-totalHeight)/2;
  lines.forEach((line,i)=>{
    ctx.fillText(line,S/2,y+sizes[i].ascent);
    y+=sizes[i].ascent+sizes[i].descent+gap;
  });
}

// 货柜顶部标识：蓝底白字圆形贴图，始终面向相机（Sprite），便于在 3D 场景中快速定位货架。
//   text   —— 显示文字（如 A / B / C，或自定义名称）
//   height —— 家具高度，用于按比例确定标牌大小
function makeRackLabelSprite(text, height) {
  const S = 256;
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = S;
  drawRackLabel(canvas, text);
  const tex = new THREE.CanvasTexture(canvas);
  tex.anisotropy = 4;
  tex.needsUpdate = true;
  const mat = new THREE.SpriteMaterial({ map: tex, transparent: true, depthWrite: false, depthTest: true });
  const sprite = new THREE.Sprite(mat);
  const w = Math.max(0.20, Math.min(0.38, height * 0.12));
  sprite.scale.set(w, w, 1);
  sprite.userData = { type: 'rackLabel', text: String(text || '').trim(), canvas, S };
  return sprite;
}

// 格位编号小标牌：无底色、深灰细字 + 极淡白描边（场景为浅色背景，深字才读得清；
// 描边保证压在深色物品方块上时仍有对比）。初始 opacity=0，由外部按相机距离淡入，
// 避免常显时整面货架糊成一片字。
//   boxW —— 格位宽度，用于按比例定标牌尺寸（合并格位自动放大）
export function makeCellLabelSprite(text, boxW, lazy = false) {
  const W = 160, H = 44;
  const mat = new THREE.SpriteMaterial({ transparent: true, depthWrite: false, depthTest: true, opacity: 0 });
  const sprite = new THREE.Sprite(mat);
  const w = Math.max(0.14, Math.min(0.62, boxW * 0.66));
  sprite.scale.set(w, w * (H / W), 1);
  sprite.renderOrder = 5;
  sprite.userData = { type: 'cellLabel', text: String(text ?? '').trim(), W, H };
  if (!lazy) ensureCellLabelTexture(sprite);
  return sprite;
}

// 远景不创建成千上万张不可见编号画布；首次靠近时再绘制，后续复用。
export function ensureCellLabelTexture(sprite) {
  const ud = sprite.userData;
  if (ud.canvas) return;
  const canvas = document.createElement('canvas');
  canvas.width = ud.W; canvas.height = ud.H; ud.canvas = canvas;
  const texture = new THREE.CanvasTexture(canvas); texture.anisotropy = 4;
  sprite.material.map = texture; sprite.material.needsUpdate = true;
  setCellLabelText(sprite, ud.text);
}

// 就地改写编号文字：重绘 canvas 并标记纹理更新（合并/改名后无需重建家具）。
export function setCellLabelText(sprite, text) {
  if (!sprite) return;
  const ud = sprite.userData || {};
  const canvas = ud.canvas;
  const t = String(text == null ? '' : text).trim();
  ud.text = t;
  if (!canvas) return;
  const ctx = canvas.getContext('2d');
  ctx.clearRect(0, 0, ud.W, ud.H);
  if (t) {
    let fs = Math.round(ud.H * 0.52);
    const maxW = ud.W - 12;
    const fontFor = (s) => `500 ${s}px "Segoe UI", "Microsoft YaHei", Arial, sans-serif`;
    ctx.font = fontFor(fs);
    while (fs > 13 && ctx.measureText(t).width > maxW) { fs -= 1; ctx.font = fontFor(fs); }
    let shown=t;
    while(shown.length>1 && ctx.measureText(shown+(shown===t?'':'…')).width>maxW)shown=Array.from(shown).slice(0,-1).join('');
    if(shown!==t)shown+='…';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.lineWidth = 3;
    ctx.strokeStyle = 'rgba(255,255,255,0.65)';
    ctx.strokeText(shown, ud.W / 2, ud.H / 2 + 1);
    ctx.fillStyle = 'rgba(51,65,85,0.9)';
    ctx.fillText(shown, ud.W / 2, ud.H / 2 + 1);
  }
  if (sprite.material && sprite.material.map) sprite.material.map.needsUpdate = true;
  ud.text = t;
}

// 就地改写标牌文字（双击改名后无需重建整个家具）：重绘 canvas 并标记纹理更新。
export function setRackLabelText(sprite, text) {
  if (!sprite) return;
  const ud = sprite.userData || {};
  const canvas = ud.canvas;
  const t = String(text == null ? '' : text).trim();
  if (!canvas) return;
  drawRackLabel(canvas, t);
  if (sprite.material && sprite.material.map) sprite.material.map.needsUpdate = true;
  ud.text = t;
}

// 生成房间：默认「无墙体」——只有地板 + 一圈地板轮廓，门/窗是平铺在地面上的 2D CAD 标记（各自独立成组、可拖动）。
//   walls:  false(默认,不画墙,门/窗画在地板上) | true(四面实墙)
//   door:   'back' | { side, offset } | 二者数组 —— offset 为沿墙位置比例 0~1，缺省 0.5（墙正中）
//   window: 同上
export function createRoom({ width = 4, depth = 3, height = 2.6, wallThickness = 0.08, walls = false, door = null, window = null } = {}) {
  const group = new THREE.Group();
  group.name = 'room';

  const floor = new THREE.Mesh(
    new THREE.BoxGeometry(width, 0.04, depth),
    new THREE.MeshStandardMaterial({ color: 0xe9e3d6, roughness: 0.95 })
  );
  floor.position.y = -0.02;
  floor.receiveShadow = true;
  floor.userData = { type: 'floor' };
  group.add(floor);

  const hw = width / 2, hd = depth / 2, hh = height / 2;
  const wallMat = new THREE.MeshStandardMaterial({ color: 0xf4f1ea, roughness: 1, side: THREE.DoubleSide });
  const doorOps = normOpeningsLocal(door);
  const winOps = normOpeningsLocal(window);
  const openings = [];

  if (walls === true) {
    // 全封闭实墙模式：仍在该侧画墙并留门/窗洞
    const sides = ['back', 'left', 'right', 'front'];
    for (const side of sides) {
      const hasDoor = doorOps.some((o) => o.side === side);
      const hasWindow = winOps.some((o) => o.side === side);
      addWall(group, side, { width, depth, height, wallThickness, hw, hd, hh, mat: wallMat, feature: hasDoor ? 'door' : (hasWindow ? 'window' : null) });
    }
  } else {
    // 默认无 3D 墙体：门/窗为地板上的 CAD 标记，每个开口独立成组，便于拖动
    const addOpen = (list, type) => {
      for (const op of list) {
        const { obj, openW } = addFloorOpening(op, { width, depth, type });
        placeOpening(obj, op.side, op.offset, width, depth);
        group.add(obj);
        const entry = { type, side: op.side, offset: op.offset, openW, obj };
        if (op.double) entry.double = true;
        if (op.flip) entry.flip = true;
        openings.push(entry);
      }
    };
    addOpen(doorOps, 'door');
    addOpen(winOps, 'window');
    addFloorOutline(group, width, depth); // 淡色地板轮廓，用于辨认空间边界
  }

  group.userData = { width, depth, height, door: doorOps, window: winOps, openings };
  return group;
}

// ---- 地板上的 2D CAD 风格门/窗标记（不画 3D 墙，仅平铺在地面区分空间）----
const FLOOR_Y = 0.02;   // 标记线抬高，避免与地面 z-fighting
const FILL_Y = 0.015;   // 半透明填充略低
function segPair(a, b) { return [a[0], FLOOR_Y, a[1], b[0], FLOOR_Y, b[1]]; }

// 房间地板轮廓：淡色矩形，辨认空间边界
function addFloorOutline(group, width, depth) {
  const hw = width / 2, hd = depth / 2;
  const pts = [[-hw, -hd], [hw, -hd], [hw, hd], [-hw, hd], [-hw, -hd]];
  const pos = [];
  for (let i = 0; i < pts.length - 1; i++) pos.push(...segPair(pts[i], pts[i + 1]));
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  const line = new THREE.LineSegments(geo, new THREE.LineBasicMaterial({ color: 0x94a3b8 }));
  line.userData = { type: 'floorOutline' };
  group.add(line);
}

// 门/窗数据规范化：'back' | { side, offset } | 二者数组 → [{ side, offset }]
function normOpeningsLocal(v) {
  if (v == null) return [];
  const SIDES = ['back', 'left', 'right', 'front'];
  const clamp = (o) => { const n = Number(o); return Number.isFinite(n) ? Math.min(0.95, Math.max(0.05, n)) : 0.5; };
  const one = (x) => {
    if (typeof x === 'string') return SIDES.includes(x) ? { side: x, offset: 0.5 } : null;
    if (x && typeof x === 'object' && SIDES.includes(x.side)) {
      const o = { side: x.side, offset: clamp(x.offset) };
      if (x.double === true || x.double === 1 || x.double === 'true') o.double = true;
      if (x.flip === true || x.flip === 1 || x.flip === 'true') o.flip = true; // 镜像开门方向
      return o;
    }
    return null;
  };
  return (Array.isArray(v) ? v : [v]).map(one).filter(Boolean);
}

// 开口的世界位姿：局部 +X 沿墙延伸，局部 +Z 指向室内
//   offset: 沿墙位置比例 0~1（back/left 从起点算起）
export function openingPose(side, offset, width, depth) {
  const hw = width / 2, hd = depth / 2;
  const t = Math.min(0.95, Math.max(0.05, Number.isFinite(Number(offset)) ? Number(offset) : 0.5));
  switch (side) {
    case 'front': return { x: -hw + t * width, z: hd, rotY: Math.PI };
    case 'left': return { x: -hw, z: -hd + t * depth, rotY: Math.PI / 2 };
    case 'right': return { x: hw, z: -hd + t * depth, rotY: -Math.PI / 2 };
    default: return { x: -hw + t * width, z: -hd, rotY: 0 }; // back
  }
}

// 把一个开口对象摆到指定墙面/位置（拖动过程中实时调用）
export function placeOpening(obj, side, offset, width, depth) {
  const p = openingPose(side, offset, width, depth);
  obj.position.set(p.x, 0, p.z);
  obj.rotation.y = p.rotY;
  return p;
}

// 在局部坐标系构建门/窗 CAD 符号：墙沿局部 X，室内为局部 +Z
// 返回 { obj, openW }；obj 是独立 Group，可直接整体拖动
function addFloorOpening(opening, o) {
  const { width, depth, type } = o;
  const sideLen = (opening.side === 'back' || opening.side === 'front') ? width : depth;
  const double = (type === 'door' && opening.double);
  const openW = type === 'door' ? (double ? Math.min(sideLen * 0.8, 2.2) : Math.min(sideLen * 0.45, 1.1)) : Math.min(sideLen * 0.4, 1.8);
  const color = type === 'door' ? 0xd97706 : 0x38bdf8;
  // 平面图（apps/web/prototype/app.js 的 drawDoorSymbol）里，门轴恒定在「沿墙 offset 较小」的一端。
  // ⚠️ 但局部 +X 并不总等于 offset 递增方向：openingPose() 为了让局部 +Z 指向室内，
  // 给 front / left 两面墙的 rotY 会把 +X 转成 offset 递减方向。不镜像的话，
  // 这两面墙的门在 2D 平面图与 3D 里就是左右相反的（开门方向不一致）。
  let flipX = (opening.side === 'front' || opening.side === 'left') ? -1 : 1;
  // 用户手动「镜像」这扇门：门轴换到墙的另一端（左右开互换），与 2D 平面图的 flip 一致
  if (opening.flip) flipX = -flipX;
  const obj = new THREE.Group();
  obj.name = 'opening:' + type;
  const pos = [];
  const seg = (a, b) => pos.push(a[0], FLOOR_Y, a[1], b[0], FLOOR_Y, b[1]); // a/b = [局部x, 局部z]
  // 在 [x,z] 位置画一个小十字标记铰链/端点，与 CAD 平面符号保持一致
  const cross = (x, z, size) => {
    seg([x - size, z], [x + size, z]);
    seg([x, z - size], [x, z + size]);
  };
  if (type === 'door') {
    if (double) {
      // 双开门：左右两扇对开，每扇宽 openW/2；闭合线沿墙（局部 X），弧线向室内（+Z）扫，与 CAD 平面一致
      const halfW = openW / 2;
      // 左扇：铰链在开口左端 -openW/2，向室内（+Z）开启
      const leftH = -openW / 2;
      seg([leftH, 0], [leftH, halfW]); // 门扇闭合线：铰链 → 室内末端（垂直于墙）
      cross(leftH, 0, 0.06); // 左扇铰链点标记
      const NL = 12;
      for (let i = 0; i < NL; i++) {
        const t0 = (i / NL) * Math.PI / 2, t1 = ((i + 1) / NL) * Math.PI / 2;
        // 弧线：圆心 leftH，半径 halfW，从 (leftH, 0) 扫到 (0, halfW) → 向室内开
        seg([leftH + halfW * Math.sin(t0), halfW * Math.cos(t0)], [leftH + halfW * Math.sin(t1), halfW * Math.cos(t1)]);
      }
      // 右扇：铰链在开口右端 +openW/2，向室内（+Z）开启
      const rightH = openW / 2;
      seg([rightH, 0], [rightH, halfW]); // 门扇闭合线：铰链 → 室内末端（垂直于墙）
      cross(rightH, 0, 0.06); // 右扇铰链点标记
      const NR = 12;
      for (let i = 0; i < NR; i++) {
        const t0 = (i / NR) * Math.PI / 2, t1 = ((i + 1) / NR) * Math.PI / 2;
        // 弧线：圆心 rightH，半径 halfW，从 (rightH, 0) 扫到 (0, halfW) → 向室内开
        seg([rightH - halfW * Math.sin(t0), halfW * Math.cos(t0)], [rightH - halfW * Math.sin(t1), halfW * Math.cos(t1)]);
      }
    } else {
      const hx = flipX * (-openW / 2); // 铰链在「offset 较小」的一端（flipX 见上）
      seg([hx, 0], [hx, openW]); // 门扇闭合线：铰链 → 室内末端（垂直于墙）
      cross(hx, 0, 0.06); // 铰链点标记
      const N = 16; // 开启弧线：铰链为心、半径 openW、向室内（+Z）扫 90°
      for (let i = 0; i < N; i++) {
        const t0 = (i / N) * Math.PI / 2, t1 = ((i + 1) / N) * Math.PI / 2;
        seg([hx + flipX * openW * Math.sin(t0), openW * Math.cos(t0)],
            [hx + flipX * openW * Math.sin(t1), openW * Math.cos(t1)]);
      }
    }
  } else {
    const t = 0.12; // 窗框内缩（朝室内）
    const s0 = [-openW / 2, 0], s1 = [openW / 2, 0];
    const inner0 = [s0[0], t], inner1 = [s1[0], t];
    seg(s0, s1); seg(s1, inner1); seg(inner1, inner0); seg(inner0, s0);
    seg([s0[0], t / 2], [s1[0], t / 2]); // 中线
    const fp = [];
    const tri = (a, b, c) => [a, b, c].forEach((q) => fp.push(q[0], FILL_Y, q[1]));
    tri(s0, s1, inner1); tri(s0, inner1, inner0);
    const fgeo = new THREE.BufferGeometry();
    fgeo.setAttribute('position', new THREE.Float32BufferAttribute(fp, 3));
    fgeo.computeVertexNormals();
    const fill = new THREE.Mesh(fgeo, new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.18, side: THREE.DoubleSide, depthWrite: false }));
    fill.userData = { type: 'openingFill' };
    obj.add(fill);
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  // 关闭深度测试，使门/窗符号始终绘制在墙面/货架之前，避免被遮挡看不见
  const line = new THREE.LineSegments(geo, new THREE.LineBasicMaterial({ color, depthTest: false, depthWrite: false, transparent: true }));
  line.renderOrder = 999;
  line.userData = { type: type === 'door' ? 'floorDoor' : 'floorWindow' };
  obj.add(line);
  // 不可见拾取代理：细线极难点中，用盒子承接拖拽命中
  // 沿用家具 hitBox 的做法——只让材质 visible:false，网格本身仍可被射线命中
  const hit = new THREE.Mesh(
    new THREE.BoxGeometry(Math.max(0.35, openW * 1.1), 0.08, Math.max(0.9, openW * 1.2)),
    new THREE.MeshBasicMaterial({ visible: false })
  );
  hit.position.set(0, 0.04, openW / 2); // 覆盖门扇沿墙 + 弧线向室内延伸的区域
  hit.userData = { type: 'openingHit' };
  obj.add(hit);
  obj.userData = { type: 'opening', openType: type, openW, hit, double: !!double };
  return { obj, openW };
}

// 在指定侧生成一段墙（可含门/窗洞）。side 决定该墙所在的固定坐标与平面跨度。
function addWall(group, side, o) {
  const { width, depth, height, wallThickness, hw, hd, hh, feature } = o;
  const L = (side === 'back' || side === 'front') ? width : depth; // 该墙的水平跨度
  // 在某侧放置一个盒子：uCenter/vCenter 为墙平面内的水平/竖直中心，uSize/vSize 为尺寸
  const place = (uCenter, vCenter, uSize, vSize, mat) => {
    let geo, pos;
    if (side === 'back' || side === 'front') {
      const z = (side === 'back') ? -hd : hd;
      geo = new THREE.BoxGeometry(Math.max(0.001, uSize), Math.max(0.001, vSize), wallThickness);
      pos = [uCenter, vCenter, z];
    } else {
      const x = (side === 'left') ? -hw : hw;
      geo = new THREE.BoxGeometry(wallThickness, Math.max(0.001, vSize), Math.max(0.001, uSize));
      pos = [x, vCenter, uCenter];
    }
    const m = new THREE.Mesh(geo, mat || o.mat);
    m.position.set(pos[0], pos[1], pos[2]);
    m.userData = { type: 'wall' };
    if (side === 'front') m.name = 'frontWall';
    group.add(m);
    return m;
  };

  if (!feature) { place(0, hh, L, height); return; }

  if (feature === 'door') {
    const dw = Math.min(0.95, L * 0.5);
    const dh = Math.min(2.05, height - 0.08);
    const sideW = (L - dw) / 2;
    place(-(dw / 2 + sideW / 2), hh, sideW, height);          // 左
    place(dw / 2 + sideW / 2, hh, sideW, height);             // 右
    place(0, (dh + height) / 2, dw, height - dh);            // 门上楣
    const doorMat = new THREE.MeshStandardMaterial({ color: 0x8a5a2b, roughness: 0.8 });
    const dm = place(0, dh / 2, dw * 0.96, dh, doorMat);     // 门板（木色）
    const normalIdx = (side === 'back' || side === 'front') ? 2 : 0;
    dm.position[normalIdx] += (side === 'front' || side === 'right') ? 0.015 : -0.015; // 略凸出墙面
    return;
  }

  // window
  const ww = Math.min(1.4, L * 0.55);
  const wY0 = Math.min(1.0, height * 0.4);
  const wY1 = Math.min(1.9, height * 0.78);
  const sideW = (L - ww) / 2;
  place(-(ww / 2 + sideW / 2), hh, sideW, height);           // 左
  place(ww / 2 + sideW / 2, hh, sideW, height);              // 右
  place(0, wY0 / 2, ww, wY0);                                // 窗台下
  place(0, (wY1 + height) / 2, ww, height - wY1);            // 窗上
  const glassMat = new THREE.MeshStandardMaterial({ color: 0xbfe3f2, transparent: true, opacity: 0.32, roughness: 0.1 });
  place(0, (wY0 + wY1) / 2, ww * 0.98, (wY1 - wY0) * 0.98, glassMat); // 玻璃
}

// 生成参数化家具（衣柜/书架/储物箱等通用），并登记所有「格位」到 cellRegistry
// spec: { type, code, label, position:[x,y,z], rotationY, width, height, depth, rows, cols, capacityPerCell, items }
//   items 形如 { 'L01-B01': [{name, qty, note}] }
// 家具以「自身中心」为原点构建，再整体平移到 position 并按 rotationY 绕竖直轴旋转，
//   因此旋转/平移都围绕家具底座中心，无缝匹配 2D 俯视布局编辑器。
// 返回的 registry 项: { locCode, items, ratio, mesh, center:Vector3, rackCode }
// 把格位合并方案解析成每个格位的 { span, head }：
//   merges 形如 { L01: [[1,2],[4,6]] }（第 1–2 列合并、第 4–6 列合并）
//   span = 该格位占几列（1 = 普通格位）；head = 是否主格位（被吞并的列 head=false，不渲染）
// 导出给前端复用，保证「3D 渲染」与「格位布局编辑界面」用同一套计算。
export function buildCellSpans(merges, rows, cols) {
  const map = new Map();
  for (let r = 1; r <= rows; r++) {
    const rowKey = 'L' + String(r).padStart(2, '0');
    const list = (merges && merges[rowKey]) || [];
    const spanOf = new Array(cols + 1).fill(1);
    const headOf = new Array(cols + 1).fill(true);
    for (const sp of list) {
      if (!Array.isArray(sp) || sp.length < 2) continue;
      const a = Math.max(1, Math.min(cols, Math.floor(Number(sp[0]))));
      const b = Math.max(1, Math.min(cols, Math.floor(Number(sp[1]))));
      const lo = Math.min(a, b), hi = Math.max(a, b);
      if (hi <= lo) continue; // 单列不算合并
      spanOf[lo] = hi - lo + 1;
      for (let c = lo + 1; c <= hi; c++) { headOf[c] = false; spanOf[c] = 0; }
    }
    for (let c = 1; c <= cols; c++) map.set(`${r}-${c}`, { span: spanOf[c], head: headOf[c] });
  }
  return map;
}

export function createFurniture(spec, cellRegistry = []) {
  const outer = new THREE.Group();
  outer.name = 'rack:' + spec.code;
  const { width, height, depth, rows, cols, position } = spec;
  const isOpen = !!spec.open;
  const isFloor = spec.type === 'floor';
  const [px, py, pz] = position;
  const rot = (spec.rotationY != null ? spec.rotationY : (spec.rotation || 0));
  outer.position.set(px, 0, pz);   // 底座中心落在 (px,0,pz)
  outer.rotation.y = rot;

  const inner = new THREE.Group();

  // 半透明外壳：开放柜极淡、封闭柜半透明（恒定开启，不再提供开关）
  const shellColor = isOpen ? 0xc9a06a : 0xb98a5e;
  const shellOpacity = isOpen ? 0.06 : 0.16;
  const shell = new THREE.Mesh(
    new THREE.BoxGeometry(width, height, depth),
    new THREE.MeshStandardMaterial({ color: shellColor, roughness: 0.7, transparent: true, opacity: shellOpacity, depthWrite: false })
  );
  shell.position.set(0, py + height / 2, 0); // 相对家具中心
  shell.renderOrder = 2; // 透明外壳最后绘制，避免与内部格位透明排序翻转导致频闪
  // 记下本件家具的原始不透明度，供「3D 拖拽」模式退出时精确还原（开放柜 0.06 / 封闭柜 0.16）
  shell.userData = { type: 'rackShell', code: spec.code, baseOpacity: shellOpacity };
  inner.add(shell);
  inner.userData.shell = shell;
  outer.userData.shell = shell;

  // 不可见拖拽命中代理：尺寸与外壳一致，仅用于 3D 拖拽拾取，
  // 避免递归命中半透明格位/物品导致「点空白也拖动家具」的误触。
  const hitBox = new THREE.Mesh(
    new THREE.BoxGeometry(width, height, depth),
    new THREE.MeshBasicMaterial({ visible: false })
  );
  hitBox.position.set(0, py + height / 2, 0); // 相对家具中心，与 shell 对齐
  hitBox.userData = { type: 'rackHit', code: spec.code };
  outer.userData.hitBox = hitBox;

  // 外框线
  const edges = new THREE.LineSegments(
    new THREE.EdgesGeometry(new THREE.BoxGeometry(width, height, depth)),
    new THREE.LineBasicMaterial({ color: 0x8a6a45 })
  );
  edges.position.copy(shell.position);
  inner.add(edges);

  // 地面区不画层板/立柱（本身就是贴地网格）；开放式置物柜才画层板+立柱
  if (isOpen && !isFloor) {
    const woodMat = new THREE.MeshStandardMaterial({ color: 0xb98a5e, roughness: 0.7 });
    const woodDark = new THREE.MeshStandardMaterial({ color: 0x8a6a45, roughness: 0.78 });
    const boardT = Math.min(0.05, (height / rows) * 0.14);
    const postT = Math.min(0.05, Math.min(width, depth) * 0.09);
    const layerH = height / rows;
    // 层板：底板 + 各层之间。刻意不画顶板——最上层做成「开放顶层」，
    // 货物可以直接堆在最上面那块层板上（对应 L0(rows) 库位），这也是原货架标签悬空的那块空间。
    for (let r = 0; r < rows; r++) {
      const y = py + layerH * r;
      const board = new THREE.Mesh(new THREE.BoxGeometry(width, boardT, depth), woodMat);
      board.position.set(0, y, 0);
      board.userData = { type: 'shelf', code: spec.code };
      inner.add(board);
    }
    // 四角立柱：只支撑到最上层板，不贯穿到「开放顶层」上方——
    // 开放顶层是 L0(rows) 库位，货物直接堆在最上面那块层板上，立柱再往上伸会挡住堆垛视觉。
    const postH = height - layerH; // 最底到最上层板中心
    const hx = width / 2 - postT / 2, hz = depth / 2 - postT / 2;
    for (const sx of [-hx, hx]) for (const sz of [-hz, hz]) {
      const post = new THREE.Mesh(new THREE.BoxGeometry(postT, postH, postT), woodDark);
      post.position.set(sx, py + postH / 2, sz);
      post.userData = { type: 'post', code: spec.code };
      inner.add(post);
    }
  }

  const cellW = width / cols;        // 沿 width = 列
  const cellD = depth / rows;        // 沿 depth = 行（仅地面区用到）
  const cellH = isFloor ? 0.08 : height / rows;
  const innerDepth = depth * 0.9;
  // 每格容量改为按 cellMeta[key].capacity 取（见循环内 cap 计算）；写死的 capacityPerCell 仅作 fallback

  // 格位合并：把一层里相邻的列合成一个宽格位。
  //   merges 形如 { L01: [[1,2],[4,6]] }，每个区间的**首列**是主格位（承载库存、可扫码），
  //   其余列被吞并（不渲染、不可录入）。loc_code 保持不变，已贴标签继续有效。
  const spans = buildCellSpans(spec.merges, rows, cols);

  // 缓存限定在单件货架内，随货架一起释放；格位仍保留独立材质和拾取对象。
  const cellGeometries = new Map(), edgeTemplates = new Map(), edgeBatches = new Map();
  const inventoryInstances=[];
  const surfaceEntries=[];
  for (let r = 1; r <= rows; r++) {
    for (let c = 1; c <= cols; c++) {
      const info = spans.get(`${r}-${c}`);
      if (!info || !info.head) continue; // 被合并吞掉的列不渲染
      const span = info.span;
      const locRow = 'L' + String(r).padStart(2, '0');
      const locCol = 'B' + String(c).padStart(2, '0');
      const key = `${locRow}-${locCol}`;
      const locCode = `${spec.code}-${locRow}-${locCol}`;
      // 宽格位占 span 列，中心落在这 span 列的正中
      const cx = -width / 2 + cellW * (c - 0.5 + (span - 1) / 2); // 相对家具中心
      // 货架：cy 沿高度分层；地面区：cy 贴地（0.04），cz 沿 depth 分布成平面网格
      const cy = isFloor ? 0.04 : py + cellH * (r - 0.5);
      const cz = isFloor ? (-depth / 2 + cellD * (r - 0.5)) : 0;
      const w = cellW * span;
      const items = (spec.items && spec.items[key]) || [];
      const meta = (spec.cellMeta && spec.cellMeta[key]) || {};
      const dimensions={width:w,height:isFloor?null:cellH,depth:isFloor?cellD:depth};
      const capacityState=skuCapacity({items,meta,dimensions});
      const cap=capacityState.capacity;
      const status = meta.status || 'normal';
      const ratio=capacityState.kind==='empty'?0:capacityState.ratio;
      const overCapacity=capacityState.over;
      // 不同库存单位可按各自的单位重量换算为 kg；缺失重量时只展示已知下限。
      const stocked = items.filter(item => Number(item.qty) > 0);
      const weightComplete = stocked.every(item => Number.isFinite(item.unit_weight_kg) && item.unit_weight_kg >= 0);
      const weightKg = stocked.reduce((sum,item) => sum + (Number.isFinite(item.unit_weight_kg) ? item.qty * item.unit_weight_kg : 0), 0);
      const overWeight = meta.max_load != null && weightKg > Number(meta.max_load) + 1e-9;
      const over = overCapacity || overWeight;
      // 状态优先于占用率着色：锁定=灰蓝、盘点中=琥珀；其余按占用率（超载=红）
      let baseColor;
      if (status === 'locked') baseColor = 0x64748b;
      else if (status === 'stocktaking') baseColor = 0xf59e0b;
      else baseColor = over ? 0xe2574c : occupancyColor(ratio==null?null:Math.min(1, ratio));
      const cellOpacity = status === 'locked' ? 0.12 : 0.26;
      // 格位底座：半透明，保留占用率配色（物品小方块在其内部可见）
      if (!cellGeometries.has(span)) {
        const geometry = new THREE.BoxGeometry(w * 0.92, isFloor ? 0.08 : cellH * 0.9, isFloor ? cellD * 0.92 : innerDepth);
        cellGeometries.set(span, geometry);
        edgeTemplates.set(span, new THREE.EdgesGeometry(geometry));
      }
      const cell = new THREE.Mesh(
        cellGeometries.get(span),
        new THREE.MeshStandardMaterial({ color: baseColor, roughness: 0.6, transparent: true, opacity: cellOpacity, emissive: 0x000000, emissiveIntensity: 0, depthWrite: false })
      );
      cell.position.set(cx, cy, cz);
      cell.renderOrder = 1; // 透明格位先于外壳绘制
      const displayCol = span > 1
        ? `B${String(c).padStart(2, '0')}-${String(c + span - 1).padStart(2, '0')}`
        : locCol;
      cell.userData = {
        type: 'cell', locCode, items, ratio, baseColor, rackCode: spec.code,
        span, // 占几列（1 = 普通格位）
        displayCol,
        capacity: cap, capacityState, dimensions, status, over, overCapacity, overWeight, weightKg, weightComplete, meta,
      };
      inner.add(cell);
      // 格位描边：让每个格位边界清晰可见（即便空置、半透明也看得出格子范围）。
      let edgeColor = 0x94a3b8;
      if (status === 'locked') edgeColor = 0xf87171;
      else if (status === 'stocktaking') edgeColor = 0xfbbf24;
      else if (over) edgeColor = 0xe2574c;
      const edgeOpacity = status === 'locked' ? 0.95 : 0.55;
      const edgeKey = edgeColor + ':' + edgeOpacity;
      if (!edgeBatches.has(edgeKey)) edgeBatches.set(edgeKey, {color:edgeColor, opacity:edgeOpacity, positions:[]});
      const positions = edgeBatches.get(edgeKey).positions, vertices = edgeTemplates.get(span).attributes.position;
      for (let i=0; i<vertices.count; i++) positions.push(vertices.getX(i)+cx, vertices.getY(i)+cy, vertices.getZ(i)+cz);
      // 格位编号：默认 LOC 短码（L01-B01 / 合并格位 L01-B01-B03）。
      // 若用户在「格位布局」弹窗或格位详情里自定义了名称（如商品 SKU），则优先显示自定义名。
      const baseLabel = `${locRow}-${displayCol}`;
      const customLabel = spec.cellNames && spec.cellNames[key];
      const cellLabel = makeCellLabelSprite(cellDisplayLabel(meta.label_mode,items,customLabel || baseLabel), w, !!spec.lazyCellLabels);
      const lblH = cellLabel.scale.y;
      if (isFloor) {
        // 地面区：贴地格子，编号浮在格面略上方、靠近相机的一侧
        cellLabel.position.set(cx, cy + 0.05 + lblH * 0.5, cz + cellD * 0.28);
      } else {
        // 货架：贴格位内底部、位于物品方块前方（物品仅占 innerDepth*0.30，不会被压住）
        cellLabel.position.set(cx, cy - cellH * 0.45 + lblH * 0.8, innerDepth * 0.42);
      }
      inner.add(cellLabel);
      // 物品小方块：纵向堆叠，统一颜色（格内层 depth 概念已移除）
      const itemColor = 0x38bdf8;
      // 示意方块有上限，完整库存仍保存在cellRegistry供查询与详情使用。
      const n = Math.min(items.length, spec.inventoryVisualLimit ?? items.length);
      const boxH = (cellH * 0.80) / Math.max(n, 1);
      const boxW = w * 0.74;
      const boxD = isFloor ? cellD * 0.74 : innerDepth * 0.30;
      items.slice(0,n).forEach((it, idx) => {
        const iy = isFloor ? (cy + 0.05 + boxH * (idx + 0.5)) : (cy - (cellH * 0.40) + boxH * (idx + 0.5));
        if(spec.batchInventory){inventoryInstances.push({x:cx,y:iy,z:cz,w:boxW,h:boxH*0.86,d:boxD,locCode,name:it.name});return;}
        const im = new THREE.Mesh(
          new THREE.BoxGeometry(boxW, boxH * 0.86, boxD),
          new THREE.MeshStandardMaterial({ color: itemColor, roughness: 0.5 })
        );
        im.position.set(cx, iy, cz); // 地面区各排沿深度分布，库存必须跟随所属格位。
        im.userData = { type: 'item', name: it.name, locCode };
        inner.add(im); // 与 cell 同为 inner 子物体，拾取仍以 cell 为准
      });
      const center = new THREE.Vector3(cx, cy, cz);
      outer.updateMatrixWorld(true);
      outer.localToWorld(center); // 含旋转后的世界坐标，供镜头飞行 / 拾取
      cellRegistry.push({
        locCode, items, ratio,
        photos: (spec.cellPhotos && spec.cellPhotos[key]) || [],
        mesh: cell,
        center,
        localCenter: new THREE.Vector3(cx, cy, cz),
        rackCode: spec.code,
        label: cellLabel, // 编号 Sprite（距离淡入用）
        baseLabel, // 默认 LOC 短码，改名清空时还原
        meta, status, capacity: cap, capacityState, dimensions, over, overCapacity, overWeight, weightKg, weightComplete,
      });
      surfaceEntries.push(cellRegistry[cellRegistry.length-1]);
    }
  }
  // 同色同透明度表面仅在远景合批；独立Mesh保留拾取和近景高亮。
  if(spec.batchCellSurfaces){
    const batches=new Map();
    for(const entry of surfaceEntries){
      const material=entry.mesh.material,key=material.color.getHex()+':'+material.opacity;
      if(!batches.has(key))batches.set(key,[]);batches.get(key).push(entry);
    }
    for(const entries of batches.values()){
      const batch=new THREE.InstancedMesh(new THREE.BoxGeometry(1,1,1),entries[0].mesh.material.clone(),entries.length);
      batch.renderOrder=1;batch.userData.type='cellSurfaceBatch';
      const transform=new THREE.Object3D();
      entries.forEach((entry,index)=>{
        transform.position.copy(entry.mesh.position);
        const size=entry.mesh.geometry.parameters;
        transform.scale.set(size.width,size.height,size.depth);transform.updateMatrix();
        const matrix=transform.matrix.clone();batch.setMatrixAt(index,matrix);
        entry.surfaceBatch={batch,index,matrix,shown:true};entry.mesh.material.visible=false;
      });
      batch.computeBoundingSphere();batch.instanceMatrix.needsUpdate=true;inner.add(batch);
    }
  }
  // 库存方块仅作占用示意；按货架合批，格位拾取和完整库存仍由 cellRegistry 承载。
  if(inventoryInstances.length){
    const batch=new THREE.InstancedMesh(new THREE.BoxGeometry(1,1,1),new THREE.MeshStandardMaterial({color:0x38bdf8,roughness:0.5}),inventoryInstances.length);
    const transform=new THREE.Object3D();
    inventoryInstances.forEach((item,index)=>{
      transform.position.set(item.x,item.y,item.z);transform.scale.set(item.w,item.h,item.d);transform.updateMatrix();batch.setMatrixAt(index,transform.matrix);
    });
    batch.instanceMatrix.needsUpdate=true;batch.computeBoundingSphere();
    batch.userData={type:'inventoryBatch',items:inventoryInstances.map(({locCode,name})=>({locCode,name}))};inner.add(batch);
  }
  // 同色描边合成一次绘制，不改变格位边界、锁定/盘点/超载颜色或货架变换。
  for (const batch of edgeBatches.values()) {
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.Float32BufferAttribute(batch.positions, 3));
    const edges = new THREE.LineSegments(geometry, new THREE.LineBasicMaterial({color:batch.color, transparent:true, opacity:batch.opacity}));
    edges.renderOrder = 3;
    edges.userData.type = 'cellEdges';
    inner.add(edges);
  }
  for (const geometry of edgeTemplates.values()) geometry.dispose();
  // 货柜顶部标识：优先显示可编辑的家具名称 spec.label（在「家具设置」里改名即实时更新），
  // 无名称时回退到 loc_code 末段（如 WH-1-A -> A）。挂在开放顶层之上居中，并与顶层货物留出间隙。
  const rackText = ((spec.label && String(spec.label).trim()) || (spec.code || '').split('-').pop() || '').trim();
  if (rackText) {
    const label = makeRackLabelSprite(rackText, isFloor ? 0.6 : height);
    const lw = label.scale.x;
    // 最上层已成开放顶层（货物可堆到 y=height），故标识需抬高，避免压住顶层货物
    const gap = Math.max(0.22, (height / Math.max(rows, 1)) * 0.3);
    label.position.set(0, isFloor ? 0.5 : py + height + gap + lw * 0.5, 0);
    label.renderOrder = 6;
    // 记录所属家具，供双击改名时定位（type:'rackLabel' 也是射线拾取的判定依据）
    label.userData = Object.assign({}, label.userData, { type: 'rackLabel', code: spec.code });
    inner.add(label);
    outer.userData.label = label;
  }

  outer.add(inner);
  outer.add(hitBox);
  return outer;
}
