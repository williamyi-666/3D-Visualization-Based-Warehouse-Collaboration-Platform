#!/usr/bin/env node
// 生成「写实模板」GLB 并可选上传到平台。
//
// 坐标系与平台一致：底座中心为原点(X 宽 / Z 深 / Y 高，底面 y=0)，直接按 loc_code 关联即可对齐。
//
// 用法：
//   node tools/make-realistic-template.mjs
//   node tools/make-realistic-template.mjs --upload --token <会话token> [--room WH-1] [--base http://localhost:3000]
//
// 仅依赖 Node 内置模块（自写 glTF 2.0 二进制写出，不需要 three/Blender）。
import { mkdirSync, writeFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const OUT_DIR = join(__dirname, 'out');

// ---------------- 几何：轴对齐盒子 ----------------
// 每个面 4 个顶点 + 统一法线，共 24 顶点 / 36 索引。材质设 doubleSided，绕序不影响观感。
const FACES = [
  { n: [0, 0, 1],  v: [[0, 0, 1], [1, 0, 1], [1, 1, 1], [0, 1, 1]] }, // +Z
  { n: [0, 0, -1], v: [[1, 0, 0], [0, 0, 0], [0, 1, 0], [1, 1, 0]] }, // -Z
  { n: [1, 0, 0],  v: [[1, 0, 1], [1, 0, 0], [1, 1, 0], [1, 1, 1]] }, // +X
  { n: [-1, 0, 0], v: [[0, 0, 0], [0, 0, 1], [0, 1, 1], [0, 1, 0]] }, // -X
  { n: [0, 1, 0],  v: [[0, 1, 1], [1, 1, 1], [1, 1, 0], [0, 1, 0]] }, // +Y
  { n: [0, -1, 0], v: [[0, 0, 0], [1, 0, 0], [1, 0, 1], [0, 0, 1]] }, // -Y
];

const box = (min, max) => ({ min, max });
// 以「中心 + 尺寸」建盒，便于按构件摆放
const boxAt = (cx, cy, cz, sx, sy, sz) => box(
  [cx - sx / 2, cy - sy / 2, cz - sz / 2],
  [cx + sx / 2, cy + sy / 2, cz + sz / 2]);

function buildPrimitive(boxes) {
  const positions = [], normals = [], indices = [];
  let base = 0;
  for (const b of boxes) {
    const [x0, y0, z0] = b.min, [x1, y1, z1] = b.max;
    for (const f of FACES) {
      for (const [sx, sy, sz] of f.v) {
        positions.push(sx ? x1 : x0, sy ? y1 : y0, sz ? z1 : z0);
        normals.push(f.n[0], f.n[1], f.n[2]);
      }
      indices.push(base, base + 1, base + 2, base, base + 2, base + 3);
      base += 4;
    }
  }
  return { positions, normals, indices };
}

// ---------------- 材质 ----------------
const MATERIALS = [
  { name: 'Upright',  baseColorFactor: [0.95, 0.42, 0.08, 1], metallicFactor: 0.25, roughnessFactor: 0.45 }, // 橙立柱
  { name: 'Beam',     baseColorFactor: [0.13, 0.36, 0.72, 1], metallicFactor: 0.35, roughnessFactor: 0.40 }, // 蓝横梁
  { name: 'Shelf',    baseColorFactor: [0.74, 0.71, 0.64, 1], metallicFactor: 0.05, roughnessFactor: 0.80 }, // 浅灰层板
  { name: 'Pallet',   baseColorFactor: [0.66, 0.47, 0.28, 1], metallicFactor: 0.00, roughnessFactor: 0.90 }, // 木托盘
];
const MAT = { upright: 0, beam: 1, shelf: 2, pallet: 3 };

// ---------------- 模型：仓库货架 ----------------
// 尺寸单位米，与平台 space_node.geom 的 w/h/d 一致
function buildRack({ width: W, depth: D, height: H, rows = 5, cols = 6 }) {
  const groups = { upright: [], beam: [], shelf: [] };
  const post = Math.min(0.05, W / 12);          // 立柱截面
  const postZ = Math.min(0.05, D / 6);
  const beamH = Math.min(0.045, H / 40);        // 横梁高
  const beamD = Math.min(0.03, D / 8);          // 横梁厚（沿 Z）
  const board = Math.min(0.022, H / 80);        // 层板厚

  // 立柱：每列分隔一根（cols 列 → cols+1 根），前后各一排
  // 外侧立柱外沿需与 ±W/2 齐平，故按 (W - post) 的内跨均分，避免模型比参数化外壳宽出一圈
  const nUpright = Math.max(2, cols + 1);
  const innerSpan = Math.max(0, W - post);
  for (let i = 0; i < nUpright; i++) {
    const cx = -W / 2 + post / 2 + (i * innerSpan) / (nUpright - 1);
    for (const cz of [-D / 2 + postZ / 2, D / 2 - postZ / 2]) {
      groups.upright.push(boxAt(cx, H / 2, cz, post, H, postZ));
    }
  }
  // 层：每层一根前后横梁 + 一块层板
  const levels = Math.max(1, rows);
  const bottom = 0.05;
  const spacing = Math.max(0.06, (H - bottom - 0.02) / levels);
  for (let i = 0; i < levels; i++) {
    const y = bottom + i * spacing;
    // 横梁（前后）
    for (const cz of [-D / 2 + beamD / 2, D / 2 - beamD / 2]) {
      groups.beam.push(boxAt(0, y + beamH / 2, cz, W, beamH, beamD));
    }
    // 层板
    groups.shelf.push(boxAt(0, y + beamH, 0, W - post * 0.5, board, D - beamD * 2));
  }
  // 顶框横梁
  for (const cz of [-D / 2 + beamD / 2, D / 2 - beamD / 2]) {
    groups.beam.push(boxAt(0, H - beamH / 2, cz, W, beamH, beamD));
  }
  return groups;
}

// ---------------- 模型：地面托盘 ----------------
function buildPallet({ width: W, depth: D, height: H }) {
  const g = { pallet: [] };
  const deck = Math.max(0.012, H * 0.25);          // 铺板厚
  const boardW = Math.min(0.16, D / 7);            // 每块铺板宽（沿 Z）
  const n = Math.max(3, Math.round(D / (boardW * 1.55)));
  const step = D / n;
  // 上下面板
  for (let i = 0; i < n; i++) {
    const cz = -D / 2 + step * (i + 0.5);
    g.pallet.push(boxAt(0, H - deck / 2, cz, W, deck, boardW));
    g.pallet.push(boxAt(0, deck / 2, cz, W, deck, boardW));
  }
  // 纵梁（承托）
  const strW = Math.min(0.14, D / 5);
  for (const cz of [-D / 2 + strW / 2, 0, D / 2 - strW / 2]) {
    g.pallet.push(boxAt(0, H / 2, cz, W, Math.max(0.02, H - deck * 2), strW));
  }
  return g;
}

// ---------------- glTF 2.0 / GLB 写出 ----------------
function packGLB(groups) {
  const json = {
    asset: { version: '2.0', generator: 'spatial-inventory realistic template' },
    scene: 0,
    scenes: [{ nodes: [] }],
    nodes: [],
    meshes: [],
    materials: MATERIALS.map((m) => ({
      name: m.name,
      pbrMetallicRoughness: {
        baseColorFactor: m.baseColorFactor,
        metallicFactor: m.metallicFactor,
        roughnessFactor: m.roughnessFactor,
      },
      doubleSided: true,
    })),
    accessors: [],
    bufferViews: [],
    buffers: [],
  };
  const chunks = [];         // 二进制片段
  let offset = 0;            // 当前 buffer 偏移
  const views = [];

  const pushView = (buf, target) => {
    const pad = (4 - (buf.byteLength % 4)) % 4;
    const padded = pad ? Buffer.concat([buf, Buffer.alloc(pad)]) : buf;
    const view = { buffer: 0, byteOffset: offset, byteLength: buf.byteLength, target };
    views.push(view);
    chunks.push(padded);
    offset += padded.length;
    return views.length - 1;
  };

  for (const [kind, boxes] of Object.entries(groups)) {
    if (!boxes.length) continue;
    const { positions, normals, indices } = buildPrimitive(boxes);
    const pBuf = Buffer.from(new Float32Array(positions).buffer);
    const nBuf = Buffer.from(new Float32Array(normals).buffer);
    const iBuf = Buffer.from(new Uint32Array(indices).buffer);

    const pView = pushView(pBuf, 34962);
    const nView = pushView(nBuf, 34962);
    const iView = pushView(iBuf, 34963);

    const min = [Infinity, Infinity, Infinity], max = [-Infinity, -Infinity, -Infinity];
    for (let i = 0; i < positions.length; i += 3) {
      for (let k = 0; k < 3; k++) {
        min[k] = Math.min(min[k], positions[i + k]);
        max[k] = Math.max(max[k], positions[i + k]);
      }
    }
    const pAcc = json.accessors.length;
    json.accessors.push({ bufferView: pView, componentType: 5126, count: positions.length / 3, type: 'VEC3', min, max });
    const nAcc = json.accessors.length;
    json.accessors.push({ bufferView: nView, componentType: 5126, count: normals.length / 3, type: 'VEC3' });
    const iAcc = json.accessors.length;
    json.accessors.push({ bufferView: iView, componentType: 5125, count: indices.length, type: 'SCALAR' });

    const meshIdx = json.meshes.length;
    json.meshes.push({
      name: kind,
      primitives: [{ attributes: { POSITION: pAcc, NORMAL: nAcc }, indices: iAcc, material: MAT[kind] ?? 0, mode: 4 }],
    });
    const nodeIdx = json.nodes.length;
    json.nodes.push({ name: kind, mesh: meshIdx });
    json.scenes[0].nodes.push(nodeIdx);
  }

  json.bufferViews = views;
  const bin = Buffer.concat(chunks);
  json.buffers = [{ byteLength: bin.length }];

  let jsonStr = JSON.stringify(json);
  while (jsonStr.length % 4) jsonStr += ' ';
  const jsonBuf = Buffer.from(jsonStr, 'utf8');

  const total = 12 + 8 + jsonBuf.length + 8 + bin.length;
  const out = Buffer.alloc(total);
  out.writeUInt32LE(0x46546c67, 0);   // magic 'glTF'
  out.writeUInt32LE(2, 4);            // version
  out.writeUInt32LE(total, 8);        // total length
  out.writeUInt32LE(jsonBuf.length, 12);
  out.writeUInt32LE(0x4e4f534a, 16);  // chunk type 'JSON'
  jsonBuf.copy(out, 20);
  const binOff = 20 + jsonBuf.length;
  out.writeUInt32LE(bin.length, binOff);
  out.writeUInt32LE(0x004e4942, binOff + 4); // chunk type 'BIN\0'
  bin.copy(out, binOff + 8);
  return out;
}

// ---------------- 主流程 ----------------
const argv = process.argv.slice(2);
const arg = (name, def = null) => {
  const i = argv.indexOf(name);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : def;
};
const has = (name) => argv.includes(name);

const BASE = arg('--base', 'http://localhost:3000');
const TOKEN = arg('--token', '');
const ROOM = arg('--room', '');
const AUTH = { Authorization: 'Bearer ' + TOKEN, 'Content-Type': 'application/json' };

// 家具规格：--upload 时从平台拉取；否则用一组默认值演示
async function loadSpecs() {
  if (!TOKEN) {
    return [
      { code: 'WH-1-A', width: 1.2, depth: 0.5, height: 2.5, rows: 7, cols: 6, type: 'rack' },
      { code: 'WH-1-B', width: 1.2, depth: 0.5, height: 2.0, rows: 5, cols: 6, type: 'rack' },
      { code: 'WH-1-C', width: 1.2, depth: 0.5, height: 2.0, rows: 5, cols: 6, type: 'rack' },
      { code: 'WH-1-F1', width: 3.0, depth: 2.0, height: 0.05, rows: 6, cols: 6, type: 'floor' },
    ];
  }
  const url = BASE + '/api/scene' + (ROOM ? '?room=' + encodeURIComponent(ROOM) : '');
  const res = await fetch(url, { headers: AUTH });
  if (!res.ok) throw new Error('拉取场景失败: ' + res.status + ' ' + (await res.text()).slice(0, 200));
  const s = await res.json();
  return (s.furniture || []).map((f) => ({
    code: f.code, width: f.width, depth: f.depth, height: f.height,
    rows: f.rows || 5, cols: f.cols || 6, type: (f.type === 'floor' || f.height < 0.15) ? 'floor' : 'rack',
  }));
}

const specs = await loadSpecs();
if (!existsSync(OUT_DIR)) mkdirSync(OUT_DIR, { recursive: true });

let uploaded = 0;
for (const sp of specs) {
  const groups = sp.type === 'floor' ? buildPallet(sp) : buildRack(sp);
  const glb = packGLB(groups);
  const file = join(OUT_DIR, sp.code.replace(/[^A-Za-z0-9_-]/g, '_') + '.glb');
  writeFileSync(file, glb);
  const parts = Object.entries(groups).map(([k, v]) => k + ':' + v.length).join(' ');
  console.log(`生成 ${sp.code}  ${sp.width}×${sp.depth}×${sp.height}m  ${sp.type}  构件(${parts})  ${(glb.length / 1024).toFixed(1)}KB -> ${file}`);

  if (has('--upload')) {
    const res = await fetch(BASE + '/api/node/' + encodeURIComponent(sp.code) + '/asset', {
      method: 'POST', headers: AUTH,
      body: JSON.stringify({ data: glb.toString('base64'), transform: { x: 0, y: 0, z: 0, rotY: 0, scale: 1 } }),
    });
    if (res.ok) { uploaded++; console.log('  ↳ 已上传到平台'); }
    else console.log('  ↳ 上传失败 ' + res.status + ' ' + (await res.text()).slice(0, 160));
  }
}
console.log(`\n完成：生成 ${specs.length} 个模型${has('--upload') ? `，上传成功 ${uploaded}/${specs.length}` : '（未上传，加 --upload --token <token> 可上传）'}`);
