// standalone-app.js —— 离线自包含版本（不依赖任何网络 / localhost）
// 数据来自 window.__SCENE__（构建时从 /api/scene 抓取后内联），所有增删改在内存中完成。
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { createRoom, createFurniture, placeOpening, setRackLabelText, setCellLabelText } from 'generator';

const INITIAL_SCENE = window.__SCENE__;

const container = document.getElementById('scene');
const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.setSize(container.clientWidth, container.clientHeight);
renderer.shadowMap.enabled = true;
container.appendChild(renderer.domElement);

const scene = new THREE.Scene();
scene.background = new THREE.Color(0xdfe6ee);

const camera = new THREE.PerspectiveCamera(50, container.clientWidth / container.clientHeight, 0.1, 100);
camera.position.set(0, 3.0, 7.0);

const controls = new OrbitControls(camera, renderer.domElement);
controls.enableDamping = true;
controls.target.set(0, 1, 0);

scene.add(new THREE.HemisphereLight(0xffffff, 0x8899aa, 0.95));
const dir = new THREE.DirectionalLight(0xffffff, 0.7);
dir.position.set(4, 8, 6);
scene.add(dir);

// 选中描边框：醒目亮青 wireframe，随选中格位 AABB 移动。
// 透明格位(opacity≈0.26)上的 emissive 辉光很弱，单独靠它看不出"选中没有跳转"，
// 故额外加一个恒显示在最前的描边框，确保选中目标一目了然。
const selectionBox = new THREE.LineSegments(
  new THREE.EdgesGeometry(new THREE.BoxGeometry(1, 1, 1)),
  new THREE.LineBasicMaterial({ color: 0x22d3ee, depthTest: false, transparent: true, opacity: 0.95 })
);
selectionBox.renderOrder = 999;
selectionBox.visible = false;
scene.add(selectionBox);
function positionSelectionBox(entry) {
  // 强制更新该格位的世界矩阵，避免 setFromObject 读到上一帧/未初始化的 AABB
  entry.mesh.updateWorldMatrix(true, false);
  const box = new THREE.Box3().setFromObject(entry.mesh);
  const size = box.getSize(new THREE.Vector3());
  const center = box.getCenter(new THREE.Vector3());
  selectionBox.position.copy(center);
  selectionBox.scale.copy(size);
  selectionBox.visible = true;
}

// ---- 格位编号：距离淡入 ----
// 每个格位都挂了一个编号 Sprite（L01-B01），但常显会让整面货架糊成一片字。
// 这里按「相机到格位中心的距离」控制透明度：近处清晰、远处彻底隐藏，
// 这样看整体布局时画面是干净的，需要找某个格位时镜头自然拉近、编号浮现。
const LABEL_NEAR = 3.2;   // 该距离内完全显示（flyTo 定位格位后约此距离）
const LABEL_FAR = 7.5;    // 超过该距离完全隐藏（默认视角约 7.3，即默认几乎不可见）
const LABEL_MAX_OP = 0.88;
let showCellLabels = true;
function updateCellLabels() {
  for (const c of cellRegistry) {
    const lb = c.label;
    if (!lb) continue;
    if (!showCellLabels) {
      if (lb.material.opacity !== 0) { lb.material.opacity = 0; lb.visible = false; }
      continue;
    }
    const d = camera.position.distanceTo(c.center);
    let op;
    if (d <= LABEL_NEAR) op = LABEL_MAX_OP;
    else if (d >= LABEL_FAR) op = 0;
    else op = LABEL_MAX_OP * (1 - (d - LABEL_NEAR) / (LABEL_FAR - LABEL_NEAR));
    lb.material.opacity = op;
    lb.visible = op > 0.02; // 完全透明时跳过绘制
  }
}

// 内存数据模型（离线版：增删改只改这里，刷新即还原为初始快照）
// 多库区：allRooms 保存各库区工作副本，state 为当前库区
function stateFromRoom(entry) {
  return { room: JSON.parse(JSON.stringify(entry.room)), furniture: JSON.parse(JSON.stringify(entry.furniture || [])) };
}
const INITIAL_ROOMS = (window.__ROOMS__ && window.__ROOMS__.length)
  ? window.__ROOMS__.map((r) => ({
      code: r.roomCode || (r.room && r.room.code) || 'HOME-BR1',
      name: r.roomName || (r.room && r.room.name) || r.code || '库区',
      room: r.room, furniture: r.furniture || [],
    }))
  : [{ code: (INITIAL_SCENE.roomCode || 'WH-1'), name: (INITIAL_SCENE.roomName || '1号库区'), room: INITIAL_SCENE.room, furniture: INITIAL_SCENE.furniture }];
let allRooms = INITIAL_ROOMS.map((r) => ({ code: r.code, name: r.name, room: JSON.parse(JSON.stringify(r.room)), furniture: JSON.parse(JSON.stringify(r.furniture || [])) }));
let roomIndex = 0;
let state = stateFromRoom(allRooms[0]);
let roomGroup = null;

// 离线版多仓库：仅支持查看/切换（无后端，不能新建）
const SITES = window.__SITES__ || [];
let currentSiteCode = SITES.length ? SITES[0].loc_code : null;
function siteRooms() {
  return currentSiteCode ? allRooms.filter((r) => r.code.startsWith(currentSiteCode + '-')) : allRooms;
}
function syncSiteSel() {
  const sel = document.getElementById('siteSel');
  if (!sel) return;
  sel.innerHTML = SITES.map((s) => `<option value="${s.loc_code}">${s.name}</option>`).join('');
  if (currentSiteCode) sel.value = currentSiteCode;
}
function onSiteChange(siteCode) {
  // 先保存当前库区的在内存改动
  allRooms[roomIndex] = { code: allRooms[roomIndex].code, name: allRooms[roomIndex].name, room: JSON.parse(JSON.stringify(state.room)), furniture: JSON.parse(JSON.stringify(state.furniture)) };
  currentSiteCode = siteCode;
  const list = siteRooms();
  roomIndex = list.length ? allRooms.indexOf(list[0]) : 0;
  if (!allRooms[roomIndex]) roomIndex = 0;
  state = stateFromRoom(allRooms[roomIndex]);
  rebuildRoom(state.room); buildScene(); syncRoomSel(); syncSiteSel(); updateBreadcrumb();
}

// 切换库区（先保存当前库区副本，再加载目标）
function switchRoom(idx) {
  allRooms[roomIndex] = { code: allRooms[roomIndex].code, name: allRooms[roomIndex].name, room: JSON.parse(JSON.stringify(state.room)), furniture: JSON.parse(JSON.stringify(state.furniture)) };
  roomIndex = idx;
  state = stateFromRoom(allRooms[idx]);
  rebuildRoom(state.room);
  buildScene();
  syncRoomSel();
  updateBreadcrumb();
}
function syncRoomSel() {
  const sel = document.getElementById('roomSel');
  const list = siteRooms();
  sel.innerHTML = list.map((r) => `<option value="${allRooms.indexOf(r)}">${r.name}</option>`).join('');
  sel.value = String(roomIndex);
}
function updateBreadcrumb() {
  const el = document.getElementById('locBreadcrumb');
  if (!el) return;
  const siteName = (SITES.find((s) => s.loc_code === currentSiteCode) || {}).name || '未选仓库';
  const roomName = (allRooms[roomIndex] && allRooms[roomIndex].name) || '未选区';
  el.replaceChildren();
  const s1 = document.createElement('span'); s1.textContent = '🏢 ' + siteName;
  const sep = document.createElement('span'); sep.className = 'sep'; sep.textContent = ' › ';
  const s2 = document.createElement('span'); s2.className = 'rm'; s2.textContent = '📦 ' + roomName;
  el.append(s1, sep, s2);
}
function addRoomOffline() {
  const prefix = currentSiteCode || 'WH';
  const list = siteRooms();
  const n = list.length + 1;
  const code = prefix + '-' + n;
  const entry = { code, name: '新库区' + n, room: { width: 12, depth: 8, height: 4, door: null, window: null }, furniture: [] };
  allRooms.push(entry);
  switchRoom(allRooms.length - 1);
  updateBreadcrumb();
}
document.getElementById('roomSel').onchange = (e) => switchRoom(Number(e.target.value));
document.getElementById('addRoomBtn').onclick = () => addRoomOffline();
const _siteSel = document.getElementById('siteSel');
if (_siteSel) _siteSel.onchange = (e) => onSiteChange(e.target.value);
const _addSiteBtn = document.getElementById('addSiteBtn');
if (_addSiteBtn) _addSiteBtn.onclick = () => alert('离线版不支持新建仓库，请使用联网版（启动后端服务）。');
syncRoomSel();
syncSiteSel();
updateBreadcrumb();
function rebuildRoom(roomSpec) {
  if (roomGroup) scene.remove(roomGroup);
  roomGroup = createRoom(roomSpec || { width: 4, depth: 3, height: 2.6 });
  scene.add(roomGroup);
}
rebuildRoom(state.room);

let rackGroups = [];
let cellRegistry = [];
let furnByCode = {};

// 隔离模式：仅保留一个货架（isolateCode），其余整体隐藏，视线与点击都不会再被前方货架挡住。
let isolateMode = false;
let isolateCode = null;
function getRackCode(g) {
  return g.userData && g.userData.shell ? g.userData.shell.userData.code : null;
}
function applyIsolate() {
  for (const g of rackGroups) {
    g.visible = !isolateMode || getRackCode(g) === isolateCode;
  }
}

function buildScene() {
  rackGroups.forEach((g) => scene.remove(g));
  rackGroups = [];
  cellRegistry = [];
  furnByCode = {};
  selected = null;
  if (selectionBox) selectionBox.visible = false;
  (state.furniture || []).forEach((f) => {
    const g = createFurniture({ ...f, merges: f.merges || {} }, cellRegistry);
    rackGroups.push(g);
    furnByCode[f.code] = g;
    scene.add(g);
  });
  initSidebar();
  applyIsolate();
}

// ---- 内存 CRUD ----
function findCell(locCode) {
  const f = state.furniture.find((x) => locCode.startsWith(x.code + '-'));
  if (!f) return null;
  const key = locCode.slice(f.code.length + 1);
  return { f, key };
}
function addItem({ name, category, qty, loc_code, note, photo }) {
  const e = findCell(loc_code);
  if (!e) throw new Error('位置无效：' + loc_code);
  e.f.items[e.key] = e.f.items[e.key] || [];
  e.f.items[e.key].push({
    id: (crypto.randomUUID ? crypto.randomUUID() : 'id' + Math.random().toString(36).slice(2)),
    name, category: category || '', qty: Number(qty) || 1, note: note || '', cover: photo || '',
  });
}
function eachItem(cb) {
  for (const f of state.furniture) for (const k in f.items) for (const it of f.items[k]) cb(it, f, k);
}
function updateItem(id, payload) {
  // 先找到物品当前所在 (货架, 格位key, 下标)
  let cur = null;
  for (const f of state.furniture) for (const k in f.items) {
    const idx = f.items[k].findIndex((x) => x.id === id);
    if (idx >= 0) { cur = { f, k, idx, it: f.items[k][idx] }; break; }
  }
  if (!cur) return false;
  const it = cur.it;
  Object.assign(it, {
    name: payload.name != null ? payload.name : it.name,
    category: payload.category != null ? (payload.category || '') : it.category,
    qty: payload.qty != null ? (Number(payload.qty) || 1) : it.qty,
    note: payload.note != null ? payload.note : it.note,
    cover: payload.photo || it.cover,
  });
  // 跨格移动：loc_code = 货架码 + '-' + 格位key（末两段）
  if (payload.loc_code) {
    const parts = payload.loc_code.split('-');
    const key = parts.slice(-2).join('-');
    const furnCode = parts.slice(0, -2).join('-');
    const curLoc = cur.f.code + '-' + cur.k;
    if (payload.loc_code !== curLoc) {
      const tf = state.furniture.find((x) => x.code === furnCode);
      if (tf) {
        cur.f.items[cur.k].splice(cur.idx, 1);
        tf.items[key] = tf.items[key] || [];
        tf.items[key].push(it);
      }
    }
  }
  return true;
}
function deleteItem(id) {
  for (const f of state.furniture) for (const k in f.items) {
    const i = f.items[k].findIndex((x) => x.id === id);
    if (i >= 0) { f.items[k].splice(i, 1); return true; }
  }
  return false;
}
// 库位短码解析（离线版）：与实时版保持一致的三种写法。
//   1) 完整库位码  HOME-BR1-F01-L01-B01
//   2) 货架+层位   F01-L01-B01
//   3) 层位         L01-B01（需配合 rack 列）
// 货架段同时接受家具 code 末段（F01）与家具名称（如「A货架」）。
function resolveImportCell(raw, rackHint) {
  const code = String(raw == null ? '' : raw).trim().toUpperCase();
  if (!code) return null;
  const direct = findCell(code);
  if (direct) return direct;
  const segs = code.split('-').filter(Boolean);
  const rack = String(rackHint == null ? '' : rackHint).trim().toUpperCase();
  let target = code;
  // 只给了层位（2 段）且填了货架列 → 补成「货架-层-位」
  if (rack && segs.length === 2) target = rack + '-' + code;
  const tSegs = target.split('-');
  if (tSegs.length < 3) return null;
  const rackSeg = tSegs[0];
  const key = tSegs.slice(-2).join('-');
  const hits = state.furniture.filter((f) => {
    const c = String(f.code || '').toUpperCase();
    const l = String(f.label || '').toUpperCase();
    return c === rackSeg || c.endsWith('-' + rackSeg) || l === rackSeg;
  });
  if (hits.length !== 1) return null; // 0 个=找不到，多个=歧义
  return { f: hits[0], key };
}
function importRows(rows) {
  const errors = [];
  const plan = [];
  (rows || []).forEach((r, i) => {
    const rowNo = i + 2; // 首行为表头
    const rr = r || {};
    const name = String(rr.name == null ? '' : rr.name).trim();
    if (!name) { errors.push({ row: rowNo, error: '产品名称为空' }); return; }
    const qtyRaw = rr.qty;
    const qty = (qtyRaw === '' || qtyRaw == null) ? 1 : Number(qtyRaw);
    if (!Number.isFinite(qty) || qty <= 0) { errors.push({ row: rowNo, name, error: `数量无效：${qtyRaw}` }); return; }
    const cell = resolveImportCell(rr.loc_code || rr.loc || rr.location, rr.rack || rr.shelf);
    if (!cell) { errors.push({ row: rowNo, name, loc_code: rr.loc_code, error: `未找到库位：${rr.loc_code || '(空)'}` }); return; }
    plan.push({ cell, name, category: rr.category, qty, note: rr.note });
  });
  // 预检未过：整批不导入，回报错误明细
  if (errors.length) return { imported: 0, skipped: errors.length, updated: 0, errors: errors.slice(0, 50) };
  let imported = 0, updated = 0;
  for (const p of plan) {
    const list = (p.cell.f.items[p.cell.key] = p.cell.f.items[p.cell.key] || []);
    const exist = list.find((x) => x.name === p.name);
    if (exist) { exist.qty = (Number(exist.qty) || 0) + p.qty; updated++; } // 同格位同产品 → 累加
    else {
      list.push({
        id: (crypto.randomUUID ? crypto.randomUUID() : 'id' + Math.random().toString(36).slice(2)),
        name: p.name, category: p.category || '', qty: p.qty, note: p.note || '', cover: '',
      });
    }
    imported++;
  }
  return { imported, skipped: 0, updated, errors: [] };
}
function addFurniture({ name, type, rows, cols, width, height, depth, open }) {
  const idx = state.furniture.length;
  const code = 'HOME-BR1-F' + String(idx + 1).padStart(2, '0');
  const x = (idx % 2 === 0) ? 0.7 : -0.7;
  const z = -0.8 - Math.floor(idx / 2) * 0.7;
  state.furniture.push({
    type, code, label: name, position: [x, 0, z],
    width: width || 1.2, height: height || 1.8, depth: depth || 0.55,
    open: open ? 1 : 0,
    rows: Number(rows) || 3, cols: Number(cols) || 4, capacityPerCell: 6, items: {},
  });
}

// ---- 交互：拾取格位 ----
const raycaster = new THREE.Raycaster();
const pointer = new THREE.Vector2();
let selected = null;
function onPointerDown(e) {
  if (drag3dMode) return; // 3D 拖拽模式下不拾取格位，避免冲突
  const rect = renderer.domElement.getBoundingClientRect();
  pointer.x = ((e.clientX - rect.left) / rect.width) * 2 - 1;
  pointer.y = -((e.clientY - rect.top) / rect.height) * 2 + 1;
  raycaster.setFromCamera(pointer, camera);
  const rawHits = raycaster.intersectObjects(cellRegistry.map((c) => c.mesh), false);

  // 过滤掉不可见的对象（隔离模式下被隐藏的货架及其子格位、穿视代理等），
  // 避免"看不见却还能点中"的诡异现象。
  const hits = rawHits.filter((h) => {
    let o = h.object;
    while (o) {
      if (!o.visible) return false;
      o = o.parent;
    }
    return true;
  });
  if (!hits.length) { hideCellPickMenu(); return; }

  // 收集所有命中的不同格位
  const seen = new Set();
  const entries = [];
  for (const h of hits) {
    const entry = cellRegistry.find((c) => c.mesh === h.object);
    if (!entry || seen.has(entry.locCode)) continue;
    seen.add(entry.locCode);
    const p = h.point.clone().project(camera);
    const sx = (p.x * 0.5 + 0.5) * rect.width + rect.left;
    const sy = (-p.y * 0.5 + 0.5) * rect.height + rect.top;
    entries.push(Object.assign({ distance: h.distance, screenD: (sx - e.clientX) ** 2 + (sy - e.clientY) ** 2 }, entry));
  }
  if (!entries.length) { hideCellPickMenu(); return; }

  // 默认策略：优先更靠近相机的前排；深度几乎相同时，取离光标屏幕中心更近的。
  // 这样即使前后格位重叠，只要瞄得准就能直接选中目标。
  entries.sort((a, b) => a.distance - b.distance);
  let best = entries[0];
  for (const en of entries) {
    if (en.distance < best.distance - 0.08) best = en;
    else if (Math.abs(en.distance - best.distance) <= 0.08 && en.screenD < best.screenD) best = en;
  }
  selectCell(best);

  // 同时命中多个格位时，弹出候选菜单供确认/切换（默认项就是已选中的）。
  if (entries.length >= 2) {
    showCellPickMenu(e.clientX, e.clientY, entries);
  } else {
    hideCellPickMenu();
  }
}
renderer.domElement.addEventListener('pointerdown', onPointerDown);

// ---- 多命中候选菜单 ----
let lastHitEntries = [];   // 最近一次点击命中的所有格位（按距离从近到远）
let cellPickIndex = 0;     // 候选菜单当前高亮项

function hideCellPickMenu() {
  const menu = document.getElementById('cellPickMenu');
  if (menu) menu.classList.add('hidden');
}
function showCellPickMenu(screenX, screenY, entries) {
  lastHitEntries = entries;
  cellPickIndex = 0;
  const menu = document.getElementById('cellPickMenu');
  const list = document.getElementById('cellPickList');
  if (!menu || !list) return;
  list.innerHTML = '';
  for (let i = 0; i < entries.length; i++) {
    const e = entries[i];
    const div = document.createElement('div');
    div.className = 'cpm-item' + (i === 0 ? ' active' : '');
    div.innerHTML = `<span>${e.rackCode} · ${e.locCode}</span><span class="cpm-dist">${e.distance.toFixed(2)}m</span>`;
    div.onclick = () => { selectCell(e); hideCellPickMenu(); };
    list.appendChild(div);
  }
  menu.classList.remove('hidden');
  // 简单布局：优先显示在光标右下方，空间不足则左/上调整
  const mw = menu.offsetWidth || 200;
  const mh = menu.offsetHeight || 160;
  let left = screenX + 12, top = screenY + 12;
  if (left + mw > window.innerWidth) left = screenX - mw - 12;
  if (top + mh > window.innerHeight) top = screenY - mh - 12;
  menu.style.left = left + 'px';
  menu.style.top = top + 'px';
}
function renderCellPickActive() {
  const list = document.getElementById('cellPickList');
  if (!list) return;
  [...list.children].forEach((el, i) => el.classList.toggle('active', i === cellPickIndex));
}
function advanceCellPick(dir) {
  if (!lastHitEntries.length) return;
  cellPickIndex = (cellPickIndex + dir + lastHitEntries.length) % lastHitEntries.length;
  renderCellPickActive();
  selectCell(lastHitEntries[cellPickIndex]);
}

// 射线命中多个格位时，用 Tab / Shift+Tab / Enter / Esc 操作候选菜单
//（避免与弹窗 Tab 循环冲突：候选菜单不是 .modal，且只在菜单打开时拦截）
document.addEventListener('keydown', (e) => {
  const menu = document.getElementById('cellPickMenu');
  if (!menu || menu.classList.contains('hidden')) return;
  if (e.key === 'Tab') {
    e.preventDefault();
    advanceCellPick(e.shiftKey ? -1 : 1);
  } else if (e.key === 'Enter') {
    e.preventDefault();
    if (lastHitEntries[cellPickIndex]) { selectCell(lastHitEntries[cellPickIndex]); hideCellPickMenu(); }
  } else if (e.key === 'Escape') {
    e.preventDefault();
    hideCellPickMenu();
  }
});

// ---- 隔离模式控制 ----
function populateIsolateSel() {
  const sel = document.getElementById('isolateSel');
  if (!sel) return;
  sel.innerHTML = rackGroups.map((g) => {
    const c = getRackCode(g);
    const f = (state.furniture || []).find((x) => x.code === c);
    return `<option value="${c}">${f ? f.label : ''}（${c}）</option>`;
  }).join('');
  if (isolateCode) sel.value = isolateCode;
  sel.onchange = () => { isolateCode = sel.value; applyIsolate(); };
}
function setIsolateMode(on) {
  isolateMode = on;
  const btn = document.getElementById('isolateBtn');
  const sel = document.getElementById('isolateSel');
  if (btn) btn.classList.toggle('active', on);
  if (btn) btn.textContent = on ? '🎯 隔离中' : '🎯 隔离';
  if (on) {
    if (!isolateCode || !rackGroups.some((g) => getRackCode(g) === isolateCode)) {
      isolateCode = (selected && selected.rackCode) || (rackGroups[0] ? getRackCode(rackGroups[0]) : null);
    }
    populateIsolateSel();
    if (sel) sel.classList.remove('hidden');
  } else {
    if (sel) sel.classList.add('hidden');
  }
  applyIsolate();
  toast(on ? ('隔离已开启：仅保留「' + (isolateCode || '') + '」，其余货架已隐藏') : '隔离已关闭，所有货架恢复显示');
}
const isolateBtnEl = document.getElementById('isolateBtn');
if (isolateBtnEl) isolateBtnEl.onclick = () => setIsolateMode(!isolateMode);

// ---- 双击顶部圆牌改名 ----
// 分两步：先只跟标牌 Sprite 求交（Sprite 是精确 quad 判定，不受任何 threshold 影响），
// 再做遮挡检查。遮挡只认「可见的实体 Mesh」——
//   · Line/Points 不算：three.js 的 Line 射线阈值默认 1 米，货架外框线会把紧邻其上方的标牌全部挡掉；
//   · material.visible=false 的拖拽代理不算（本就看不见）；
//   · 恒定半透明的货架外壳不算（看得穿就点得到）。
function pickRackLabel(e) {
  const rect = renderer.domElement.getBoundingClientRect();
  pointer.x = ((e.clientX - rect.left) / rect.width) * 2 - 1;
  pointer.y = -((e.clientY - rect.top) / rect.height) * 2 + 1;
  raycaster.setFromCamera(pointer, camera);

  const labels = [];
  for (const g of rackGroups) {
    const sp = g.userData && g.userData.label;
    if (sp) labels.push(sp);
  }
  if (!labels.length) return null;
  const lhits = raycaster.intersectObjects(labels, false);
  if (!lhits.length) return null;
  const labelHit = lhits[0].object;
  const labelDist = lhits[0].distance;

  const hits = raycaster.intersectObjects(scene.children, true);
  for (const h of hits) {
    if (h.distance >= labelDist) break; // 更远的都不构成遮挡
    const o = h.object;
    if (o.isSprite || o.isLine || o.isPoints) continue;
    const m = o.material;
    if (!m || m.visible === false) continue;
    if ((o.userData || {}).type === 'rackShell') continue;
    return null; // 标牌前面挡着实体 → 不触发，避免误改
  }
  return labelHit;
}
renderer.domElement.addEventListener('dblclick', (e) => {
  if (drag3dMode) return; // 3D 拖拽模式下不抢双击
  const sp = pickRackLabel(e);
  if (sp) openLabelRename(sp.userData.code, sp.userData.text);
});
// 悬停到标牌时换成手型光标，提示「这里可以双击改名」
let hoverLabel = false;
let hoverTs = 0;
renderer.domElement.addEventListener('pointermove', (e) => {
  const now = (performance && performance.now) ? performance.now() : Date.now();
  if (now - hoverTs < 80) return; // 节流到 ~12Hz
  hoverTs = now;
  if (drag3dMode) { hoverLabel = false; return; } // 拖拽模式保留十字光标，不抢
  const on = !!pickRackLabel(e);
  if (on !== hoverLabel) {
    hoverLabel = on;
    renderer.domElement.style.cursor = on ? 'pointer' : '';
  }
});

function selectCell(entry) {
  // 防御：切换选中时把所有格位清回基础辉光，避免上次选中态残留在其它格位上
  for (const c of cellRegistry) {
    if (c !== entry) {
      c.mesh.material.emissive.setHex(c._baseEmissive ?? 0x000000);
      c.mesh.material.emissiveIntensity = c._baseEmInt ?? 1;
    }
  }
  if (entry._baseEmissive === undefined) {
    entry._baseEmissive = entry.mesh.material.emissive.getHex();
    entry._baseEmInt = entry.mesh.material.emissiveIntensity;
  }
  selected = entry;
  entry.mesh.material.emissive.setHex(0x22d3ee);
  entry.mesh.material.emissiveIntensity = 0.85;
  positionSelectionBox(entry);
  showSidebar(entry);
}

function showSidebar(entry) {
  const el = document.getElementById('sidebar');
  const itemsHtml = entry.items.length
    ? entry.items.map((i) => `
        <div class="item-card">
          ${i.cover ? `<img class="cover" src="${i.cover}" alt="" />` : ''}
          <div class="row">
            <span class="nm"><b>${i.name}</b> ×${i.qty}${i.note ? ` · ${i.note}` : ''}</span>
            <span class="acts">
              <button class="edit" data-id="${i.id}">编辑</button>
              <button class="del" data-id="${i.id}">删除</button>
            </span>
          </div>
        </div>`).join('')
    : '<div class="muted" style="padding:6px 0">（空）</div>';
  const pct = Math.round(entry.ratio * 100);
  const cf = state.furniture.find((x) => x.code === entry.rackCode);
  const suffix = entry.locCode.split('-').slice(-2).join('-');
  const customName = cf && cf.cellNames && cf.cellNames[suffix];
  const nameVal = (customName || '').replace(/"/g, '&quot;');
  const fillCls = (pct >= 80 || entry.over) ? 'occ-fill hi' : 'occ-fill';
  const m = (cf && cf.cellMeta && cf.cellMeta[suffix]) || {};
  const curStatus = entry.status || 'normal';
  const capVal = (entry.capacity != null) ? entry.capacity : '';
  const loadVal = (m.max_load != null) ? m.max_load : '';
  const tagsVal = (Array.isArray(m.tags) ? m.tags : []).map((t) => String(t).replace(/"/g, '&quot;')).join(', ');
  const noteVal = (m.note || '').replace(/"/g, '&quot;');
  const photos = (Array.isArray(m.photos) ? m.photos : []);
  const photoHtml = photos.length
    ? photos.map((u, i) => `<img class="thumb" src="${u}" data-i="${i}" alt="格位照片">`).join('')
    : '<div class="muted" style="padding:4px 0;font-size:11px">（暂无照片）</div>';
  el.innerHTML = `
    <div class="card loc-card">
      <h3>格位 <span class="pill">${entry.locCode}</span>${customName ? ` <span style="color:#7dd3fc;font-size:13px">· ${customName}</span>` : ''}</h3>
      <div class="occ">占用率 ${pct}% &nbsp;·&nbsp; 物品 ${entry.items.length} 件${capVal !== '' ? ` &nbsp;·&nbsp; 容量 ${capVal} 件` : ''}${entry.over ? ' &nbsp;·&nbsp; <span style="color:#fca5a5">超载</span>' : ''}</div>
      <div class="occ-bar"><div class="${fillCls}" style="width:${pct}%"></div></div>
      <div class="nameLine"><label>名称</label><input id="cellNameInput" value="${nameVal}" placeholder="例如：螺丝区 / SKU" maxlength="24"><button id="cellNameSave">保存</button></div>
      <div class="nameLine" style="margin-top:4px"><label>数量</label><input id="cellQtyInput" type="number" min="0" placeholder="件" value="${entry.items[0] ? entry.items[0].qty : ''}"><span class="muted" style="font-size:11px">保存时同步写入库存</span></div>
      <div class="nameLine" style="margin-top:4px"><button id="cellNameSku" class="ghost sm" ${entry.items && entry.items[0] && entry.items[0].sku ? '' : 'disabled style="opacity:.45;cursor:not-allowed"'}>用库存SKU填充</button><span class="muted" style="font-size:11px">（取本格首个物品的 SKU 作为编号）</span></div>
      <div id="cellNameMsg" class="nameMsg"></div>
      <div class="nameLine" style="margin-top:6px"><label>容量/承重</label>
        <span style="display:inline-flex;gap:6px">
          <input id="cellCapInput" type="number" min="0" placeholder="件" style="width:64px" value="${capVal}">
          <input id="cellLoadInput" type="number" min="0" step="0.1" placeholder="kg" style="width:64px" value="${loadVal}">
        </span>
      </div>
      <div class="nameLine" style="margin-top:6px"><label>状态</label>
        <select id="cellStatusSel" style="flex:1;padding:6px 8px;border-radius:8px;border:1px solid var(--border);background:var(--surface-2);color:var(--text)">
          <option value="normal" ${curStatus === 'normal' ? 'selected' : ''}>正常</option>
          <option value="locked" ${curStatus === 'locked' ? 'selected' : ''}>🔒 锁定（禁止出入库）</option>
          <option value="stocktaking" ${curStatus === 'stocktaking' ? 'selected' : ''}>📋 盘点中</option>
        </select>
      </div>
      <div class="nameLine" style="margin-top:6px"><label>标签</label><input id="cellTagsInput" placeholder="逗号分隔，如 易碎,待检" value="${tagsVal}"></div>
      <div class="nameLine" style="margin-top:6px"><label>备注</label><input id="cellNoteInput" placeholder="格位备注" value="${noteVal}"></div>
      <button id="cellMetaSave" class="full" style="margin-top:8px">保存格位属性</button>
      <div id="cellMetaMsg" class="nameMsg"></div>
      <div class="nameLine" style="margin-top:8px">
        <button id="cellQrBtn" class="ghost sm">📷 打印格位码</button>
        <button id="cellHistBtn" class="ghost sm">🕓 物品时间线</button>
      </div>
      <div class="nameLine" style="margin-top:8px"><label>格位照片</label>
        <button id="cellPhotoBtn" class="ghost sm" type="button">📸 拍照 / 选图</button>
        <input id="cellPhotoInput" type="file" accept="image/*" capture="environment" style="display:none">
      </div>
      <div id="cellPhotos" class="photoWall">${photoHtml}</div>
    </div>
    ${itemsHtml}
    <button id="locateBtn" class="ghost">📍 镜头飞向此处</button>
    <button class="full" id="impBtn">📥 批量导入 CSV</button>
  `;
  document.getElementById('locateBtn').onclick = () => flyTo(entry);
  document.getElementById('impBtn').onclick = openImport;
  const saveBtn = document.getElementById('cellNameSave');
  const nameInput = document.getElementById('cellNameInput');
  const qtyInput = document.getElementById('cellQtyInput');
  const nameMsg = document.getElementById('cellNameMsg');
  saveBtn.onclick = () => {
    const newName = nameInput.value.trim();
    const qtyRaw = qtyInput.value.trim();
    const qty = qtyRaw === '' ? null : parseInt(qtyRaw, 10);
    if (!entry.rackCode) { nameMsg.style.color = '#fca5a5'; nameMsg.textContent = '无法确定所属货架'; return; }
    if (qty !== null && (!Number.isFinite(qty) || qty < 0)) { nameMsg.style.color = '#fca5a5'; nameMsg.textContent = '数量须为大于等于 0 的整数'; return; }
    if (!cf.cellNames) cf.cellNames = {};
    if (newName) cf.cellNames[suffix] = newName; else delete cf.cellNames[suffix];
    // 3D 编号实时刷新（清空时还原为默认 LOC 短码）
    if (entry.label) setCellLabelText(entry.label, newName || (entry.baseLabel || entry.locCode.split('-').slice(-2).join('-')));
    let qtyMsg = '';
    if (qty !== null) {
      if (entry.items.length > 0) {
        entry.items[0].qty = qty;
        qtyMsg = `，数量更新为 ${qty}`;
      } else {
        const sku = newName || suffix;
        entry.items.push({
          id: (crypto.randomUUID ? crypto.randomUUID() : 'id' + Math.random().toString(36).slice(2)),
          name: sku, sku, qty, category: '', note: '', cover: '',
        });
        qtyMsg = `，新建物品 ×${qty}`;
      }
    }
    state._dirty = true;
    nameMsg.style.color = '#86efac'; nameMsg.textContent = '已保存' + qtyMsg + '（内存模式，刷新还原）';
    buildScene();
    const refreshed = cellRegistry.find((c) => c.locCode === entry.locCode);
    if (refreshed) selectCell(refreshed);
  };
  nameInput.onkeydown = (ev) => { if (ev.key === 'Enter') saveBtn.click(); };
  qtyInput.onkeydown = (ev) => { if (ev.key === 'Enter') saveBtn.click(); };
  // 用库存 SKU 一键填充本格编号
  const skuBtn = document.getElementById('cellNameSku');
  if (skuBtn) skuBtn.onclick = () => {
    const sku = entry.items && entry.items[0] && entry.items[0].sku;
    if (!sku) return;
    nameInput.value = sku;
    saveBtn.click();
  };
  el.querySelectorAll('button.edit').forEach((b) => b.onclick = () => openEdit(b.dataset.id));
  el.querySelectorAll('button.del').forEach((b) => b.onclick = () => doDelete(b.dataset.id));
  // 格位扩展属性（容量/承重/状态/标签/备注）保存 —— 离线版仅写入内存
  const metaSaveBtn = document.getElementById('cellMetaSave');
  const metaMsg = document.getElementById('cellMetaMsg');
  if (metaSaveBtn) metaSaveBtn.onclick = () => {
    const capRaw = document.getElementById('cellCapInput').value.trim();
    const loadRaw = document.getElementById('cellLoadInput').value.trim();
    const status = document.getElementById('cellStatusSel').value;
    const tagsRaw = document.getElementById('cellTagsInput').value.trim();
    const note = document.getElementById('cellNoteInput').value.trim();
    const body = {};
    if (capRaw === '') body.capacity = null;
    else { const n = parseInt(capRaw, 10); if (!Number.isFinite(n) || n < 0) { metaMsg.style.color = '#fca5a5'; metaMsg.textContent = '容量须为非负整数'; return; } body.capacity = n; }
    if (loadRaw === '') body.max_load = null;
    else { const v = parseFloat(loadRaw); if (!Number.isFinite(v) || v < 0) { metaMsg.style.color = '#fca5a5'; metaMsg.textContent = '承重须为非负数字'; return; } body.max_load = v; }
    body.status = status;
    body.tags = tagsRaw ? tagsRaw.split(/[,，]/).map((s) => s.trim()).filter(Boolean) : [];
    body.note = note;
    if (!cf.cellMeta) cf.cellMeta = {};
    cf.cellMeta[suffix] = Object.assign({}, cf.cellMeta[suffix] || {}, body);
    state._dirty = true;
    metaMsg.style.color = '#86efac'; metaMsg.textContent = '已保存格位属性（内存模式，刷新还原）';
    buildScene();
    const refreshed = cellRegistry.find((c) => c.locCode === entry.locCode);
    if (refreshed) selectCell(refreshed);
  };
  // 格位现场照片：选图 → 压缩 → 存入内存 cellMeta.photos（离线无后端）
  const cellPhotoInput = document.getElementById('cellPhotoInput');
  if (cellPhotoInput) {
    const cellPhotoBtn = document.getElementById('cellPhotoBtn');
    if (cellPhotoBtn) cellPhotoBtn.onclick = () => cellPhotoInput.click();
  }
  if (cellPhotoInput) cellPhotoInput.onchange = (e) => {
    const file = e.target.files && e.target.files[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      const img = new Image();
      img.onload = () => {
        const scale = Math.min(1, 1000 / Math.max(img.width, img.height));
        const cv = document.createElement('canvas');
        cv.width = Math.round(img.width * scale); cv.height = Math.round(img.height * scale);
        cv.getContext('2d').drawImage(img, 0, 0, cv.width, cv.height);
        const dataUrl = cv.toDataURL('image/jpeg', 0.8);
        if (!cf.cellMeta) cf.cellMeta = {};
        if (!cf.cellMeta[suffix]) cf.cellMeta[suffix] = {};
        cf.cellMeta[suffix].photos = (cf.cellMeta[suffix].photos || []).concat(dataUrl).slice(-12);
        state._dirty = true;
        if (typeof toast === 'function') toast('格位照片已保存（内存）'); else console.log('格位照片已保存');
        showSidebar(entry);
      };
      img.src = reader.result;
    };
    reader.readAsDataURL(file);
  };
  el.querySelectorAll('#cellPhotos .thumb').forEach((im) => im.onclick = () => window.open(im.src, '_blank'));
  const qrBtn = document.getElementById('cellQrBtn');
  if (qrBtn) qrBtn.onclick = () => showCellQR(entry.locCode);
  const histBtn = document.getElementById('cellHistBtn');
  if (histBtn) histBtn.onclick = () => showCellHistory(entry.locCode);
}

// 格位二维码弹窗（复用 labels 的 qrcode-generator 全局 qrcode）
function showCellQR(locCode) {
  const modal = document.getElementById('qrModal');
  const box = document.getElementById('qrBox');
  document.getElementById('qrTitle').textContent = '格位码 · ' + locCode;
  let qr = null;
  try {
    for (let t = 4; t <= 40; t *= 2) {
      try { qr = qrcode(t, 'M'); qr.addData(locCode); qr.make(); break; } catch (_) {}
    }
    if (!qr) { qr = qrcode(40, 'M'); qr.addData(locCode); qr.make(); }
  } catch (e) { box.innerHTML = '<div class="muted">生成失败：' + e.message + '</div>'; modal.classList.remove('hidden'); return; }
  box.innerHTML = qr.createImgTag(6, 10);
  modal.classList.remove('hidden');
}

// 格位物品时间线弹窗（离线：读构建期嵌入的 window.__HISTORY__；无则提示联网版）
function showCellHistory(locCode) {
  const modal = document.getElementById('histModal');
  const box = document.getElementById('histBox');
  document.getElementById('histTitle').textContent = '物品时间线 · ' + locCode;
  const rows = (window.__HISTORY__ && window.__HISTORY__[locCode]) || [];
  if (!rows.length) { box.innerHTML = '<div class="muted">（离线版未包含流转记录，请用联网版）</div>'; modal.classList.remove('hidden'); return; }
  const TYPE = { inbound: '入库', outbound: '出库', move: '移库', merge: '合并', relocate: '重定位', erp_sync: 'ERP同步' };
  box.innerHTML = '<ul class="list">' + rows.map((r) => {
    const dir = (r.from_loc && r.to_loc) ? (r.from_loc + ' → ' + r.to_loc)
      : r.to_loc ? ('→ ' + r.to_loc) : r.from_loc ? ('← ' + r.from_loc) : '—';
    return '<li><span class="code">' + r.occurred_at + '</span> · <b>' + (TYPE[r.move_type] || r.move_type) + '</b> · ' + (r.item_name || '(未知物品)') + ' ×' + r.qty + ' <span class="muted">' + dir + '</span></li>';
  }).join('') + '</ul>';
  modal.classList.remove('hidden');
}

// 批量设置格位（离线：仅写入内存 cellMeta）
function openBatch() {
  const modal = document.getElementById('batchModal');
  const box = document.getElementById('batchBox');
  const groups = {};
  cellRegistry.forEach((e) => { if (!groups[e.rackCode]) groups[e.rackCode] = []; groups[e.rackCode].push(e); });
  const fmap = {};
  state.furniture.forEach((f) => { fmap[f.code] = f.label || f.code; });
  let html = '';
  Object.keys(groups).forEach((code) => {
    const label = fmap[code] || code;
    html += '<div class="batch-grp"><div class="batch-grp-h"><label><input type="checkbox" class="grp-all" data-grp="' + code + '"> <b>' + label + '</b> <span class="muted">' + code + '</span></label></div><div class="batch-cells">';
    groups[code].forEach((e) => {
      const suffix = e.locCode.split('-').slice(-2).join('-');
      html += '<label class="batch-cell"><input type="checkbox" class="cell-chk" value="' + e.locCode + '"> ' + suffix + (e.status === 'locked' ? ' 🔒' : e.status === 'stocktaking' ? ' 📋' : '') + '</label>';
    });
    html += '</div></div>';
  });
  box.innerHTML = html;
  box.querySelectorAll('.grp-all').forEach((cb) => cb.onchange = () => {
    const g = cb.dataset.grp;
    box.querySelectorAll('.cell-chk').forEach((x) => { if (x.value.indexOf(g + '-') === 0) x.checked = cb.checked; });
  });
  document.getElementById('batchCancel').onclick = () => modal.classList.add('hidden');
  document.getElementById('batchApply').onclick = () => {
    const sel = Array.from(box.querySelectorAll('.cell-chk:checked')).map((x) => x.value);
    if (!sel.length) { if (typeof toast === 'function') toast('请先勾选格位'); else alert('请先勾选格位'); return; }
    const status = document.getElementById('batchStatus').value;
    const cap = document.getElementById('batchCap').value.trim();
    const load = document.getElementById('batchLoad').value.trim();
    const tags = document.getElementById('batchTags').value.trim();
    const note = document.getElementById('batchNote').value.trim();
    const meta = { status };
    if (cap) meta.capacity = parseInt(cap, 10);
    if (load) meta.max_load = parseFloat(load);
    if (tags) meta.tags = tags.split(/[,，]/).map((s) => s.trim()).filter(Boolean);
    if (note) meta.note = note;
    sel.forEach((locCode) => {
      const e = findCell(locCode);
      if (!e) return;
      if (!e.f.cellMeta) e.f.cellMeta = {};
      const key = locCode.slice(e.f.code.length + 1);
      e.f.cellMeta[key] = Object.assign({}, e.f.cellMeta[key] || {}, meta);
    });
    state._dirty = true;
    if (typeof toast === 'function') toast('已更新 ' + sel.length + ' 个格位（内存）'); else alert('已更新 ' + sel.length + ' 个格位');
    modal.classList.add('hidden');
    buildScene();
  };
  modal.classList.remove('hidden');
}

// ---- 搜索（本地） ----
function doSearch(q) {
  q = (q || '').trim().toLowerCase();
  const msg = document.getElementById('searchMsg');
  if (!q) { msg.textContent = ''; return; }
  const found = cellRegistry.find((c) => c.locCode.toLowerCase().includes(q))
    || cellRegistry.find((c) => c.items.some((it) => it.name.toLowerCase().includes(q))) || null;
  if (found) {
    selectCell(found); flyTo(found);
    msg.textContent = `已定位：${found.locCode}（${found.items.length} 件）`;
  } else {
    msg.textContent = `未找到包含“${q}”的物品`;
  }
}

// ---- 相机飞行 ----
let tween = null;
function flyTo(entry) {
  const center = entry.center.clone();
  const isWide = !entry.locCode;
  tween = {
    fromPos: camera.position.clone(),
    toPos: isWide
      ? new THREE.Vector3(center.x, center.y + 2.2, center.z + 6.0)
      : new THREE.Vector3(center.x * 0.5, center.y + 0.5, center.z + 2.3),
    fromTarget: controls.target.clone(),
    toTarget: center.clone(),
    t: 0, dur: 1.1,
  };
}
const easeInOut = (x) => (x < 0.5 ? 2 * x * x : 1 - Math.pow(-2 * x + 2, 2) / 2);

// ---- 工具栏 ----
document.getElementById('resetView').onclick = () => {
  flyTo({ center: new THREE.Vector3(0, 1, 0) });
  controls.target.set(0, 1, 0);
};
// ---- 收纳概览 ----
document.getElementById('overviewBtn').onclick = openOverview;
document.getElementById('ov_close').onclick = () => document.getElementById('overviewModal').classList.add('hidden');
document.getElementById('qrBtn').onclick = () => window.open('standalone-labels.html', '_blank');
// 出入库：离线版无后端，打开出入库台会不可用，提示用联网版
const ioBtnEl = document.getElementById('ioBtn');
if (ioBtnEl) ioBtnEl.onclick = () => { if (typeof toast === 'function') toast('离线版不支持出入库，请使用联网版', false); else alert('离线版不支持出入库，请使用联网版'); };

function openOverview() {
  const items = [];
  cellRegistry.forEach((e) => { (e.items || []).forEach((it) => items.push(it)); });
  const totalItems = items.length;
  const totalCells = cellRegistry.length;
  const occupied = cellRegistry.filter((e) => (e.items || []).length > 0).length;
  const occPct = totalCells ? Math.round((occupied / totalCells) * 100) : 0;
  const emptyCells = cellRegistry.filter((e) => (e.items || []).length === 0).length;
  const totalCap = cellRegistry.reduce((s, e) => s + (e.capacity != null ? e.capacity : 6), 0);
  const capPct = totalCap ? Math.round((totalItems / totalCap) * 100) : 0;
  const locked = cellRegistry.filter((e) => e.status === 'locked').length;
  const stocktaking = cellRegistry.filter((e) => e.status === 'stocktaking').length;
  const emptyPct = totalCells ? Math.round((emptyCells / totalCells) * 100) : 0;

  const roomName = (allRooms[roomIndex] && allRooms[roomIndex].name) || '当前空间';
  document.getElementById('ov_room').textContent = roomName;
  document.getElementById('ov_head').innerHTML = `
    <div class="ov-card"><div class="n">${totalItems}</div><div class="l">物品总数</div></div>
    <div class="ov-card"><div class="n">${totalCells}</div><div class="l">格位总数</div></div>
    <div class="ov-card"><div class="n">${occPct}%</div><div class="l">格位占用率（${occupied}/${totalCells}）</div></div>
    <div class="ov-card"><div class="n">${capPct}%</div><div class="l">容量利用率（${totalItems}/${totalCap} 件）</div></div>
    <div class="ov-card"><div class="n">${emptyPct}%</div><div class="l">空置格位（${emptyCells}）</div></div>
    <div class="ov-card"><div class="n" style="color:${(locked + stocktaking) ? '#fbbf24' : '#86efac'}">${locked + stocktaking}</div><div class="l">锁定/盘点中（${locked}/${stocktaking}）</div></div>
  `;

  const catMap = {};
  items.forEach((i) => { const c = (i.category || '未分类').trim() || '未分类'; catMap[c] = (catMap[c] || 0) + 1; });
  const cats = Object.entries(catMap).sort((a, b) => b[1] - a[1]);
  const maxCat = cats.length ? cats[0][1] : 1;
  const catsEl = document.getElementById('ov_cats');
  catsEl.innerHTML = cats.length
    ? cats.map(([c, n]) => `<div class="ov-bar-row"><span class="name" title="${c}">${c}</span><div class="ov-bar-track"><div class="ov-bar-fill" style="width:${Math.max(6, Math.round((n / maxCat) * 100))}%"></div></div><span class="val">${n} 件</span></div>`).join('')
    : '<div class="ov-empty">暂无物品，先去「＋ 录入物品」吧。</div>';

  const furnMap = {};
  cellRegistry.forEach((e) => {
    const code = e.rackCode;
    if (!furnMap[code]) furnMap[code] = { code, label: code, total: 0, occupied: 0, items: 0 };
    furnMap[code].total++;
    if ((e.items || []).length > 0) furnMap[code].occupied++;
    furnMap[code].items += (e.items || []).length;
  });
  (state.furniture || []).forEach((f) => { if (furnMap[f.code]) furnMap[f.code].label = f.label || f.code; });
  const furnList = Object.values(furnMap);
  const furnEl = document.getElementById('ov_furn');
  furnEl.innerHTML = furnList.length
    ? furnList.map((f) => {
        const pct = f.total ? Math.round((f.occupied / f.total) * 100) : 0;
        return `<div class="ov-furn"><span class="nm" title="${f.label}">${f.label}</span><div class="track"><div class="fill" style="width:${pct}%"></div></div><span class="meta">${f.items} 件 · ${pct}%</span></div>`;
      }).join('')
    : '<div class="ov-empty">暂无货架。</div>';

  document.getElementById('ovBatchBtn').onclick = openBatch;
  document.getElementById('overviewModal').classList.remove('hidden');
}
document.getElementById('searchBtn').onclick = () => doSearch(document.getElementById('searchInput').value);
document.getElementById('searchInput').addEventListener('keydown', (e) => { if (e.key === 'Enter') doSearch(e.target.value); });

function initSidebar() {
  const total = cellRegistry.reduce((s, c) => s + c.items.length, 0);
  const occupied = cellRegistry.filter((c) => c.items.length > 0).length;
  const el = document.getElementById('sidebar');
  const usedCells = cellRegistry.filter((c) => c.items.length);
  el.innerHTML = `
    <div class="card">
      <h3>空间概览（离线快照）</h3>
      <div class="occ">格位 ${cellRegistry.length} 个 · 已用 ${occupied} 个 · 物品 ${total} 件</div>
      <p class="hint">点击任意格位查看/编辑物品；或在上方搜索。点「＋ 录入物品」可入库（仅内存，刷新还原）。</p>
    </div>
    ${usedCells.length ? `
    <div class="card">
      <div class="ov-section" style="margin-top:0">已用格位（${usedCells.length}）</div>
      <ul class="list">${usedCells.map((c) => `<li><span class="code">${c.locCode}</span> · ${c.items.length} 件</li>`).join('')}</ul>
    </div>` : '<div class="muted" style="padding:6px 0">暂无已用格位</div>'}
    <button class="full" id="impBtn2">📥 批量导入 CSV</button>
  `;
  document.getElementById('impBtn2').onclick = openImport;
}

// ================= 录入 / 编辑弹窗 =================
const modal = document.getElementById('modal');
let pendingPhoto = null;
let editingId = null;

function ensureCells() {
  const sel = document.getElementById('f_loc');
  if (!sel.options.length) {
    sel.innerHTML = cellRegistry.map((c) => `<option value="${c.locCode}">${c.locCode}</option>`).join('');
  }
}

document.getElementById('addBtn').onclick = () => {
  editingId = null;
  document.getElementById('f_title').textContent = '录入物品';
  document.getElementById('f_name').value = '';
  document.getElementById('f_cat').value = '';
  document.getElementById('f_qty').value = 1;
  document.getElementById('f_note').value = '';
  pendingPhoto = null;
  document.getElementById('f_preview').classList.add('hidden');
  document.getElementById('f_msg').textContent = '';
  ensureCells();
  modal.classList.remove('hidden');
};

function openEdit(id) {
  editingId = id;
  document.getElementById('f_title').textContent = '编辑物品';
  let found = null, foundLoc = null;
  for (const c of cellRegistry) { const it = c.items.find((x) => x.id === id); if (it) { found = it; foundLoc = c.locCode; break; } }
  ensureCells();
  document.getElementById('f_name').value = found ? found.name : '';
  document.getElementById('f_cat').value = found ? (found.category || '') : '';
  document.getElementById('f_qty').value = found ? found.qty : 1;
  document.getElementById('f_note').value = found ? (found.note || '') : '';
  const sel = document.getElementById('f_loc');
  if (foundLoc) sel.value = foundLoc;
  pendingPhoto = found && found.cover ? found.cover : null;
  const pv = document.getElementById('f_preview');
  if (pendingPhoto) { pv.src = pendingPhoto; pv.classList.remove('hidden'); } else pv.classList.add('hidden');
  document.getElementById('f_msg').textContent = '';
  modal.classList.remove('hidden');
}

document.getElementById('f_cancel').onclick = () => { modal.classList.add('hidden'); };

document.getElementById('f_photo').addEventListener('change', (e) => {
  const file = e.target.files[0];
  if (!file) return;
  const reader = new FileReader();
  reader.onload = () => {
    const img = new Image();
    img.onload = () => {
      const scale = Math.min(1, 900 / Math.max(img.width, img.height));
      const cv = document.createElement('canvas');
      cv.width = Math.round(img.width * scale); cv.height = Math.round(img.height * scale);
      cv.getContext('2d').drawImage(img, 0, 0, cv.width, cv.height);
      pendingPhoto = cv.toDataURL('image/jpeg', 0.8);
      const pv = document.getElementById('f_preview');
      pv.src = pendingPhoto; pv.classList.remove('hidden');
    };
    img.src = reader.result;
  };
  reader.readAsDataURL(file);
});

document.getElementById('f_save').onclick = () => {
  const name = document.getElementById('f_name').value.trim();
  const loc = document.getElementById('f_loc').value;
  const msg = document.getElementById('f_msg');
  if (!name || !loc) { msg.style.color = '#fca5a5'; msg.textContent = '请填写物品名称与位置'; return; }
  const payload = {
    name, category: document.getElementById('f_cat').value.trim() || '',
    qty: Number(document.getElementById('f_qty').value) || 1,
    loc_code: loc, note: document.getElementById('f_note').value.trim() || '',
    photo: pendingPhoto,
  };
  msg.style.color = '#fde68a'; msg.textContent = '保存中…';
  try {
    if (editingId) updateItem(editingId, payload); else addItem(payload);
    msg.style.color = '#86efac'; msg.textContent = '已保存 ✓（内存）';
    setTimeout(() => {
      modal.classList.add('hidden');
      pendingPhoto = null; editingId = null;
      document.getElementById('f_preview').classList.add('hidden');
      document.getElementById('f_name').value = '';
      buildScene();
      if (selected) { const s = cellRegistry.find((c) => c.locCode === selected.locCode); if (s) selectCell(s); }
    }, 450);
  } catch (e) {
    msg.style.color = '#fca5a5'; msg.textContent = '保存失败：' + e.message;
  }
};

function doDelete(id) {
  if (!confirm('确认删除该物品？（仅在内存中删除，刷新可还原）')) return;
  deleteItem(id);
  buildScene();
  if (selected) { const s = cellRegistry.find((c) => c.locCode === selected.locCode); if (s) selectCell(s); }
}

// ================= 批量导入（CSV，离线） =================
const impModal = document.getElementById('impModal');
function openImport() { impModal.classList.remove('hidden'); document.getElementById('imp_msg').textContent = ''; }
document.getElementById('imp_cancel').onclick = () => impModal.classList.add('hidden');

// 下载 CSV 模板
document.getElementById('imp_tpl').onclick = () => {
  const BOM = '\uFEFF';
  const rows = [
    'rack,loc_code,name,qty,sku,category,note,erp_code',
    ',A-L01-B01,包装纸箱(小),24,BX-001,纸制品,60×40cm,ERP-BX001',
    'A,L02-B03,螺丝配件包,500,SC-M6,紧固件,M6×20 平头,ERP-SC006',
    ',WH-1-B-L03-B02,电子元器件,100,EC-R01,电子料,防静电包装,ERP-EC101',
  ];
  const csv = BOM + rows.join('\r\n');
  const blob = new Blob([csv], { type: 'text/csv;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = '批量导入模板.csv';
  document.body.appendChild(a); a.click();
  a.remove(); URL.revokeObjectURL(url);
};

function parseCsv(text) {
  const rows = []; let field = '', row = [], inQ = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inQ) { if (ch === '"') { if (text[i + 1] === '"') { field += '"'; i++; } else inQ = false; } else field += ch; }
    else { if (ch === '"') inQ = true; else if (ch === ',') { row.push(field); field = ''; } else if (ch === '\n') { row.push(field); rows.push(row); row = []; field = ''; } else if (ch !== '\r') field += ch; }
  }
  if (field.length || row.length) { row.push(field); rows.push(row); }
  return rows.filter((r) => r.some((c) => c.trim() !== ''));
}
// 中英文表头别名 → 规范化字段名（与联网版对齐：导出中文表头文件也能直接回灌导入）
const IMPORT_FIELD_ALIAS = {
  rack: 'rack', loc_code: 'loc_code', loc: 'loc_code', location: 'loc_code',
  loc_name: 'loc_name', name: 'name', qty: 'qty', quantity: 'qty',
  sku: 'sku', category: 'category', note: 'note', erp_code: 'erp_code',
  '货架': 'rack', '库位': 'loc_code', '库位名': 'loc_name', '物品名称': 'name', '物品': 'name',
  '数量': 'qty', 'sku码': 'sku', '品类': 'category', '分类': 'category', '备注': 'note', 'erp编码': 'erp_code', 'erp': 'erp_code',
};
function csvRowsToObjects(rows) {
  if (!rows.length) return [];
  const header = rows[0].map((h) => { const k = (h || '').trim().toLowerCase(); return IMPORT_FIELD_ALIAS[k] || k; });
  const out = [];
  for (let i = 1; i < rows.length; i++) { const obj = {}; header.forEach((h, idx) => { obj[h] = (rows[i][idx] || '').trim(); }); out.push(obj); }
  return out;
}
document.getElementById('imp_save').onclick = () => {
  const msg = document.getElementById('imp_msg');
  const errBox = document.getElementById('imp_err');
  if (errBox) { errBox.style.display = 'none'; errBox.textContent = ''; }
  const text = document.getElementById('imp_text').value.trim();
  if (!text) { msg.style.color = '#fca5a5'; msg.textContent = '请粘贴 CSV'; return; }
  const rows = csvRowsToObjects(parseCsv(text));
  if (!rows.length) { msg.style.color = '#fca5a5'; msg.textContent = '未解析到数据行'; return; }
  msg.style.color = '#fde68a'; msg.textContent = `导入中…（${rows.length} 行）`;
  try {
    const r = importRows(rows);
    // 预检未过：整批没有导入，逐行列出问题让用户改完重试
    if (r.errors && r.errors.length) {
      msg.style.color = '#fca5a5';
      msg.textContent = `未导入：${r.errors.length} 行有问题，修正后再导一次`;
      if (errBox) {
        errBox.style.display = 'block';
        errBox.style.color = '#fca5a5';
        errBox.textContent = r.errors
          .map((e) => `第 ${e.row} 行${e.name ? '（' + e.name + '）' : ''}：${e.error}`)
          .join('\n');
      }
      return;
    }
    msg.style.color = '#86efac';
    msg.textContent = `已导入 ${r.imported} 条（累加已有格位 ${r.updated} 处，内存）`;
    setTimeout(() => { impModal.classList.add('hidden'); buildScene(); }, 900);
  } catch (e) { msg.style.color = '#fca5a5'; msg.textContent = '导入失败：' + e.message; }
};

// ================= 货架类型目录（驱动开放/封闭与默认尺寸） =================
const RACK_TYPES = {
  shelf:      { open: 1, w: 1.2, h: 1.8, d: 0.4, rows: 3, cols: 4 },
  rack:       { open: 1, w: 1.2, h: 1.8, d: 0.4, rows: 3, cols: 4 },
  drivein:    { open: 1, w: 1.2, h: 2.2, d: 1.2, rows: 4, cols: 2 },
  shuttle:    { open: 1, w: 1.2, h: 2.2, d: 1.2, rows: 4, cols: 2 },
  pushback:   { open: 1, w: 1.2, h: 2.0, d: 0.9, rows: 3, cols: 2 },
  doubledeep: { open: 1, w: 1.2, h: 1.8, d: 0.8, rows: 3, cols: 2 },
  vna:        { open: 1, w: 1.0, h: 2.4, d: 0.4, rows: 4, cols: 3 },
  flow:       { open: 1, w: 1.2, h: 1.6, d: 0.8, rows: 3, cols: 4 },
  cantilever: { open: 1, w: 0.6, h: 2.2, d: 1.0, rows: 3, cols: 1 },
  mezzanine:  { open: 1, w: 2.4, h: 2.6, d: 2.4, rows: 2, cols: 4 },
  asrs:       { open: 1, w: 1.2, h: 3.0, d: 0.4, rows: 6, cols: 3 },
  pegboard:   { open: 1, w: 1.0, h: 1.2, d: 0.1, rows: 2, cols: 4 },
  wardrobe:   { open: 0, w: 0.9, h: 1.8, d: 0.5, rows: 3, cols: 2 },
  box:        { open: 0, w: 0.6, h: 0.4, d: 0.4, rows: 1, cols: 1 },
  cabinet:    { open: 0, w: 0.6, h: 1.0, d: 0.4, rows: 4, cols: 1 },
  mold:       { open: 0, w: 0.8, h: 2.0, d: 0.6, rows: 4, cols: 1 },
  mesh:       { open: 0, w: 1.0, h: 0.9, d: 1.0, rows: 1, cols: 1 },
  mobile:     { open: 0, w: 1.0, h: 2.0, d: 0.5, rows: 5, cols: 4 },
  floor:      { open: 1, w: 3, h: 0.05, d: 2, rows: 6, cols: 6, floor: true },
};

// ================= 添加货架 / 储位 =================
const furnModal = document.getElementById('furnModal');
document.getElementById('f_addFurn').onclick = () => { furnModal.classList.remove('hidden'); document.getElementById('furn_msg').textContent = ''; };
document.getElementById('furn_cancel').onclick = () => furnModal.classList.add('hidden');
document.getElementById('furn_type').onchange = (e) => {
  const v = e.target.value;
  const isFloor = v === 'floor';
  const t = RACK_TYPES[v] || RACK_TYPES.shelf;
  document.getElementById('lbl_rows').firstChild.textContent = isFloor ? '行数' : '层数';
  document.getElementById('lbl_h').firstChild.textContent = isFloor ? '高(地面区无需)' : '高(m)';
  document.getElementById('furn_h').disabled = isFloor;
  document.getElementById('furn_rows').value = t.rows;
  document.getElementById('furn_cols').value = t.cols;
  document.getElementById('furn_w').value = t.w;
  document.getElementById('furn_d').value = t.d;
  document.getElementById('furn_h').value = isFloor ? '' : t.h;
};
document.getElementById('furn_save').onclick = () => {
  const name = document.getElementById('furn_name').value.trim();
  const msg = document.getElementById('furn_msg');
  if (!name) { msg.style.color = '#fca5a5'; msg.textContent = '请填写名称'; return; }
  const type = document.getElementById('furn_type').value;
  const isFloor = type === 'floor';
  const W = +document.getElementById('furn_w').value, H = +document.getElementById('furn_h').value, D = +document.getElementById('furn_d').value;
  addFurniture({
    name, type,
    rows: Number(document.getElementById('furn_rows').value) || (isFloor ? 6 : 3),
    cols: Number(document.getElementById('furn_cols').value) || (isFloor ? 6 : 4),
    width: isFloor ? (W > 0 ? W : 3) : (W > 0 ? W : 1.2),
    height: isFloor ? 0.05 : (H > 0 ? H : 1.8),
    depth: isFloor ? (D > 0 ? D : 2) : (D > 0 ? D : 0.4),
    open: isFloor ? 1 : (RACK_TYPES[type]?.open ?? 0),
  });
  msg.style.color = '#86efac'; msg.textContent = '已生成（内存，刷新还原）';
  setTimeout(() => {
    furnModal.classList.add('hidden');
    document.getElementById('furn_name').value = '';
    buildScene();
    // 从「布局编辑器」内点击「＋添加货架」进来的：保存完自动刷新布局视图
    if (layoutPendingRefresh) {
      layoutPendingRefresh = false;
      layoutState = {
        room: Object.assign({}, state.room || { width: 4, depth: 3, height: 2.6 }),
        furniture: (state.furniture || []).map((f) => ({
          code: f.code, label: f.label,
          x: f.position ? f.position[0] : 0, z: f.position ? f.position[2] : 0,
          rot: f.rotation || 0, w: f.width, h: f.height, d: f.depth,
        })),
      };
      layoutSel = layoutState.furniture[layoutState.furniture.length - 1]?.code || layoutSel;
      renderLayout(); renderList(); layoutMsg('货架已添加');
      setTimeout(() => layoutMsg(''), 1200);
    }
  }, 600);
};

// ================= 货架设置（离线，仅内存） =================
const furnSetModal = document.getElementById('furnSetModal');
function openFurnSetModal(targetCode) {
  const sel = document.getElementById('furnSetSel');
  if (!state.furniture.length) { alert('当前库区还没有货架，请先「添加货架」。'); return; }
  sel.innerHTML = state.furniture.map((f) => `<option value="${f.code}">${f.label}（${f.code}）</option>`).join('');
  if (targetCode) sel.value = targetCode;
  fillFurnSet();
  furnSetModal.classList.remove('hidden');
}
function deleteFurniture(code) {
  const i = state.furniture.findIndex((x) => x.code === code);
  if (i >= 0) state.furniture.splice(i, 1);
  return true;
}
// 计算 n 份复制货架的室内坐标（离线内存版）：从源货架右侧起沿行铺排，避开已有家具，夹在房间内
function computeClonePositions(src, n, occupied, W, D) {
  const gap = 0.6;
  const sw = src.width || src.w || 1.2, sd = src.depth || src.d || 0.4;
  const hw = sw / 2, hd = sd / 2;
  const rects = (occupied || []).map((e) => {
    const ew = e.w || e.width || sw, ed = e.d || e.depth || sd;
    return { x0: e.x - ew / 2 - gap / 2, x1: e.x + ew / 2 + gap / 2, z0: e.z - ed / 2 - gap / 2, z1: e.z + ed / 2 + gap / 2 };
  });
  const overlaps = (x, z) => rects.some((r) => x + hw > r.x0 && x - hw < r.x1 && z + hd > r.z0 && z - hd < r.z1);
  const stepX = sw + gap, stepZ = sd + gap;
  const limX = Math.max(0, W / 2 - hw), limZ = Math.max(0, D / 2 - hd);
  const positions = [];
  const zCands = [];
  for (let k = 0; k < 400 && zCands.length < 200; k++) {
    let z = src.z + (k % 2 ? -1 : 1) * Math.ceil(k / 2) * stepZ;
    z = Math.max(-limZ, Math.min(limZ, z));
    zCands.push(z);
  }
  for (let k = 0; k < zCands.length && positions.length < n; k++) {
    const z = zCands[k];
    const xs0 = (k === 0) ? (src.x + stepX) : -limX; // 首行从源货架右侧开始
    for (let x = xs0; x <= limX + 1e-6 && positions.length < n; x += stepX) {
      if (overlaps(x, z)) continue;
      const key = `${x.toFixed(3)},${z.toFixed(3)}`;
      if (positions.some((p) => `${p.x.toFixed(3)},${p.z.toFixed(3)}` === key)) continue;
      positions.push({ x: +x.toFixed(3), z: +z.toFixed(3) });
    }
  }
  let fb = 0;
  while (positions.length < n) { positions.push({ x: +(-limX + ((fb * stepX) % (2 * limX || 1))).toFixed(3), z: +(-limZ).toFixed(3) }); fb++; }
  return positions;
}

function cloneFurniture(f, n = 1) {
  const src = state.furniture.find((x) => x.code === f.code);
  if (!src) return [];
  const W = (state.room && state.room.width) || 12, D = (state.room && state.room.depth) || 8;
  const occupied = state.furniture.map((e) => ({ x: e.position ? e.position[0] : 0, z: e.position ? e.position[2] : 0, w: e.width || e.w, d: e.depth || e.d }));
  const srcPos = { x: src.position ? src.position[0] : 0, z: src.position ? src.position[2] : 0, w: src.width || src.w, d: src.depth || src.d };
  const positions = computeClonePositions(srcPos, n, occupied, W, D);
  const created = [];
  for (let i = 0; i < n; i++) {
    const copy = JSON.parse(JSON.stringify(src));
    const idx = state.furniture.length;
    copy.code = 'HOME-BR1-F' + String(idx + 1).padStart(2, '0');
    const p = positions[i] || { x: srcPos.x + 0.7 * (i + 1), z: srcPos.z };
    copy.position = [p.x, src.position ? src.position[1] : 0, p.z];
    state.furniture.push(copy);
    created.push(copy.code);
  }
  return created;
}
function fillFurnSet() {
  const f = state.furniture.find((x) => x.code === document.getElementById('furnSetSel').value);
  if (!f) return;
  document.getElementById('furnSet_name').value = f.label || '';
  document.getElementById('furnSet_type').value = f.type || 'shelf';
  document.getElementById('furnSet_w').value = (f.width != null) ? f.width : '';
  document.getElementById('furnSet_h').value = (f.height != null) ? f.height : '';
  document.getElementById('furnSet_d').value = (f.depth != null) ? f.depth : '';
  document.getElementById('furnSet_rows').value = (f.rows != null) ? f.rows : '';
  document.getElementById('furnSet_cols').value = (f.cols != null) ? f.cols : '';
  document.getElementById('furnSet_msg').textContent = '';
}
document.getElementById('furnSetSel').onchange = fillFurnSet;
document.getElementById('furnSet_cancel').onclick = () => furnSetModal.classList.add('hidden');
document.getElementById('furnSet_save').onclick = () => {
  const code = document.getElementById('furnSetSel').value;
  if (!code) return;
  const f = state.furniture.find((x) => x.code === code);
  if (!f) return;
  const type = document.getElementById('furnSet_type').value;
  const W = +document.getElementById('furnSet_w').value, H = +document.getElementById('furnSet_h').value, D = +document.getElementById('furnSet_d').value;
  const rows = +document.getElementById('furnSet_rows').value, cols = +document.getElementById('furnSet_cols').value;
  // 缩小层/列会裁掉超出范围的格位及其库存——先确认（离线版刷新可还原，但仍提示）
  if (rows > 0 && cols > 0 && (rows < (f.rows || 0) || cols < (f.cols || 0))) {
    const ok = confirm(
      `把「${f.label || code}」从 ${f.rows || '?'} 层 × ${f.cols || '?'} 列 改为 ${rows} 层 × ${cols} 列？\n\n` +
      `超出新范围的格位会被删除，其中的库存也会一并清除。\n确定继续吗？`
    );
    if (!ok) return;
  }
  f.label = document.getElementById('furnSet_name').value.trim(); // 允许清空（留空回退显示库位末段）
  f.type = type; f.open = RACK_TYPES[type]?.open ?? 0;
  if (W > 0) f.width = W; if (H > 0) f.height = H; if (D > 0) f.depth = D;
  if (rows > 0) f.rows = rows; if (cols > 0) f.cols = cols;
  const msg = document.getElementById('furnSet_msg');
  msg.style.color = '#86efac'; msg.textContent = '已应用（内存，刷新还原）';
  buildScene();
  setTimeout(() => furnSetModal.classList.add('hidden'), 700);
};
document.getElementById('furnSet_del').onclick = () => {
  const code = document.getElementById('furnSetSel').value;
  if (!code) return;
  if (!confirm(`确定删除货架「${code}」？\n该货架下所有格位与已录入物品将一并删除，不可恢复。`)) return;
  const i = state.furniture.findIndex((x) => x.code === code);
  if (i >= 0) state.furniture.splice(i, 1);
  const msg = document.getElementById('furnSet_msg');
  msg.style.color = '#86efac'; msg.textContent = '已删除（内存，刷新还原）';
  buildScene();
  setTimeout(() => furnSetModal.classList.add('hidden'), 600);
};

// ================= 格位布局（离线，仅内存） =================
const mergeModal = document.getElementById('mergeModal');
let mergeState = null;
const pad2 = (n) => String(n).padStart(2, '0');
function mergesToLink(merges, cols) {
  const link = new Array(cols).fill(false);
  for (const sp of (merges || [])) {
    const a = Math.min(sp[0], sp[1]), b = Math.max(sp[0], sp[1]);
    for (let c = a; c < b; c++) link[c] = true;
  }
  return link;
}
function linkToMerges(link, cols, row) {
  const groups = []; let start = 1;
  for (let c = 1; c < cols; c++) { if (!link[c]) { groups.push([start, c]); start = c + 1; } }
  groups.push([start, cols]);
  const out = groups.filter((g) => g[1] > g[0]).map((g) => [g[0], g[1]]);
  return { [row]: out };
}
function openMergeModal() {
  if (!state.furniture.length) { alert('当前库区还没有货架，请先「添加货架」。'); return; }
  const sel = document.getElementById('mergeSel');
  sel.innerHTML = state.furniture.map((f) => `<option value="${f.code}">${f.label}（${f.code}）</option>`).join('');
  sel.onchange = fillMerge;
  fillMerge();
  mergeModal.classList.remove('hidden');
}
function fillMerge() {
  const f = state.furniture.find((x) => x.code === document.getElementById('mergeSel').value);
  if (!f) return;
  const rows = f.rows || 3, cols = f.cols || 4;
  const link = {};
  for (let r = 1; r <= rows; r++) {
    const row = 'L' + pad2(r);
    link[row] = mergesToLink((f.merges && f.merges[row]) || [], cols);
  }
  mergeState = { code: f.code, label: f.label, rows, cols, link, cellNames: f.cellNames || {} };
  document.getElementById('mergeTitle').textContent = ` · ${f.label}（${f.code}） · ${rows}层 × ${cols}列`;
  renderMergeBody();
}
function renderMergeBody() {
  const body = document.getElementById('mergeBody');
  const { rows, cols, link, cellNames } = mergeState;
  let html = '';
  // 弹窗里从上到下按「从顶层到底层」排列，与 3D 货架视觉一致
  for (let r = rows; r >= 1; r--) {
    const row = 'L' + pad2(r);
    const lk = link[row];
    const groups = []; let start = 1;
    for (let c = 1; c < cols; c++) { if (!lk[c]) { groups.push([start, c]); start = c + 1; } }
    groups.push([start, cols]);
    const rowTagHint = r === rows ? '（顶）' : r === 1 ? '（底）' : '';
    html += `<div class="merge-row"><span class="rowTag">${row}${rowTagHint}</span><div class="merge-cols" data-row="${row}">`;
    groups.forEach((g, gi) => {
      const [a, b] = g;
      const suffix = `${row}-B${pad2(a)}`;
      const label = a === b ? 'B' + pad2(a) : 'B' + pad2(a) + '-' + pad2(b);
      const nameVal = (cellNames[suffix] || '').replace(/"/g, '&quot;');
      const merged = b > a;
      html += `<div class="mcell">`;
      html += `<div class="mchip${merged ? ' merged' : ''}">${label}${merged ? ` <span class="msplit" data-act="split" data-row="${row}" data-a="${a}" data-b="${b}" title="拆回单格">✂拆分</span>` : ''}</div>`;
      html += `<input class="cellName" data-suffix="${suffix}" value="${nameVal}" placeholder="命名此格" maxlength="24" />`;
      html += `</div>`;
      if (gi < groups.length - 1) html += `<div class="mlink on" data-act="toggle" data-row="${row}" data-b="${b}" title="与右侧合并">✂</div>`;
    });
    html += `</div></div>`;
  }
  body.innerHTML = html;
}
document.getElementById('mergeBody').addEventListener('click', (e) => {
  const t = e.target.closest('[data-act]'); if (!t || !mergeState) return;
  const row = t.dataset.row, b = +t.dataset.b;
  if (t.dataset.act === 'split') {
    const a = +t.dataset.a;
    for (let c = a; c < b; c++) mergeState.link[row][c] = false; // 把这一组合并拆回单格
    renderMergeBody();
    return;
  }
  // 合并：切换该组右边界（与右侧相邻组合并）
  if (b < 1 || b >= mergeState.cols) return;
  mergeState.link[row][b] = !mergeState.link[row][b];
  renderMergeBody();
});
document.getElementById('merge_save').onclick = () => {
  const { code, rows, cols, link } = mergeState;
  const merges = {};
  for (let r = 1; r <= rows; r++) {
    const row = 'L' + pad2(r);
    const e = linkToMerges(link[row], cols, row)[row];
    if (e && e.length) merges[row] = e;
  }
  // 收集每格自定义名称（含空串=清空；被合并吞掉的列没有输入框，不会误改）
  const names = {};
  document.querySelectorAll('#mergeBody input.cellName').forEach((inp) => { names[inp.dataset.suffix] = inp.value.trim(); });
  const f = state.furniture.find((x) => x.code === code);
  if (f) {
    f.merges = merges;
    f.cellNames = names;
    // 把被吞并列的在库物品并入主格位，避免物品在 3D 中“消失”
    const items = f.items || {};
    for (const row of Object.keys(merges)) {
      for (const [a, b] of merges[row]) {
        const headKey = `${row}-B${pad2(a)}`;
        for (let c = a + 1; c <= b; c++) {
          const k = `${row}-B${pad2(c)}`;
          if (items[k]) { items[headKey] = (items[headKey] || []).concat(items[k]); delete items[k]; }
        }
      }
    }
    f.items = items;
  }
  const msg = document.getElementById('merge_msg');
  msg.style.color = '#86efac'; msg.textContent = '已保存（内存，刷新还原）';
  buildScene();
  setTimeout(() => mergeModal.classList.add('hidden'), 800);
};
document.getElementById('merge_clear').onclick = () => {
  if (!mergeState) return;
  if (!confirm('确定要清除该货架上所有格位合并吗？已存放的物品仍会保留在各自的库位上。')) return;
  for (const row of Object.keys(mergeState.link)) {
    mergeState.link[row].fill(false);
  }
  renderMergeBody();
  document.getElementById('merge_msg').textContent = '';
};
document.getElementById('merge_sku').onclick = () => {
  if (!mergeState) return;
  const f = state.furniture.find((x) => x.code === mergeState.code);
  const items = (f && f.items) || {};
  let filled = 0;
  document.querySelectorAll('#mergeBody input.cellName').forEach((inp) => {
    const sku = (items[inp.dataset.suffix] || [])[0];
    if (sku && sku.sku) { inp.value = sku.sku; filled++; }
  });
  document.getElementById('merge_msg').style.color = '#7dd3fc';
  document.getElementById('merge_msg').textContent = `已用 SKU 填充 ${filled} 个有库存的格位（点「保存布局」生效）`;
};
document.getElementById('merge_cancel').onclick = () => mergeModal.classList.add('hidden');
document.getElementById('mergeBtn').onclick = openMergeModal;


// ================= 双击标牌改名（离线，仅内存） =================
const labelModal = document.getElementById('labelModal');
let labelTarget = null;
function openLabelRename(code, cur) {
  if (!code) return;
  labelTarget = code;
  const inp = document.getElementById('labelInput');
  inp.value = cur || '';
  document.getElementById('label_msg').textContent = '';
  labelModal.classList.remove('hidden');
  setTimeout(() => { inp.focus(); inp.select(); }, 30);
}
document.getElementById('label_cancel').onclick = () => labelModal.classList.add('hidden');
document.getElementById('labelInput').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') document.getElementById('label_save').click();
  if (e.key === 'Escape') labelModal.classList.add('hidden');
});
document.getElementById('label_save').onclick = () => {
  const code = labelTarget;
  if (!code) return;
  const raw = document.getElementById('labelInput').value.trim();
  const f = state.furniture.find((x) => x.code === code);
  if (!f) return;
  f.label = raw;
  const text = raw || String(code).split('-').pop() || code; // 留空则回退显示库位末段
  const g = furnByCode[code];
  if (g && g.userData && g.userData.label) setRackLabelText(g.userData.label, text);
  _dirty = true;
  const msg = document.getElementById('label_msg');
  msg.style.color = '#86efac'; msg.textContent = raw ? '已改名（内存，刷新还原）' : '已清空（显示回退为库位末段）';
  setTimeout(() => labelModal.classList.add('hidden'), 500);
};

// ================= 库区设置（离线，仅内存） =================
const roomModal = document.getElementById('roomModal');
// 当前库区开口（优先取 3D 库区组的最新状态，含拖动后的 offset）
function currentOpenings(type) {
  const ud = (roomGroup && roomGroup.userData) ? roomGroup.userData : {};
  const list = Array.isArray(ud.openings) ? ud.openings : [];
  const from3d = list.filter((o) => o.type === type).map((o) => ({ side: o.side, offset: o.offset }));
  if (from3d.length) return from3d;
  return normOpeningsFE((state.room && state.room[type]) || null);
}
function openRoomModal() {
  document.getElementById('room_name').value = (allRooms[roomIndex] && allRooms[roomIndex].name) || '';
  // 门/窗已拆到「🚪 门窗」弹窗，本弹窗只管名称与尺寸
  document.getElementById('r_w').value = (state.room && state.room.width != null) ? state.room.width : '';
  document.getElementById('r_d').value = (state.room && state.room.depth != null) ? state.room.depth : '';
  document.getElementById('r_h').value = (state.room && state.room.height != null) ? state.room.height : '';
  document.getElementById('room_msg').textContent = '';
  roomModal.classList.remove('hidden');
}
document.getElementById('roomBtn').onclick = openRoomModal;
document.getElementById('roomEditBtn').onclick = openRoomModal;
document.getElementById('room_cancel').onclick = () => roomModal.classList.add('hidden');
document.getElementById('room_save').onclick = () => {
  // 门/窗由「🚪 门窗」弹窗管理，此处原样保留（不能丢，否则重建库区时门/窗会消失）
  const door = currentOpenings('door');
  const win = currentOpenings('window');
  const name = document.getElementById('room_name').value.trim();
  const W = +document.getElementById('r_w').value, D = +document.getElementById('r_d').value, H = +document.getElementById('r_h').value;
  const msg = document.getElementById('room_msg');
  state.room = Object.assign({}, state.room || {}, { door, window: win });
  if (W > 0) state.room.width = W; if (D > 0) state.room.depth = D; if (H > 0) state.room.height = H;
  if (name) allRooms[roomIndex] = Object.assign({}, allRooms[roomIndex], { name });
  rebuildRoom(state.room);
  if (name) syncRoomSel();
  msg.style.color = '#86efac'; msg.textContent = `已应用（${state.room.width}×${state.room.depth}×${state.room.height}m）${name ? `，名称：${name}` : ''} — 门/窗请在「🚪 门窗」里管理 — 仅内存，刷新还原`;
  setTimeout(() => roomModal.classList.add('hidden'), 900);
};
document.getElementById('room_del').onclick = () => {
  if (allRooms.length <= 1) { alert('至少保留一个库区，不能删除最后一个。'); return; }
  if (!confirm(`确定删除当前库区及其下所有货架与物品？\n库区：${allRooms[roomIndex] ? allRooms[roomIndex].name : ''}\n此操作不可恢复。`)) return;
  allRooms.splice(roomIndex, 1);
  roomIndex = Math.min(roomIndex, allRooms.length - 1);
  state = stateFromRoom(allRooms[roomIndex]);
  rebuildRoom(state.room);
  buildScene();
  syncRoomSel();
  const msg = document.getElementById('room_msg');
  msg.style.color = '#86efac'; msg.textContent = '已删除（内存，刷新还原）';
  setTimeout(() => roomModal.classList.add('hidden'), 700);
};

// 离线版修改无持久化：刷新前提示
let _dirty = false;
['furn_save', 'furnSet_save', 'furnSet_del', 'room_save', 'room_del', 'imp_save'].forEach((id) => {
  const el = document.getElementById(id); if (el) el.addEventListener('click', () => { _dirty = true; });
});
window.addEventListener('beforeunload', (e) => { if (_dirty) { e.preventDefault(); e.returnValue = ''; } });


// ================= 扫码定位（本地匹配） =================
const scanModal = document.getElementById('scanModal');
let scanStream = null, scanRAF = null;
document.getElementById('scanBtn').onclick = () => { scanModal.classList.remove('hidden'); startScan(); };
document.getElementById('scan_cancel').onclick = () => { stopScan(); scanModal.classList.add('hidden'); };
async function startScan() {
  const video = document.getElementById('scanVideo');
  const msg = document.getElementById('scanMsg');
  try {
    scanStream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment' } });
    video.srcObject = scanStream; await video.play();
    msg.textContent = '将二维码对准摄像头…';
    const tick = () => {
      if (video.readyState === video.HAVE_ENOUGH_DATA && video.videoWidth) {
        const cv = document.createElement('canvas'); cv.width = video.videoWidth; cv.height = video.videoHeight;
        const ctx = cv.getContext('2d'); ctx.drawImage(video, 0, 0, cv.width, cv.height);
        const img = ctx.getImageData(0, 0, cv.width, cv.height);
        const code = window.jsQR ? window.jsQR(img.data, img.width, img.height, { inversionAttempts: 'dontInvert' }) : null;
        if (code && code.data) {
          const loc = code.data.trim();
          const cell = cellRegistry.find((c) => c.locCode === loc) || cellRegistry.find((c) => c.locCode.startsWith(loc));
          if (cell) { msg.textContent = `已识别：${loc}，定位中…`; stopScan(); scanModal.classList.add('hidden'); selectCell(cell); flyTo(cell); document.getElementById('searchMsg').textContent = `扫码定位：${loc}`; return; }
          else msg.textContent = `码内容「${loc}」在空间中无对应格位`;
        }
      }
      scanRAF = requestAnimationFrame(tick);
    };
    scanRAF = requestAnimationFrame(tick);
  } catch (e) { msg.style.color = '#fca5a5'; msg.textContent = '无法开启摄像头：' + e.message; }
}
function stopScan() { if (scanRAF) cancelAnimationFrame(scanRAF); scanRAF = null; if (scanStream) { scanStream.getTracks().forEach((t) => t.stop()); scanStream = null; } }

// ================= 布局编辑（离线：内存 + 模板导入导出） =================
const layoutModal = document.getElementById('layoutModal');
const SVGNS = 'http://www.w3.org/2000/svg';
const LPAD = 34;
const KOFF = 13;            // 旋转手柄相对货架右上角的偏移（SVG 像素，确保明显在矩形外侧）
const LAYOUT_FIT_W = 1200; // 适应窗口时的回退画布宽（像素；能量到画布时以实际尺寸为准）
const LAYOUT_FIT_H = 820;  // 适应窗口时的回退画布高（像素）
let layoutState = null;
let layoutSel = null;
let layoutZoom = 1;        // 布局视图缩放（1 = 适应窗口）
let layoutPendingRefresh = false; // 从布局编辑器内打开添加货架后，保存完自动刷新布局视图

function layoutMsg(t) { document.getElementById('layout_msg').textContent = t || ''; }
// 适应窗口：优先按画布当前可见尺寸计算（modal 隐藏时量不到，退回常量）
function layoutFitScale() {
  const W = layoutState.room.width, D = layoutState.room.depth;
  let aw = LAYOUT_FIT_W, ah = LAYOUT_FIT_H;
  const box = document.querySelector('.layout-canvas');
  if (box) {
    // 强制同步布局，确保读到 flex 完成后的真实尺寸（否则可能拿到旧 SVG 撑出的内容高度）
    void box.offsetHeight;
    if (box.clientWidth > 60 && box.clientHeight > 60) { aw = box.clientWidth - 10; ah = box.clientHeight - 10; }
  }
  return Math.max(1, Math.min((aw - 2 * LPAD) / W, (ah - 2 * LPAD) / D));
}
function layoutScale() { return layoutFitScale() * layoutZoom; }
function setLayoutZoom(z) { layoutZoom = Math.max(0.3, Math.min(6, z)); renderLayout(); updateLayoutZoomLbl(); }
function updateLayoutZoomLbl() { const el = document.getElementById('layoutZoomLbl'); if (el) el.textContent = `缩放 ${Math.round(layoutZoom * 100)}%`; }
function w2s(x, z, W, D, s) { return [(x + W / 2) * s + LPAD, (z + D / 2) * s + LPAD]; }
function svgPoint(svg, e) { const p = svg.createSVGPoint(); p.x = e.clientX; p.y = e.clientY; const m = svg.getScreenCTM().inverse(); const r = p.matrixTransform(m); return { x: r.x, y: r.y }; }

// 门/窗数据规范化（前端兜底，兼容字符串旧格式）：→ [{ side, offset }]
function normOpeningsFE(v) {
  if (v == null) return [];
  const SIDES = ['back', 'left', 'right', 'front'];
  const clamp = (o) => { const n = Number(o); return Number.isFinite(n) ? Math.min(0.95, Math.max(0.05, n)) : 0.5; };
  const one = (x) => {
    if (typeof x === 'string') return SIDES.includes(x) ? { side: x, offset: 0.5 } : null;
    if (x && typeof x === 'object' && SIDES.includes(x.side)) return { side: x.side, offset: clamp(x.offset) };
    return null;
  };
  return (Array.isArray(v) ? v : [v]).map(one).filter(Boolean);
}
const lerpPt = (a, b, t) => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];

// 在俯视图上标出房门（橙）与窗户（蓝）：按 offset 定位在墙面上的任意位置，并留出门/窗洞
function drawRoom(svg, W, D, s, door, win) {
  // 与 renderLayout 中的 room rect 左上角对齐（w2s(-W/2,-D/2) = LPAD,LPAD）
  const rx = LPAD, ry = LPAD;
  const x0 = rx, y0 = ry, x1 = rx + W * s, y1 = ry + D * s;
  const sides = {
    back:  { a: [x0, y0], b: [x1, y0], dir: [1, 0], n: [0, 1] },
    front: { a: [x0, y1], b: [x1, y1], dir: [1, 0], n: [0, -1] },
    left:  { a: [x0, y0], b: [x0, y1], dir: [0, 1], n: [1, 0] },
    right: { a: [x1, y0], b: [x1, y1], dir: [0, 1], n: [-1, 0] },
  };
  const sideLen = (side) => (side === 'back' || side === 'front') ? (W * s) : (D * s);
  const mkLine = (ax, ay, bx, by, cls, color, wpx) => {
    const l = document.createElementNS(SVGNS, 'line');
    l.setAttribute('x1', ax); l.setAttribute('y1', ay); l.setAttribute('x2', bx); l.setAttribute('y2', by);
    if (cls) l.setAttribute('class', cls);
    if (color) { l.setAttribute('stroke', color); l.setAttribute('stroke-width', wpx || 2); }
    svg.appendChild(l);
  };
  // 按墙面归集开口
  const bySide = {};
  for (const op of normOpeningsFE(door)) (bySide[op.side] = bySide[op.side] || []).push({ ...op, type: 'door' });
  for (const op of normOpeningsFE(win)) (bySide[op.side] = bySide[op.side] || []).push({ ...op, type: 'window' });

  for (const side of ['back', 'left', 'right', 'front']) {
    const S = sides[side];
    const ops = (bySide[side] || []).slice().sort((a, b) => a.offset - b.offset);
    if (!ops.length) { mkLine(S.a[0], S.a[1], S.b[0], S.b[1], 'wall'); continue; }
    let prev = 0;
    for (const op of ops) {
      const L = sideLen(side);
      const openPx = op.type === 'door' ? Math.min(50, L * 0.45) : Math.min(40, L * 0.4);
      const half = (openPx / L) / 2;
      const g0 = Math.max(prev, Math.min(1, op.offset - half));
      const g1 = Math.max(g0, Math.min(1, op.offset + half));
      if (g0 > prev) { // 开口左侧的实墙段
        const p1 = lerpPt(S.a, S.b, prev), p2 = lerpPt(S.a, S.b, g0);
        mkLine(p1[0], p1[1], p2[0], p2[1], 'wall');
      }
      const c = lerpPt(S.a, S.b, (g0 + g1) / 2);
      const spanPx = (g1 - g0) * L;
      if (op.type === 'door') drawDoorSymbol(svg, c[0], c[1], S.dir, S.n, spanPx);
      else drawWindowSymbol(svg, c[0], c[1], S.dir, S.n, spanPx);
      prev = Math.max(prev, g1);
    }
    if (prev < 1) { // 最后一个开口右侧的实墙段
      const p1 = lerpPt(S.a, S.b, prev);
      mkLine(p1[0], p1[1], S.b[0], S.b[1], 'wall');
    }
  }
}

function drawDoorSymbol(svg, cx, cy, dir, n, openPx) {
  const color = '#d97706';
  const hinge = [cx - dir[0] * openPx / 2, cy - dir[1] * openPx / 2];
  const tip = [hinge[0] + n[0] * openPx, hinge[1] + n[1] * openPx];
  const openEnd = [cx + dir[0] * openPx / 2, cy + dir[1] * openPx / 2];
  const cross = dir[0] * n[1] - dir[1] * n[0];
  const sweep = cross > 0 ? 0 : 1;
  const l = document.createElementNS(SVGNS, 'line');
  l.setAttribute('x1', hinge[0]); l.setAttribute('y1', hinge[1]); l.setAttribute('x2', tip[0]); l.setAttribute('y2', tip[1]);
  l.setAttribute('stroke', color); l.setAttribute('stroke-width', 2.5); svg.appendChild(l);
  const p = document.createElementNS(SVGNS, 'path');
  p.setAttribute('d', `M ${tip[0].toFixed(1)} ${tip[1].toFixed(1)} A ${openPx} ${openPx} 0 0 ${sweep} ${openEnd[0].toFixed(1)} ${openEnd[1].toFixed(1)}`);
  p.setAttribute('fill', 'none'); p.setAttribute('stroke', color); p.setAttribute('stroke-width', 1.5); svg.appendChild(p);
  const h = document.createElementNS(SVGNS, 'circle');
  h.setAttribute('cx', hinge[0]); h.setAttribute('cy', hinge[1]); h.setAttribute('r', 2.5);
  h.setAttribute('fill', color); svg.appendChild(h);
  const t = document.createElementNS(SVGNS, 'text');
  t.setAttribute('x', cx + n[0] * (openPx * 0.55)); t.setAttribute('y', cy + n[1] * (openPx * 0.55) + 4);
  t.setAttribute('text-anchor', 'middle'); t.setAttribute('font-size', 11); t.setAttribute('font-weight', 'bold'); t.setAttribute('fill', color);
  t.textContent = '门'; svg.appendChild(t);
}

function drawWindowSymbol(svg, cx, cy, dir, n, openPx) {
  const color = '#38bdf8';
  const t = 7;
  const s0 = [cx - dir[0] * openPx / 2, cy - dir[1] * openPx / 2];
  const s1 = [cx + dir[0] * openPx / 2, cy + dir[1] * openPx / 2];
  const inner0 = [s0[0] + n[0] * t, s0[1] + n[1] * t];
  const inner1 = [s1[0] + n[0] * t, s1[1] + n[1] * t];
  const poly = document.createElementNS(SVGNS, 'polygon');
  poly.setAttribute('points', `${s0[0]},${s0[1]} ${s1[0]},${s1[1]} ${inner1[0]},${inner1[1]} ${inner0[0]},${inner0[1]}`);
  poly.setAttribute('fill', 'rgba(56,189,248,.22)'); poly.setAttribute('stroke', color); poly.setAttribute('stroke-width', 1.5); svg.appendChild(poly);
  const m0 = [(s0[0] + inner0[0]) / 2, (s0[1] + inner0[1]) / 2];
  const m1 = [(s1[0] + inner1[0]) / 2, (s1[1] + inner1[1]) / 2];
  const ml = document.createElementNS(SVGNS, 'line');
  ml.setAttribute('x1', m0[0]); ml.setAttribute('y1', m0[1]); ml.setAttribute('x2', m1[0]); ml.setAttribute('y2', m1[1]);
  ml.setAttribute('stroke', color); ml.setAttribute('stroke-width', 1); svg.appendChild(ml);
  const tx = document.createElementNS(SVGNS, 'text');
  tx.setAttribute('x', cx + n[0] * (t + 8)); tx.setAttribute('y', cy + n[1] * (t + 8) + 4);
  tx.setAttribute('text-anchor', 'middle'); tx.setAttribute('font-size', 11); tx.setAttribute('font-weight', 'bold'); tx.setAttribute('fill', color);
  tx.textContent = '窗'; svg.appendChild(tx);
}

function findFurnState(code) { return state.furniture.find((x) => x.code === code); }
function applyTransform(f) {
  const g = furnByCode[f.code];
  if (g) { g.position.x = f.x; g.position.z = f.z; g.rotation.y = f.rot; g.updateMatrixWorld(true); for (const c of cellRegistry) if (c.rackCode === f.code) c.center.copy(g.localToWorld(c.localCenter.clone())); }
  const st = findFurnState(f.code);
  if (st) { st.position = [f.x, st.position ? st.position[1] : 0, f.z]; st.rotation = f.rot; }
}
function selectLayout(code) {
  layoutSel = code;
  if (layoutState) {
    for (const f of layoutState.furniture) {
      if (!f._el) continue;
      const on = (layoutSel === f.code);
      f._el.rect.setAttribute('class', 'furn' + (on ? ' sel' : '') + (f.open ? ' open' : ''));
      f._el.g.style.filter = on ? 'drop-shadow(0 0 6px rgba(59,130,246,.6))' : '';
      // 旋转手柄/连线/坐标提示只在选中时显示：未选中的货架只能拖动移动，杜绝误触旋转
      if (f._el.knob) f._el.knob.classList.toggle('hide', !on);
      if (f._el.knobLink) f._el.knobLink.classList.toggle('hide', !on);
      if (f._el.tip) f._el.tip.classList.toggle('hide', !on);
    }
  }
  renderList();
}
function snapValue(v, grid) { return grid > 0 ? Math.round(v / grid) * grid : v; }
function clampInRoom(f) {
  const W = layoutState.room.width, D = layoutState.room.depth;
  const hw = f.w / 2, hd = f.d / 2;
  f.x = Math.max(-W / 2 + hw, Math.min(W / 2 - hw, f.x));
  f.z = Math.max(-D / 2 + hd, Math.min(D / 2 - hd, f.z));
}
function updateFurnEl(f) {
  if (!f._el) return;
  const W = layoutState.room.width, D = layoutState.room.depth, s = layoutScale();
  const [cx, cy] = w2s(f.x, f.z, W, D, s);
  const deg = -f.rot * 180 / Math.PI;
  f._el.g.setAttribute('transform', `translate(${cx.toFixed(2)},${cy.toFixed(2)}) rotate(${deg.toFixed(2)})`);
  if (f._el.tip) {
    f._el.tip.setAttribute('x', cx); f._el.tip.setAttribute('y', cy + f.d * s / 2 + 16);
    f._el.tip.textContent = `X ${f.x.toFixed(2)}  Z ${f.z.toFixed(2)}  ${Math.round(f.rot * 180 / Math.PI)}°`;
  }
}

function renderLayout() {
  const svg = document.getElementById('layoutSvg');
  const W = layoutState.room.width, D = layoutState.room.depth, s = layoutScale();
  const vw = W * s + 2 * LPAD, vh = D * s + 2 * LPAD;
  svg.setAttribute('viewBox', `0 0 ${vw} ${vh}`);
  svg.setAttribute('width', vw);   // 真实像素尺寸：配合可滚动容器，缩放时视图真正变大
  svg.setAttribute('height', vh);
  svg.innerHTML = '';
  const [rx, ry] = w2s(-W / 2, -D / 2, W, D, s);
  const room = document.createElementNS(SVGNS, 'rect');
  room.setAttribute('x', rx); room.setAttribute('y', ry);
  room.setAttribute('width', W * s); room.setAttribute('height', D * s);
  room.setAttribute('class', 'room');
  svg.appendChild(room);
  drawRoom(svg, W, D, s, layoutState.room.door, layoutState.room.window);
  for (const f of layoutState.furniture) {
    const [cx, cy] = w2s(f.x, f.z, W, D, s);
    const w = f.w * s, h = f.d * s;
    const deg = -f.rot * 180 / Math.PI;
    const g = document.createElementNS(SVGNS, 'g');
    g.setAttribute('transform', `translate(${cx.toFixed(2)},${cy.toFixed(2)}) rotate(${deg.toFixed(2)})`);
    const rect = document.createElementNS(SVGNS, 'rect');
    rect.setAttribute('x', -w / 2); rect.setAttribute('y', -h / 2);
    rect.setAttribute('width', w); rect.setAttribute('height', h); rect.setAttribute('rx', 3);
    rect.setAttribute('class', 'furn' + (layoutSel === f.code ? ' sel' : '') + (f.open ? ' open' : ''));
    g.appendChild(rect);
    const colN = Number(f.cols) || 0;
    if (colN > 1) {
      for (let c = 1; c < colN; c++) {
        const dx = -w / 2 + (w * c) / colN;
        const ln = document.createElementNS(SVGNS, 'line');
        ln.setAttribute('x1', dx); ln.setAttribute('y1', -h / 2);
        ln.setAttribute('x2', dx); ln.setAttribute('y2', h / 2);
        ln.setAttribute('class', 'furn-div' + (f.open ? ' open' : ''));
        g.appendChild(ln);
      }
    }
    const txt = document.createElementNS(SVGNS, 'text');
    txt.setAttribute('x', 0); txt.setAttribute('y', 4); txt.setAttribute('text-anchor', 'middle');
    txt.setAttribute('font-size', 11); txt.setAttribute('fill', '#e2e8f0');
    txt.textContent = f.label;
    g.appendChild(txt);
    // 旋转手柄：放置于货架右上角外侧，并仅当选中时可见——与「拖动主体移动」彻底分开，避免误触。
    const selected = (f.code === layoutSel);
    const knobLink = document.createElementNS(SVGNS, 'line');
    knobLink.setAttribute('x1', w / 2); knobLink.setAttribute('y1', -h / 2);
    knobLink.setAttribute('x2', w / 2 + KOFF); knobLink.setAttribute('y2', -(h / 2 + KOFF));
    knobLink.setAttribute('class', 'knob-link' + (selected ? '' : ' hide'));
    g.appendChild(knobLink);
    const knob = document.createElementNS(SVGNS, 'circle');
    knob.setAttribute('cx', w / 2 + KOFF); knob.setAttribute('cy', -(h / 2 + KOFF)); knob.setAttribute('r', 9);
    knob.setAttribute('class', 'knob' + (selected ? '' : ' hide'));
    g.appendChild(knob);
    const tip = document.createElementNS(SVGNS, 'text');
    tip.setAttribute('x', cx); tip.setAttribute('y', cy + h / 2 + 16); tip.setAttribute('text-anchor', 'middle');
    tip.setAttribute('class', 'drag-tip' + (selected ? '' : ' hide'));
    tip.textContent = `X ${f.x.toFixed(2)}  Z ${f.z.toFixed(2)}  ${Math.round(f.rot * 180 / Math.PI)}°`;
    svg.appendChild(tip);
    svg.appendChild(g);
    f._el = { g, rect, knob, knobLink, tip };
    attachFurn(g, rect, knob, f);
  }
}

function attachFurn(g, rect, knob, f) {
  const svg = document.getElementById('layoutSvg');
  let mode = null, start = null;
  const grid = () => +document.getElementById('snapGrid').value || 0;
  const centerOf = () => {
    const s = layoutScale();
    return w2s(f.x, f.z, layoutState.room.width, layoutState.room.depth, s);
  };
  rect.addEventListener('pointerdown', (e) => {
    mode = 'move'; selectLayout(f.code);
    const pt = svgPoint(svg, e);
    start = { sx: pt.x, sy: pt.y, x: f.x, z: f.z };
    rect.setPointerCapture(e.pointerId); e.preventDefault();
    rect.classList.add('dragging');
  });
  // 旋转：记录按下时的光标角度，之后按「角度增量」跟随光标转动，避免一按下就跳到光标方向
  if (knob) {
    knob.addEventListener('pointerdown', (e) => {
      mode = 'rotate'; selectLayout(f.code);
      const pt = svgPoint(svg, e);
      const [ccx, ccy] = centerOf();
      start = { a0: Math.atan2(pt.y - ccy, pt.x - ccx), rot0: f.rot };
      knob.setPointerCapture(e.pointerId); e.preventDefault(); e.stopPropagation();
      rect.classList.add('dragging');
    });
  }
  const onMove = (e) => {
    if (!mode) return;
    e.preventDefault();
    const pt = svgPoint(svg, e);
    const s = layoutScale();
    if (mode === 'move') {
      let nx = start.x + (pt.x - start.sx) / s;
      let nz = start.z + (pt.y - start.sy) / s;
      const gval = grid();
      if (gval > 0) { nx = snapValue(nx, gval); nz = snapValue(nz, gval); }
      f.x = nx; f.z = nz;
      clampInRoom(f);
      applyTransform(f); updateFurnEl(f); renderList();
    } else if (mode === 'rotate') {
      const [ccx, ccy] = centerOf();
      const a = Math.atan2(pt.y - ccy, pt.x - ccx);
      // SVG 的 y 轴向下：光标角度增大 = 顺时针，对应 rot 减小（rot 到 SVG 角为 -rot）
      let nr = start.rot0 - (a - start.a0);
      nr = Math.atan2(Math.sin(nr), Math.cos(nr)); // 归一化到 [-π, π]
      const gval = grid();
      if (gval > 0) nr = snapValue(nr, gval);
      f.rot = +nr.toFixed(3);
      applyTransform(f); updateFurnEl(f); renderList();
    }
  };
  const onUp = (e) => {
    mode = null; start = null;
    rect.classList.remove('dragging');
    for (const el of [rect, knob]) {
      try { if (el && el.hasPointerCapture && el.hasPointerCapture(e.pointerId)) el.releasePointerCapture(e.pointerId); } catch (_) { /* 已释放 */ }
    }
  };
  rect.addEventListener('pointermove', onMove);
  rect.addEventListener('pointerup', onUp);
  rect.addEventListener('pointercancel', onUp);
  if (knob) {
    knob.addEventListener('pointermove', onMove);
    knob.addEventListener('pointerup', onUp);
    knob.addEventListener('pointercancel', onUp);
  }
}

document.addEventListener('keydown', (e) => {
  if (layoutModal.classList.contains('hidden')) return;
  if (['ArrowUp','ArrowDown','ArrowLeft','ArrowRight'].includes(e.key)) {
    const f = layoutState.furniture.find((x) => x.code === layoutSel);
    if (!f) return;
    e.preventDefault();
    const step = e.shiftKey ? 0.01 : 0.1;
    if (e.key === 'ArrowUp') f.z -= step;
    if (e.key === 'ArrowDown') f.z += step;
    if (e.key === 'ArrowLeft') f.x -= step;
    if (e.key === 'ArrowRight') f.x += step;
    clampInRoom(f);
    applyTransform(f); updateFurnEl(f); renderList();
  }
});

function renderList() {
  const ul = document.getElementById('layoutList');
  ul.innerHTML = '';
  for (const f of layoutState.furniture) {
    const li = document.createElement('li');
    li.className = layoutSel === f.code ? 'sel' : '';
    li.innerHTML = `
      <div class="ll-head">
        <span>${f.label}<br><span style="color:#64748b">${f.code}</span></span>
        <span class="acts">
          <button class="mini" data-act="edit" title="编辑货架规格">⚙</button>
          <button class="mini" data-act="clone" title="复制货架">📋</button>
          <button class="mini danger" data-act="del" title="删除货架">🗑</button>
        </span>
      </div>
      <div class="ll-row">
        <label>X<input data-k="x" type="number" step="0.1" value="${+f.x.toFixed(3)}"></label>
        <label>Z<input data-k="z" type="number" step="0.1" value="${+f.z.toFixed(3)}"></label>
        <label>°<input data-k="rot" type="number" step="5" value="${Math.round(f.rot * 180 / Math.PI)}"></label>
        <button class="mini" data-d="15">↻15</button>
        <button class="mini rot90" data-d="90">↻90</button>
      </div>`;
    li.querySelector('.ll-head > span').onclick = () => selectLayout(f.code);
    li.querySelectorAll('input').forEach((inp) => {
      inp.oninput = () => {
        const k = inp.dataset.k;
        if (k === 'rot') f.rot = (+inp.value) * Math.PI / 180;
        else f[k] = +inp.value;
        clampInRoom(f); applyTransform(f); updateFurnEl(f);
      };
    });
    li.querySelectorAll('button[data-d]').forEach((b) => {
      b.onclick = (e) => { e.stopPropagation(); f.rot += (+b.dataset.d) * Math.PI / 180; applyTransform(f); updateFurnEl(f); renderList(); };
    });
    li.querySelectorAll('button[data-act]').forEach((b) => {
      b.onclick = (e) => {
        e.stopPropagation();
        const act = b.dataset.act;
        try {
          if (act === 'edit') { openFurnSetModal(f.code); }
          else if (act === 'clone') {
            const created = cloneFurniture(f, 1);
            layoutMsg('已复制 ' + created.join('、'));
            document.getElementById('layoutBtn').click();
            setTimeout(() => layoutMsg(''), 1200);
          } else if (act === 'del') {
            if (!confirm(`确定删除货架「${f.code}」？\n该货架下所有格位与物品将一并删除。`)) return;
            deleteFurniture(f.code);
            if (!layoutState.furniture.find((x) => x.code === layoutSel)) layoutSel = layoutState.furniture[0]?.code || null;
            buildScene();
            document.getElementById('layoutBtn').click();
            layoutMsg('已删除'); setTimeout(() => layoutMsg(''), 1200);
          }
        } catch (err) { layoutMsg('失败：' + err.message); setTimeout(() => layoutMsg(''), 2000); }
      };
    });
    ul.appendChild(li);
  }
}

document.getElementById('layoutBtn').onclick = () => {
  layoutState = {
    room: Object.assign({}, state.room || { width: 4, depth: 3, height: 2.6 }),
    furniture: (state.furniture || []).map((f) => ({
      code: f.code, label: f.label,
      x: f.position ? f.position[0] : 0, z: f.position ? f.position[2] : 0,
      rot: f.rotation || 0, w: f.width, h: f.height, d: f.depth,
    })),
  };
  layoutSel = layoutState.furniture[0] ? layoutState.furniture[0].code : null;
  layoutZoom = 1;               // 每次打开先回到「适应窗口」
  layoutModal.classList.remove('hidden'); // 先显示再渲染：便于按画布实际尺寸计算适应比例
  // 弹窗从 display:none 切换到 flex 后，浏览器需要完成一次布局才能拿到画布真实尺寸；
  // 若同步渲染，画布 clientHeight 可能还未稳定，导致 SVG 只有一半高、下方出现大片空白。
  setTimeout(() => {
    const c = document.querySelector('.layout-canvas');
    if (c) c.scrollTop = 0;
    renderLayout(); renderList(); updateLayoutZoomLbl();
    layoutMsg('');
  }, 0);
};
document.getElementById('layout_close').onclick = () => layoutModal.classList.add('hidden');
document.getElementById('layout_add_rack').onclick = () => {
  layoutPendingRefresh = true;
  furnModal.classList.remove('hidden');
  document.getElementById('furn_msg').textContent = '';
};
document.getElementById('layoutZoomIn').onclick = () => setLayoutZoom(layoutZoom * 1.25);
document.getElementById('layoutZoomOut').onclick = () => setLayoutZoom(layoutZoom / 1.25);
document.getElementById('layoutZoomFit').onclick = () => setLayoutZoom(1);

// Ctrl / ⌘ + 滚轮 = 缩放画布；普通滚轮仍用于滚动（放大后需要平移）
document.querySelector('.layout-canvas').addEventListener('wheel', (e) => {
  if (!e.ctrlKey && !e.metaKey) return;
  e.preventDefault();
  setLayoutZoom(layoutZoom * (e.deltaY < 0 ? 1.12 : 1 / 1.12));
}, { passive: false });

// 窗口尺寸变化时重新渲染：画布变大变小都能继续保持合适的适应比例
let layoutResizeTimer = null;
window.addEventListener('resize', () => {
  if (layoutModal.classList.contains('hidden') || !layoutState) return;
  clearTimeout(layoutResizeTimer);
  layoutResizeTimer = setTimeout(() => renderLayout(), 150);
});
// 监听画布容器本身的尺寸变化（flex 布局完成、列表展开/折叠等导致画布高度变化），更精确地自动重绘
if (typeof ResizeObserver !== 'undefined') {
  const layoutResizeObs = new ResizeObserver((entries) => {
    if (layoutModal.classList.contains('hidden') || !layoutState) return;
    clearTimeout(layoutResizeTimer);
    layoutResizeTimer = setTimeout(() => renderLayout(), 120);
  });
  const layoutCanvasObs = document.querySelector('.layout-canvas');
  if (layoutCanvasObs) layoutResizeObs.observe(layoutCanvasObs);
}
document.getElementById('layout_save').onclick = () => {
  // 离线：位置已在拖动时写入 state，这里重建场景使格位中心重算
  state.room = Object.assign({}, state.room || {}, layoutState.room);
  buildScene();
  layoutMsg('布局已更新（内存，刷新还原）');
  setTimeout(() => layoutModal.classList.add('hidden'), 500);
};
document.getElementById('layout_export').onclick = () => {
  const data = { room: layoutState.room, furniture: layoutState.furniture.map((f) => ({ code: f.code, label: f.label, x: f.x, z: f.z, rot: f.rot, w: f.w, h: f.h, d: f.d })) };
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
  const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = '空间布局模板.json'; a.click();
  layoutMsg('已导出布局模板 JSON');
};
document.getElementById('layout_import_btn').onclick = () => document.getElementById('layout_file').click();
document.getElementById('layout_file').onchange = (e) => {
  const file = e.target.files[0]; if (!file) return;
  const reader = new FileReader();
  reader.onload = () => {
    try {
      const data = JSON.parse(reader.result);
      if (data.room) { layoutState.room = Object.assign({}, layoutState.room, data.room); }
      if (Array.isArray(data.furniture)) {
        for (const nf of data.furniture) {
          const f = layoutState.furniture.find((x) => x.code === nf.code);
          if (f) { f.x = nf.x != null ? nf.x : f.x; f.z = nf.z != null ? nf.z : f.z; f.rot = nf.rot != null ? nf.rot : f.rot; f.w = nf.w != null ? nf.w : f.w; f.h = nf.h != null ? nf.h : f.h; f.d = nf.d != null ? nf.d : f.d; applyTransform(f); }
        }
      }
      renderLayout(); renderList();
      layoutMsg('已导入模板（点「保存布局」写入内存）');
    } catch (err) { layoutMsg('解析失败：' + err.message); }
  };
  reader.readAsText(file);
  e.target.value = '';
};
// 拍照生成：离线版无后端视觉识别能力，提示需连接实时版
document.getElementById('layout_photo_btn').onclick = () => {
  layoutMsg('离线版不支持「拍照生成」：该功能需要连接实时版后端（视觉识别在服务器端完成）');
};

// ---- 3D 视图直接拖拽货架模式 ----
let drag3dMode = false;
const floorPlane = new THREE.Mesh(
  new THREE.PlaneGeometry(200, 200),
  new THREE.MeshBasicMaterial({ visible: false })
);
floorPlane.rotation.x = -Math.PI / 2;
scene.add(floorPlane);
let drag3d = null; // { group, furnState, offset }

function setDrag3dMode(on) {
  drag3dMode = on;
  const btn = document.getElementById('drag3dBtn');
  btn.classList.toggle('active', on);
  btn.textContent = on ? '🖐 3D 拖拽中' : '🖐 3D 拖拽';
  renderer.domElement.style.cursor = on ? 'crosshair' : '';
  controls.enabled = !on;
  // 高亮可拖拽货架
  for (const g of rackGroups) {
    const sh = g.userData.shell;
    // 退出拖拽模式时按各货架自身的原始不透明度还原（开放柜 0.06 / 封闭柜 0.16），
    // 避免统一写回 0.16 导致开放货架被「变实」
    if (sh) {
      const base = (sh.userData && sh.userData.baseOpacity != null) ? sh.userData.baseOpacity : 0.16;
      sh.material.opacity = on ? 0.35 : base;
      sh.material.emissive.setHex(on ? 0x2244aa : 0x000000);
    }
  }
  // 门/窗：进入拖拽模式时显形拾取代理，提示「这里可以拖」
  const ops = (roomGroup && Array.isArray(roomGroup.userData.openings)) ? roomGroup.userData.openings : [];
  for (const op of ops) {
    const h = op.obj && op.obj.userData && op.obj.userData.hit;
    if (!h) continue;
    h.material.visible = !!on;
    if (on) { h.material.transparent = true; h.material.opacity = 0.3; h.material.color.setHex(op.type === 'door' ? 0xd97706 : 0x38bdf8); }
  }
}
document.getElementById('drag3dBtn').onclick = () => setDrag3dMode(!drag3dMode);

renderer.domElement.addEventListener('pointerdown', (e) => {
  if (!drag3dMode) return;
  e.stopPropagation(); // 阻止冒泡到格位拾取
  const rect = renderer.domElement.getBoundingClientRect();
  const ndc = new THREE.Vector2(((e.clientX - rect.left) / rect.width) * 2 - 1, -((e.clientY - rect.top) / rect.height) * 2 + 1);
  raycaster.setFromCamera(ndc, camera);
  // 只命中货架的不可见 hitBox 代理，不会误触半透明格位/物品，避免「点空白也拖动货架」
  const hitBoxes = rackGroups.map((g) => g.userData.hitBox).filter(Boolean);
  const hits = raycaster.intersectObjects(hitBoxes);
  if (hits.length) {
    const code = hits[0].object.userData.code;
    const fs = state.furniture.find((x) => x.code === code);
    if (!fs) return;
    drag3d = { kind: 'furniture', group: fs, fs };
    renderer.domElement.setPointerCapture(e.pointerId);
    e.preventDefault();
    return;
  }
  // 门/窗开口：沿墙拖动（离线版仅内存，刷新还原）
  const ops = (roomGroup && Array.isArray(roomGroup.userData.openings)) ? roomGroup.userData.openings : [];
  const proxies = ops.map((o) => o.obj && o.obj.userData.hit).filter(Boolean);
  if (proxies.length) {
    const oh = raycaster.intersectObjects(proxies);
    if (oh.length) {
      const op = ops.find((o) => o.obj && o.obj.userData.hit === oh[0].object);
      if (op) {
        drag3d = { kind: 'opening', op, dirty: false };
        renderer.domElement.setPointerCapture(e.pointerId);
        e.preventDefault();
      }
    }
  }
});
renderer.domElement.addEventListener('pointercancel', () => { drag3d = null; });

// 拖动门/窗：吸附到指针最近的墙，并沿墙定位（钳制保证开口完整落在墙上）
function dragOpeningTo(p) {
  const W = state.room.width, D = state.room.depth;
  const hw = W / 2, hd = D / 2;
  const cand = [
    { side: 'back', d: Math.abs(p.z + hd) },
    { side: 'front', d: Math.abs(p.z - hd) },
    { side: 'left', d: Math.abs(p.x + hw) },
    { side: 'right', d: Math.abs(p.x - hw) },
  ];
  const near = cand.reduce((a, b) => (b.d < a.d ? b : a));
  const alongX = (near.side === 'back' || near.side === 'front');
  const sideLen = alongX ? W : D;
  let t = alongX ? (p.x + hw) / W : (p.z + hd) / D;
  const half = Math.min(0.45, (drag3d.op.openW / 2) / sideLen);
  t = Math.max(half, Math.min(1 - half, t));
  drag3d.op.side = near.side;
  drag3d.op.offset = t;
  placeOpening(drag3d.op.obj, near.side, t, W, D);
  drag3d.dirty = true;
}
renderer.domElement.addEventListener('pointermove', (e) => {
  if (!drag3dMode || !drag3d) return;
  const rect = renderer.domElement.getBoundingClientRect();
  const ndc = new THREE.Vector2(((e.clientX - rect.left) / rect.width) * 2 - 1, -((e.clientY - rect.top) / rect.height) * 2 + 1);
  raycaster.setFromCamera(ndc, camera);
  const hits = raycaster.intersectObject(floorPlane);
  if (!hits.length) return;
  const p = hits[0].point;
  if (drag3d.kind === 'opening') { dragOpeningTo(p); return; }
  let nx = p.x, nz = p.z;
  const gval = +document.getElementById('snapGrid').value || 0;
  if (gval > 0) { nx = snapValue(nx, gval); nz = snapValue(nz, gval); }
  // 以库区边界裁剪
  const W = state.room.width, D = state.room.depth;
  const hw = drag3d.fs.width / 2, hd = drag3d.fs.depth / 2;
  nx = Math.max(-W / 2 + hw, Math.min(W / 2 - hw, nx));
  nz = Math.max(-D / 2 + hd, Math.min(D / 2 - hd, nz));
  drag3d.fs.position[0] = nx; drag3d.fs.position[2] = nz;
  drag3d.fs.rotation = drag3d.fs.rotation || 0;
  const layoutF = layoutState && layoutState.furniture.find((x) => x.code === drag3d.fs.code);
  if (layoutF) { layoutF.x = nx; layoutF.z = nz; }
  applyTransform({ code: drag3d.fs.code, x: nx, z: nz, rot: drag3d.fs.rotation });
  if (layoutState && layoutF) { updateFurnEl(layoutF); }
});
renderer.domElement.addEventListener('pointerup', (e) => {
  if (!drag3d) return;
  const d = drag3d;
  drag3d = null;
  renderer.domElement.releasePointerCapture(e.pointerId);
  // 门/窗拖完：把最新位置写回内存状态（离线版不落盘，刷新还原）
  if (d.kind === 'opening' && d.dirty && roomGroup) {
    const ops = Array.isArray(roomGroup.userData.openings) ? roomGroup.userData.openings : [];
    const pack = (type) => ops.filter((o) => o.type === type).map((o) => ({ side: o.side, offset: o.offset }));
    state.room.door = pack('door');
    state.room.window = pack('window');
    _dirty = true;
  }
});

// ---- 渲染循环 ----
const clock = new THREE.Clock();
function animate() {
  requestAnimationFrame(animate);
  const dt = clock.getDelta();
  if (tween) {
    tween.t = Math.min(1, tween.t + dt / tween.dur);
    const e = easeInOut(tween.t);
    camera.position.lerpVectors(tween.fromPos, tween.toPos, e);
    controls.target.lerpVectors(tween.fromTarget, tween.toTarget, e);
    if (tween.t >= 1) tween = null;
  }
  controls.update();
  updateCellLabels();
  renderer.render(scene, camera);
}
animate();
// 格位编号开关：关闭后远景近景都不再显示编号
const cellLabelBtnEl = document.getElementById('cellLabelBtn');
if (cellLabelBtnEl) {
  cellLabelBtnEl.onclick = () => {
    showCellLabels = !showCellLabels;
    cellLabelBtnEl.classList.toggle('active', showCellLabels);
  };
}
buildScene();
window.addEventListener('resize', () => {
  camera.aspect = container.clientWidth / container.clientHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(container.clientWidth, container.clientHeight);
});

// 顶栏「更多 ▾」浮层：离线版同样需要，否则收起的工具无法触达
const _moreBtn = document.getElementById('moreBtn');
const _morePanel = document.getElementById('morePanel');
if (_moreBtn && _morePanel) {
  const _closeMore = () => _morePanel.classList.add('hidden');
  _moreBtn.onclick = (e) => { e.stopPropagation(); _morePanel.classList.toggle('hidden'); };
  _morePanel.addEventListener('click', (e) => {
    const b = e.target.closest('button');
    if (b && !['cellLabelBtn', 'realBtn', 'drag3dBtn'].includes(b.id)) _closeMore();
  });
  document.addEventListener('click', (e) => {
    if (!_morePanel.contains(e.target) && e.target !== _moreBtn) _closeMore();
  });
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') _closeMore(); });
}

// 写实模型：离线版无后端，无法上传/托管 GLB，统一提示使用联网版
const _realBtn = document.getElementById('realBtn');
if (_realBtn) { _realBtn.onclick = () => alert('离线版不支持写实模型（无后端托管 GLB）。请使用联网版（启动后端服务后访问）。'); };
const _assetBtn = document.getElementById('assetBtn');
if (_assetBtn) _assetBtn.onclick = () => alert('离线版不支持上传写实模型（需后端服务）。请使用联网版。');
const _assetClose = document.getElementById('assetClose');
if (_assetClose) _assetClose.onclick = () => { const m = document.getElementById('assetModal'); if (m) m.classList.add('hidden'); };
