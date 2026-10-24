import {createCounterPanel} from './counter-panel.mjs';
import {createMobileAccessUI} from './mobile-access-ui.mjs';
import {mountLiveInventory,inventoryDelta,inventorySyncMessage} from './live-inventory.mjs';
import {mountLayoutWorkspace} from './layout-workspace.mjs';
import {formatBusinessTime} from './business-time.mjs';
import {mountGuidedTour} from './guided-tour.mjs';
import {workspaceCapabilities,mountWorkspaceNavigation} from './workspace-navigation.mjs';
import {layoutPreviewSpec,layoutStructureKey} from './layout-preview.mjs';
import {mergeCapacityPlan,mergeCapacityPreview} from './merge-capacity.mjs';
import {capacityProducts,capacitySummary,productKey} from '../../../packages/three-kit/sku-capacity.mjs';
import {rackInputError} from './rack-input.mjs';
import {mountBatchSelection} from './batch-selection.mjs';
import {buildBatchMeta} from './batch-meta.mjs';
import {showExternalHistory} from './business-history.js';
import {renderStandaloneSidebar} from './standalone-sidebar.mjs';
import {createStocktakeUI} from './stocktake-ui.mjs';
import {createWarehouseWorkUI} from './warehouse-work-ui.mjs';
import {createTeamTasksUI} from './team-tasks-ui.mjs';
import {createRouteLayer} from './route-layer.mjs';
import {openItemStorage} from './item-storage-ui.mjs';
import {openItemCodes} from './item-codes-ui.mjs';
import {createAssistantUI} from './assistant-ui.mjs';
import {createAssistantSettingsUI} from './assistant-settings-ui.mjs';
import {createAssistantGuide} from './assistant-guide.mjs';
import {createErpStocktakeUI} from './erp-stocktake-ui.mjs';
const stocktakeUI=createStocktakeUI({confirm:appConfirm,onChanged:()=>window.SPATIAL_REFRESH_VIEW()});
const assistantErpStocktake=createErpStocktakeUI();
import {mountFreshness} from './inventory-freshness.mjs';
import {createDraftHistory} from './draft-history.mjs';
import {arrangeRacks} from '../../../packages/three-kit/layout-arrange.mjs';
import { footprint, halfExtents, placementError } from '../../../packages/three-kit/layout-geometry.mjs';
import { createSpaceManagement } from './space-management.js';
import { createInventoryFilters } from './inventory-filters.mjs';
import { createSceneNavigation } from './scene-navigation.mjs';
import { setLocationOptions, setLocationChoices } from './location-options.mjs';
import { parseWarehouseCode } from './warehouse-code.mjs';
import { createHostBridge } from './host-bridge.mjs';
// apps/web/prototype/app.js
// [APP_VERSION v2.9 COPY-FIX] 复制货架改为增量添加 + 双保险锁定源货架位置（不再 loadScene 全量重载）
console.log('[spatial] APP_VERSION v2.9 COPY-FIX loaded');
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { createRoom, createFurniture, placeOpening, setRackLabelText, setCellLabelText, ensureCellLabelTexture, updateCellSurface } from '../../../packages/three-kit/spaceGenerator.js';
import { SEED } from './seed.js';

// ================= 企业级 P0：登录 / 令牌 / 权限 =================
// 统一包装 fetch：身份或读取权限失效时进入登录层；写操作403交由表单提示。
// 这样无需逐处改动已有调用（页面里 fetch 很多），一处收口即可。
const IS_SUPOS = window.SPATIAL_RUNTIME?.provider === 'supos';
const IS_INTEGRATION = window.SPATIAL_RUNTIME?.mode === 'integration';
const TOKEN_KEY = IS_SUPOS ? 'spatial_supos_unused_token' : 'spatial_token';
const USER_KEY = IS_SUPOS ? 'spatial_supos_user' : 'spatial_user';
const apiGetToken = () => localStorage.getItem(TOKEN_KEY) || '';
let workspaceNavigation = null;
function workspaceAccess() {
  return workspaceCapabilities({user:JSON.parse(localStorage.getItem(USER_KEY)||'null'),access:window.SPATIAL_ACCESS,
    platform:IS_SUPOS,integration:IS_INTEGRATION,spaceEditable:document.documentElement.classList.contains('space-editor')});
}

// 网络 / 服务端异常统一提示。
// 以前 5xx 和断网是完全静默的：搜索会悄悄退化成"只搜本地"，用户会误以为"库里没有这个物品"，
// 而其实是后端挂了。这里补上提示，但要做防刷屏 —— 一次操作常常并发好几个请求。
let netWarnAt = 0;
function notifyFetchTrouble(why) {
  const now = Date.now();
  if (now - netWarnAt < 8000) return; // 8 秒内只提示一次
  netWarnAt = now;
  try { toast(why + '：数据可能不是最新的，请稍后重试'); } catch (_) { /* toast 未就绪（极早期请求） */ }
}

const _rawFetch = window.fetch.bind(window);
window.fetch = function (input, init = {}) {
  const t = apiGetToken();
  if (t) {
    const h = new Headers(init.headers || {});
    if (!h.has('Authorization')) h.set('Authorization', 'Bearer ' + t);
    init = Object.assign({}, init, { headers: h });
  }
  return _rawFetch(input, init).then((res) => {
    const method = String(init.method || (input instanceof Request ? input.method : 'GET')).toUpperCase();
    if (res.status === 401 || (res.status === 403 && ['GET','HEAD'].includes(method))) {
      showLogin(res.status === 403 ? '权限不足或会话已过期' : '会话已过期，请重新登录');
    } else if (res.status >= 500) {
      notifyFetchTrouble('服务端异常（' + res.status + '）');
    }
    return res;
  }, (err) => {
    // 保持原语义：继续向外抛出，调用方（如 doSearch 的本地兜底）逻辑不受影响
    notifyFetchTrouble('网络连接失败');
    throw err;
  });
};

function showLogin(msg) {
  // 权限失效后不能继续展示已缓存库存；重新验证身份后才恢复主界面。
  document.body.classList.add('auth-required');
  document.querySelectorAll('.modal').forEach(el=>el.classList.add('hidden'));
  window.dispatchEvent(new Event('spatial-auth-required'));
  if (IS_SUPOS) {
    hideBoot();
    const mask = document.getElementById('loginMask');
    if (mask) { mask.style.display = 'flex'; mask.replaceChildren(); const link = document.createElement('a'); link.href = '/home'; link.textContent = msg || '请返回 Open supOS 登录后重新打开仓储应用'; mask.append(link); }
    return;
  }
  const mask = document.getElementById('loginMask');
  if (!mask) return;
  mask.style.display = 'flex';
  hideBoot(); // 要登录了就别再顶着"正在加载 3D 场景"，登录表单的 z-index 本来也更高
  if (msg) document.getElementById('loginErr').textContent = '';
  if (msg) document.getElementById('loginSub').textContent = msg;
  checkBootstrap();
}
function hideLogin() {
  document.body.classList.remove('auth-required');
  const mask = document.getElementById('loginMask');
  if (mask) mask.style.display = 'none';
  window.dispatchEvent(new Event('spatial-auth-ready'));
}
// 首屏加载遮罩（#bootMask）：3D 场景构建完成前给出反馈，避免 3~4 秒纯空白。
// 幂等，且在 showLogin() 与启动链 .finally() 两处调用，另有超时兜底，确保不会永久卡住。
let bootHidden = false;
function hideBoot() {
  if (bootHidden) return;
  bootHidden = true;
  const b = document.getElementById('bootMask');
  if (!b) return;
  b.classList.add('hidden');
  setTimeout(() => { b.style.display = 'none'; }, 350); // 淡出后彻底移除
}
// 防闪烁：实测本地热加载从导航到就绪约 0.64s（app.js 执行起点 235ms + 加载链 407ms），
// 立刻显示遮罩只会闪一下。所以等 500ms 还没加载完，才真正把它淡入；加载完 hideBoot() 会淡出。
// 只有在"真的慢"（冷启动 / 走网络）时才看得到遮罩。
setTimeout(() => {
  if (bootHidden) return;
  const b = document.getElementById('bootMask');
  if (b) b.classList.add('show');
}, 500);
setTimeout(hideBoot, 12000); // 安全网：网络卡死时也别一直转圈
function renderUserChip() {
  const chip = document.getElementById('userChip');
  if (!chip) return;
  const u = JSON.parse(localStorage.getItem(USER_KEY) || 'null');
  if (!u) { chip.style.display = 'none'; return; }
  chip.style.display = 'inline-flex';
  chip.title = IS_SUPOS ? '返回平台首页；账号退出请在平台操作' : '点击退出登录';
  document.getElementById('userActionIcon').textContent = IS_SUPOS ? '⌂' : '⏻';
  const roleMap = { spaceAdmin: '空间管理员', admin: '管理员', operator: '操作员', viewer: '只读' };
  document.getElementById('userName').textContent = u.name || u.username;
  document.getElementById('userRole').textContent = roleMap[u.role] || u.role;
  const ab = document.getElementById('adminBtn');
  if (ab) ab.style.display = (u.role === 'admin') ? 'inline-flex' : 'none';
  if(!IS_SUPOS){document.getElementById('quickBuildBtn').disabled=u.role!=='admin';document.getElementById('openingStockBtn').disabled=!['admin','operator'].includes(u.role);}
  document.getElementById('teamTasksBtn').disabled=!['admin','operator'].includes(u.role);
  workspaceNavigation?.refresh();
}
async function checkBootstrap() {
  // 用一个「只读」的状态接口判断是否已初始化。
  // 注意：绝不能靠试探性调用 /api/auth/bootstrap 来判断——那会在未初始化时真的建出一个垃圾账号。
  try {
    const r = await _rawFetch('/api/auth/status');
    if (!r.ok) return;
    const d = await r.json();
    document.getElementById('loginBootstrap').style.display = d.initialized ? 'none' : 'block';
    if (!d.initialized) document.getElementById('loginSub').textContent = '系统未初始化，请创建首个管理员';
  } catch (_) { /* 忽略探针失败 */ }
}
async function doBootstrap() {
  const err = document.getElementById('loginErr');
  err.textContent = '';
  const username = document.getElementById('loginUser').value.trim();
  const password = document.getElementById('loginPass').value;
  const name = document.getElementById('bsName').value.trim();
  if (!username || !password) { err.textContent = '请先填写用户名与密码'; return; }
  try {
    const r = await _rawFetch('/api/auth/bootstrap', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username, password, name: name || '管理员' }),
    });
    const d = await r.json();
    if (!r.ok) { err.textContent = d.error || '创建失败'; return; }
    await doLogin(username, password);
  } catch (e) { err.textContent = '网络错误：' + e.message; }
}

async function doLogin(username, password) {
  const err = document.getElementById('loginErr');
  err.textContent = '';
  try {
    const r = await _rawFetch('/api/auth/login', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username, password }),
    });
    const d = await r.json();
    if (!r.ok) { err.textContent = d.error || '登录失败'; return; }
    localStorage.setItem(TOKEN_KEY, d.token);
    localStorage.setItem(USER_KEY, JSON.stringify(d.user));
    hideLogin();
    renderUserChip();
    await refreshSites();
    await refreshRooms();
    await loadFirstRoomOfSite();
    await locateInitialTarget();
    maybeAutoTour(); // 首次登录自动跑一次交互式引导
  } catch (e) { err.textContent = '网络错误：' + e.message; }
}
async function doLogout() {
  if (IS_SUPOS) { window.location.assign('/home'); return; }
  try { await _rawFetch('/api/auth/logout', { method: 'POST', headers: { Authorization: 'Bearer ' + apiGetToken() } }); } catch (_) {}
  localStorage.removeItem(TOKEN_KEY);
  localStorage.removeItem(USER_KEY);
  renderUserChip();
  showLogin('已退出登录');
}

const container = document.getElementById('scene');
const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.setSize(Math.max(1, container.clientWidth), Math.max(1, container.clientHeight));
renderer.shadowMap.enabled = true;
container.appendChild(renderer.domElement);
let sceneRenderDirty = true;
function requestSceneRender() { sceneRenderDirty = true; }

// ---- 左侧工具栏 / 右侧侧栏 收缩切换 ----
const lt = document.getElementById('leftToolbar');
const ltToggle = document.getElementById('ltToggle');
const sb = document.getElementById('sidebar');
const sbToggle = document.getElementById('sbToggle');
// 重算 3D 画布尺寸：工具栏/侧栏收拢会改变 #scene 宽度，否则 canvas 停在旧像素尺寸 → 右侧露白
function onResize() {
  const width = container.clientWidth, height = container.clientHeight;
  // 登录层隐藏主界面时不覆盖镜头比例；恢复可见后由容器观察器更新画布。
  if (!width || !height) return;
  requestSceneRender();
  camera.aspect = width / height;
  camera.updateProjectionMatrix();
  renderer.setSize(width, height);
}
// 切换带 .28s 过渡：立即校一次 + 过渡结束后精确校一次（transitionend 触发，setTimeout 兜底）
function scheduleResize() {
  onResize();
  setTimeout(onResize, 320);
}
[lt, sb].forEach((el) => el && el.addEventListener('transitionend', (e) => {
  if (e.propertyName === 'width' || e.propertyName === 'flex-basis') onResize();
}));
function updatePanelToggle(button, expanded, name) {
  button.setAttribute('aria-expanded', String(expanded));
  button.title = `${expanded ? '收起' : '展开'}${name}`;
  button.setAttribute('aria-label', button.title);
}
// 窄窗口保留完整场景，工具栏按需展开为抽屉。
lt.classList.toggle('lt-open', !window.matchMedia('(max-width: 720px)').matches);
updatePanelToggle(ltToggle, lt.classList.contains('lt-open'), '工具栏');
if (sbToggle) updatePanelToggle(sbToggle, !sb.classList.contains('sb-collapsed'), '库存详情');
ltToggle.onclick = () => {
  lt.classList.toggle('lt-open');
  updatePanelToggle(ltToggle, lt.classList.contains('lt-open'), '工具栏');
  scheduleResize();
};
// 分组只控制菜单显示，保留原按钮及权限逻辑。
lt.addEventListener('click', event => {
  if (!window.matchMedia('(max-width: 720px)').matches || !event.target.closest('.lt-btn, #userChip')) return;
  lt.classList.remove('lt-open');
  updatePanelToggle(ltToggle, false, '工具栏');
});
lt.addEventListener('keydown', event => {
  if (event.key !== 'Escape' || !window.matchMedia('(max-width: 720px)').matches || !lt.classList.contains('lt-open')) return;
  event.preventDefault();
  lt.classList.remove('lt-open');
  updatePanelToggle(ltToggle, false, '工具栏');
  ltToggle.focus();
});
document.querySelectorAll('.lt-group-toggle').forEach(button => {
  button.onclick = () => {
    const collapsed = button.closest('.lt-group').classList.toggle('is-collapsed');
    button.setAttribute('aria-expanded', String(!collapsed));
  };
});
// #sbToggle 是 #sidebar 的兄弟节点（位于 #app 内，绝对定位），不会被侧栏 overflow 裁切
if (sbToggle) sbToggle.onclick = () => {
  sb.classList.toggle('sb-collapsed');
  updatePanelToggle(sbToggle, !sb.classList.contains('sb-collapsed'), '库存详情');
  scheduleResize();
};

const scene = new THREE.Scene();
scene.background = new THREE.Color(0xdfe6ee);

let tween = null;
const camera = new THREE.PerspectiveCamera(50, Math.max(1, container.clientWidth) / Math.max(1, container.clientHeight), 0.1, 100);
camera.position.set(0, 3.0, 7.0);

const controls = new OrbitControls(camera, renderer.domElement);
controls.addEventListener('change', requestSceneRender);
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
  entry.mesh.updateWorldMatrix(true, true);
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
    if(IS_INTEGRATION)updateCellSurface(c,camera.position,c===selected || c===hoverCell);
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
    if (lb.visible) ensureCellLabelTexture(lb);
  }
}

let roomGroup = null;
function rebuildRoom(roomSpec) {
  requestSceneRender();
  if (roomGroup) { scene.remove(roomGroup); disposeGroup(roomGroup,true); }
  roomGroup = createRoom(roomSpec || { width: 4, depth: 3, height: 2.6 });
  scene.add(roomGroup);
}
rebuildRoom(SEED.roomSize);

let rackGroups = [];
let cellRegistry = [];
let furnByCode = {};
let sceneFurniture = []; // 与 3D 场景同步的货架状态，不依赖布局编辑器是否打开
let sceneRoomDims = { width: 12, depth: 8 }; // 当前库区的物理尺寸（米），供复制货架时计算室内坐标
// 写实模式：Blender 导出的 GLB 叠加层（按 loc_code 关联），与参数化示意图可切换
let realisticMode = localStorage.getItem('spatial_realistic') === '1';
let assetGroups = []; // 已加载的写实模型 Object3D，重建场景时整体移除
let sceneAssets = {}; // 当前场景的写实模型映射（loc_code → {url, transform}），用于「写实」模式无模型提示
const gltfLoader = new GLTFLoader();
// 写实模型解析缓存：同一 URL 只下载+解析一次，之后 clone 复用，避免频繁切写实模式/重建场景时重复拉取与解析 GLB
const gltfCache = new Map();
THREE.Cache.enabled = true;
function invalidateAssetCache(url) { if (url) gltfCache.delete(url); else gltfCache.clear(); }
let sceneBuildVersion = 0;
let savedSceneSpec = SEED;
const routeLayer=createRouteLayer({scene,host:container,onRender:requestSceneRender});
function buildScene(spec, fitCamera = true) {
  routeLayer.setLayout(spec);
  requestSceneRender();
  ++sceneBuildVersion;
  rackGroups.forEach((g) => { scene.remove(g); disposeGroup(g,true); });
  assetGroups.forEach((g) => { scene.remove(g); disposeGroup(g); });
  assetGroups = [];
  rackGroups = [];
  cellRegistry = [];
  furnByCode = {};
  selected = null;
  if (selectionBox) selectionBox.visible = false;
  sceneFurniture = (spec.furniture || []).map((f) => ({
    code: f.code, label: f.label,
    x: f.position[0], z: f.position[2],
    rot: (f.rotationY != null ? f.rotationY : (f.rotation || 0)),
    w: f.width, h: f.height, d: f.depth,
    type: f.type, open: f.open, rows: f.rows, cols: f.cols,
    merges: f.merges || {},
    cellNames: f.cellNames || {}, // 每格自定义名称：{ "L01-B01": "螺丝区" }
    mergeCapacities:f.mergeCapacities,
  }));
  (spec.furniture || []).forEach((f) => {
    // 显式把 merges 透传给 createFurniture，避免任何中间对象丢失合并方案导致 3D 不更新
    const g = createFurniture({ ...f, merges: f.merges || {}, ...(IS_INTEGRATION?{inventoryVisualLimit:8,lazyCellLabels:true,batchInventory:true,batchCellSurfaces:true}:{}) }, cellRegistry);
    rackGroups.push(g);
    furnByCode[f.code] = g;
    scene.add(g);
  });
  // 写实模式：叠加 Blender 导出的 GLB（隐藏参数化外壳，保留格位热区用于扫码/点选）
  if (realisticMode && spec.assets) applyRealisticAssets(spec);
  // 隔离模式：重建后按 isolateCode 重新仅保留一个货架，其余隐藏
  if (isolateMode) {
    if (!rackGroups.some((g) => getRackCode(g) === isolateCode)) {
      isolateCode = rackGroups[0] ? getRackCode(rackGroups[0]) : null;
    }
    applyIsolate();
    populateIsolateSel();
  }
  // 自动框选：根据场景包围盒把相机拉到能看见全部货架/房间的合理距离（修复默认视角只看到最前 2 个货架）
  if (fitCamera) fitCameraToScene();
}

// 两种显示模式共用参数化布局的取景范围（不修改相机）。
function frameBounds(box, direction = new THREE.Vector3(0.25, 0.65, 1)) {
  const size = box.getSize(new THREE.Vector3());
  const target = box.getCenter(new THREE.Vector3());
  const dir = direction.clone();
  if (Math.abs(dir.x) + Math.abs(dir.z) < 1e-6) dir.z = 0.01;
  dir.normalize();
  const right = new THREE.Vector3().crossVectors(new THREE.Vector3(0, 1, 0), dir).normalize();
  const up = new THREE.Vector3().crossVectors(dir, right).normalize();
  const tanV = Math.tan(THREE.MathUtils.degToRad(camera.fov / 2));
  const tanH = tanV * container.clientWidth / Math.max(1, container.clientHeight);
  let distance = 0.8;
  // 用实际画布比例框住货架，保留边距，不把上方空白当作取景中心。
  for (const x of [box.min.x, box.max.x]) for (const y of [box.min.y, box.max.y]) for (const z of [box.min.z, box.max.z]) {
    const point = new THREE.Vector3(x, y, z).sub(target);
    distance = Math.max(distance, point.dot(dir) + 1.18 * Math.max(Math.abs(point.dot(right)) / tanH, Math.abs(point.dot(up)) / tanV));
  }
  return {position:target.clone().addScaledVector(dir,distance),target,dist:distance,center:target.clone(),size};
}
function computeCameraFit() {
  // 写实模型可能带地板，始终使用参数化货架范围保持两种模式取景一致。
  const box = new THREE.Box3();
  for (const g of rackGroups) if (g.visible) {
    // 标牌随镜头缩放，不能参与实体取景，否则反复复位会越拉越远。
    const shell = g.userData.shell;
    if (shell) { shell.updateWorldMatrix(true, false); box.expandByObject(shell, true); }
  }
  if (box.isEmpty() && roomGroup) box.expandByObject(roomGroup, true);
  if (box.isEmpty()) return {position:new THREE.Vector3(0,3,7),target:new THREE.Vector3(0,1,0),dist:7};
  return frameBounds(box);
}

// 根据当前场景包围盒自动放置相机，确保首次进入/切换库区能看到全貌而非贴脸的局部
function fitCameraToScene() {
  tween = null;
  const fit = computeCameraFit();
  camera.position.copy(fit.position);
  controls.target.copy(fit.target);
  camera.near = 0.1;
  camera.far = Math.max(200, fit.dist * 4);
  camera.updateProjectionMatrix();
  if (controls.update) controls.update();
}

// 释放 GLB 资源（几何体/材质），避免反复切换场景时内存堆积
function disposeGroup(g,disposeTextures=false) {
  // 复用模板克隆出的写实模型共享几何体/材质（由 gltfCache 模板持有），这里只移除不释放，避免误伤其它克隆体
  if (g.userData && g.userData.cachedClone) return;
  g.traverse((o) => {
    if (o.isInstancedMesh) o.dispose();
    if (o.geometry) o.geometry.dispose();
    if (o.material) { const m = Array.isArray(o.material) ? o.material : [o.material]; m.forEach((mm) => { if(disposeTextures && mm)for(const value of Object.values(mm))if(value?.isTexture)value.dispose(); mm?.dispose?.(); }); }
  });
}
// 隐藏货架/房间的参数化外壳，但保留格位 hitbox（仍可被射线拾取 → 扫码/点选照常可用）
function hideShellKeepCells(group, code) {
  const cellMeshes = new Set(cellRegistry.filter((c) => c.locCode.startsWith(code + '-')).map((c) => c.mesh));
  group.traverse((o) => {
    const inventoryMesh = o.userData?.type === 'item' || o.userData?.type === 'inventoryBatch';
    if (o.isMesh && !cellMeshes.has(o) && !inventoryMesh) o.visible = false;
    if (o.isSprite) o.visible = false;
  });
}
// 把已就位的写实模型加入场景（设置坐标/旋转/缩放，登记到 assetGroups 供重建时整体移除）
function placeAssetGLB(root, worldPos, rotY, scale, onLoaded) {
  requestSceneRender();
  root.position.copy(worldPos);
  root.rotation.y = rotY || 0;
  root.scale.setScalar(scale || 1);
  scene.add(root);
  assetGroups.push(root);
  if (onLoaded) onLoaded();
}
// 加载并放置一个写实模型到场景世界坐标。
// onLoaded：仅当 GLB 真正解析成功才回调（用于隐藏参数化外壳），失败则保留示意图，避免货架"消失"。
// 性能：命中 gltfCache 时直接 clone 模板复用，零网络、零解析；否则解析后缓存模板供后续复用。
function loadAssetGLB(asset, worldPos, rotY, scale, onLoaded) {
  const version = sceneBuildVersion;
  const tpl = gltfCache.get(asset.url);
  if (tpl) {
    const root = tpl.clone(true);
    root.userData.cachedClone = true;
    placeAssetGLB(root, worldPos, rotY, scale, onLoaded);
    return;
  }
  const modelUrl=asset.url.startsWith('/uploads/') ? (window.SPATIAL_RUNTIME?.basePath || '')+asset.url : asset.url;
  gltfLoader.load(modelUrl, (gltf) => {
    if (version !== sceneBuildVersion) return;
    const parsed = gltf.scene;
    gltfCache.set(asset.url, parsed); // 缓存解析结果供后续复用
    const root = parsed.clone(true);
    root.userData.cachedClone = true;
    placeAssetGLB(root, worldPos, rotY, scale, onLoaded);
  }, undefined, (err) => {
    if (version !== sceneBuildVersion) return;
    // 加载失败：保留参数化示意图（外壳/格位）照常显示，不隐藏，避免货架凭空消失
    console.warn('写实模型加载失败，已保留示意图:', asset.url, err);
    toast(`写实模型加载失败：${asset.url}\n${err?.message || err || '未知错误'}`);
  });
}
// 把 scene.assets（loc_code → {url, transform}）映射到 3D：库区整体 / 单货架
function applyRealisticAssets(spec) {
  const assets = spec.assets || {};
  if (assets[spec.roomCode] && !isolateMode) {
    const a = assets[spec.roomCode];
    document.getElementById('assetDelete').disabled=false;
    const t = a.transform || {};
    // 仅当 GLB 真正加载成功才隐藏参数化房间外壳；失败则保留示意图
    loadAssetGLB(a, new THREE.Vector3(t.x || 0, t.y || 0, t.z || 0), t.rotY || 0, t.scale || 1,
      () => {
        if (roomGroup) roomGroup.visible = false;
        // 房间级 GLB 已替换整个库区（含全部货架外观），必须同时隐藏所有参数化货架外壳与标签，
        // 否则 schematic 标签会穿透叠加在写实模型上。格位 hitbox 保留，扫码/点选不受影响。
        rackGroups.forEach((g) => {
          const code = getRackCode(g);
          if (code) hideShellKeepCells(g, code);
        });
      });
  }
  for (const f of (spec.furniture || [])) {
    const a = assets[f.code];
    if (!a) continue;
    const g = furnByCode[f.code];
    document.getElementById('assetDelete').disabled=false;
    const t = a.transform || {};
    // 场景接口使用 position 数组；f.x / f.z 属于布局编辑草稿，不能在这里读取。
    const [x, y, z] = f.position;
    const pos = new THREE.Vector3(x + (t.x || 0), y + (t.y || 0), z + (t.z || 0));
    const baseRot = (f.rotationY != null ? f.rotationY : (f.rotation || 0));
    // 仅当 GLB 真正加载成功才隐藏参数化外壳并保留格位点击区；失败则外壳/格位照常显示
    loadAssetGLB(a, pos, baseRot + (t.rotY || 0), t.scale || 1,
      () => {
        const root = assetGroups[assetGroups.length - 1];
        root.userData.rackCode = f.code;
        root.visible = !isolateMode || isolateCode === f.code;
        if (g) hideShellKeepCells(g, f.code);
      });
  }
}
function findFurnData(code) {
  let f = sceneFurniture.find((x) => x.code === code);
  if (!f && layoutState) f = layoutState.furniture.find((x) => x.code === code);
  return f;
}

// ---------- 场景导航：读取成功后才更新库区、列表和场景 ----------
let currentRoomCode = null;
const teamTasksUI=createTeamTasksUI({getRoom:()=>currentRoomCode,confirm:appConfirm,onChanged:()=>window.SPATIAL_REFRESH_VIEW(),locate:loc=>locateByLoc(loc),
  showRoute:async route=>{await window.SPATIAL_REFRESH_VIEW();routeLayer.show(route);fitCameraToScene();requestSceneRender();}});
document.getElementById('teamTasksBtn').onclick=()=>teamTasksUI.open().catch(error=>toast(error.message,false));
const warehouseWork=createWarehouseWorkUI({
  confirm:appConfirm,
  getRoom:()=>currentRoomCode,
  openJob:id=>warehouseAssistant.showJob(id),
  openTeam:id=>teamTasksUI.open(id),
  onChanged:async room=>{if(room&&room!==currentRoomCode){await refreshRooms();await sceneNavigation.loadRoom(room);}else await window.SPATIAL_REFRESH_VIEW();},
  openLayout:()=>document.getElementById('layoutBtn').click(),
  openLabels:()=>document.getElementById('qrBtn').click(),
  openCount:(loc,options)=>stocktakeUI.open(loc,{canOperate:true},options),
  openCounter:(loc,mode,options)=>openCounter(loc,mode,options),locate:loc=>locateByLoc(loc),
});
for(const [id,action] of [['quickBuildBtn','quickBuild'],['openingStockBtn','opening'],['workTasksBtn','tasks']])document.getElementById(id).onclick=()=>warehouseWork[action]().catch(error=>toast(error.message,false));
const assistantGuide=createAssistantGuide({getRoom:()=>currentRoomCode,prepare:async topic=>{
  guidedTour.stop();
  if(topic==='room'&&roomModal.classList.contains('hidden'))openRoomModal();
  if(['layout','openings'].includes(topic)&&layoutModal.classList.contains('hidden'))await document.getElementById('layoutBtn').onclick();
  if(topic==='model'&&assetModal.classList.contains('hidden'))openAssetModal();
  if(topic==='cells')await spaceManagement.open();
  if(topic==='quickBuild')await warehouseWork.quickBuild();
  if(topic==='opening')await warehouseWork.opening();
  if(topic==='labels')document.getElementById('qrBtn').click();
  if(topic==='integration')document.getElementById('integrationAdminLink').click();
}});
const warehouseAssistant=createAssistantUI({getRoom:()=>currentRoomCode,getContext:()=>({loc_code:selected?.locCode||'',item_id:selected?.items?.length===1?selected.items[0].item_id:'',item_name:selected?.items?.length===1?selected.items[0].name:'',view:'warehouse'}),locate:loc=>locateByLoc(loc),openGuide:topic=>assistantGuide.open(topic),
  openCounter:(loc,mode,options)=>openCounter(loc,mode,options),openTeam:id=>teamTasksUI.open(id),
  openQuickBuild:options=>warehouseWork.quickBuild(options),openOpening:(loc,options)=>warehouseWork.opening(loc.split('-').slice(0,-3).join('-'),loc,options),
  openCount:(loc,options)=>IS_INTEGRATION?assistantErpStocktake.open(loc,options.access,options):stocktakeUI.open(loc,{canOperate:true},options),openTasks:()=>warehouseWork.tasks(),onAuthRequired:()=>showLogin('请重新登录后继续使用智能助手'),onError:error=>toast(error.message,false)});
document.getElementById('mobileAccessBtn').onclick=createMobileAccessUI({getRoom:()=>currentRoomCode,getLoc:()=>selected?.locCode||''});
let currentSiteCode = null;
let sceneLoaded = false;
async function readNavigationJSON(url) {
  const response = await fetch(url);
  if (!response.ok) throw Object.assign(new Error('加载失败（' + response.status + '）'),{status:response.status});
  return response.json();
}
const sceneNavigation = createSceneNavigation({
  current: () => ({roomCode:currentRoomCode, siteCode:currentSiteCode}),
  readRooms: site => readNavigationJSON('/api/rooms' + (site ? '?site=' + encodeURIComponent(site) : '')),
  readScene: room => readNavigationJSON('/api/scene' + (room ? '?room=' + encodeURIComponent(room) : '')),
  commit({spec, siteCode, rooms}) {
    if (spec.roomCode && spec.roomCode !== currentRoomCode) clearSearchFeedback();
    currentRoomCode = spec.roomCode || currentRoomCode;
    currentSiteCode = siteCode || currentSiteCode;
    if (rooms) setLocationOptions(document.getElementById('roomSel'), rooms);
    if (spec.room) sceneRoomDims = {width:spec.room.width || 12, depth:spec.room.depth || 8};
    sceneAssets = spec.assets || {};
    rebuildRoom(spec.room);
    if (spec.room) window.__roomCfg = {door:spec.room.door || null, window:spec.room.window || null};
    savedSceneSpec = spec;
    buildScene(spec);
    initSidebar();
    sceneLoaded = true;
    syncRoomSel();
    updateBreadcrumb();
    if (!spec.furniture.length) toast(document.documentElement.classList.contains('space-editor') || !IS_INTEGRATION
      ? '本库区还没有货架，点「📐 布局」添加货架' : '本库区暂无货架，请联系空间管理员配置');
  }
});
async function loadScene(roomCode = null, preserveOnError = false) {
  if(window.SPATIAL_POSITION_EDITING) {
    const message='请先保存或取消3D位置调整';
    if(preserveOnError)throw new Error(message);
    toast(message);return false;
  }
  try { return await sceneNavigation.loadRoom(roomCode); }
  catch (error) {
    syncRoomSel(); updateBreadcrumb();
    if(error.status===401||error.status===403) {
      const message='无法访问库区，请重新登录或联系管理员确认仓库权限。';
      if(preserveOnError)throw new Error(message);
      toast(message);return false;
    }
    const message = '库区加载失败，' + (sceneLoaded ? '已保留当前视图，' : '') + '请重试：' + error.message;
    if (preserveOnError) throw new Error(message);
    if (sceneLoaded) { toast(message); return false; }
    if (IS_SUPOS || IS_INTEGRATION) {
      document.getElementById('sidebar').textContent = message;
      return false;
    }
    // 独立演示首次加载失败时仍允许内置示意；已加载的真实场景不会被替换。
    sceneAssets = {};
    if (SEED.roomSize) sceneRoomDims = {width:SEED.roomSize.width || 12, depth:SEED.roomSize.depth || 8};
    rebuildRoom(SEED.roomSize); buildScene(SEED); initSidebar();
    return false;
  }
}

// 仓库（场地）下拉：拉取仓库列表并同步当前选择
async function refreshSites() {
  const sel = document.getElementById('siteSel');
  try {
    const res = await fetch('/api/sites');
    if (res.ok) {
      const sites = await res.json();
      setLocationOptions(sel, sites);
      if (!currentSiteCode && sites.length) currentSiteCode = sites[0].loc_code;
      if (currentSiteCode) sel.value = currentSiteCode;
      updateBreadcrumb();
    } else {
      toast('仓库列表加载失败（' + res.status + '）');
    }
  } catch (e) { /* 离线/无接口时隐藏选择器 */ }
}

// 库区下拉：拉取「当前仓库」下的库区列表并同步当前选择
let roomsRefreshVersion = 0;
async function refreshRooms() {
  const version = ++roomsRefreshVersion, site = currentSiteCode;
  const sel = document.getElementById('roomSel');
  try {
    const url = currentSiteCode ? `/api/rooms?site=${encodeURIComponent(currentSiteCode)}` : '/api/rooms';
    const res = await fetch(url);
    if (res.ok) {
      const rooms = await res.json();
      if (version !== roomsRefreshVersion || site !== currentSiteCode) return;
      setLocationOptions(sel, rooms);
      if (currentRoomCode) sel.value = currentRoomCode;
      updateBreadcrumb();
    } else {
      toast('库区列表加载失败（' + res.status + '）');
    }
  } catch (e) { /* 离线/无接口时隐藏选择器 */ }
}

// 更新顶栏「仓库 › 库区」面包屑
function updateBreadcrumb() {
  const el = document.getElementById('locBreadcrumb');
  if (!el) return;
  const siteSel = document.getElementById('siteSel');
  const roomSel = document.getElementById('roomSel');
  const siteName = (siteSel && siteSel.selectedOptions.length) ? siteSel.selectedOptions[0].textContent : '未选仓库';
  const roomName = (roomSel && roomSel.selectedOptions.length) ? roomSel.selectedOptions[0].textContent : '未选区';
  el.replaceChildren();
  const s1 = document.createElement('span'); s1.textContent = '🏢 ' + siteName;
  const sep = document.createElement('span'); sep.className = 'sep'; sep.textContent = ' › ';
  const s2 = document.createElement('span'); s2.className = 'rm'; s2.textContent = '📦 ' + roomName;
  el.append(s1, sep, s2);
}

// 首次进入或删除库区后，选取当前仓库首个库区。
async function loadFirstRoomOfSite() {
  const sel = document.getElementById('roomSel');
  return loadScene(sel.options.length ? sel.options[0].value : null);
}
async function onSiteChange(siteCode) {
  try { return await sceneNavigation.loadSite(siteCode); }
  catch (error) { syncRoomSel(); updateBreadcrumb(); toast('仓库切换失败，已保留当前视图：' + error.message); return false; }
}
function syncRoomSel() {
  document.getElementById('siteSel').value = currentSiteCode || '';
  document.getElementById('roomSel').value = currentRoomCode || '';
}

// ---- 「当前库区」选择器（顶栏 #locPickerBtn → #locPickerModal） ----
// 原来顶栏的「仓库」「库区」两个下拉 + 3 个按钮占 444px，现合并成一个按钮。
// 隐藏下拉仅保留已提交的选择；异步导航成功后一起更新面包屑与场景。
function renderLocPicker() {
  const siteSel = document.getElementById('siteSel');
  const roomSel = document.getElementById('roomSel');
  const sg = document.getElementById('lpSiteList');
  const rg = document.getElementById('lpRoomList');
  if (!siteSel || !roomSel || !sg || !rg) return;
  const sites = [...siteSel.options];
  const rooms = [...roomSel.options];
  setLocationChoices(sg, sites, currentSiteCode, 'site', '暂无仓库');
  setLocationChoices(rg, rooms, currentRoomCode, 'room', '该仓库下暂无库区');
  sg.querySelectorAll('[data-site]').forEach((b) => {
    b.onclick = async () => {
      await onSiteChange(b.dataset.site);
      renderLocPicker();
    };
  });
  rg.querySelectorAll('[data-room]').forEach((b) => {
    b.onclick = () => {
      loadScene(b.dataset.room);
      closeLocPicker();
    };
  });
}
function openLocPicker() {
  renderLocPicker();
  const m = document.getElementById('locPickerModal');
  if (m) m.classList.remove('hidden');
}
function closeLocPicker() {
  const m = document.getElementById('locPickerModal');
  if (m) m.classList.add('hidden');
}
{
  const btn = document.getElementById('locPickerBtn');
  if (btn) btn.onclick = openLocPicker;
  const close = document.getElementById('lpClose');
  if (close) close.onclick = closeLocPicker;
  // 新建仓库/库区、库区设置：先收掉选择器，避免两层弹窗叠在一起。
  // 用 addEventListener 而不是 onclick —— 这几个按钮各自的 onclick handler 在别处赋值，两者会按注册顺序都执行。
  ['addSiteBtn', 'addRoomBtn', 'roomEditBtn'].forEach((id) => {
    const el = document.getElementById(id);
    if (el) el.addEventListener('click', closeLocPicker);
  });
}

// ---- 交互：拾取格位 ----
const raycaster = new THREE.Raycaster();
const pointer = new THREE.Vector2();
let selected = null;

// 拖拽旋转检测：区分「点击空白取消选中」与「按住拖拽旋转视角」。
// pointerdown 时记录坐标，pointerup 时若移动 > 阈值则视为拖拽、不取消选中。
let _pdX = 0, _pdY = 0;          // pointerdown 时的屏幕坐标
let _pendingCell = null, _clickPointer = null, _pointerMoved = false;
let _pendingClear = false;         // pointerdown 命中空白、待 pointerup 确认
const _DRAG_THRESH = 3;            // 像素阈值，超过此值视为拖拽而非点击

// 拾取射线命中的格位（含可见性过滤），选中与悬停共用同一套逻辑。
function pickCell(e) {
  const rect = renderer.domElement.getBoundingClientRect();
  pointer.x = ((e.clientX - rect.left) / rect.width) * 2 - 1;
  pointer.y = -((e.clientY - rect.top) / rect.height) * 2 + 1;
  raycaster.setFromCamera(pointer, camera);
  const hits = raycaster.intersectObjects(cellRegistry.map((c) => c.mesh), false);
  const visibleHits = hits.filter((h) => {
    let o = h.object;
    while (o) {
      if (!o.visible) return false;
      o = o.parent;
    }
    return true;
  });
  if (!visibleHits.length) return null;
  return cellRegistry.find((c) => c.mesh === visibleHits[0].object) || null;
}

let hoverCell = null; // 当前悬停的格位（悬停高亮，区别于选中）
function ensureBase(c) {
  if (c._baseEmissive === undefined) {
    c._baseEmissive = c.mesh.material.emissive.getHex();
    c._baseEmInt = c.mesh.material.emissiveIntensity;
  }
}
// 悬停高亮：低强度青，明显弱于选中的 0x22d3ee@0.85，避免与选中混淆。
function setHoverCell(entry) {
  if (hoverCell === entry) return;
  requestSceneRender();
  if (hoverCell && hoverCell !== selected) {
    hoverCell.mesh.material.emissive.setHex(hoverCell._baseEmissive ?? 0x000000);
    hoverCell.mesh.material.emissiveIntensity = hoverCell._baseEmInt ?? 1;
  }
  hoverCell = entry;
  if (entry && entry !== selected) {
    ensureBase(entry);
    entry.mesh.material.emissive.setHex(0x0e7490);
    entry.mesh.material.emissiveIntensity = 0.45;
  }
}

function onPointerDown(e) {
  if (drag3dMode || e.button!==0 || !e.isPrimary) { _pendingCell=null; _pendingClear=false; _clickPointer=null; return; } // 拖拽、右键及多指手势不触发定位
  _clickPointer=e.pointerId;_pointerMoved=false;_pendingCell=null;
  _pdX = e.clientX;
  _pdY = e.clientY;
  _pendingClear = false;
  const entry = pickCell(e);
  // 点到空白（没命中任何格位）—— 不立即取消，标记待确认，
  // 等 pointerup 判断是点击还是拖拽旋转。
  if (!entry) { if (selected) _pendingClear = true; return; }
  _pendingCell=entry;
}
renderer.domElement.addEventListener('pointerdown', onPointerDown);

// 完整单击只选中格位；镜头定位由右侧按钮触发。
renderer.domElement.addEventListener('pointermove',e=>{
  if(e.pointerId===_clickPointer && (Math.abs(e.clientX-_pdX)>_DRAG_THRESH || Math.abs(e.clientY-_pdY)>_DRAG_THRESH))_pointerMoved=true;
});
renderer.domElement.addEventListener('pointerup',e=>{
  if(e.pointerId!==_clickPointer)return;
  const clicked=!drag3dMode && !_pointerMoved && Math.abs(e.clientX-_pdX)<=_DRAG_THRESH && Math.abs(e.clientY-_pdY)<=_DRAG_THRESH;
  const entry=_pendingCell,clear=_pendingClear;
  _pendingCell=null;_pendingClear=false;_clickPointer=null;
  if(!clicked)return;
  if(entry && cellRegistry.includes(entry)){
    selectCell(entry);
  }else if(clear)clearCellSelection();
});
renderer.domElement.addEventListener('pointercancel',()=>{_pendingCell=null;_pendingClear=false;_clickPointer=null;});

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
  if (now - hoverTs < 80) return; // 射线检测有成本，节流到 ~12Hz
  hoverTs = now;
  if (drag3dMode) { hoverLabel = false; setHoverCell(null); renderer.domElement.style.cursor = ''; return; } // 拖拽模式保留十字光标，不抢
  if (e.buttons & 1) return; // 拖拽旋转中（按住左键移动）不更新悬停，避免闪烁
  const on = !!pickRackLabel(e);
  if (on !== hoverLabel) hoverLabel = on;
  setHoverCell(pickCell(e)); // 格位悬停高亮，提示「这里可点击选中」
  renderer.domElement.style.cursor = (hoverLabel || hoverCell) ? 'pointer' : '';
});

function selectCell(entry) {
  requestSceneRender();
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
  // 隔离模式下，跟随当前选中的货架同步下拉（点击的必然是可见的保留货架，值不变也无妨）
  if (isolateMode && selected.rackCode) {
    isolateCode = selected.rackCode;
    const sel = document.getElementById('isolateSel');
    if (sel && !sel.classList.contains('hidden')) sel.value = isolateCode;
  }
  entry.mesh.material.emissive.setHex(0x22d3ee);
  entry.mesh.material.emissiveIntensity = 0.85;
  positionSelectionBox(entry);
  hoverCell = null; // 已转为选中，悬停高亮不再单独作用
  showSidebar(entry);
}

// 取消选中：清掉所有格位的辉光、隐藏选中框、侧栏回到「空间概览」。
// 点击 3D 空白处会走这里 —— 否则选中一旦发生就没有"退出"的办法，侧栏会一直停在旧格位。
function clearCellSelection() {
  requestSceneRender();
  for (const c of cellRegistry) {
    if (c._baseEmissive !== undefined) {
      c.mesh.material.emissive.setHex(c._baseEmissive);
      c.mesh.material.emissiveIntensity = c._baseEmInt;
    }
  }
  selected = null;
  hoverCell = null;
  selectionBox.visible = false;
  initSidebar();
}

// ---- 侧栏 ----
function inventoryWeightText(entry) {
  if(entry.weightComplete)return Number(entry.weightKg || 0).toLocaleString()+' kg';
  const known=entry.items.some(item=>item.qty>0 && Number.isFinite(item.unit_weight_kg) && item.unit_weight_kg>=0);
  return known?'已知至少 '+Number(entry.weightKg || 0).toLocaleString()+' kg（部分库存缺少重量）':'未知（库存未提供单位重量）';
}
function showSidebar(entry) {
  const panel=document.getElementById('sidebar');
  if(panel.querySelector('#sbCellList') && sidebarLists.has(currentRoomCode)) sidebarLists.get(currentRoomCode).scrollTop=panel.scrollTop;
  renderSidebarContent(entry);
  const back = document.createElement('button');
  back.type='button'; back.className='business-link'; back.textContent='‹ 返回库区概况';
  back.onclick=()=>{
    clearSearchFeedback(); clearCellSelection();
    const sidebar=document.getElementById('sidebar');
    const previous=[...sidebar.querySelectorAll('.sb-cell')].find(b=>b.dataset.loc===entry.locCode);
    (previous || sidebar.querySelector('summary'))?.focus({preventScroll:true});
  };
  document.getElementById('sidebar').prepend(back);
}
function renderSidebarContent(entry) {
  const el = document.getElementById('sidebar');
  if(!IS_INTEGRATION){
    const access=workspaceAccess();
    renderStandaloneSidebar(el,entry,access,{
      locate:()=>flyTo(entry),counter:mode=>openCounter(entry.locCode,mode),history:()=>showCellHistory(entry.locCode),qr:()=>showCellQR(entry.locCode),
      stocktake:()=>stocktakeUI.open(entry.locCode,access),
      storage:itemId=>openItemStorage({itemId,room:currentRoomCode,onChanged:()=>window.SPATIAL_REFRESH_VIEW(),locate:loc=>locateByLoc(loc),openCounter:(loc,mode,options)=>openCounter(loc,mode,options)}).catch(error=>toast(error.message,false)),
      edit:()=>spaceManagement.open(entry.locCode),capacity:()=>spaceManagement.open(entry.locCode,{capacity:true}),photo:url=>spaceManagement.previewPhoto(url),photos:()=>spaceManagement.open(entry.locCode,{photos:true})
    });return;
  }
  if (IS_INTEGRATION) {
    el.innerHTML = `<div class="card"><h3>格位 ${esc(entry.locCode)}</h3><p class="hint">外部库存 · 只读${entry.items.some(item=>item.placement==='sku')?' · 按 SKU 归位':''} · ${entry.items.length} 条库存记录${entry.items.length>8?' · 三维方块为占用示意':''}</p><p>重量：${inventoryWeightText(entry)} · 承重上限：${entry.meta?.max_load == null ? '未设置' : esc(String(entry.meta.max_load)) + ' kg'}</p>${entry.overWeight ? '<p style="color:#fca5a5">超出承重上限</p>' : ''}${entry.overCapacity ? '<p style="color:#fca5a5">超出数量容量</p>' : ''}</div>` +
      entry.items.map(i => `<article class="item-card external-item">
        <div class="inventory-card-heading"><h4>${esc(i.name)}</h4><span class="inventory-status ${i.status==='可用'?'available':i.status==='待检'?'pending':''}">${esc(i.status || '状态未提供')}</span></div>
        <p class="inventory-quantity"><strong>${esc(String(i.qty))}</strong> ${esc(i.unit)}</p>
        <dl class="inventory-properties"><dt>SKU</dt><dd>${esc(i.sku)}</dd><dt>单位重量</dt><dd>${i.unit_weight_kg == null ? '未提供' : esc(String(i.unit_weight_kg)) + ' kg/' + esc(i.unit)}</dd><dt>批次</dt><dd>${esc(i.batch_no || '无')}</dd>${i.external_loc_code ? `<dt>外部库位</dt><dd>${esc(i.external_loc_code)}</dd>` : ''}<dt>来源</dt><dd>${esc(i.source)}</dd><dt>更新时间</dt><dd>${i.received_at ? esc(new Date(i.received_at).toLocaleString()) : '未知'}</dd></dl>
      </article>`).join('') +
      (entry.items.length ? '' : '<p class="muted">此格位暂无外部库存</p>');
    const locateButton=document.createElement('button');locateButton.type='button';locateButton.id='locateBtn';
    locateButton.className='business-link';locateButton.textContent='📍 定位到此格位';
    locateButton.onclick=()=>{flyTo(entry);document.getElementById('searchMsg').textContent='已定位：'+entry.locCode;};
    el.querySelector('.card').append(locateButton);
    const header=el.querySelector('.card'),meta=entry.meta || {};
    const facts=document.createElement('dl');facts.className='inventory-properties';
    const units=new Set(entry.items.map(i=>i.unit || '件'));
    const quantity=entry.items.reduce((n,i)=>n+Number(i.qty || 0),0);
    const utilization=capacitySummary(entry.capacityState);
    for(const [name,value] of [['名称',meta.name || entry.locCode],['状态',{normal:'正常',locked:'锁定标记',stocktaking:'盘点标记'}[entry.status] || '正常'],['SKU容量',utilization],['标签',(meta.tags || []).join('、') || '无'],['备注',meta.note || '无']]) {
      const dt=document.createElement('dt'),dd=document.createElement('dd');dt.textContent=name;dd.textContent=String(value);facts.append(dt,dd);
    }
    header.insertBefore(facts,locateButton);
    const edit=document.createElement('button');edit.type='button';edit.className='business-link';edit.textContent='格位属性';edit.onclick=()=>spaceManagement.open(entry.locCode);header.append(edit);
    if(workspaceAccess().canManage){const cap=document.createElement('button');cap.type='button';cap.className='business-link';cap.textContent='设置SKU容量';cap.onclick=()=>spaceManagement.open(entry.locCode,{capacity:true});header.append(cap);}
    const qr=document.createElement('button');qr.type='button';qr.className='business-link';qr.textContent='打印格位码';qr.onclick=()=>window.open('/apps/web/labels/index.html?loc='+encodeURIComponent(entry.locCode),'_blank');header.append(qr);
    const photos=document.createElement('section');photos.className='card';
    const photoTitle=document.createElement('h3');photoTitle.textContent='现场照片';photos.append(photoTitle);
    const wall=document.createElement('div');wall.className='photoWall';photos.append(wall);
    for(const url of entry.photos || []) {
      const button=document.createElement('button');button.type='button';button.title='放大查看现场照片';
      const image=document.createElement('img');image.className='thumb';image.src=url;image.alt='格位现场照片';button.append(image);
      button.onclick=()=>spaceManagement.previewPhoto(url);wall.append(button);
    }
    if(!entry.photos?.length){const empty=document.createElement('p');empty.className='muted';empty.textContent='暂无现场照片';photos.append(empty);}
    if(document.documentElement.classList.contains('space-editor'))for(const [label,camera] of [['拍照',true],['上传 / 管理照片',false]]) {
      const button=document.createElement('button');button.type='button';button.className='business-link';button.textContent=label;button.onclick=()=>spaceManagement.open(entry.locCode,{photos:true,camera});photos.append(button);
    }
    el.append(photos);
    entry.items.forEach((item,index)=>{
      mountFreshness(el.querySelectorAll('.item-card')[index],item);
      const button=document.createElement('button');button.className='business-link';button.textContent='在 ERP/WMS 打开';button.title='由已连接的 ERP/WMS 打开对应业务记录';
      button.onclick=()=>{
        if(!hostBridge?.connected()) {toast('宿主尚未连接，请从已接入的 ERP/WMS 页面打开');return;}
        hostBridge.send('open-business',{source:item.source,sku:item.sku,loc:item.loc_code,external_loc_code:item.external_loc_code,batch_no:item.batch_no,status:item.status});
      };
      el.querySelectorAll('.item-card')[index].append(button);
    });
    const historyButton=document.createElement('button');historyButton.className='business-link';historyButton.textContent='外部业务时间线';
    historyButton.onclick=()=>showExternalHistory(entry.locCode);el.append(historyButton);
    updateBusinessLinks();
    hostBridge?.send('selection',{loc:entry.locCode});
    return;
  }
  const itemsHtml = entry.items.length
    ? entry.items.map((i) => `
        <div class="item-card">
          ${i.cover ? `<img class="cover" src="${i.cover}" alt="" />` : ''}
          <div class="row">
            <span class="nm"><b>${esc(i.name)}</b> ×${i.qty}${i.note ? ` · ${esc(i.note)}` : ''}</span>
            <span class="acts">
              <button class="edit" data-id="${i.id}">编辑</button>
              <button class="del" data-id="${i.id}">删除</button>
            </span>
          </div>
        </div>`).join('')
    : '<div class="muted" style="padding:6px 0">（空）</div>';
  const photoHtml = (entry.photos && entry.photos.length)
    ? entry.photos.map((u, i) => `<img class="thumb" src="${u}" data-i="${i}" alt="格位照片">`).join('')
    : '<div class="muted" style="padding:4px 0;font-size:11px">（暂无照片）</div>';
  const pct = Math.round(entry.ratio * 100);
  const cf = sceneFurniture.find((x) => x.code === entry.rackCode);
  const suffix = entry.locCode.split('-').slice(-2).join('-');
  const customName = cf && cf.cellNames && cf.cellNames[suffix];
  const nameVal = (customName || '').replace(/"/g, '&quot;');
  const fillCls = (pct >= 80 || entry.over) ? 'occ-fill hi' : 'occ-fill';
  const m = entry.meta || {};
  const curStatus = entry.status || 'normal';
  const capVal = (m.capacity != null) ? m.capacity : '';
  const loadVal = (m.max_load != null) ? m.max_load : '';
  const tagsVal = (Array.isArray(m.tags) ? m.tags : []).map((t) => String(t).replace(/"/g, '&quot;')).join(', ');
  const noteVal = (m.note || '').replace(/"/g, '&quot;');
  el.innerHTML = `
    <div class="card loc-card">
      <h3>格位 <span class="pill">${entry.locCode}</span>${customName ? ` <span style="color:#7dd3fc;font-size:13px">· ${customName}</span>` : ''}</h3>
      <div class="occ">占用率 ${pct}% &nbsp;·&nbsp; 物品 ${entry.items.length} 件${capVal !== '' ? ` &nbsp;·&nbsp; 容量 ${capVal} 件` : ''}${entry.over ? ' &nbsp;·&nbsp; <span style="color:#fca5a5">超载</span>' : ''}</div>
      <div class="occ-bar"><div class="${fillCls}" style="width:${pct}%"></div></div>
      <div class="nameLine"><label>名称</label><input id="cellNameInput" value="${nameVal}" placeholder="例如：螺丝区 / SKU" maxlength="24"><button id="cellNameSave">保存</button></div>
      <div class="nameLine" style="margin-top:4px"><button id="cellCountBtn" class="ghost sm">盘点此格位</button><span class="muted" style="font-size:11px">数量差异通过盘点登记与复核</span></div>
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
    <button id="addHereBtn" class="full">＋ 在此格位录入物品</button>
    <button id="locateBtn" class="ghost">📍 镜头飞向此处</button>
    <button class="full" id="impBtn">📥 批量导入 CSV</button>
  `;
  document.getElementById('addHereBtn').onclick = () => openAddModal(entry.locCode);
  document.getElementById('locateBtn').onclick = () => flyTo(entry);
  document.getElementById('impBtn').onclick = openImport;
  const saveBtn = document.getElementById('cellNameSave');
  const nameInput = document.getElementById('cellNameInput');
  document.getElementById('cellCountBtn').onclick=()=>IS_INTEGRATION?assistantErpStocktake.open(entry.locCode,window.SPATIAL_ACCESS):stocktakeUI.open(entry.locCode,window.SPATIAL_ACCESS);
  const nameMsg = document.getElementById('cellNameMsg');
  saveBtn.onclick = async () => {
    const newName = nameInput.value.trim();
    if (!entry.rackCode) { nameMsg.style.color = '#fca5a5'; nameMsg.textContent = '无法确定所属货架'; return; }
    saveBtn.disabled = true; nameMsg.style.color = '#fde68a'; nameMsg.textContent = '保存中…';
    try {
      const res = await fetch('/api/rack/' + encodeURIComponent(entry.rackCode) + '/cell-names', {
        method: 'PUT', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ names: { [suffix]: newName } }),
      });
      if (!res.ok) throw new Error((await res.json()).error || '保存失败');
      if (!cf.cellNames) cf.cellNames = {};
      if (newName) cf.cellNames[suffix] = newName; else delete cf.cellNames[suffix];
      // 3D 编号实时刷新（清空时还原为默认 LOC 短码）
      if (entry.label) setCellLabelText(entry.label, newName || (entry.baseLabel || entry.locCode.split('-').slice(-2).join('-')));
      requestSceneRender();
      nameMsg.style.color = '#86efac'; nameMsg.textContent = '已保存格位名称';showSidebar(entry);
    } catch (e) { nameMsg.style.color = '#fca5a5'; nameMsg.textContent = '失败：' + e.message; }
    finally { saveBtn.disabled = false; }
  };
  // 格位扩展属性（容量/承重/状态/标签/备注）保存
  const metaSaveBtn = document.getElementById('cellMetaSave');
  const metaMsg = document.getElementById('cellMetaMsg');
  if (metaSaveBtn) metaSaveBtn.onclick = async () => {
    const capRaw = document.getElementById('cellCapInput').value.trim();
    const loadRaw = document.getElementById('cellLoadInput').value.trim();
    const status = document.getElementById('cellStatusSel').value;
    const tagsRaw = document.getElementById('cellTagsInput').value.trim();
    const note = document.getElementById('cellNoteInput').value.trim();
    const body = {};
    if (capRaw !== '') { const n = parseInt(capRaw, 10); if (!Number.isFinite(n) || n < 0) { metaMsg.style.color = '#fca5a5'; metaMsg.textContent = '容量须为非负整数'; return; } body.capacity = n; }
    if (loadRaw !== '') { const v = parseFloat(loadRaw); if (!Number.isFinite(v) || v < 0) { metaMsg.style.color = '#fca5a5'; metaMsg.textContent = '承重须为非负数字'; return; } body.max_load = v; }
    body.status = status;
    body.tags = tagsRaw ? tagsRaw.split(/[,，]/).map((s) => s.trim()).filter(Boolean) : [];
    body.note = note;
    metaSaveBtn.disabled = true; metaMsg.style.color = '#fde68a'; metaMsg.textContent = '保存中…';
    try {
      const res = await fetch('/api/cell/' + encodeURIComponent(entry.locCode) + '/meta', {
        method: 'PUT', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({...body, revision:entry.meta?.revision}),
      });
      if (!res.ok) throw new Error((await res.json()).error || '保存失败');
      entry.meta = { capacity: body.capacity != null ? body.capacity : null, max_load: body.max_load != null ? body.max_load : null, status, tags: body.tags, note };
      entry.status = status;
      if (cf && cf.cellMeta) cf.cellMeta[suffix] = entry.meta;
      if (entry.mesh && entry.mesh.userData) { entry.mesh.userData.status = status; entry.mesh.userData.meta = entry.meta; }
      metaMsg.style.color = '#86efac'; metaMsg.textContent = '已保存格位属性';
      await loadScene();
      const refreshed = cellRegistry.find((c) => c.locCode === entry.locCode);
      if (refreshed) selectCell(refreshed);
    } catch (e) { metaMsg.style.color = '#fca5a5'; metaMsg.textContent = '失败：' + e.message; }
    finally { metaSaveBtn.disabled = false; }
  };
  // 回车快捷保存
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
  // 格位现场照片：选图（手机可用后置摄像头）→ 压缩 → 上传 → 刷新
  const cellPhotoInput = document.getElementById('cellPhotoInput');
  if (cellPhotoInput) {
    const cellPhotoBtn = document.getElementById('cellPhotoBtn');
    if (cellPhotoBtn) cellPhotoBtn.onclick = () => cellPhotoInput.click();
  }
  if (cellPhotoInput) cellPhotoInput.onchange = async (e) => {
    const file = e.target.files && e.target.files[0];
    if (!file) return;
    try {
      const dataUrl = await downscaleToDataUrl(file, 1000);
      const res = await fetch('/api/cell/' + encodeURIComponent(entry.locCode) + '/photo', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ photo: dataUrl }),
      });
      if (!res.ok) throw new Error((await res.json()).error || '上传失败');
      const j = await res.json();
      entry.photos = j.photos || [];
      toast('格位照片已保存');
      showSidebar(entry);
    } catch (err) { toast('格位照片失败：' + err.message); }
  };
  el.querySelectorAll('#cellPhotos .thumb').forEach((im) => im.onclick = () => window.open(im.src, '_blank'));
  const qrBtn = document.getElementById('cellQrBtn');
  if (qrBtn) qrBtn.onclick = () => showCellQR(entry.locCode);
  const histBtn = document.getElementById('cellHistBtn');
  if (histBtn) histBtn.onclick = () => showCellHistory(entry.locCode);
}

// 格位二维码弹窗（复用 labels 的 qrcode-generator）
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
  const printButton = document.createElement('button');
  printButton.type = 'button';
  printButton.className = 'ghost';
  printButton.textContent = '打开打印页';
  printButton.style.display = 'block';
  printButton.style.margin = '12px auto 0';
  printButton.onclick = () => window.open('/apps/web/labels/index.html?loc=' + encodeURIComponent(locCode), '_blank');
  box.appendChild(printButton);
  modal.classList.remove('hidden');
}

// 格位物品时间线弹窗
async function showCellHistory(locCode) {
  const modal = document.getElementById('histModal');
  const box = document.getElementById('histBox');
  document.getElementById('histTitle').textContent = '库存流水 · ' + locCode;
  box.innerHTML = '<div class="muted">加载中…</div>';
  modal.classList.remove('hidden');
  try {
    const res = await fetch('/api/cell/' + encodeURIComponent(locCode) + '/history');
    if (!res.ok) throw new Error((await res.json()).error || '加载失败');
    const rows = await res.json();
    if (!rows.length) { box.innerHTML = '<div class="muted">暂无流转记录</div>'; return; }
    const TYPE = { opening:'期初建账',inbound: '入库', outbound: '出库', move: '移库', merge: '合并', relocate: '重定位', erp_sync: 'ERP同步', stocktake:'盘点调账' };
    box.innerHTML = '<ul class="list">' + rows.map((r) => {
      const dir = (r.from_loc && r.to_loc) ? (r.from_loc + ' → ' + r.to_loc)
        : r.to_loc ? ('→ ' + r.to_loc) : r.from_loc ? ('← ' + r.from_loc) : '—';
      const stocktakeId=!IS_INTEGRATION && r.move_type==='stocktake' ? /^stocktake:([0-9a-f-]{36}):/i.exec(r.idem_key||'')?.[1] : null;
      const link=stocktakeId?' <button type="button" class="btn-ghost" data-stocktake="'+esc(stocktakeId)+'">查看盘点单</button>':'';
      return '<li><span class="code">' + esc(formatBusinessTime(r.occurred_at)) + '</span> · <b>' + esc(TYPE[r.move_type] || r.move_type) + '</b> · ' + esc(r.item_name || '(未知物品)') + ' · ' + esc(String(r.qty)) + ' ' + esc(r.unit || '（历史单位未知）') + ' <span class="muted">' + esc(dir) + ' · '+esc(r.actor_name || '操作人未知')+'</span>'+link+(r.business?'<p class="muted">'+esc(window.SpatialBusiness.describe(r.business))+'</p>':'')+'</li>';
    }).join('') + '</ul>';
    box.querySelectorAll('[data-stocktake]').forEach(button=>button.onclick=()=>{
      modal.classList.add('hidden');
      stocktakeUI.open(locCode,window.SPATIAL_ACCESS,{recordId:button.dataset.stocktake,onClose:()=>modal.classList.remove('hidden')});
    });
  } catch (e) { box.innerHTML = '<div style="color:#fca5a5">失败：' + e.message + '</div>'; }
}

let inventorySearchVersion = 0;
function clearSearchFeedback() {
  // 库区成功切换后，旧查询不能再覆盖新场景的提示。
  ++inventorySearchVersion;
  document.getElementById('searchMsg').replaceChildren();
}
// 关闭结果不清空条件；使仍在等待的查询失效，避免结果随后重新弹出。
function addSearchDismiss(msg) {
  const close=document.createElement('button');
  close.type='button'; close.className='search-dismiss'; close.textContent='关闭结果';
  close.onclick=()=>{
    clearTimeout(searchTimer);
    clearSearchFeedback();
    document.getElementById('searchInput').focus({preventScroll:true});
  };
  msg.prepend(close);
}
async function searchExternalInventory(q, page=1, priorParams=null) {
  const version = ++inventorySearchVersion;
  const msg=document.getElementById('searchMsg');msg.textContent='正在查询外部库存…';addSearchDismiss(msg);
  const params=priorParams ? new URLSearchParams(priorParams) : new URLSearchParams({q});
  if(!priorParams) {
    for(const key of ['source','status','unit','batch_no']) {
      const value=document.getElementById('filter_'+key).value.trim();if(value)params.set(key,value);
    }
    if(document.getElementById('searchScope').value==='room' && currentRoomCode)params.set('room',currentRoomCode);
  }
  params.set('page',page);params.set('page_size',50);
  try {
    const response=await fetch('/api/integration/inventory/page?'+params);
    if(!response.ok)throw new Error(response.status===409?'库存已更新，请重新查询后再翻页':'库存查询失败，请稍后重试');
    const data=await response.json();
    if (version !== inventorySearchVersion) return;
    msg.replaceChildren();
    addSearchDismiss(msg);
    msg.append(data.total?'找到 '+data.total+' 条库存记录 · 第 '+data.page+' / '+data.pages+' 页 · 本页 '+data.rows.length+' 条（点击定位）：':'没有符合条件的库存，请调整关键词或筛选条件');
    for(const row of data.rows) {
      const button=document.createElement('button');button.className='inventory-hit';
      button.textContent=`${row.name} · ${row.qty} ${row.unit} · ${row.status} · 批次 ${row.batch_no || '无'} · ${row.loc_code || '待分配（尚未绑定格位）'}`;
      mountFreshness(button,row);
      button.onclick=()=>row.loc_code ? locateByLoc(row.loc_code) : alert('该货品尚未分配格位。请在同一仓库的「格位管理 → 库存归位」中，填写 SKU 并保存；该货品来源：'+row.source+'，SKU：'+row.sku+'。');msg.append(button);
    }
    if(data.pages>1) {
      params.set('revision',data.revision);
      for(const [text,next,disabled] of [['上一页',data.page-1,data.page<=1],['下一页',data.page+1,data.page>=data.pages]]) {
        const button=document.createElement('button');button.textContent=text;button.disabled=disabled;
        button.onclick=()=>searchExternalInventory(q,next,params);msg.append(button);
      }
    }
  }catch(e){if (version === inventorySearchVersion) {
    msg.textContent=e.message;addSearchDismiss(msg);
    const retry=document.createElement('button');retry.textContent='重新查询';retry.onclick=()=>searchExternalInventory(document.getElementById('searchInput').value);msg.append(retry);
  }}
}
let inventoryFilterUI=null;
if(IS_INTEGRATION) {
  const filters=document.getElementById('inventoryFilters');filters.hidden=false;
  document.getElementById('searchInput').placeholder='名称 / SKU / 库位 / 批次 / 状态';
  filters.querySelectorAll('input').forEach(input=>{
    input.addEventListener('keydown',event=>{if(event.key==='Enter' && !event.isComposing)doSearch(document.getElementById('searchInput').value);});
    input.addEventListener('input',scheduleInventorySearch);
    input.addEventListener('compositionend',scheduleInventorySearch);
  });
  inventoryFilterUI=createInventoryFilters({document,search:()=>doSearch(document.getElementById('searchInput').value),fetchOptions:()=>readNavigationJSON('/api/integration/facets')});
  inventoryFilterUI.refreshOptions();
  new ResizeObserver(()=>{const bar=document.getElementById('topbar');document.getElementById('searchMsg').style.top=(bar.offsetTop+bar.offsetHeight+8)+'px';}).observe(document.getElementById('topbar'));
}
// ---- 搜索定位（走 /api/search，支持跨库区） ----
async function doSearch(q) {
  clearTimeout(searchTimer);
  q = (q || '').trim();
  const msg = document.getElementById('searchMsg');
  if (IS_INTEGRATION) return searchExternalInventory(q);
  const version = ++inventorySearchVersion;
  if (!q) { msg.textContent = ''; return; }
  let hits = [];
  let searchLoaded = false;
  try {
    const res = await fetch('/api/search?q=' + encodeURIComponent(q));
    if (res.ok) { hits = await res.json(); searchLoaded = true; }
  } catch (e) { /* 回退本地 */ }
  if (version !== inventorySearchVersion) return;
  // 补充当前库区的本地匹配：物品名 + SKU + 库位码（与后端 /api/search 的维度保持一致，
  // 否则后端失联时，输入 SKU 或库位码会一个都搜不到）
  const lq = q.toLowerCase();
  const local = cellRegistry.filter((c) =>
    c.locCode.toLowerCase().includes(lq) ||
    c.items.some((it) => (it.name || '').toLowerCase().includes(lq) || String(it.sku || '').toLowerCase().includes(lq)));
  // 接口返回的是货品明细，不能用整格数量覆盖，也不能按格位去重。
  const all = [...hits];
  for (const c of local) {
    const items = c.items || [];
    if (!items.length) { all.push({name:'空格位',loc_code:c.locCode}); continue; }
    if (searchLoaded) continue;
    for (const item of items) {
      if (Number(item.qty) <= 0) continue;
      if (c.locCode.toLowerCase().includes(lq) || String(item.name || '').toLowerCase().includes(lq) || String(item.sku || '').toLowerCase().includes(lq)) {
        all.push({...item,loc_code:c.locCode});
      }
    }
  }
  // 编码分段边界：WH-1 的格位以 WH-1- 开头，不能混入 WH-10。
  const scopeEl = document.getElementById('searchScope');
  const scope = scopeEl ? scopeEl.value : 'all';
  if (scope === 'room' && currentRoomCode) {
    const kept = all.filter((h) => (h.loc_code || '').startsWith(currentRoomCode + '-'));
    all.length = 0; for (const h of kept) all.push(h);
  }
  // 空状态别说一句"没找到"就完事 —— 告诉用户还能怎么办，并提示可搜的维度
  if (!all.length) {
    msg.textContent = `未找到包含"${q}"的物品 —— 可搜 物品名 / SKU / 库位码（如 WH-1-A-L01-B01）；或用「📷 扫码」直接扫格位码定位`;
    addSearchDismiss(msg);
    return;
  }
  msg.innerHTML = `找到 ${all.length} 项，点击定位：` + all.map((h) =>
    ` <button type="button" class="inventory-hit" data-loc="${esc(h.loc_code)}">${h.name ? esc(h.name) + ' · ' : ''}${h.sku ? esc(h.sku) + ' · ' : ''}${esc(h.loc_code)}${Number(h.qty) > 0 ? ' ×' + esc(String(h.qty)) + (h.unit ? ' ' + esc(h.unit) : '') : ''}</button>`).join('');
  msg.querySelectorAll('[data-loc]').forEach((button) => { button.onclick = () => locateByLoc(button.dataset.loc); });
  addSearchDismiss(msg);
}
// 按位置码定位：若不在当前库区则先切换库区，再高亮+飞行
async function locateByLoc(loc) {
  const msg = document.getElementById('searchMsg');
  const roomOf = loc.split('-').slice(0, 2).join('-');
  if (currentRoomCode && roomOf !== currentRoomCode) {
    msg.textContent = `切换到 ${roomOf}…`;
    if (await loadScene(roomOf) === false) return;
    const rs = document.getElementById('roomSel');
    if (rs) rs.value = roomOf;
    updateBreadcrumb();
  } else { sceneNavigation.cancelPending(); }
  const entry = cellRegistry.find((c) => c.locCode === loc) || cellRegistry.find((c) => c.locCode.startsWith(loc+'-'));
  if (entry) { selectCell(entry); flyTo(entry); msg.textContent = `已定位：${entry.locCode}`; return entry.locCode; }
  else { msg.textContent = `已切换到 ${roomOf}，但未找到 ${loc}`; }
}

let hostBridge=null;
function updateBusinessLinks(connected=!!hostBridge?.connected()) {
  document.querySelectorAll('.external-item .business-link').forEach(button=>{
    button.disabled=!connected;
    button.textContent=connected?'在 ERP/WMS 打开':'业务系统未连接';
    button.title=connected?'打开对应业务记录':'请从已接入的 ERP/WMS 页面打开仓储视图';
    let hint=button.nextElementSibling;
    if(!hint || !hint.classList.contains('business-link-hint')) {
      hint=document.createElement('p');hint.className='business-link-hint muted';button.after(hint);
    }
    hint.hidden=connected;
    hint.textContent='从已接入的 ERP/WMS 打开本视图后，可跳转业务记录。';
  });
}
async function locateTarget({loc,sku,source}) {
  if(loc) {
    const result=await locateByLoc(loc);
    if(!result) throw new Error('未找到库位：'+loc);
    return {loc:result};
  }
  const response=await fetch('/api/search?q='+encodeURIComponent(sku));
  if(!response.ok) throw new Error('物料查询失败');
  const hits=(await response.json()).filter(row=>row.sku===sku && (!source || row.source===source));
  if(!hits.length) throw new Error('未找到物料：'+sku);
  const locations=[...new Set(hits.map(row=>row.loc_code).filter(Boolean))];
  if(!locations.length)throw new Error('该物料在待分配货品中，请先在格位管理中绑定来源和 SKU');
  await locateByLoc(locations[0]);
  const msg=document.getElementById('searchMsg');msg.replaceChildren();
  msg.append('物料 '+sku+' · '+locations.length+' 个库位：');
  for(const code of locations) {
    const button=document.createElement('button');button.textContent=code;button.onclick=()=>locateByLoc(code);msg.append(button);
  }
  return {sku,locations,loc:locations[0]};
}

// 首次打开与重新登录使用同一个链接目标，避免助手读取首个库区的场景。
async function locateInitialTarget() {
  const params=new URLSearchParams(location.search);
  if(params.get('loc') || (IS_INTEGRATION && params.get('sku'))) {
    await locateTarget({loc:params.get('loc'),sku:params.get('sku'),source:params.get('source')});
  }else if(params.get('room')){
    const response=await fetch('/api/rooms');if(!response.ok)throw Error('无法读取可访问库区');
    const target=(await response.json()).find(room=>room.loc_code===params.get('room')||room.id===params.get('room'));
    if(!target)throw Error('链接中的库区不存在或当前账号无权访问');
    await sceneNavigation.loadRoom(target.loc_code);
  }
}

// ---- 相机 Tween 飞行 ----
function flyTo(entry) {
  const center = entry.center.clone();
  // 无 locCode 时（复位/全局视角）按场景全貌取景，保证多个货架同时可见；有 locCode 时近距离查看格位
  const isWide = !entry.locCode;
  const fit = isWide ? computeCameraFit() : null;
  let toPos, toTarget;
  if (isWide) {
    toPos = fit ? fit.position.clone() : new THREE.Vector3(0, 3, 7);
    toTarget = fit ? fit.target.clone() : new THREE.Vector3(0, 1, 0);
  } else {
    // 保留观察方向，框住目标所在货架，避免固定退距把边缘格位或货架裁掉。
    const dir = camera.position.clone().sub(controls.target);
    if (dir.lengthSq() < 1e-6) dir.set(0, 0.35, 1);
    dir.normalize();
    dir.y = Math.max(dir.y, 0.18);
    const object = furnByCode[entry.rackCode] || entry.mesh;
    object.updateWorldMatrix(true, true);
    const fit = frameBounds(new THREE.Box3().setFromObject(object, true), dir);
    toTarget = fit.target;
    toPos = fit.position;
  }
  tween = {
    fromPos: camera.position.clone(),
    toPos,
    fromTarget: controls.target.clone(),
    toTarget,
    t: 0, dur: 1.1,
  };
}
const easeInOut = (x) => (x < 0.5 ? 2 * x * x : 1 - Math.pow(-2 * x + 2, 2) / 2);

// ---- 工具栏 ----
document.getElementById('resetView').onclick = () => {
  fitCameraToScene();
};

// ---- 3D 视角快速切换（右上角浮层 #viewBar） ----
function flyToView(pos, target, dur = 0.8) {
  tween = {
    fromPos: camera.position.clone(),
    toPos: pos.clone(),
    fromTarget: controls.target.clone(),
    toTarget: target.clone(),
    t: 0, dur
  };
}
function setViewPreset(name) {
  const fit = computeCameraFit();
  const c = fit.center || new THREE.Vector3(0, 1, 0);
  const cy = c.y;
  const sz = fit.size || new THREE.Vector3(4, 2, 3);
  const maxDim = Math.max(sz.x, sz.z);
  const dist = Math.max((fit.dist || 7) * 0.95, 7);
  const target = new THREE.Vector3(c.x, cy, c.z);
  let pos;
  if (name === 'top') {
    // 正上方俯视：加极小 z 偏移，避免相机视线与 up 平行导致 OrbitControls 万向锁翻转
    pos = new THREE.Vector3(c.x, cy + Math.max(maxDim * 1.6, dist * 1.4), c.z + 0.001);
  } else if (name === 'front') {
    pos = new THREE.Vector3(c.x, cy + sz.y * 0.25, c.z + dist);
  } else if (name === 'right') {
    pos = new THREE.Vector3(c.x + dist, cy + sz.y * 0.25, c.z);
  } else { // iso：等同「复位 / 适应全貌」
    pos = fit.position.clone();
    target.copy(fit.target);
  }
  flyToView(pos, target);
}
const viewBtns = Array.from(document.querySelectorAll('#viewBar [data-view]'));
function clearViewActive() { viewBtns.forEach((b) => b.classList.remove('active')); }
let gizmoDragged = false; // 拖拽结束后短暂置位，抑制误触发的视角点击
viewBtns.forEach((b) => {
  b.addEventListener('click', () => {
    if (gizmoDragged) return;
    clearViewActive();
    b.classList.add('active');
    setViewPreset(b.dataset.view);
  });
});

// 视角立方体控件可拖拽：轻点=切视角，按住移动=拖动（位置记 localStorage）
// 注意：不能用 setPointerCapture，否则 click 会被重定向到容器、立方面/按钮收不到点击。
// 改为在 window 上挂 move/up 监听，普通点击照常触发 [data-view] 处理器。
// 边界固定为 #scene（3D 界面容器），保证控件只会在 3D 区域内移动，绝不会压到侧栏 / 布局编辑器等其它界面。
(function makeGizmoDraggable() {
  const el = document.getElementById('viewBar');
  const sceneEl = document.getElementById('scene');
  if (!el || !sceneEl) return;
  const parent = sceneEl; // 显式锁定边界为 3D 容器，不依赖 offsetParent（可能解析到 body）
  const KEY = 'spatial_viewGizmoPos';
  // 把坐标钳制在 #scene 内部，避免越界
  const clampToScene = (l, t) => {
    const maxL = Math.max(0, parent.clientWidth - el.offsetWidth);
    const maxT = Math.max(0, parent.clientHeight - el.offsetHeight);
    const bar = document.getElementById('topbar');
    const minT = Math.min(maxT, bar.offsetTop + bar.offsetHeight + 8);
    return { l: Math.max(0, Math.min(l, maxL)), t: Math.max(minT, Math.min(t, maxT)) };
  };
  const saved = (() => { try { return JSON.parse(localStorage.getItem(KEY) || 'null'); } catch { return null; } })();
  if (saved && typeof saved.left === 'number' && typeof saved.top === 'number') {
    const c = clampToScene(saved.left, saved.top);
    el.style.right = 'auto';
    el.style.left = c.l + 'px';
    el.style.top = c.t + 'px';
  }
  let startX = 0, startY = 0, startLeft = 0, startTop = 0, dragging = false, moved = false;
  const TH = 4;
  el.style.touchAction = 'none';
  const onMove = (e) => {
    if (!dragging) return;
    const dx = e.clientX - startX, dy = e.clientY - startY;
    if (!moved && Math.hypot(dx, dy) > TH) moved = true;
    if (!moved) return;
    const c = clampToScene(startLeft + dx, startTop + dy);
    el.style.left = c.l + 'px';
    el.style.top = c.t + 'px';
  };
  const onUp = () => {
    if (!dragging) return;
    dragging = false;
    el.classList.remove('dragging');
    window.removeEventListener('pointermove', onMove);
    window.removeEventListener('pointerup', onUp);
    window.removeEventListener('pointercancel', onUp);
    if (moved) {
      gizmoDragged = true;
      setTimeout(() => { gizmoDragged = false; }, 0);
      try { localStorage.setItem(KEY, JSON.stringify({ left: el.offsetLeft, top: el.offsetTop })); } catch {}
    }
  };
  el.addEventListener('pointerdown', (e) => {
    if (e.button) return; // 仅左键 / 触摸
    el.style.right = 'auto';
    startLeft = el.offsetLeft; startTop = el.offsetTop;
    startX = e.clientX; startY = e.clientY;
    dragging = true; moved = false;
    el.classList.add('dragging');
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
    window.addEventListener('pointercancel', onUp);
  });
  // 窗口 / 工具栏收拢导致 #scene 尺寸变化时，重新把控件钳回界内，防止越界压到其它界面
  const repositionGizmo = () => {
    const c = clampToScene(el.offsetLeft, el.offsetTop);
    el.style.left = c.l + 'px';
    el.style.top = c.t + 'px';
  };
  const gizmoBoundsObserver = new ResizeObserver(repositionGizmo);
  gizmoBoundsObserver.observe(parent);
  gizmoBoundsObserver.observe(document.getElementById('topbar'));
  repositionGizmo();
})();
// 用户用鼠标 / 触控自由旋转或平移后，取消预设视角高亮（当前视角已不再是某个预设）
if (controls && controls.addEventListener) {
  controls.addEventListener('start', clearViewActive);
}

// ---- 收纳概览（从 cellRegistry + sceneFurniture 实时统计，无需后端） ----
document.getElementById('overviewBtn').onclick = openOverview;
document.getElementById('ov_close').onclick = () => document.getElementById('overviewModal').classList.add('hidden');
document.getElementById('inventoryExportBtn').onclick = () => document.getElementById('transferModal').classList.remove('hidden');
function openTransferChild(id, open) {
  const parent=document.getElementById('transferModal'),child=document.getElementById(id);
  parent.classList.add('hidden');
  // 子窗口的取消、Esc、遮罩关闭及完成操作，都返回本次进入的选择页。
  const observer=new MutationObserver(()=>{
    if(!child.classList.contains('hidden'))return;
    observer.disconnect();
    parent.classList.remove('hidden');
  });
  open();
  observer.observe(child,{attributes:true,attributeFilter:['class']});
}
document.getElementById('transferImport').onclick=()=>openTransferChild('impModal',openImport);
document.getElementById('transferExport').onclick=()=>openTransferChild('exportModal',()=>document.getElementById('exportModal').classList.remove('hidden'));
document.getElementById('transferClose').onclick=()=>document.getElementById('transferModal').classList.add('hidden');
document.getElementById('qrBtn').onclick = () => window.open('/apps/web/labels/index.html?room=' + encodeURIComponent(currentRoomCode || '') + '&roomName=' + encodeURIComponent(document.getElementById('roomSel')?.selectedOptions[0]?.textContent || ''), '_blank');
const openCounter = createCounterPanel({getRoom:()=>currentRoomCode,confirm:appConfirm,onAuthRequired:()=>showLogin('权限不足或会话已过期，请重新登录后核对待确认操作')});
document.getElementById('ioBtn').onclick=()=>openCounter();
window.addEventListener('spatial-access-change',()=>{if(IS_SUPOS&&!IS_INTEGRATION&&selected)showSidebar(selected);});
// 子窗口（出入库台）完成 入库/出库/移库 后，自动刷新主视图，避免主窗口数据滞后
const counterAppPath = new URL('.',window.location.href).pathname;
let counterRefreshTimer=null,counterRefreshRunning=false,counterRefreshPending=false;
function refreshAfterCounter() {
  counterRefreshPending=true;
  clearTimeout(counterRefreshTimer);
  counterRefreshTimer=setTimeout(flushCounterRefresh,200);
}
async function flushCounterRefresh() {
  if(counterRefreshRunning)return;
  counterRefreshRunning=true;
  try {
    while(counterRefreshPending){
      counterRefreshPending=false;
      const refreshed=await window.SPATIAL_REFRESH_VIEW();
      if(refreshed!==false)toast('出入库台已更新，当前格位已刷新',true);
    }
  }catch(error){counterRefreshPending=false;toast('库存已变更，视图尚未刷新：'+error.message);}
  finally{counterRefreshRunning=false;}
}
// 只响应同源、同一应用实例的库存通知；连续业务完成后仍刷新最终数量。
window.addEventListener('message',e=>{
  if(e.origin===window.location.origin&&e.data?.type==='counter-updated'&&e.data.appPath===counterAppPath)refreshAfterCounter();
});
window.addEventListener('storage',e=>{
  if(e.key==='spatial_counter_dirty:'+counterAppPath)refreshAfterCounter();
});

function openOverview() {
  const items = [];
  cellRegistry.forEach((e) => { (e.items || []).forEach((it) => items.push(it)); });
  const totalItems = items.length;
  const totalCells = cellRegistry.length;
  const occupied = cellRegistry.filter((e) => (e.items || []).length > 0).length;
  const emptyCells = cellRegistry.filter((e) => (e.items || []).length === 0).length;
  const capacityCells=cellRegistry.filter(e=>e.items.length && e.capacityState?.basis==='manual');
  const estimatedCells=cellRegistry.filter(e=>e.items.length && e.capacityState?.basis==='estimated');
  const locked = cellRegistry.filter((e) => e.status === 'locked').length;
  const stocktaking = cellRegistry.filter((e) => e.status === 'stocktaking').length;
  // 占用率：3/670 这类极低占用取整会变成刺眼的「0%」，明明已经用了却说没用到。
  // 所以小于 1% 时保留一位小数，正好 0 才显示 0。
  const fmtPct = (num, den) => {
    if (!den || !num) return '0';
    const pct = (num / den) * 100;
    return String(Number(pct.toFixed(1)));
  };
  const occPct = fmtPct(occupied, totalCells);
  const emptyPct = fmtPct(emptyCells, totalCells);

  document.getElementById('ov_room').textContent = roomSel?.selectedOptions[0]?.textContent || currentRoomCode || '当前空间';
  document.getElementById('ov_head').innerHTML = `
    <div class="ov-card"><div class="n">${totalItems}</div><div class="l">库存记录数</div></div>
    <div class="ov-card"><div class="n">${totalCells}</div><div class="l">格位总数</div></div>
    <div class="ov-card"><div class="n">${occPct}%</div><div class="l">格位占用率（${occupied}/${totalCells}）</div></div>
    <div class="ov-card"><div class="n">${capacityCells.length}</div><div class="l">已核定 SKU 容量格位 · ${estimatedCells.length} 格可估算<br>不同 SKU 容量不合计</div></div>
    <div class="ov-card"><div class="n">${emptyPct}%</div><div class="l">空置格位（${emptyCells}）</div></div>
    <div class="ov-card"><div class="n" style="color:${(locked + stocktaking) ? '#fbbf24' : '#86efac'}">${locked + stocktaking}</div><div class="l">锁定/盘点中（${locked}/${stocktaking}）</div></div>
  `;

  if(IS_INTEGRATION) {
    const sources=new Map(items.map(item=>[item.source,item]));
    for(const [source,item] of sources) {
      const card=document.createElement('div');card.className='ov-card';
      const label=document.createElement('div');label.textContent=source || '未知来源';card.append(label);
      mountFreshness(card,item);document.getElementById('ov_head').append(card);
    }
  }

  // 分类分布
  const catMap = {};
  items.forEach((i) => { const c = (i.category || '未分类').trim() || '未分类'; catMap[c] = (catMap[c] || 0) + 1; });
  const cats = Object.entries(catMap).sort((a, b) => b[1] - a[1]);
  const maxCat = cats.length ? cats[0][1] : 1;
  const catsEl = document.getElementById('ov_cats');
  catsEl.innerHTML = cats.length
    ? cats.map(([c, n]) => `<div class="ov-bar-row"><span class="name" title="${esc(c)}">${esc(c)}</span><div class="ov-bar-track"><div class="ov-bar-fill" style="width:${Math.max(6, Math.round((n / maxCat) * 100))}%"></div></div><span class="val">${n} 条</span></div>`).join('')
    : '<div class="ov-empty">暂无库存，请配置库存来源并同步。</div>';

  // 各货架占用率
  const furnMap = {};
  cellRegistry.forEach((e) => {
    const code = e.rackCode;
    if (!furnMap[code]) furnMap[code] = { code, label: code, total: 0, occupied: 0, items: 0 };
    furnMap[code].total++;
    if ((e.items || []).length > 0) furnMap[code].occupied++;
    furnMap[code].items += (e.items || []).length;
  });
  sceneFurniture.forEach((f) => { if (furnMap[f.code]) furnMap[f.code].label = f.label || f.code; });
  const furnList = Object.values(furnMap);
  const furnEl = document.getElementById('ov_furn');
  furnEl.innerHTML = furnList.length
    ? furnList.map((f) => {
        const pct = fmtPct(f.occupied,f.total);
        return `<div class="ov-furn"><span class="nm" title="${esc(f.label)}">${esc(f.label)}</span><div class="track"><div class="fill" style="width:${pct}%"></div></div><span class="meta">已用 ${f.occupied}/${f.total} 格 · ${pct}% · ${f.items} 条库存</span></div>`;
      }).join('')
    : '<div class="ov-empty">暂无货架。</div>';

  document.getElementById('ovBatchBtn').hidden = (IS_INTEGRATION || IS_SUPOS) && !document.documentElement.classList.contains('space-editor');
  document.getElementById('ovBatchBtn').onclick = openBatch;
  document.getElementById('overviewModal').classList.remove('hidden');
}

const spaceManagement = createSpaceManagement({
  confirm: appConfirm,
  canManage: () => workspaceAccess().canManage,
  cells: () => cellRegistry, selected: () => selected, refresh: async () => {
    const code=selected?.locCode;await loadScene();
    const entry=cellRegistry.find(c=>c.locCode===code);if(entry)selectCell(entry);
  },
  actions: [
    ['格位合并', () => document.getElementById('mergeBtn').click(), 'mergeModal'],
    ['批量格位属性', () => openBatch(), 'batchModal'],
  ],
});
document.getElementById('spaceManageBtn').onclick = () => spaceManagement.open();
function openBatch() {
  if ((IS_INTEGRATION || IS_SUPOS) && !document.documentElement.classList.contains('space-editor')) return;
  for (const id of ['batchStatus','batchCap','batchLoad','batchTags','batchNote']) document.getElementById(id).value = '';
  const fieldIds={capacity:'batchCap',max_load:'batchLoad',tags:'batchTags',note:'batchNote'};
  for(const id of Object.values(fieldIds)){
    const mode=document.getElementById(id+'Mode'),input=document.getElementById(id);
    mode.value='keep';input.disabled=true;input.style.display='none';
    mode.onchange=()=>{input.disabled=mode.value!=='set';input.style.display=input.disabled?'none':'';updateSummary();};
  }
  const modal = document.getElementById('batchModal');
  const box = document.getElementById('batchBox');
  const revisions=Object.fromEntries(cellRegistry.map(c=>[c.locCode,c.meta?.revision]));
  const selection=mountBatchSelection(box,[...cellRegistry],updateSummary);
  let saving=false;
  function updateSummary(){
    const count=selection.codes().length;
    const changed=Object.values(fieldIds).filter(id=>document.getElementById(id+'Mode').value!=='keep').length+(document.getElementById('batchStatus').value?1:0);
    document.getElementById('batchSummary').textContent='已选 '+count+' 格 · 修改 '+changed+' 项属性 · 筛选外已选 '+selection.hiddenCount()+' 格';
    document.getElementById('batchApply').disabled=!count||!changed;
  }
  document.getElementById('batchStatus').onchange=updateSummary;
  selection.render();
  modal.onclick=event=>{if(event.target===modal&&!saving)modal.classList.add('hidden');};
  document.getElementById('batchCancel').onclick = () => modal.classList.add('hidden');
  document.getElementById('batchApply').onclick = async () => {
    if(saving)return;
    const sel = selection.codes();
    if (!sel.length) { toast('请先勾选格位'); return; }
    const status = document.getElementById('batchStatus').value;
    let meta;
    try {
      const fields=Object.fromEntries(Object.entries(fieldIds).map(([key,id])=>[key,{mode:document.getElementById(id+'Mode').value,value:document.getElementById(id).value}]));
      meta=buildBatchMeta(fields,status);
      if(Object.hasOwn(meta,'capacity')) {
        if(meta.capacity===null)meta.capacity_rule={clear:true};
        else {
          const groups=sel.map(code=>capacityProducts(cellRegistry.find(c=>c.locCode===code)?.items || []));
          if(groups.some(p=>p.length!==1) || new Set(groups.map(p=>productKey(p[0]))).size!==1)throw Error('批量核定容量请选择存放同一 SKU、同一单位的格位；空格位或混放格位请单独设置');
          meta.capacity_rule={product:groups[0][0],capacity:meta.capacity};
        }
      }
    }catch(error){toast(error.message);return;}
    if (!Object.keys(meta).length) { toast('请填写需要修改的属性'); return; }
    saving=true;
    const controls=[...modal.querySelectorAll('input,select,button')].map(el=>[el,el.disabled]);
    controls.forEach(([el])=>el.disabled=true);
    try {
      const res = await fetch('/api/cells/meta', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ codes: sel, meta, revisions:Object.fromEntries(sel.map(code=>[code,revisions[code]])) }) });
      if (!res.ok) throw new Error((await res.json()).error || '批量失败');
      const result = await res.json();
      toast('已更新 ' + result.updated.length + ' 个格位');
      await loadScene();
      modal.classList.add('hidden');
    } catch (e) { toast('批量失败：' + e.message); }
    finally { saving=false;controls.forEach(([el,disabled])=>el.disabled=disabled);updateSummary(); }
  };
  modal.classList.remove('hidden');
}

document.getElementById('searchBtn').onclick = () => doSearch(document.getElementById('searchInput').value);
document.getElementById('searchInput').addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.isComposing) doSearch(e.target.value); });
// 输入防抖：停止输入 300ms 后才触发搜索，避免逐字符重建定位结果
let searchTimer = null;
function scheduleInventorySearch(event) {
  ++inventorySearchVersion;
  clearTimeout(searchTimer);
  if(event?.isComposing)return;
  searchTimer=setTimeout(()=>doSearch(document.getElementById('searchInput').value),300);
}
document.getElementById('searchInput').addEventListener('input',scheduleInventorySearch);
document.getElementById('searchInput').addEventListener('compositionend',scheduleInventorySearch);
document.getElementById('searchScope').onchange=()=>doSearch(document.getElementById('searchInput').value);
document.getElementById('clearSearch').onclick=()=>{
  const input=document.getElementById('searchInput');input.value='';input.focus();doSearch('');
};

// ---- 库存导出（Excel / CSV）：复用已打包的 xlsx 依赖 ----
function csvCell(v) {
  const s = v == null ? '' : String(v);
  return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
}
let inventoryExportUrl = null;
let inventoryExportFile = null;
function clearInventoryExport() {
  if (inventoryExportUrl) URL.revokeObjectURL(inventoryExportUrl);
  inventoryExportUrl = null;
  inventoryExportFile = null;
  document.getElementById('expResult').hidden = true;
  document.getElementById('expDownload').removeAttribute('href');
}
function downloadBlob(filename, blob) {
  inventoryExportFile = { filename, blob };
  inventoryExportUrl = URL.createObjectURL(blob);
  const link = document.getElementById('expDownload');
  link.href = inventoryExportUrl;
  link.download = filename;
  document.getElementById('expFilename').textContent = filename;
  document.getElementById('expResult').hidden = false;
  const canChoose = typeof window.showSaveFilePicker === 'function';
  document.getElementById('expSaveAs').hidden = !canChoose;
  document.getElementById('expSaveHint').textContent = canChoose
    ? '选择保存位置可指定文件夹和文件名；直接下载由浏览器决定保存位置。'
    : '当前浏览器不支持选择保存位置。请点击下载文件，并查看浏览器下载记录（通常在“下载”文件夹）。';
}
function fileStamp() {
  const d = new Date(), p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}
async function doExportInventory() {
  const generate = document.getElementById('expOk');
  if (generate.disabled) return;
  clearInventoryExport();
  generate.disabled = true;
  generate.textContent = '正在生成…';
  document.getElementById('expScope').disabled = true;
  document.getElementById('expFmt').disabled = true;
  try {
  const scope = document.getElementById('expScope').value;
  const fmt = document.getElementById('expFmt').value;
  const exportRoomCode = currentRoomCode;
  const tk = apiGetToken();
  const headers = { Authorization: 'Bearer ' + tk };
  const [invRes, itemsRes] = await Promise.all([
    fetch('/api/v1/inventory', { headers }),
    fetch('/api/v1/items', { headers }),
  ]);
  if (!invRes.ok) { toast('导出失败：' + invRes.status); return; }
  const inv = await invRes.json();
  const skuMap = {}, catMap = {}, noteMap = {};
  if (itemsRes.ok) { (await itemsRes.json()).forEach((it) => { skuMap[it.id] = it.sku || ''; catMap[it.id] = it.category || ''; noteMap[it.id] = it.note || ''; }); }
  let rows = inv.map((r) => {
    const rack = (r.loc_code || '').split('-').slice(0, -2).join('-'); // 完整库位码去掉末两段（层-位）即得货架前缀
    return {
      ...(IS_INTEGRATION?{归位状态:r.loc_code?'已归位':'待分配',所属仓库:r.warehouse_code || ''}:{}),
      库位: r.loc_code || '', 库位名: r.loc_name || '', 货架: rack,
      物品名称: r.name, 数量: r.qty, SKU: r.sku || skuMap[r.item_id] || '',
      品类: catMap[r.item_id] || '', 备注: noteMap[r.item_id] || '', ERP编码: r.erp_code || '',
      来源:r.source || '',批次:r.batch_no || '',单位:r.unit || '件',状态:r.status || '',外部库位:r.external_loc_code || '',
    };
  });
  if (scope === 'room' && exportRoomCode) rows = rows.filter((r) => (r.库位 || '').startsWith(exportRoomCode + '-'));
  if (!rows.length) { toast('当前范围没有可导出的库存'); return; }
  if (fmt === 'csv') {
    const cols = ['库位', '库位名', '货架', '物品名称', '数量', 'SKU', '品类', '备注', 'ERP编码', '来源', '批次', '单位', '状态', '外部库位'];
    if(IS_INTEGRATION)cols.push('归位状态','所属仓库');
    const csv = [cols.join(',')].concat(rows.map((r) => cols.map((c) => csvCell(r[c])).join(','))).join('\n');
    downloadBlob('库存_' + fileStamp() + '.csv', new Blob(['﻿' + csv], { type: 'text/csv;charset=utf-8' }));
  } else {
    const ws = XLSX.utils.json_to_sheet(rows);
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, '库存');
    const out = XLSX.write(wb, { bookType: 'xlsx', type: 'array' });
    downloadBlob('库存_' + fileStamp() + '.xlsx', new Blob([new Uint8Array(out)], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' }));
  }
  document.getElementById('expStatus').textContent = '文件已生成，共 ' + rows.length + ' 条库存。请选择保存位置或下载文件。';
  } catch (error) {
    toast('导出失败，请检查连接后重试');
  } finally {
    generate.disabled = false;
    generate.textContent = '生成文件';
    document.getElementById('expScope').disabled = false;
    document.getElementById('expFmt').disabled = false;
  }
}
document.getElementById('expScope').addEventListener('change', clearInventoryExport);
document.getElementById('expFmt').addEventListener('change', clearInventoryExport);
document.getElementById('expDownload').onclick = () => {
  document.getElementById('expStatus').textContent = '已请求浏览器下载，请查看浏览器下载记录或保存提示。';
};
document.getElementById('expSaveAs').onclick = async () => {
  const file = inventoryExportFile;
  if (!file) return;
  const button = document.getElementById('expSaveAs');
  button.disabled = true;
  try {
    // 必须由用户点击直接打开，不能放在获取库存的异步请求之后。
    const isCsv = file.filename.endsWith('.csv');
    const handle = await window.showSaveFilePicker({
      suggestedName: file.filename,
      types: [{ description: isCsv ? 'CSV 文件' : 'Excel 文件', accept: isCsv
        ? { 'text/csv': ['.csv'] }
        : { 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': ['.xlsx'] } }],
    });
    const writable = await handle.createWritable();
    await writable.write(file.blob);
    await writable.close();
    if (inventoryExportFile === file) document.getElementById('expStatus').textContent = '已保存到所选位置：' + handle.name;
  } catch (error) {
    if (inventoryExportFile === file) document.getElementById('expStatus').textContent = error.name === 'AbortError'
      ? '已取消保存，文件仍可下载。'
      : '未能保存文件，请重试或使用“下载文件”。';
  } finally {
    button.disabled = false;
  }
};
const exportBtn = document.getElementById('exportBtn');
if (exportBtn) exportBtn.onclick = () => { const m = document.getElementById('exportModal'); if (m) m.classList.remove('hidden'); };
if (document.getElementById('expCancel')) document.getElementById('expCancel').onclick = () => document.getElementById('exportModal').classList.add('hidden');
if (document.getElementById('expOk')) document.getElementById('expOk').onclick = () => doExportInventory();
const exportModalEl = document.getElementById('exportModal');
if (exportModalEl) exportModalEl.addEventListener('click', (e) => { if (e.target === exportModalEl) exportModalEl.classList.add('hidden'); });

// 多库区切换
document.getElementById('roomSel').onchange = (e) => { const target = e.target.value; syncRoomSel(); loadScene(target); };
document.getElementById('siteSel').onchange = (e) => { const target = e.target.value; syncRoomSel(); onSiteChange(target); };
document.getElementById('addRoomBtn').onclick = async () => {
  const v = await askInputs('新建库区', [{ key: 'name', label: '库区名称', placeholder: '如：1号库区', default: '新库区', required: true }]);
  if (!v) return;
  const name = v.name;
  try {
    const res = await fetch('/api/rooms', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name, siteCode: currentSiteCode }) });
    if (!res.ok) throw new Error((await res.json()).error || '创建失败');
    const r = await res.json();
    await refreshRooms();
    await loadScene(r.loc_code);
  } catch (e) { toast('创建库区失败：' + e.message); }
};
// 新建仓库（场地）
document.getElementById('addSiteBtn').onclick = async () => {
  const v = await askInputs('新建仓库', [
    { key: 'name', label: '仓库名称', placeholder: '如：主仓库', default: '新仓库', required: true },
    { key: 'code', label: '仓库编码（选填，1–8位字母或数字，留空自动生成）', placeholder: '如 WH / CK / DC', default: '' },
  ]);
  if (!v) return;
  const name = v.name;
  const code = v.code;
  try {
    const res = await fetch('/api/site', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name, code }) });
    if (!res.ok) throw new Error((await res.json()).error || '创建失败');
    const s = await res.json();
    await refreshSites();
    await onSiteChange(s.loc_code);
  } catch (e) { toast('创建仓库失败：' + e.message); }
};

// 概览
const sidebarSections = new Map();
const sidebarLists = new Map();
function initSidebar() {
  const total = cellRegistry.reduce((sum,c)=>sum+c.items.length,0);
  const occupied = cellRegistry.filter(c=>c.items.length>0).length;
  const empty = cellRegistry.length-occupied;
  const percent = cellRegistry.length ? Number((occupied/cellRegistry.length*100).toFixed(1)) : 0;
  const el = document.getElementById('sidebar');
  const nameOf=id=>[...document.getElementById(id).options].find(o=>o.value===(id==='siteSel'?currentSiteCode:currentRoomCode))?.textContent || '未选择';
  const area=roomGroup ? Number((sceneRoomDims.width*sceneRoomDims.depth).toFixed(2))+' ㎡' : '未设置';
  const concerns=[['overCapacity','超容量',c=>c.overCapacity],['overWeight','超承重',c=>c.overWeight],
    ['locked','锁定',c=>c.status==='locked'],['stocktaking','盘点中',c=>c.status==='stocktaking']];
  const labels=c=>concerns.filter(([, ,matches])=>matches(c)).map(([,name])=>name);
  el.innerHTML=`
    <div class="card"><h3>空间概况</h3>
      <dl class="sb-facts"><dt>仓库</dt><dd>${esc(nameOf('siteSel'))}</dd><dt>库区</dt><dd>${esc(nameOf('roomSel'))}</dd>
      <dt>库区面积</dt><dd>${area}</dd><dt>货架 / 储位区</dt><dd>${rackGroups.length} 个</dd></dl>
    </div>
    <div class="card"><h3>占用统计</h3>
      <div class="sb-stats"><div><strong>${cellRegistry.length}</strong><span>总格位</span></div><div><strong>${occupied}</strong><span>已用</span></div><div><strong>${empty}</strong><span>空闲</span></div></div>
      <div class="sb-occupancy">格位占用率 <b>${percent}%</b></div><progress class="sb-progress" max="100" value="${percent}" aria-label="格位占用率"></progress>
      <p class="hint">库存记录 ${total} 条${IS_INTEGRATION?' · 按当前同步数据统计，空闲表示暂无库存记录。':''}</p>
    </div>
    <div class="card"><h3>需关注事项</h3><div class="sb-concerns">${concerns.map(([key,name,matches])=>{
      const count=cellRegistry.filter(matches).length;
      return `<button type="button" data-concern="${key}" ${count?'':'disabled'}>${name} <b>${count}</b></button>`;
    }).join('')}</div><p class="hint">点击分类查看格位，再点击格位定位。锁定、盘点为本应用空间标记。</p></div>
    <div class="card"><h3>格位列表</h3><div class="sb-filter" role="group" aria-label="格位列表筛选">
      <button type="button" data-cell-filter="all">全部</button><button type="button" data-cell-filter="used">已用</button><button type="button" data-cell-filter="empty">空闲</button>
      </div><p id="sbListSummary" class="hint" aria-live="polite"></p><div id="sbCellList"></div><button type="button" id="sbMore" class="full">显示更多</button>
    </div>
    <button class="full" id="impBtn2">📥 批量导入 CSV</button><button class="full" id="expBtn2" style="margin-top:6px">📤 导出库存</button>`;
  // 使用原生折叠区，刷新库存或返回概况时保留本次会话的展开状态。
  const summaries = [nameOf('roomSel'), `${occupied} / ${cellRegistry.length} 已用 · ${percent}%`,
    `${cellRegistry.filter(c=>labels(c).length).length} 个格位需关注`, `${cellRegistry.length} 个格位`];
  [...el.querySelectorAll(':scope > .card')].forEach((card, index) => {
    const heading = card.querySelector('h3');
    const key = heading.textContent;
    const section = document.createElement('details'); section.className = 'card sb-section';
    section.open = sidebarSections.get(key) ?? (index !== 2 || cellRegistry.some(c=>labels(c).length));
    const summary = document.createElement('summary');
    const title = document.createElement('span'); title.className = 'sb-section-title'; title.textContent = key;
    const brief = document.createElement('span'); brief.className = 'sb-section-brief'; brief.textContent = summaries[index];
    summary.append(title, brief); heading.remove();
    const body = document.createElement('div'); body.className = 'sb-section-body'; body.append(...card.childNodes);
    section.append(summary, body); card.replaceWith(section);
    section.addEventListener('toggle', () => sidebarSections.set(key, section.open));
  });
  if(IS_INTEGRATION) {
    const card=document.createElement('div');card.className='card';
    const heading=document.createElement('h3');heading.textContent='待分配货品';
    const summary=document.createElement('p');summary.className='hint';summary.textContent='正在读取当前仓库…';
    const list=document.createElement('div');
    const more=document.createElement('button');more.type='button';more.className='full';more.textContent='显示更多';more.hidden=true;
    card.append(heading,summary,list,more);el.insertBefore(card,el.children[2]);
    const warehouse=currentSiteCode;let page=1,revision='';
    async function loadPending() {
      more.disabled=true;
      try {
        const params=new URLSearchParams({assignment:'unassigned',warehouse,page:String(page),page_size:'20'});
        if(revision)params.set('revision',revision);
        const response=await fetch('/api/integration/inventory/page?'+params);
        if(!response.ok)throw new Error(response.status===409?'库存已变化，请刷新数据':'待分配读取失败，请重试');
        const data=await response.json();if(!card.isConnected || warehouse!==currentSiteCode)return;
        revision=data.revision;
        summary.textContent=`当前仓库 ${data.total} 条待分配库存，不计入格位占用。`;
        for(const row of data.rows) {
          const item=document.createElement('div');item.className='sb-cell';
          const title=document.createElement('strong');title.textContent=row.name;
          const detail=document.createElement('span');detail.textContent=`SKU：${row.sku} · ${row.qty} ${row.unit} · 来源：${row.source} · 批次：${row.batch_no || '无'}`;
          item.append(title,detail);list.append(item);
        }
        more.hidden=data.page>=data.pages;page=data.page+1;
        if(data.total)summary.textContent+=' 在「格位管理」选择格位、填写 SKU 并保存后自动归入，多来源时再选择来源。';
      } catch(error) {summary.textContent=error.message;more.hidden=false;more.textContent='重新读取';page=1;revision='';list.replaceChildren();}
      finally {more.disabled=false;}
    }
    more.onclick=loadPending;loadPending();
  }
  const listState=sidebarLists.get(currentRoomCode) || {filter:'used',limit:20,scrollTop:0};
  sidebarLists.set(currentRoomCode,listState);
  let {filter,limit}=listState;
  function renderCells() {
    Object.assign(listState,{filter,limit});
    const concern=concerns.find(([key])=>key===filter);
    const cells=cellRegistry.filter(c=>concern ? concern[2](c) : filter==='used' ? c.items.length>0 : filter==='empty' ? !c.items.length : true);
    el.querySelectorAll('[data-cell-filter]').forEach(b=>b.setAttribute('aria-pressed',String(b.dataset.cellFilter===filter)));
    el.querySelectorAll('[data-concern]').forEach(b=>b.setAttribute('aria-pressed',String(b.dataset.concern===filter)));
    el.querySelector('#sbListSummary').textContent=`${concern?concern[1]:{all:'全部',used:'已用',empty:'空闲'}[filter]} · ${cells.length} 个格位 · 显示 ${Math.min(limit,cells.length)} 个`;
    const list=el.querySelector('#sbCellList');list.replaceChildren();
    if(!cells.length)list.textContent='暂无符合条件的格位';
    for(const cell of cells.slice(0,limit)) {
      const button=document.createElement('button');button.type='button';button.className='sb-cell';button.dataset.loc=cell.locCode;
      const code=document.createElement('span');code.className='code';code.textContent=cell.locCode;
      const info=document.createElement('span');info.textContent=[cell.items.length ? cell.items.length+' 条库存记录':'暂无库存记录',...labels(cell)].join(' · ');
      button.append(code,info);button.title='定位到 '+cell.locCode;button.onclick=()=>locateByLoc(cell.locCode);list.append(button);
    }
    el.querySelector('#sbMore').hidden=cells.length<=limit;
  }
  el.querySelectorAll('[data-cell-filter],[data-concern]').forEach(button=>button.onclick=()=>{
    filter=button.dataset.cellFilter || button.dataset.concern;limit=20;renderCells();
    if(button.dataset.concern) { const list=el.querySelector('#sbListSummary'); list.closest('details').open=true; list.scrollIntoView({block:'nearest'}); }
  });
  el.querySelector('#sbMore').onclick=()=>{limit+=20;renderCells();};
  document.getElementById('impBtn2').onclick=openImport;
  document.getElementById('expBtn2').onclick=()=>document.getElementById('exportModal').classList.remove('hidden');
  renderCells();
  el.scrollTop=listState.scrollTop;
}

// ================= 录入 / 编辑弹窗 =================
const modal = document.getElementById('modal');
let pendingPhoto = null;
let editingId = null;

// 每次打开录入/编辑弹窗都重新拉取格位：新增或删除货架后格位会变，
// 若只在首次加载时拉，新货架的格位将永远选不到（录入卡在「请填写位置」）。
async function ensureCells() {
  const sel = document.getElementById('f_loc');
  const hint = document.getElementById('f_nocell');
  try {
    const res = await fetch('/api/cells');
    const allCells = res.ok ? await res.json() : [];
    const currentCodes = new Set(cellRegistry.map(c => c.locCode));
    const cells = allCells.filter(c => currentCodes.has(c.loc_code));
    // 无格位时不再只给一行死文字，直接给「添加货架」入口（库区为空时录入流程否则是死路）
    if (hint) hint.classList.toggle('hidden', !!(cells && cells.length));
    if (!cells.length) {
      sel.innerHTML = '<option value="">（暂无格位，请先添加货架）</option>';
      return;
    }
    // 按货架分组：WH-1-A-L01-B01 → 前 3 段 WH-1-A。格位多时扁平列表根本找不到。
    const rackLabel = {};
    for (const f of sceneFurniture) if (f.code) rackLabel[f.code] = f.label || f.code;
    const groups = new Map();
    for (const c of cells) {
      const rack = String(c.loc_code).split('-').slice(0, 3).join('-');
      if (!groups.has(rack)) groups.set(rack, []);
      groups.get(rack).push(c);
    }
    sel.innerHTML = [...groups.entries()].map(([rack, list]) => {
      const opt = (c) => `<option value="${esc(c.loc_code)}">${esc(c.loc_code)} · ${esc(c.name)}</option>`;
      const g = rackLabel[rack] ? `${esc(rack)} · ${esc(rackLabel[rack])}` : esc(rack);
      return `<optgroup label="${g}（${list.length}）">${list.map(opt).join('')}</optgroup>`;
    }).join('');
  } catch (e) {
    if (hint) hint.classList.add('hidden');
    sel.innerHTML = '<option value="">（无法加载格位）</option>';
  }
}

async function openAddModal(preselectLoc) {
  editingId = null;
  document.getElementById('f_title').textContent = '录入物品';
  document.getElementById('f_name').value = '';
  document.getElementById('f_sku').value = '';
  document.getElementById('f_cat').value = '';
  document.getElementById('f_qty').value = 1;
  document.getElementById('f_qty').disabled=false;document.getElementById('f_loc').disabled=false;document.getElementById('f_sku').readOnly=false;
  document.getElementById('f_unit').value = '';document.getElementById('f_unit').disabled=false;
  document.getElementById('f_note').value = '';
  pendingPhoto = null;
  document.getElementById('f_preview').classList.add('hidden');
  document.getElementById('f_msg').textContent = '';
  await ensureCells();
  if (preselectLoc) {
    const sel = document.getElementById('f_loc');
    if (sel) sel.value = preselectLoc;
  }
  modal.classList.remove('hidden');
  try{await refreshCreateRecovery();}catch(error){document.getElementById('f_msg').textContent=error.message;}
}

async function refreshCreateRecovery(){
  const record=(await window.CounterWrites.list()).find(row=>row.path==='/api/items');
  document.getElementById('f_retry').classList.toggle('hidden',!record||!!editingId);
  if(record&&!editingId){const body=record.body;document.getElementById('f_msg').textContent=`上次录入结果待确认：${body.name} · ${body.sku||'未编号'} · ${body.qty} ${body.unit||'沿用单位'} · ${body.loc_code}。请先核对原操作。`;}
  return record;
}
document.getElementById('f_retry').onclick=async()=>{
  if(!(await appConfirm('核对上次录入？已完成的不会重复入账，未完成的将按原内容继续提交。')))return;
  const button=document.getElementById('f_retry');button.disabled=true;
  try{
    const response=await window.CounterWrites.retry('/api/items'),result=await response.json();
    if(!response.ok)throw Error(result.error||'核对失败');
    document.getElementById('f_msg').textContent=result.replayed?'已确认：此前录入已完成，未重复入账':'录入已完成';
    await refreshCreateRecovery();await loadScene();
  }catch(error){document.getElementById('f_msg').textContent=error.message;}
  finally{button.disabled=false;}
};

document.getElementById('addBtn').onclick = () => openCounter(selected?.locCode || '', 'in');

// 从「录入物品 → 无格位 → ＋添加货架」进来的：建完货架自动回到录入弹窗，
// 否则用户建完货架还得自己再点一次「＋录入物品」。
let pendingReopenAdd = false;
document.getElementById('f_addFurn').onclick = () => {
  pendingReopenAdd = true;
  modal.classList.add('hidden');
  furnModal.classList.remove('hidden');
  document.getElementById('furn_msg').textContent = '';
};

async function openEdit(id) {
  editingId = id;
  document.getElementById('f_retry').classList.add('hidden');
  document.getElementById('f_title').textContent = '编辑货品资料';
  document.getElementById('f_qty').disabled=true;document.getElementById('f_loc').disabled=true;document.getElementById('f_sku').readOnly=true;
  // 找到该物品当前所在格位与信息（从 scene 缓存反查）
  let found = null, foundLoc = null;
  for (const c of cellRegistry) {
    const it = c.items.find((x) => x.id === id);
    if (it) { found = it; foundLoc = c.locCode; break; }
  }
  await ensureCells();
  document.getElementById('f_name').value = found ? found.name : '';
  document.getElementById('f_cat').value = found ? (found.category || '') : '';
  document.getElementById('f_qty').value = found ? found.qty : 1;
  document.getElementById('f_sku').value=found?.sku||'';
  document.getElementById('f_unit').value=found?.unit||'件';document.getElementById('f_unit').disabled=true;
  document.getElementById('f_note').value = found ? (found.note || '') : '';
  const sel = document.getElementById('f_loc');
  if (foundLoc) sel.value = foundLoc;
  pendingPhoto = found && found.cover ? found.cover : null;
  const pv = document.getElementById('f_preview');
  if (pendingPhoto) { pv.src = pendingPhoto; pv.classList.remove('hidden'); } else pv.classList.add('hidden');
  document.getElementById('f_msg').textContent = '数量和位置请通过出入库、移库或盘点调整；货品编码在货品资料中维护。';
  modal.classList.remove('hidden');
}

document.getElementById('f_cancel').onclick = () => { pendingReopenAdd = false; modal.classList.add('hidden'); };

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

document.getElementById('f_save').onclick = async () => {
  const button=document.getElementById('f_save');
  if(button.disabled)return;
  const name = document.getElementById('f_name').value.trim();
  const loc = document.getElementById('f_loc').value;
  const msg = document.getElementById('f_msg');
  if (!name || (!editingId&&!loc)) { msg.style.color = '#fca5a5'; msg.textContent = '请填写物品名称与位置'; return; }
  const qty=Number(document.getElementById('f_qty').value);
  if(!editingId&&(!Number.isFinite(qty)||qty<=0)){msg.style.color='#fca5a5';msg.textContent='请输入大于0的有效数量';return;}
  const payload = {
    name,
    sku: document.getElementById('f_sku').value.trim() || null,
    category: document.getElementById('f_cat').value.trim() || null,
    qty,
    unit:document.getElementById('f_unit').value.trim(),
    loc_code: loc,
    note: document.getElementById('f_note').value.trim() || null,
    photo: pendingPhoto,
  };
  if(editingId){delete payload.qty;delete payload.loc_code;delete payload.unit;delete payload.sku;}
  msg.style.color = '#fde68a'; msg.textContent = editingId ? '保存中…' : '保存中…';
  button.disabled=true;
  try {
    if(!editingId&&await refreshCreateRecovery())return;
    const url = editingId ? `/api/items/${editingId}` : '/api/items';
    const method = editingId ? 'PUT' : 'POST';
    const res = await fetch(url, { method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
    const r = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(r.error || '保存失败');
    msg.style.color = r.reused ? '#7dd3fc' : '#86efac';
    msg.textContent = r.reused ? `已合并到「${r.name}」库存（${r.added} ${r.unit||payload.unit||'件'}，现存 ${r.qty}）✓` : '已保存 ✓';
    await new Promise(resolve=>setTimeout(resolve,500));
      modal.classList.add('hidden');
      pendingPhoto = null;
      editingId = null;
      document.getElementById('f_preview').classList.add('hidden');
      document.getElementById('f_name').value = '';
      document.getElementById('f_sku').value = '';
      await loadScene();
  } catch (e) {
    msg.style.color = '#fca5a5'; msg.textContent = '保存失败：' + e.message;
    if(!editingId)try{await refreshCreateRecovery();}catch{}
  }
  finally{button.disabled=false;}
};

async function doDelete(id) {
  if (!(await appConfirm('确认删除该物品及当前库存？历史流水会保留。', { danger: true }))) return;
  try {
    const res = await fetch(`/api/items/${id}`, { method: 'DELETE' });
    if (!res.ok) throw new Error((await res.json()).error || '删除失败');
    await loadScene();
  } catch (e) { toast('删除失败：' + e.message); }
}

// ================= 批量导入 =================
const impModal = document.getElementById('impModal');

async function refreshImportRecovery(){
  const record=(await window.CounterWrites.list()).find(row=>row.path==='/api/import');
  document.getElementById('imp_retry').classList.toggle('hidden',!record);
  if(record){
    document.getElementById('imp_msg').textContent=`上次${record.body.rows.length}行导入结果待确认（${new Date(record.at).toLocaleString()}）。请先核对原请求，避免再次入账。`;
    document.getElementById('imp_err').style.display='block';
    document.getElementById('imp_err').textContent=record.body.rows.map(row=>`${row.loc_code||row.loc||row.location} · ${row.sku||'未编号'} ${row.name} · ${row.qty??1} ${row.unit||'沿用单位'}`).join('\n');
  }
  return record;
}
async function openImport() {
  impModal.classList.remove('hidden');document.getElementById('imp_msg').textContent='';
  try{await refreshImportRecovery();}catch(error){document.getElementById('imp_msg').textContent=error.message;}
}
document.getElementById('imp_retry').onclick=async()=>{
  if(!(await appConfirm('核对上次导入？已完成的不会重复入账，未完成的将按原内容继续提交。')))return;
  const button=document.getElementById('imp_retry');button.disabled=true;
  try{
    const response=await window.CounterWrites.retry('/api/import'),result=await response.json();
    if(!response.ok||result.errors?.length)throw Error(result.error||result.errors.map(row=>row.error).join('\n'));
    document.getElementById('imp_msg').textContent=`已确认导入${result.imported}行${result.replayed?'，未重复入账':''}`;
    document.getElementById('imp_text').value='';document.getElementById('imp_file').value='';
    await loadScene();await refreshImportRecovery();
  }catch(error){document.getElementById('imp_msg').textContent=error.message;}
  finally{button.disabled=false;}
};
document.getElementById('imp_cancel').onclick = () => impModal.classList.add('hidden');

// 下载 CSV 模板（含表头 + 3 行示例 + 注释说明）
document.getElementById('imp_tpl').onclick = () => {
  const BOM = '\uFEFF';
  const rows = [
    'rack,loc_code,name,qty,sku,unit,category,note,erp_code',
    ',WH-1-A-L01-B01,包装纸箱(小),24,BX-001,件,纸制品,60×40cm,ERP-BX001',
    ',WH-1-A-L02-B03,螺丝配件包,0.5,SC-M6,kg,紧固件,M6×20 平头,ERP-SC006',
    ',WH-1-B-L03-B02,电子元器件,100,EC-R01,件,电子料,防静电包装,ERP-EC101',
  ];
  const csv = BOM + rows.join('\r\n');
  const blob = new Blob([csv], { type: 'text/csv;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = '批量导入模板.csv';
  document.body.appendChild(a); a.click();
  a.remove(); URL.revokeObjectURL(url);
};

let reviewedImport='';
let importInputVersion=0;
function resetImportPreview(){
  reviewedImport='';
  document.getElementById('imp_save').textContent='预览并导入';
  document.getElementById('imp_err').textContent='';
  document.getElementById('imp_err').style.display='none';
  document.getElementById('imp_msg').textContent='';
}
document.getElementById('imp_text').addEventListener('input',()=>{
  importInputVersion++;
  resetImportPreview();
});
document.getElementById('imp_file').addEventListener('change', (e) => {
  const file = e.target.files[0];
  if (!file) return;
  const version=++importInputVersion;
  resetImportPreview();
  // 读取失败时也不能沿用上一份文件；迟到的读取结果不能覆盖新输入。
  document.getElementById('imp_text').value='';
  document.getElementById('imp_msg').textContent='正在读取 '+file.name+'…';
  const reader = new FileReader();
  reader.onerror=()=>{
    if(version!==importInputVersion)return;
    document.getElementById('imp_msg').textContent='文件读取失败，请重新选择文件';
  };
  const isExcel = /\.(xlsx|xls)$/i.test(file.name);
  if (isExcel) {
    reader.onload = () => {
      if(version!==importInputVersion)return;
      try {
        const wb = XLSX.read(new Uint8Array(reader.result), { type: 'array' });
        const ws = wb.Sheets[wb.SheetNames[0]];
        document.getElementById('imp_text').value = XLSX.utils.sheet_to_csv(ws);
        document.getElementById('imp_msg').textContent = '已读取 ' + file.name + ' 的第一张表，请先预览';
      } catch (err) { document.getElementById('imp_msg').textContent = 'Excel 解析失败：' + err.message; }
    };
    reader.readAsArrayBuffer(file);
  } else {
    reader.onload = () => {
      if(version!==importInputVersion)return;
      document.getElementById('imp_text').value = reader.result;
      document.getElementById('imp_msg').textContent = '已读取 ' + file.name + '，请先预览';
    };
    reader.readAsText(file);
  }
});

// 最小可用 CSV 解析（支持引号包裹、字段内含逗号）
function parseCsv(text) {
  const rows = [];
  let field = '', row = [], inQ = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inQ) {
      if (ch === '"') { if (text[i + 1] === '"') { field += '"'; i++; } else inQ = false; }
      else field += ch;
    } else {
      if (ch === '"') inQ = true;
      else if (ch === ',') { row.push(field); field = ''; }
      else if (ch === '\n') { row.push(field); rows.push(row); row = []; field = ''; }
      else if (ch !== '\r') field += ch;
    }
  }
  if (field.length || row.length) { row.push(field); rows.push(row); }
  return rows.filter((r) => r.some((c) => c.trim() !== ''));
}

// 中英文表头别名 → 规范化字段名。让「导出（中文表头）」的文件也能直接回灌「导入（英文模板）」，反之亦然。
// 这是模板对齐的关键：导入端统一认两种表头，导出再导入就不会整批错位。
const IMPORT_FIELD_ALIAS = {
  // 英文（模板原生）
  rack: 'rack', loc_code: 'loc_code', loc: 'loc_code', location: 'loc_code',
  loc_name: 'loc_name', name: 'name', qty: 'qty', quantity: 'qty',
  sku: 'sku', unit:'unit', '单位':'unit', category: 'category', note: 'note', erp_code: 'erp_code',
  // 中文（导出表头）
  '货架': 'rack', '库位': 'loc_code', '库位名': 'loc_name', '物品名称': 'name', '物品': 'name',
  '数量': 'qty', 'sku码': 'sku', '品类': 'category', '分类': 'category', '备注': 'note', 'erp编码': 'erp_code', 'erp': 'erp_code',
};
function csvRowsToObjects(rows) {
  if (!rows.length) return [];
  const header = rows[0].map((h) => {
    const k = (h || '').trim().toLowerCase();
    return IMPORT_FIELD_ALIAS[k] || k;
  });
  const out = [];
  for (let i = 1; i < rows.length; i++) {
    const obj = {};
    header.forEach((h, idx) => { obj[h] = (rows[i][idx] || '').trim(); });
    out.push(obj);
  }
  return out;
}

document.getElementById('imp_save').onclick = async () => {
  const button=document.getElementById('imp_save');
  if(button.disabled)return;
  const msg = document.getElementById('imp_msg');
  const errBox = document.getElementById('imp_err');
  errBox.style.display = 'none';
  errBox.textContent = '';
  const text = document.getElementById('imp_text').value.trim();
  if (!text) { msg.style.color = '#fca5a5'; msg.textContent = '请粘贴或上传 CSV'; return; }
  const rows = csvRowsToObjects(parseCsv(text));
  const inputVersion=importInputVersion;
  if (!rows.length) { msg.style.color = '#fca5a5'; msg.textContent = '未解析到数据行'; return; }
  button.disabled=true;
  msg.style.color = '#fde68a'; msg.textContent = `预览中…（${rows.length} 行）`;
  try {
    if(await refreshImportRecovery())return;
    let res = await fetch('/api/import', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ rows,preview:true }) });
    let r = await res.json().catch(() => ({}));
    if(inputVersion!==importInputVersion)return;
    if (!res.ok) throw new Error(r.error || '导入失败');
    // 预检未通过：整批没有导入，逐行列出问题让用户改完重试
    if (r.errors && r.errors.length) {
      msg.style.color = '#fca5a5';
      msg.textContent = `未导入：${r.errors.length} 行有问题，修正后再导一次`;
      errBox.style.display = 'block';
      errBox.style.color = '#fca5a5';
      errBox.textContent = r.errors
        .map((e) => `第 ${e.row} 行${e.name ? '（' + e.name + '）' : ''}：${e.error}`)
        .join('\n');
      return;
    }
    errBox.style.display='block';errBox.style.color='var(--text-2)';
    errBox.textContent=(r.rows||[]).map(row=>`第${row.row}行 · ${row.loc_code} · ${row.sku||'未编号'} ${row.name} · ${row.action} · ${row.before} → ${row.after} ${row.unit}`).join('\n');
    msg.textContent=`预览${rows.length}行，新建货品${r.created}个。数量按追加入库，不覆盖现有库存。`;
    if(reviewedImport!==JSON.stringify(rows)){
      reviewedImport=JSON.stringify(rows);button.textContent='确认追加导入';return;
    }
    if(!(await appConfirm(`确认追加导入这${rows.length}行库存？请先核对预览中的库位、SKU和单位。`)))return;
    res=await fetch('/api/import',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({rows})});
    r=await res.json();
    if(!res.ok||r.errors?.length)throw Error(r.error||r.errors.map(e=>`第${e.row}行：${e.error}`).join('\n'));
    msg.style.color = '#86efac';
    msg.textContent = `已导入 ${r.imported} 条（新建产品 ${r.created} 个，累加已有格位 ${r.updated} 处）`;
    document.getElementById('imp_text').value='';document.getElementById('imp_file').value='';
    reviewedImport='';button.textContent='预览并导入';
    setTimeout(async () => { impModal.classList.add('hidden'); await loadScene(); }, 1000);
  } catch (e) { msg.style.color = '#fca5a5'; msg.textContent = '导入失败：' + e.message; }
  finally{button.disabled=false;try{await refreshImportRecovery();}catch{}}
};

// ================= 货架类型目录（驱动开放/封闭与默认尺寸） =================
// open: 1=开放式(半透明可视穿), 0=封闭式(实体感更强); floor 为贴地网格特例。
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
document.getElementById('furn_cancel').onclick = () => { layoutPendingRefresh=false; furnModal.classList.add('hidden'); };
// 选不同类型时按目录载入合适的默认尺寸/层数（地面区特例：贴地网格、不需高度）
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
document.getElementById('furn_save').onclick = async () => {
  const name = document.getElementById('furn_name').value.trim();
  const msg = document.getElementById('furn_msg');
  if (!name) { msg.style.color = '#fca5a5'; msg.textContent = '请填写名称'; return; }
  const ftype = document.getElementById('furn_type').value;
  const isFloor = ftype === 'floor';
  const payload = {
    name,
    type: ftype,
    roomCode: currentRoomCode,
    rows: Number(document.getElementById('furn_rows').value),
    cols: Number(document.getElementById('furn_cols').value),
    open: isFloor ? 1 : (RACK_TYPES[ftype]?.open ?? 0),
  };
  payload.geom={w:Number(document.getElementById('furn_w').value),h:isFloor?0.05:Number(document.getElementById('furn_h').value),d:Number(document.getElementById('furn_d').value)};
  const error=rackInputError({...payload,...payload.geom});
  if(error){msg.style.color='#fca5a5';msg.textContent=error;return;}
  msg.style.color = '#fde68a'; msg.textContent = '生成中…';
  try {
    if (layoutPendingRefresh && editingLayout()) {
      const draft = {label:payload.name,type:payload.type,rows:payload.rows,cols:payload.cols,open:payload.open,
        w:payload.geom?.w || 1.2,h:isFloor?0.05:(payload.geom?.h || 1.8),d:payload.geom?.d || 0.5,rot:0,merges:{},cellNames:{}};
      appendDraftRack(draft);
      layoutPendingRefresh=false;
      furnModal.classList.add('hidden');
      document.getElementById('furn_name').value='';
      return;
    }
    const res = await fetch('/api/rack', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
    if (!res.ok) throw new Error((await res.json()).error || '生成失败');
    const r = await res.json();
    msg.style.color = '#86efac'; msg.textContent = `已生成 ${r.furn_code}（${r.rows}×${r.cols} 格位）`;
    setTimeout(async () => {
      furnModal.classList.add('hidden');
      document.getElementById('furn_name').value = '';
      await loadScene();
      // 从「录入物品 → 无格位 → ＋添加货架」进来的：建完直接回到录入弹窗
      if (pendingReopenAdd) {
        pendingReopenAdd = false;
        document.getElementById('addBtn').click();
      }
    }, 700);
  } catch (e) { msg.style.color = '#fca5a5'; msg.textContent = '生成失败：' + e.message; }
};

// ================= 货架设置（尺寸 / 类型 / 层数） =================
const furnSetModal = document.getElementById('furnSetModal');
function openFurnSetModal(targetCode) {
  const sel = document.getElementById('furnSetSel');
  if (!sceneFurniture.length) {
    toast('当前库区还没有货架，请先「添加货架」。');
    return;
  }
  setLocationOptions(sel, sceneFurniture.map(f => ({loc_code:f.code, name:f.label+'（'+f.code+'）'})));
  if (targetCode) sel.value = targetCode;
  fillFurnSet();
  furnSetModal.classList.remove('hidden');
}
function fillFurnSet() {
  const f = sceneFurniture.find((x) => x.code === document.getElementById('furnSetSel').value);
  if (!f) return;
  document.getElementById('furnSet_name').value = f.label || '';
  document.getElementById('furnSet_type').value = f.type || 'shelf';
  document.getElementById('furnSet_w').value = (f.w != null) ? f.w : '';
  document.getElementById('furnSet_h').value = (f.h != null) ? f.h : '';
  document.getElementById('furnSet_d').value = (f.d != null) ? f.d : '';
  document.getElementById('furnSet_rows').value = (f.rows != null) ? f.rows : '';
  document.getElementById('furnSet_cols').value = (f.cols != null) ? f.cols : '';
  document.getElementById('furnSet_msg').textContent = '';
}
document.getElementById('furnSetSel').onchange = fillFurnSet;
document.getElementById('furnSet_cancel').onclick = () => furnSetModal.classList.add('hidden');
document.getElementById('furnSet_save').onclick = async () => {
  const code = document.getElementById('furnSetSel').value;
  if (!code) return;
  const type = document.getElementById('furnSet_type').value;
  const name = document.getElementById('furnSet_name').value.trim();
  const W = +document.getElementById('furnSet_w').value, H = +document.getElementById('furnSet_h').value, D = +document.getElementById('furnSet_d').value;
  const rows = +document.getElementById('furnSet_rows').value, cols = +document.getElementById('furnSet_cols').value;
  const error=rackInputError({w:W,h:type==='floor'?0.05:H,d:D,rows,cols});
  if(error){const msg=document.getElementById('furnSet_msg');msg.style.color='#fca5a5';msg.textContent=error;return;}
  // 缩小层列会删除超出范围的格位；历史保留，外部引用由后端保护。
  const cur = sceneFurniture.find((x) => x.code === code);
  if (cur && rows > 0 && cols > 0 && (rows < (cur.rows || 0) || cols < (cur.cols || 0))) {
    const ok = await appConfirm(
      `把「${cur.label || code}」从 ${cur.rows || '?'} 层 × ${cur.cols || '?'} 列 改为 ${rows} 层 × ${cols} 列？\n\n` +
      `超出新范围的格位会被删除，历史流水保留。仍有外部库存或库位映射引用时会拒绝修改。\n确定继续吗？`,
      { danger: true }
    );
    if (!ok) return;
  }
  // name 始终下发（含空串）——后端已支持用空串清空名称，回退显示库位末段
  const body = { type, open: (RACK_TYPES[type]?.open ?? 0), name };
  Object.assign(body,{w:W,h:type==='floor'?0.05:H,d:D,rows,cols});
  const msg = document.getElementById('furnSet_msg');
  msg.style.color = '#fde68a'; msg.textContent = '保存中…';
  try {
    const res = await fetch('/api/rack/' + encodeURIComponent(code), { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    if (!res.ok) throw new Error((await res.json()).error || '保存失败');
    const dim = (W > 0 || H > 0 || D > 0) ? `，${W || '?'}×${H || '?'}×${D || '?'}m` : '';
    const grid = (rows > 0 || cols > 0) ? `，${rows || '?'}层×${cols || '?'}列` : '';
    await loadScene();
    msg.style.color = '#86efac'; msg.textContent = `已应用（${type === 'shelf' || type === 'rack' ? '开放式' : '封闭式'}${dim}${grid}）`;
    setTimeout(() => furnSetModal.classList.add('hidden'), 800);
  } catch (e) { msg.style.color = '#fca5a5'; msg.textContent = '失败：' + e.message; }
};
async function deleteFurniture(code) {
  if (!code) return false;
  if (!(await appConfirm(`确定删除货架「${code}」？\n该货架及其格位将被删除，历史流水保留。仍有外部库存或库位映射引用时会拒绝删除。`, { danger: true }))) return false;
  const res = await fetch('/api/rack/' + encodeURIComponent(code), { method: 'DELETE' });
  if (!res.ok) throw new Error((await res.json()).error || '删除失败');
  return true;
}

document.getElementById('furnSet_del').onclick = async () => {
  const code = document.getElementById('furnSetSel').value;
  if (!code) return;
  const msg = document.getElementById('furnSet_msg');
  msg.style.color = '#fde68a'; msg.textContent = '删除中…';
  try {
    const ok = await deleteFurniture(code);
    if (!ok) { msg.textContent = ''; return; }
    msg.style.color = '#86efac'; msg.textContent = '已删除';
    setTimeout(async () => { furnSetModal.classList.add('hidden'); await loadScene(); }, 600);
  } catch (e) { msg.style.color = '#fca5a5'; msg.textContent = '失败：' + e.message; }
};

// 复制货架：按原货架规格（类型/层数/列数/尺寸/开放与否）克隆出 N 份，自动排到右侧
// 计算 n 份复制货架的室内坐标：从源货架右侧开始，沿行向右铺排，超出房间宽度则换到下一行；
// 自动避开与已有家具（含源货架）的重叠，并确保全部落在房间边界内（否则在布局里看不到）。
function computeClonePositions(src, n, occupied, W, D) {
  const gap = 0.6;
  const {x:hw,z:hd}=halfExtents(src), positions=[], taken=[...occupied];
  const room={width:W,depth:D};
  for(let z=-D/2+hd;z<=D/2-hd+1e-6 && positions.length<n;z+=2*hd+gap) {
    for(let x=-W/2+hw;x<=W/2-hw+1e-6 && positions.length<n;x+=2*hw+gap) {
      const candidate={...src,code:undefined,x,z};
      if(placementError(candidate,room,taken))continue;
      positions.push({x,z});taken.push({...candidate,code:'copy-'+positions.length});
    }
  }
  if(positions.length<n)throw new Error('库区剩余空间不足，请减少复制数量或调整布局');
  return positions;
}

async function cloneFurniture(f, n = 1) {
  if (!f) return { created: [], srcSnapshot: null, cloneData: [] };
  n = Math.max(1, Math.min(20, parseInt(n, 10) || 1));
  // 捕获源货架当前内存中的位置/旋转快照
  const srcSnapshot = f.code ? { code: f.code, x: f.x, z: f.z, rot: f.rot || 0 } : null;
  const openFlag = (f.open == null ? (RACK_TYPES[f.type]?.open ?? 0) : f.open) ? 1 : 0;
  const room = (layoutState && layoutState.room) || ({ width: sceneRoomDims.width, depth: sceneRoomDims.depth });
  const occupied = (layoutState && layoutState.furniture && layoutState.furniture.length)
    ? layoutState.furniture
    : sceneFurniture;
  const positions = computeClonePositions(f, n, occupied, room.width, room.depth);
  const response = await fetch('/api/rack/' + encodeURIComponent(f.code) + '/clone', {
    method:'POST', headers:{'Content-Type':'application/json'},
    body:JSON.stringify({ positions, source: {name:f.label,type:f.type,rows:f.rows,cols:f.cols,open:openFlag,
      geom:{w:f.w,h:f.h,d:f.d,rot:f.rot || 0},merges:f.merges || {},cellNames:f.cellNames || {}} })
  });
  if (!response.ok) throw new Error((await response.json()).error || '复制失败');
  const { created, cloneData } = await response.json();
  return { created, srcSnapshot, cloneData };
}

// loadScene() 重载后，用快照恢复源货架的位置/旋转（防止 DB 旧数据覆盖内存中的最新值）
function restoreSrcAfterReload(src) {
  if (!src || !src.code) return;
  const targets = [sceneFurniture];
  if (layoutState && layoutState.furniture) targets.push(layoutState.furniture);
  for (const list of targets) {
    const item = list.find((x) => x.code === src.code);
    if (item) { item.x = src.x; item.z = src.z; item.rot = src.rot; applyTransform(item); }
  }
}

// 双保险：复制操作中无论发生什么，源货架自身的位置/旋转必须保持复制前的值
function lockSourcePosition(f) {
  if (!f) return;
  const x = f.x, z = f.z, rot = f.rot || 0;
  // 强制把内存数据对象（3D 与布局编辑器两份）恢复到复制前
  if (f.x !== x) f.x = x;
  f.z = z; f.rot = rot;
  applyTransform(f);
  if (layoutState) {
    const lf = layoutState.furniture.find((p) => p.code === f.code);
    if (lf) { lf.x = x; lf.z = z; lf.rot = rot; }
  }
}

// 增量添加复制的副本到当前场景（不触发 loadScene 全量重载，源货架完全不被触碰）
// cloneData: 每个副本的完整数据（与 buildScene 中 spec.furniture 格式一致）
async function addClonesIncrementally(cloneData) {
  requestSceneRender();
  for (const f of cloneData) {
    try {
      // 追加数据对象到 sceneFurniture（与 buildScene 格式一致）
      const item = {
        code: f.code, label: f.label,
        x: f.position[0], z: f.position[2],
        rot: (f.rotationY != null ? f.rotationY : 0),
        w: f.width, h: f.height, d: f.depth,
        type: f.type, open: f.open, rows: f.rows, cols: f.cols,
        merges: f.merges || {},
        cellNames: f.cellNames || {},
      };
      sceneFurniture.push(item);
      // 创建 3D 网格并加入场景（与 buildScene 调用方式完全一致）
      const g = createFurniture({ ...f, merges: f.merges || {}, ...(IS_INTEGRATION?{inventoryVisualLimit:8,lazyCellLabels:true,batchInventory:true,batchCellSurfaces:true}:{}) }, cellRegistry);
      rackGroups.push(g);
      furnByCode[f.code] = g;
      scene.add(g);
      // 同步到布局编辑器状态
      if (layoutState && layoutState.furniture) {
        layoutState.furniture.push({ ...item });
      }
    } catch (_) { /* 单个副本加载失败不阻断其余 */ }
  }
  // 刷新侧栏列表
  initSidebar();
}

document.getElementById('furnSet_clone').onclick = async () => {
  const f = sceneFurniture.find((x) => x.code === document.getElementById('furnSetSel').value);
  if (!f) return;
  const v = await askInputs('复制货架 · ' + (f.label || f.code), [
    { key: 'count', label: '复制几份（1-20，自动排到右侧且不重叠）', type: 'number', default: '1', required: true },
  ]);
  if (!v) return;
  const n = parseInt(v.count, 10);
  const msg = document.getElementById('furnSet_msg');
  msg.style.color = '#fde68a'; msg.textContent = `复制中（0/${n}）…`;
  try {
    const { created, cloneData } = await cloneFurniture(f, n);
    msg.style.color = '#86efac'; msg.textContent = `已复制 ${created.length} 份货架${created.length ? '：' + created.join('、') : ''}`;
    // 增量添加副本到场景（不 loadScene 全量重载，源货架位置/旋转完全不被触碰）
    await addClonesIncrementally(cloneData);
    lockSourcePosition(f); // 双保险：无论内部发生什么，源货架自身位置不变
    fillFurnSet();
    setTimeout(() => furnSetModal.classList.add('hidden'), 900);
  } catch (e) { msg.style.color = '#fca5a5'; msg.textContent = '失败：' + e.message; }
};

// ================= 格位布局：把相邻列合成宽格位 =================
const mergeModal = document.getElementById('mergeModal');
let mergeState = null; // { code, label, rows, cols, link: { 'L01': [bool,...], ... } }
let mergeSources = new Map();
const pad2 = (n) => String(n).padStart(2, '0');
function mergesToLink(merges, cols) {
  const link = new Array(cols).fill(false); // link[c] = 列 c 与 c+1 是否合并（c:1..cols-1）
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
function mergeFurniture() { return editingLayout() ? layoutState.furniture : sceneFurniture; }
async function openMergeModal(preferCode) {
  const sceneFurniture=mergeFurniture();
  if (!sceneFurniture.length) { toast('当前库区还没有货架，请先在「📐 布局」里添加货架。'); return; }
  try {
    const response=await fetch('/api/scene?room='+encodeURIComponent(currentRoomCode));
    if(!response.ok)throw Error('格位容量读取失败，请重试');
    mergeSources=new Map((await response.json()).furniture.map(f=>[f.code,f]));
  } catch(error) { toast(error.message,false); return; }
  const sel = document.getElementById('mergeSel');
  setLocationOptions(sel, sceneFurniture.map(f => ({loc_code:f.code, name:f.label+'（'+f.code+'）'})));
  sel.onchange = fillMerge;
  // 优先级：传入参数 > 当前选中格位所属货架 > 上次选择 > 第一个货架
  const picked = (selected && selected.rackCode) || null;
  const target = preferCode || picked;
  if (target && sceneFurniture.find((x) => x.code === target)) {
    sel.value = target;
  }
  fillMerge();
  document.getElementById('merge_save').textContent=editingLayout()?'应用到布局草稿':'保存格位布局';
  mergeModal.classList.remove('hidden');
}
function fillMerge() {
  const f = mergeFurniture().find((x) => x.code === document.getElementById('mergeSel').value);
  if (!f) return;
  const rows = f.rows || 3, cols = f.cols || 4;
  const link = {};
  for (let r = 1; r <= rows; r++) {
    const row = 'L' + pad2(r);
    link[row] = mergesToLink((f.merges && f.merges[row]) || [], cols);
  }
  const saved=mergeSources.get(f.code) || {rows,cols};
  const source={...(f.mergeCapacities ? {...saved,...mergeCapacityPreview(saved,f),rows,cols,merges:f.merges} : saved),
    width:f.w,height:f.h,depth:f.d,type:f.type,catalog:capacityProducts([...mergeSources.values()].flatMap(r=>Object.values(r.items || {}).flat()))};
  const edits={},targets={};
  for(const group of mergeCapacityPlan(source,rows,cols,f.merges || {})) {
    const value=f.mergeCapacities?.[group.suffix];
    if(value && typeof value==='object'){edits[group.id]=value.capacity;targets[group.id]=value.product;}
  }
  mergeState = { code: f.code, label: f.label, rows, cols, link, source, edits, targets, hints:{},
    initialCapacities:structuredClone(f.mergeCapacities || {}),
    capacityRevision:f.mergeCapacityRevision || source.capacityRevision || 'new',cellNames: {...(f.cellNames || {})} };
  document.getElementById('merge_msg').textContent='';
  document.getElementById('mergeTitle').textContent = ` · ${f.label}（${f.code}） · ${rows}层 × ${cols}列`;
  renderMergeBody();
}
function renderMergeBody() {
  const body = document.getElementById('mergeBody');
  const { rows, cols, link, cellNames } = mergeState;
  const merges=Object.assign({},...Object.keys(link).map(row=>linkToMerges(link[row],cols,row)));
  mergeState.plan=mergeCapacityPlan(mergeState.source,rows,cols,merges,mergeState.targets);
  let html = '';
  // 弹窗里从上到下按「从顶层到底层」排列，与 3D 货架视觉一致（最上面一行 = 最上层 L(rows)，最下面一行 = 最底层 L01）
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
      const plan=mergeState.plan.find(p=>p.suffix===suffix);
      if(merged || plan.changed) {
        const capacity=Object.hasOwn(mergeState.edits,plan.id)?mergeState.edits[plan.id]:plan.capacity;
        html += `<label class="merge-cap-label">容量对应 SKU<select class="merge-cap-product" data-group="${plan.id}" data-suffix="${suffix}" aria-label="${row} ${label}容量SKU"><option value="">选择目标 SKU</option>${plan.choices.map(p=>`<option value="${esc(productKey(p))}" ${productKey(plan.product)===productKey(p)?'selected':''}>${esc(p.sku || p.name)} · ${esc(p.unit)}${p.source?' · '+esc(p.source):''}</option>`).join('')}</select></label>`;
        html += `<label class="merge-cap-label">${merged?'合并后核定容量':'拆分后核定容量'}<input class="merge-capacity" type="number" min="0" step="1" data-group="${plan.id}" data-suffix="${suffix}" aria-label="${row} ${label}容量" value="${capacity ?? ''}" placeholder="留空自动估算" ${plan.product?'':'disabled'} /></label>`;
        html += `<small class="merge-cap-hint">${esc(mergeState.hints[plan.id] || plan.hint)} · ${esc(plan.unit)}</small>`;
      }
      html += `</div>`;
      if (gi < groups.length - 1) html += `<div class="mlink on" data-act="toggle" data-row="${row}" data-b="${b}" title="与右侧合并">✂</div>`;
    });
    html += `</div></div>`;
  }
  body.innerHTML = html;
}
function rememberMergeInputs() {
  document.querySelectorAll('#mergeBody input.cellName').forEach(inp=>{mergeState.cellNames[inp.dataset.suffix]=inp.value.trim();});
  document.querySelectorAll('#mergeBody input.merge-capacity').forEach(inp=>{mergeState.edits[inp.dataset.group]=inp.value;});
}
document.getElementById('mergeBody').addEventListener('change',event=>{
  if(!event.target.matches('.merge-cap-product'))return;
  rememberMergeInputs();const input=event.target,id=input.dataset.group,plan=mergeState.plan.find(p=>p.id===id);
  mergeState.targets[id]=plan.choices.find(p=>productKey(p)===input.value) || null;
  delete mergeState.edits[id];delete mergeState.hints[id];delete mergeState.initialCapacities[input.dataset.suffix];
  renderMergeBody();
});
document.getElementById('mergeBody').addEventListener('click', (e) => {
  const t = e.target.closest('[data-act]'); if (!t || !mergeState) return;
  rememberMergeInputs();
  const row = t.dataset.row, b = +t.dataset.b;
  if (t.dataset.act === 'split') {
    const a = +t.dataset.a;
    for (let c = a; c < b; c++) mergeState.link[row][c] = false; // 把这一组合并拆回单格
    renderMergeBody();
    return;
  }
  // 合并：切换该组右边界（与右侧相邻组合并）
  if (b < 1 || b >= mergeState.cols) return; // 最后一组没有右侧边界，不处理
  const left=mergeState.plan.find(p=>p.row===row && p.b===b),right=mergeState.plan.find(p=>p.row===row && p.a===b+1);
  mergeState.link[row][b] = !mergeState.link[row][b];
  if(left && right) {
    const value=p=>{const raw=Object.hasOwn(mergeState.edits,p.id)?mergeState.edits[p.id]:p.capacity;return raw===null||raw===''?null:Number(raw);};
    const a=value(left),c=value(right),id=`${row}:${left.a}-${right.b}`;
    const merges=Object.assign({},...Object.keys(mergeState.link).map(r=>linkToMerges(mergeState.link[r],mergeState.cols,r)));
    if(left.product && productKey(left.product)===productKey(right.product))mergeState.targets[id]=left.product;
    const next=mergeCapacityPlan(mergeState.source,mergeState.rows,mergeState.cols,merges,mergeState.targets).find(p=>p.id===id);
    const known=a!==null && c!==null && Number.isInteger(a) && a>=0 && Number.isInteger(c) && c>=0 && left.product && productKey(left.product)===productKey(right.product) && productKey(next.product)===productKey(left.product);
    // 包装尺寸完整时优先按新空间估算；只有同 SKU 的核定值才可给出参考合计。
    if(known && next.state.basis!=='estimated') {mergeState.edits[id]=a+c;mergeState.hints[id]=`同 SKU 核定容量参考合计：${a} + ${c} = ${a+c}，保存前请核对`;}
  }
  renderMergeBody();
});
document.getElementById('merge_save').onclick = async () => {
  const invalid=[...document.querySelectorAll('#mergeBody input.merge-capacity')].find(input=>!input.checkValidity());
  if(invalid){invalid.reportValidity();return;}
  const { code, rows, cols, link } = mergeState;
  const merges = {};
  for (let r = 1; r <= rows; r++) {
    const row = 'L' + pad2(r);
    const e = linkToMerges(link[row], cols, row)[row];
    if (e && e.length) merges[row] = e;
  }
  // 收集每格自定义名称（含空串=清空；被合并吞掉的列没有输入框，不会误改）
  const names = {};
  document.querySelectorAll('#mergeBody input.cellName').forEach((inp) => {
    names[inp.dataset.suffix] = inp.value.trim();
  });
  const capacities=Object.fromEntries(Object.entries(mergeState.initialCapacities).filter(([suffix])=>mergeState.plan.some(p=>p.suffix===suffix)));
  document.querySelectorAll('#mergeBody input.merge-capacity').forEach(input=>{
    const plan=mergeState.plan.find(p=>p.id===input.dataset.group);
    if(plan.product)capacities[input.dataset.suffix]={product:plan.product,capacity:input.value===''?null:Number(input.value)};
  });
  const capacityRevision=mergeState.capacityRevision;
  const msg = document.getElementById('merge_msg');
  msg.style.color = '#fde68a'; msg.textContent = '保存中…';
  try {
    if(editingLayout()) {
      const rack=layoutState.furniture.find(f=>f.code===code);
      rack.merges=merges; rack.cellNames=names;
      rack.mergeCapacities=capacities; rack.mergeCapacityRevision=capacityRevision;
      markDirty(); mergeModal.classList.add('hidden'); renderList();
      layoutMsg('格位合并、名称和容量已应用到草稿，请保存布局');
      return;
    }
    const response = await fetch('/api/rack/' + encodeURIComponent(code) + '/cells', {
      method:'PUT', headers:{'Content-Type':'application/json'}, body:JSON.stringify({merges,names,capacities,capacityRevision}),
    });
    if (!response.ok) throw new Error((await response.json()).error || '保存失败');
    await loadScene();
    msg.style.color = '#86efac'; msg.textContent = '已保存格位布局、名称和容量';
    setTimeout(() => mergeModal.classList.add('hidden'), 900);
  } catch (e) { msg.style.color = '#fca5a5'; msg.textContent = '失败：' + e.message; }
};
document.getElementById('merge_sku').onclick = () => {
  if (!mergeState) return;
  // 从 cellRegistry 按 locCode 前缀取真实库存 SKU（sceneFurniture 不带 items 字段，故不能从它取）
  const prefix = mergeState.code + '-';
  const cellItems = {};
  for (const c of cellRegistry) {
    if (c.locCode && c.locCode.startsWith(prefix)) {
      const suffix = c.locCode.slice(prefix.length);
      cellItems[suffix] = c.items || [];
    }
  }
  let filled = 0;
  document.querySelectorAll('#mergeBody input.cellName').forEach((inp) => {
    const arr = cellItems[inp.dataset.suffix] || [];
    const sku = arr[0] && arr[0].sku;
    if (sku) { inp.value = sku; filled++; }
  });
  document.getElementById('merge_msg').style.color = '#7dd3fc';
  document.getElementById('merge_msg').textContent = `已用 SKU 填充 ${filled} 个有库存的格位（点「保存布局」生效）`;
};
document.getElementById('merge_clear').onclick = async () => {
  if (!mergeState) return;
  if (!(await appConfirm('确定要清除该货架上所有格位合并吗？已存放的物品仍会保留在各自的库位上。'))) return;
  rememberMergeInputs();
  for (const row of Object.keys(mergeState.link)) {
    mergeState.link[row].fill(false);
  }
  renderMergeBody();
  document.getElementById('merge_msg').textContent = '';
};
document.getElementById('merge_cancel').onclick = () => mergeModal.classList.add('hidden');
const mergeBtn = document.getElementById('mergeBtn');
if (mergeBtn) mergeBtn.onclick = () => openMergeModal(selected && selected.rackCode);

// ================= 双击标牌改名 =================
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
// 把新名字同步到内存状态 + 3D 标牌（不必整场重建，改名即时可见）。
// 传 raw（用户输入的原始值，可能为空串）；内存一律存原始值，
// 只有 3D 标牌显示时才回退到库位末段——否则「清空名称」的回退值会被
// 「货架设置」读去当真名保存，导致清空永远失效。
function applyLabelToScene(code, raw) {
  const f = sceneFurniture.find((x) => x.code === code);
  if (f) f.label = raw;
  const text = raw || String(code).split('-').pop() || code; // 留空则回退显示库位末段
  const g = furnByCode[code];
  if (g && g.userData && g.userData.label) setRackLabelText(g.userData.label, text);
  requestSceneRender();
  if (layoutState) {
    const lf = layoutState.furniture.find((x) => x.code === code);
    if (lf) lf.label = raw;
  }
}
document.getElementById('label_cancel').onclick = () => labelModal.classList.add('hidden');
document.getElementById('labelInput').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') document.getElementById('label_save').click();
  if (e.key === 'Escape') labelModal.classList.add('hidden');
});
document.getElementById('label_save').onclick = async () => {
  const code = labelTarget;
  if (!code) return;
  const raw = document.getElementById('labelInput').value.trim();
  const msg = document.getElementById('label_msg');
  msg.style.color = '#fde68a'; msg.textContent = '保存中…';
  try {
    const res = await fetch('/api/rack/' + encodeURIComponent(code), {
      method: 'PUT', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: raw }),
    });
    if (!res.ok) throw new Error((await res.json()).error || '保存失败');
    applyLabelToScene(code, raw);
    msg.style.color = '#86efac'; msg.textContent = raw ? '已改名' : '已清空（显示回退为库位末段）';
    setTimeout(() => labelModal.classList.add('hidden'), 500);
  } catch (e) { msg.style.color = '#fca5a5'; msg.textContent = '失败：' + e.message; }
};

// ================= 库区设置（门/窗方向） =================
const roomModal = document.getElementById('roomModal');
// 当前库区的开口列表（优先取 3D 库区组里的最新状态，含拖动后的 offset）
function currentOpenings(type) {
  const ud = (roomGroup && roomGroup.userData) ? roomGroup.userData : {};
  const list = Array.isArray(ud.openings) ? ud.openings : [];
  const from3d = list.filter((o) => o.type === type).map((o) => ({ side: o.side, offset: o.offset }));
  if (from3d.length) return from3d;
  return normOpeningsFE((window.__roomCfg && window.__roomCfg[type]) || null);
}
function updateRoomArea() {
  const area=document.getElementById('room_area');
  if(!area)return;
  const width=Number(document.getElementById('r_w').value), depth=Number(document.getElementById('r_d').value);
  area.textContent=width>0&&depth>0 ? `库区面积：${Number((width*depth).toFixed(2))} 平方米（宽 × 深）` : '填写有效的宽、深后显示面积';
}
['r_w','r_d'].forEach(id=>document.getElementById(id).addEventListener('input',updateRoomArea));
function openRoomModal() {
  const cur = (roomGroup && roomGroup.userData) ? roomGroup.userData : (window.__roomCfg || {});
  const sel = document.getElementById('roomSel');
  document.getElementById('room_name').value = (sel.options[sel.selectedIndex]) ? sel.options[sel.selectedIndex].text : '';
  // 门/窗已拆到「🚪 门窗」弹窗，本弹窗只管名称与尺寸
  document.getElementById('r_w').value = (cur.width != null) ? cur.width : '';
  document.getElementById('r_d').value = (cur.depth != null) ? cur.depth : '';
  document.getElementById('r_h').value = (cur.height != null) ? cur.height : '';
  document.getElementById('room_msg').textContent = '';
  updateRoomArea();
  roomModal.classList.remove('hidden');
}
// 库区设置：只保留顶栏那个「设置」按钮。
// 原先还有一个 ⚙(roomBtn) 绑定到同一个 openRoomModal，两个按钮干同一件事、挨在一起却长得不一样，已删除。
document.getElementById('roomEditBtn').onclick = openRoomModal;
document.getElementById('room_cancel').onclick = () => {
  roomModal.classList.add('hidden');
  document.getElementById('locPickerModal').classList.remove('hidden');
};
document.getElementById('room_save').onclick = async () => {
  // 门/窗已交给「🚪 门窗」弹窗管理；此处必须原样回传，
  // 否则后端 setRoom 收到缺省的 door/window=null 会把已有门/窗清空
  const door = currentOpenings('door');
  const win = currentOpenings('window');
  const name = document.getElementById('room_name').value.trim();
  const W = +document.getElementById('r_w').value, D = +document.getElementById('r_d').value, H = +document.getElementById('r_h').value;
  const body = { door, window: win, id: currentRoomCode };
  if (name) body.name = name;
  if (W > 0) body.width = W; if (D > 0) body.depth = D; if (H > 0) body.height = H;
  const msg = document.getElementById('room_msg');
  msg.style.color = '#fde68a'; msg.textContent = '保存中…';
  try {
    const res = await fetch('/api/room', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    if (!res.ok) throw new Error((await res.json()).error || '失败');
    const r = await res.json();
    window.__roomCfg = r;
    const sel = document.getElementById('roomSel');
    if (name && sel.options[sel.selectedIndex]) sel.options[sel.selectedIndex].text = name;
    await loadScene(); // 重新拉取场景，room 已含 door/window/尺寸
    msg.style.color = '#86efac'; msg.textContent = `已应用（${r.width}×${r.depth}×${r.height}m）${name ? `，名称：${name}` : ''} — 门/窗请在「🚪 门窗」里管理`;
    setTimeout(() => roomModal.classList.add('hidden'), 900);
  } catch (e) { msg.style.color = '#fca5a5'; msg.textContent = '失败：' + e.message; }
};
document.getElementById('room_del').onclick = async () => {
  if (!currentRoomCode) return;
  if (!(await appConfirm(`确定删除当前库区及其下所有货架与格位？\n库区：${currentRoomCode}\n历史流水保留；仍有外部库存或库位映射引用时会拒绝删除。`, { danger: true }))) return;
  const msg = document.getElementById('room_msg');
  msg.style.color = '#fde68a'; msg.textContent = '删除中…';
  try {
    const res = await fetch('/api/rooms/' + encodeURIComponent(currentRoomCode), { method: 'DELETE' });
    if (!res.ok) throw new Error((await res.json()).error || '删除失败');
    msg.style.color = '#86efac'; msg.textContent = '已删除，切换到第一个库区…';
    currentRoomCode = null;
    setTimeout(async () => { roomModal.classList.add('hidden'); await refreshRooms(); await loadFirstRoomOfSite(); }, 700);
  } catch (e) { msg.style.color = '#fca5a5'; msg.textContent = '失败：' + e.message; }
};

// ================= 门窗管理（独立于「库区设置」） =================
// ================= 统一 CAD 画布：布局 + 门/窗（取代独立门窗弹窗） =================
// 单一画布、米制坐标、可见网格+吸附（沿用 snapGrid）、选中显示真实尺寸线、
// 底部坐标读数、点墙即加门/窗；门/窗直接读写 layoutState.room，随「保存布局」或即时存库。

let cadTool = 'select';           // 'select' | 'door' | 'window'
let cadGrid = true;               // 网格显隐
let cadShowDims = localStorage.getItem('spatial_layout_dims') === '1'; // 全部货架尺寸标注显隐：默认关闭，避免首次打开时满屏尺寸线重叠
let cadSel = null;                // {kind:'furn',code} | {kind:'opening',type,index} | null

// ---- 门/窗读取（直接来自 layoutState.room，归一化为统一结构） ----
function roomDoors() { return normOpeningsFE((layoutState && layoutState.room && layoutState.room.door) || []); }
function roomWindows() { return normOpeningsFE((layoutState && layoutState.room && layoutState.room.window) || []); }
function allOpenings() {
  return [
    ...roomDoors().map((o, i) => ({ type: 'door', index: i, ...o })),
    ...roomWindows().map((o, i) => ({ type: 'window', index: i, ...o })),
  ];
}

// 计算某侧墙在 SVG 中的两端点（与 drawRoom 一致）
function wallSegSVG(side, W, D, s) {
  const x0 = LPAD, y0 = LPAD, x1 = LPAD + W * s, y1 = LPAD + D * s;
  switch (side) {
    case 'back': return [[x0, y0], [x1, y0]];
    case 'front': return [[x0, y1], [x1, y1]];
    case 'left': return [[x0, y0], [x0, y1]];
    case 'right': return [[x1, y0], [x1, y1]];
  }
  return null;
}
// 某开口在 SVG 中的中心点
function openingCenterSVG(op, W, D, s) {
  const seg = wallSegSVG(op.side, W, D, s);
  if (!seg) return null;
  const [a, b] = seg;
  const t = Math.min(0.95, Math.max(0.05, op.offset));
  return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];
}

// ---- 网格（房间足迹内，米制 0.25 小格 / 1 米大格） ----
function drawGrid(svg, W, D, s) {
  const minor = 0.25, major = 1;
  const legend=document.getElementById('layoutGridLegend');
  legend.textContent=`小格 ${minor} m ／ 大格 ${major} m${cadGrid?'':' · 网格已隐藏'}`;
  if (!cadGrid) return;
  const x0 = LPAD, y0 = LPAD, x1 = LPAD + W * s, y1 = LPAD + D * s;
  const mk = (ax, ay, bx, by, color) => {
    const l = document.createElementNS(SVGNS, 'line');
    l.setAttribute('x1', ax); l.setAttribute('y1', ay); l.setAttribute('x2', bx); l.setAttribute('y2', by);
    l.setAttribute('stroke', color); l.setAttribute('stroke-width', 1); svg.appendChild(l);
  };
  // 以世界坐标零点对齐，非整米库区也保留准确的整米粗线。
  for (let gx = Math.ceil(-W / 2 / minor) * minor; gx <= W / 2 + 1e-6; gx += minor) {
    const [sx] = w2s(gx, 0, W, D, s);
    if (Math.abs(gx / major - Math.round(gx / major)) < 1e-6) mk(sx, y0, sx, y1, 'rgba(148,163,184,0.18)');
    else mk(sx, y0, sx, y1, 'rgba(148,163,184,0.07)');
  }
  for (let gz = Math.ceil(-D / 2 / minor) * minor; gz <= D / 2 + 1e-6; gz += minor) {
    const [, sy] = w2s(0, gz, W, D, s);
    if (Math.abs(gz / major - Math.round(gz / major)) < 1e-6) mk(x0, sy, x1, sy, 'rgba(148,163,184,0.18)');
    else mk(x0, sy, x1, sy, 'rgba(148,163,184,0.07)');
  }
}

// ---- 房间尺寸标注（顶/左） ----
function drawRoomDims(svg, W, D, s) {
  const x0 = LPAD, y0 = LPAD, x1 = LPAD + W * s, y1 = LPAD + D * s;
  const txt = (x, y, t, anchor) => {
    const e = document.createElementNS(SVGNS, 'text');
    e.setAttribute('x', x); e.setAttribute('y', y); e.setAttribute('text-anchor', anchor || 'middle');
    e.setAttribute('fill', '#64748b'); e.setAttribute('font-size', 11); e.textContent = t; svg.appendChild(e);
  };
  txt((x0 + x1) / 2, y0 - 8, `宽 ${W.toFixed(2)} m`);
  txt(x0 - 8, (y0 + y1) / 2, `深 ${D.toFixed(2)} m`, 'middle');
}

// ---- 选中货架的尺寸线（宽/深，米） ----
function drawFurnDims(svg, f, s) {
  // 每个货架持有独立标注层，拖动时仅重绘此层，保留主体的指针捕获。
  const dims = f._el.dims || document.createElementNS(SVGNS, 'g');
  if (!f._el.dims) {
    dims.setAttribute('pointer-events', 'none');
    svg.appendChild(dims);
    f._el.dims = dims;
  }
  dims.replaceChildren();
  const [cx, cy] = w2s(f.x, f.z, layoutState.room.width, layoutState.room.depth, s);
  const deg = -f.rot * 180 / Math.PI;
  const hw = (f.w * s) / 2, hh = (f.d * s) / 2;
  const rot = (lx, ly) => {
    const r = deg * Math.PI / 180, c = Math.cos(r), sn = Math.sin(r);
    return [cx + lx * c - ly * sn, cy + lx * sn + ly * c];
  };
  const off = 12;
  const dimLine = (p1, p2, label, mx, my) => {
    const l = document.createElementNS(SVGNS, 'line');
    l.setAttribute('x1', p1[0]); l.setAttribute('y1', p1[1]); l.setAttribute('x2', p2[0]); l.setAttribute('y2', p2[1]);
    l.setAttribute('stroke', '#fbbf24'); l.setAttribute('stroke-width', 1.2); dims.appendChild(l);
    const t = document.createElementNS(SVGNS, 'text');
    t.setAttribute('x', mx); t.setAttribute('y', my); t.setAttribute('text-anchor', 'middle');
    t.setAttribute('fill', '#fbbf24'); t.setAttribute('font-size', 10); t.textContent = label; dims.appendChild(t);
  };
  // 宽（上边外移）
  const wl = rot(-hw, -hh - off), wr = rot(hw, -hh - off);
  dimLine(wl, wr, `${f.w.toFixed(2)} m`, (wl[0] + wr[0]) / 2, (wl[1] + wr[1]) / 2 - 2);
  // 深（右边外移）
  const w2a = rot(hw + off, -hh), w2b = rot(hw + off, hh);
  dimLine(w2a, w2b, `${f.d.toFixed(2)} m`, (w2a[0] + w2b[0]) / 2 + 14, (w2a[1] + w2b[1]) / 2);
}

// ---- 门/窗命中测试与高亮 ----
function drawOpeningHits(svg, W, D, s) {
  for (const op of allOpenings()) {
    const c = openingCenterSVG(op, W, D, s);
    if (!c) continue;
    const hit = document.createElementNS(SVGNS, 'circle');
    hit.setAttribute('cx', c[0]); hit.setAttribute('cy', c[1]); hit.setAttribute('r', 11);
    hit.setAttribute('fill', 'transparent'); hit.style.cursor = 'grab';
    // 按下即选中并进入拖动（沿墙移动）；click 仅用于阻止冒泡到画布（否则会当成「点墙加门」）
    hit.addEventListener('pointerdown', (e) => { e.stopPropagation(); e.preventDefault(); startOpeningDrag(op); });
    hit.addEventListener('click', (e) => e.stopPropagation());
    svg.appendChild(hit);
  }
}
function drawOpeningHighlight(svg) {
  if (!cadSel || cadSel.kind !== 'opening') return;
  const op = allOpenings().find((o) => o.type === cadSel.type && o.index === cadSel.index);
  if (!op) return;
  const c = openingCenterSVG(op, layoutState.room.width, layoutState.room.depth, layoutScale());
  if (!c) return;
  const ring = document.createElementNS(SVGNS, 'circle');
  ring.setAttribute('cx', c[0]); ring.setAttribute('cy', c[1]); ring.setAttribute('r', 14);
  ring.setAttribute('stroke', '#f43f5e'); ring.setAttribute('stroke-width', 2); ring.setAttribute('fill', 'none');
  svg.appendChild(ring);
}

// ---- 2D 里拖动门/窗沿墙移动 ----
// ⚠️ renderLayout() 会 svg.innerHTML='' 整体重建，命中圆点随之消失。
// 所以 pointermove/pointerup 必须挂在 document 上；挂圆点上会「一渲染就断」。
let openingDrag = null; // { type, index, moved }
function openingRef(type, index) {
  const key = type === 'door' ? 'door' : 'window';
  return normOpeningsFE(layoutState.room[key])[index] || null;
}
// 写回 offset（顺带把旧的字符串格式归一化成数组），并夹在 0.05~0.95
function setOpeningOffset(type, index, offset) {
  const key = type === 'door' ? 'door' : 'window';
  const arr = normOpeningsFE(layoutState.room[key]);
  if (!arr[index]) return false;
  arr[index].offset = Math.min(0.95, Math.max(0.05, offset));
  layoutState.room[key] = arr;
  return true;
}
// 镜像开门方向：在门轴所在端之间切换（左开 ↔ 右开）。
// 只对门有意义（窗左右对称，双开门本身对称），故调用处只给门显示按钮。
function toggleOpeningFlip(type, index) {
  const key = type === 'door' ? 'door' : 'window';
  const arr = normOpeningsFE(layoutState.room[key]);
  if (!arr[index]) return;
  const on = !arr[index].flip;
  if (on) arr[index].flip = true; else delete arr[index].flip;
  layoutState.room[key] = arr;
  renderLayout();
  renderOpeningListCAD();
  persistRoom();
  layoutMsg(on ? '已镜像：门轴换到另一端（左开↔右开）' : '已复原开门方向');
}
// 把指针位置投影到「它原本所在的那面墙」上，得到 0~1 的沿墙位置。
// 刻意不用 wallHitTest：拖动时指针可能离开墙面，不该跳墙。
function projectOnWall(pt, side, W, D, s) {
  const seg = wallSegSVG(side, W, D, s);
  if (!seg) return 0.5;
  const [a, b] = seg;
  const dx = b[0] - a[0], dy = b[1] - a[1];
  const len2 = dx * dx + dy * dy || 1;
  const t = ((pt.x - a[0]) * dx + (pt.y - a[1]) * dy) / len2;
  return Math.min(0.95, Math.max(0.05, t));
}
// 门窗微调立即标记草稿，统一由保存布局写入。
let openingPersistTimer = null;
function schedulePersistRoom() {
  clearTimeout(openingPersistTimer);
  persistRoom();
}
function startOpeningDrag(op) {
  cadSel = { kind: 'opening', type: op.type, index: op.index };
  renderOpeningListCAD();
  openingDrag = { type: op.type, index: op.index, moved: false };
  document.body.style.cursor = 'grabbing';
  document.addEventListener('pointermove', onOpeningDragMove, true);
  document.addEventListener('pointerup', onOpeningDragEnd, true);
  document.addEventListener('pointercancel', onOpeningDragEnd, true);
}
function onOpeningDragMove(e) {
  if (!openingDrag || !layoutState) return;
  const o = openingRef(openingDrag.type, openingDrag.index);
  if (!o) return;
  e.preventDefault();
  const svg = document.getElementById('layoutSvg');
  const pt = svgPoint(svg, e);
  const s = layoutScale();
  const W = layoutState.room.width, D = layoutState.room.depth;
  let t = projectOnWall(pt, o.side, W, D, s);
  const gval = +document.getElementById('snapGrid').value || 0;
  if (gval > 0) { // 按米吸附，与货架拖动同一套吸附值
    const wallLen = (o.side === 'back' || o.side === 'front') ? W : D;
    t = snapValue(t * wallLen, gval) / wallLen;
  }
  if (!setOpeningOffset(openingDrag.type, openingDrag.index, t)) return;
  openingDrag.moved = true;
  renderLayout();
}
function onOpeningDragEnd() {
  document.removeEventListener('pointermove', onOpeningDragMove, true);
  document.removeEventListener('pointerup', onOpeningDragEnd, true);
  document.removeEventListener('pointercancel', onOpeningDragEnd, true);
  document.body.style.cursor = '';
  const moved = !!(openingDrag && openingDrag.moved);
  openingDrag = null;
  // 门窗移动只修改草稿，由保存布局统一提交。
  if (moved) { renderOpeningListCAD(); persistRoom(); layoutMsg('已移动门/窗'); }
}

// ---- 墙命中：点 (px,py) 最近墙段 -> {side, offset} ----
function wallHitTest(px, py, W, D, s) {
  const sides = ['back', 'front', 'left', 'right'];
  let best = null, bestD = 1e9;
  for (const side of sides) {
    const seg = wallSegSVG(side, W, D, s);
    const [a, b] = seg;
    const dx = b[0] - a[0], dy = b[1] - a[1];
    const len2 = dx * dx + dy * dy;
    let t = len2 ? ((px - a[0]) * dx + (py - a[1]) * dy) / len2 : 0;
    t = Math.max(0, Math.min(1, t));
    const cx = a[0] + dx * t, cy = a[1] + dy * t;
    const d = Math.hypot(px - cx, py - cy);
    if (d < bestD) { bestD = d; best = { side, offset: t }; }
  }
  if (best && bestD <= 16) return best;
  return null;
}

// ---- 即时存门/窗到后端（与布局保存互不冲突） ----
function persistRoom() {
  markDirty();
  layoutMsg('门窗修改尚未保存，请点击保存布局');
}

function addOpeningAtWall(side, type, offset) {
  const arr = type === 'door' ? (layoutState.room.door = layoutState.room.door || []) : (layoutState.room.window = layoutState.room.window || []);
  const o = { side, offset: Math.min(0.95, Math.max(0.05, offset)) };
  arr.push(o);
  cadSel = { kind: 'opening', type, index: (type === 'door' ? roomDoors() : roomWindows()).length - 1 };
  // 新增门/窗时自动展开列表，便于看到反馈（此时面板可能还没渲染，先置位再让 render 接管）
  setPanelCollapsed(document.getElementById('secOpen'), false);
  renderOpeningListCAD(); renderLayout(); persistRoom();
  layoutMsg(`已添加${type === 'door' ? '门' : '窗'}`);
}
function deleteOpening(type, index) {
  const key = type === 'door' ? 'door' : 'window';
  const arr = layoutState.room[key] || [];
  arr.splice(index, 1);
  if (cadSel && cadSel.kind === 'opening' && cadSel.type === type) cadSel = null;
  renderOpeningListCAD(); renderLayout(); persistRoom();
  layoutMsg(`已删除${type === 'door' ? '门' : '窗'}`);
}

function renderOpeningListCAD() {
  const box = document.getElementById('cadOpeningList');
  if (!box) return;
  const list = allOpenings();
  // 更新门窗分区头计数（0 时自动隐藏徽标）+ 接好收放（可点/可键盘，只需接一次）
  setSecCount('secOpenCnt', list.length);
  wireCollapseHead(document.getElementById('secOpen'), document.getElementById('secOpenHead'));
  if (!list.length) { box.innerHTML = '<div class="op-empty">暂无门窗。点击「＋ 添加」，选择门或窗，再点击房间墙面放置。</div>'; return; }
  const sideCN = { back: '后墙', front: '前墙', left: '左墙', right: '右墙' };
  box.innerHTML = list.map((o, i) => {
    const sel = cadSel && cadSel.kind === 'opening' && cadSel.type === o.type && cadSel.index === o.index;
    const color = o.type === 'door' ? '#d97706' : '#38bdf8';
    const label = o.type === 'door' ? (o.double ? '双开门' : '门') : '窗';
    const pct = Math.round((o.offset || 0) * 100);
    // 镜像按钮：只给单开门。窗左右对称、双开门本身也对称，给了也没变化，反而误导。
    const flipBtn = (o.type === 'door' && !o.double)
      ? `<button class="op-flip${o.flip ? ' on' : ''}" data-i="${i}" title="镜像开门方向：门轴换到墙的另一端（左开↔右开）" aria-label="镜像开门方向">⇋</button>`
      : '';
    return `<div data-i="${i}" class="op-row ${sel ? 'op-sel' : ''}" title="点击选中，可在画布上拖动调整位置">
      <span class="op-dot" style="background:${color}"></span>
      <span class="op-name">${label}</span>
      <span class="op-side">${sideCN[o.side] || o.side}</span>
      <span class="op-pos" title="沿墙位置 ${pct}%"><i style="left:${pct}%"></i></span>
      <span class="op-pct">${pct}%</span>
      ${flipBtn}
      <button class="op-del" data-i="${i}" title="删除" aria-label="删除">✕</button>
    </div>`;
  }).join('');
  box.querySelectorAll('.op-row').forEach((el) => {
    el.onclick = (e) => {
      if (e.target.closest('button')) return;   // 点行内按钮（镜像/删除）不触发选中
      const i = +el.dataset.i; const o = list[i];
      cadSel = { kind: 'opening', type: o.type, index: o.index };
      renderOpeningListCAD(); renderLayout();
    };
  });
  box.querySelectorAll('.op-flip').forEach((b) => {
    b.onclick = (e) => { e.stopPropagation(); const i = +b.dataset.i; const o = list[i]; toggleOpeningFlip(o.type, o.index); };
  });
  box.querySelectorAll('.op-del').forEach((b) => {
    b.onclick = (e) => { e.stopPropagation(); const i = +b.dataset.i; const o = list[i]; deleteOpening(o.type, o.index); };
  });
  updateSelHint();
}

// ---- 工具栏 + 状态栏 ----
function setCadTool(t) {
  cadTool = t;
  document.getElementById('cadToolSelect')?.classList.toggle('active', t === 'select');
  document.getElementById('cadToolDoor')?.classList.toggle('active', t === 'door');
  document.getElementById('cadToolWindow')?.classList.toggle('active', t === 'window');
  const hint = document.getElementById('cadStatus');
  if (hint) hint.textContent = t === 'select' ? '选择 / 拖动货架' : (t === 'door' ? '点击房间某面墙放置门' : '点击房间某面墙放置窗');
  const svg = document.getElementById('layoutSvg');
  if (svg) svg.style.cursor = (t === 'select') ? 'default' : 'crosshair';
  // 画布浮动引导：激活门/窗工具时提示用户去点墙
  const ch = document.getElementById('layoutCanvasHint');
  if (ch) {
    if (t === 'door' || t === 'window') {
      ch.textContent = (t === 'door' ? '🚪 点击房间任意一面墙放置门' : '🪟 点击房间任意一面墙放置窗');
      ch.classList.remove('hidden');
    } else {
      ch.classList.add('hidden');
    }
  }
}
function toggleCadGrid() {
  cadGrid = !cadGrid;
  document.getElementById('cadGridToggle')?.classList.toggle('active', cadGrid);
  if (layoutState) renderLayout();
}
function toggleCadDims() {
  cadShowDims = !cadShowDims;
  localStorage.setItem('spatial_layout_dims', cadShowDims ? '1' : '0');
  updateCadDimBtn();
  if (layoutState) renderLayout();
}
function updateCadDimBtn() {
  document.getElementById('cadDimToggle')?.classList.toggle('active', cadShowDims);
}

// ---- 画布点击：门/窗工具下点墙添加 / 选中已有 ----
function cadCanvasClick(e) {
  if (!layoutState) return;
  if (cadTool !== 'select' && e.target.closest && e.target.closest('.furn')) return; // 点货架不触发加门
  if (cadTool === 'select') {
    if (e.target.tagName === 'svg' || e.target.classList.contains('room')) {
      if (cadSel && cadSel.kind === 'opening') { cadSel = null; renderOpeningListCAD(); }
    }
    return;
  }
  const svg = document.getElementById('layoutSvg');
  const p = svgPoint(svg, e);
  const W = layoutState.room.width, D = layoutState.room.depth, s = layoutScale();
  for (const op of allOpenings()) {
    const c = openingCenterSVG(op, W, D, s);
    if (c && Math.hypot(p.x - c[0], p.y - c[1]) <= 12) { cadSel = { kind: 'opening', type: op.type, index: op.index }; renderOpeningListCAD(); renderLayout(); return; }
  }
  const hit = wallHitTest(p.x, p.y, W, D, s);
  if (hit) addOpeningAtWall(hit.side, cadTool, hit.offset);
}

// ---- 坐标读数 ----
function cadCursorMove(e) {
  if (!layoutState) return;
  const svg = document.getElementById('layoutSvg');
  const p = svgPoint(svg, e);
  const [wx, wz] = s2w(p.x, p.y, layoutState.room.width, layoutState.room.depth, layoutScale());
  const st = document.getElementById('cadStatusCoord');
  if (st) st.textContent = `X ${wx.toFixed(2)}   Z ${wz.toFixed(2)} m`;
}

// ---- DXF 导出（R12 ASCII），与 dxfToTemplate 互逆 ----
function r4(n) { return Math.round((+n || 0) * 10000) / 10000; }
function wallSegWorld(side, W, D) {
  const hw = W / 2, hd = D / 2;
  switch (side) {
    case 'back': return [[-hw, -hd], [hw, -hd]];
    case 'front': return [[-hw, hd], [hw, hd]];
    case 'left': return [[-hw, -hd], [-hw, hd]];
    case 'right': return [[hw, -hd], [hw, hd]];
  }
  return [[0, 0], [0, 0]];
}
function templateToDXF(tpl) {
  const room = (tpl && tpl.room) || {};
  const W = room.width || 0, D = room.depth || 0;
  const furn = (tpl && tpl.furniture) || [];
  const L = [];
  const w = (n, v) => { L.push(String(n)); L.push(String(v)); };
  L.push('0', 'SECTION', '2', 'HEADER', '9', '$INSUNITS', '70', '6', '0', 'ENDSEC');
  L.push('0', 'SECTION', '2', 'ENTITIES');
  const poly = (layer, pts, closed) => {
    L.push('0', 'LWPOLYLINE', '8', layer, '70', closed ? '1' : '0');
    for (const [x, y] of pts) { w(10, r4(x)); w(20, r4(y)); }
  };
  const rectPts = (x, z, w, d, rot) => footprint({x,z,w,d,rot});
  poly('ROOM', rectPts(0, 0, W, D, 0), true);
  for (const f of furn) {
    const code = String(f.code || 'FURN').replace(/[^\w-]/g, '_').slice(0, 24);
    poly(code, rectPts(f.x || 0, f.z || 0, f.w || 0, f.d || 0, f.rot || 0), true);
  }
  const mark = (type, op) => {
    const seg = wallSegWorld(op.side, W, D);
    const [a, b] = seg;
    const t = Math.min(0.95, Math.max(0.05, op.offset));
    const cx = a[0] + (b[0] - a[0]) * t, cy = a[1] + (b[1] - a[1]) * t;
    const dx = b[0] - a[0], dy = b[1] - a[1], len = Math.hypot(dx, dy) || 1;
    const nx = -dy / len, ny = dx / len, half = 0.25;
    poly(type === 'door' ? 'DOOR' : 'WINDOW', [[cx - nx * half, cy - ny * half], [cx + nx * half, cy + ny * half]], false);
  };
  for (const op of normOpeningsFE(room.door || [])) mark('door', op);
  for (const op of normOpeningsFE(room.window || [])) mark('window', op);
  L.push('0', 'ENDSEC', '0', 'EOF');
  return L.join('\r\n');
}

// ---- 接线（元素在 DOM 中已存在） ----
document.getElementById('cadToolSelect').onclick = () => setCadTool('select');
document.getElementById('cadToolDoor').onclick = () => setCadTool('door');
document.getElementById('cadToolWindow').onclick = () => setCadTool('window');
document.getElementById('cadGridToggle').onclick = toggleCadGrid;
// 图例跟随可见画布，缩放/滚动不改变文字大小和物理单位。
document.querySelector('.layout-canvas').addEventListener('scroll',event=>{
  const canvas=event.currentTarget;
  document.getElementById('layoutGridLegend').style.transform=`translate(${canvas.scrollLeft}px,${canvas.scrollTop}px)`;
},{passive:true});
document.getElementById('cadDimToggle').onclick = toggleCadDims;
const cadSvgEl = document.getElementById('layoutSvg');
if (cadSvgEl) {
  cadSvgEl.addEventListener('pointermove', cadCursorMove);
  cadSvgEl.addEventListener('click', cadCanvasClick);
}
setCadTool('select');


// ================= 布局编辑（2D 俯视 + 与 3D 同步） =================
const layoutModal = document.getElementById('layoutModal');
const SVGNS = 'http://www.w3.org/2000/svg';
const LPAD = 34;
const KOFF = 13;            // 旋转手柄相对货架右上角的偏移（SVG 像素，确保明显在矩形外侧）
const LAYOUT_FIT_W = 1200; // 适应窗口时的回退画布宽（像素；能量到画布时以实际尺寸为准）
const LAYOUT_FIT_H = 820;  // 适应窗口时的回退画布高（像素）
let layoutState = null; // { room:{width,depth,height,door,window}, furniture:[{code,label,x,z,rot,w,h,d}] }
let layoutSel = null;
const layoutMultiSelect=new Set();
let layoutZoom = 1;        // 布局视图缩放（1 = 适应窗口）
let layoutPendingRefresh = false; // 新建表单属于布局草稿时，不独立提交

function layoutMsg(t) { document.getElementById('layout_msg').textContent = t || ''; }
// 未保存改动标记：移动/旋转/改规格等仅存在于前端 layoutState，需点「保存布局」才写回
let layoutDirty = false;
let layoutSaving = false;
let layoutClosePending = false;
const layoutHistory=createDraftHistory();
const layoutSnapshot=()=>({state:layoutState,replace:layoutReplacePending});
function updateHistoryButtons() {
  document.getElementById('layoutUndo').disabled=!layoutHistory.canUndo;
  document.getElementById('layoutRedo').disabled=!layoutHistory.canRedo;
}
function syncLayoutPreview() {
  if (layoutStructureKey(layoutState.furniture) !== layoutStructureKey(sceneFurniture)) {
    // 草稿使用参数化外观，避免已上传的静态模型遮住新规格。
    buildScene(layoutPreviewSpec(savedSceneSpec, layoutState), false);
    if (roomGroup) roomGroup.visible = true;
    initSidebar();
  } else layoutState.furniture.forEach(applyTransform);
}
function markDirty() {
  layoutDirty=true;
  if(layoutState && !layoutModal.classList.contains('hidden')) {
    syncLayoutPreview();
    layoutHistory.push(layoutSnapshot());layoutDirty=layoutHistory.dirty;updateHistoryButtons();
  }
  updateDirtyUI();
}
function clearDirty() {
  layoutDirty=false;
  if(layoutState){layoutHistory.reset(layoutSnapshot());updateHistoryButtons();}
  updateDirtyUI();
}
function restoreLayoutHistory(direction) {
  if(layoutSaving || layoutModal.classList.contains('hidden'))return;
  const value=layoutHistory[direction]();if(!value)return;
  layoutState=value.state;layoutReplacePending=value.replace;
  if(!layoutState.furniture.some(f=>f.code===layoutSel))layoutSel=layoutState.furniture[0]?.code || null;
  rebuildRoom(layoutState.room);syncLayoutPreview();
  renderLayout();renderList();renderOpeningListCAD();
  layoutDirty=layoutHistory.dirty;updateDirtyUI();updateHistoryButtons();
  layoutMsg(direction==='undo'?'已撤销，尚未写入':'已重做，尚未写入');
}
document.getElementById('layoutUndo').onclick=()=>restoreLayoutHistory('undo');
document.getElementById('layoutRedo').onclick=()=>restoreLayoutHistory('redo');
document.addEventListener('keydown',e=>{
  if(layoutModal.classList.contains('hidden') || !(e.ctrlKey||e.metaKey) || e.altKey)return;
  if(e.target.closest('input,textarea,select,[contenteditable="true"]'))return;
  const key=e.key.toLowerCase();if(key!=='z' && key!=='y')return;
  e.preventDefault();restoreLayoutHistory(key==='y'||e.shiftKey?'redo':'undo');
});
function updateDirtyUI() {
  const b = document.getElementById('layout_save');
  const d = document.getElementById('layout_dirty');
  if (b) b.classList.toggle('dirty', layoutDirty);
  if (d) d.classList.toggle('hidden', !layoutDirty);
}
function updateLayoutEmpty() {
  const el = document.getElementById('layoutEmpty');
  if (!el) return;
  const empty = !layoutState || !layoutState.furniture || !layoutState.furniture.length;
  el.classList.toggle('hidden', !empty);
}
function updateSelHint() {
  document.getElementById('layoutFocus').disabled=!layoutState?.furniture.some(f=>f.code===layoutSel);
  const el = document.getElementById('layoutSelHint');
  if (!el) return;
  const isOpening = !!(cadSel && cadSel.kind === 'opening');
  const show = !!layoutSel || isOpening;
  el.classList.toggle('hidden', !show);
  if (!show) return;
  el.textContent = isOpening
    ? '拖动门/窗沿墙移动 · 方向键微调 · 右侧列表可删除'
    : '拖动货架主体移动 · 拖右上角蓝点旋转 · 方向键微调';
}
// ===== 统一的「收放」控制器 =====
// 作用：给带 .collapsed 的面板（分区面板 / 货架编辑面板）做可动画、可键盘操作的折叠切换。
// 之前是直接 display:none 硬切 + 各处各自 classList.toggle，导致：
//   1) 展开/收起瞬间跳变，没有过渡；2) 「展开/收起」文案容易和状态脱节；
//   3) 货架分区头有 cursor:pointer / hover 高亮却没有点击处理（点了没反应）。
// 这里统一收口：动画用 max-height 实测值过渡，结束后清掉内联高度让内容可自由伸缩。
function setPanelCollapsed(panel, collapsed, animate = true) {
  if (!panel) return;
  const body = panel.querySelector(':scope > .sec-body, :scope > .fp-body');
  const hint = panel.querySelector('.sec-hint, .fp-toggle-hint');
  const head = panel.querySelector('.sec-head, .fp-head');
  const isCollapsed = () => panel.classList.contains('collapsed');
  const syncHint = () => {
    if (hint) hint.textContent = isCollapsed() ? '展开' : '收起';
    if (head) head.setAttribute('aria-expanded', isCollapsed() ? 'false' : 'true');
  };
  if (!animate || !body) { panel.classList.toggle('collapsed', !!collapsed); syncHint(); return; }
  // 已经在目标状态就不重复触发，避免重复动画
  if (isCollapsed() === !!collapsed) { syncHint(); return; }
  if (collapsed) {
    body.style.maxHeight = body.scrollHeight + 'px';
    void body.offsetHeight;                 // 强制回流，让起点高度生效
    panel.classList.add('collapsed');
    body.style.maxHeight = '0px';
  } else {
    panel.classList.remove('collapsed');
    body.style.maxHeight = '0px';
    void body.offsetHeight;
    body.style.maxHeight = body.scrollHeight + 'px';
    // 过渡结束后清掉内联高度，后续列表变长时不会被旧高度截断
    setTimeout(() => { if (!isCollapsed()) body.style.maxHeight = ''; }, 340);
  }
  syncHint();
}
// 把一个 .sec-head / .fp-head 接成可点、可键盘（Enter/空格）切换的收放头
function wireCollapseHead(panel, head) {
  if (!panel || !head || head.dataset.wired) return;
  head.dataset.wired = '1';
  const toggle = () => setPanelCollapsed(panel, !panel.classList.contains('collapsed'));
  head.addEventListener('click', (e) => {
    // 头里内嵌的按钮（如「＋ 添加」）不触发收放
    if (e.target.closest('button, a, input, select')) return;
    toggle();
  });
  head.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ' ' || e.key === 'Spacebar') { e.preventDefault(); toggle(); }
  });
}
// 布局编辑器右侧栏两个分区（门窗 / 货架）的收放接线，打开编辑器时调用一次即可
function wireLayoutSections() {
  wireCollapseHead(document.getElementById('secOpen'), document.getElementById('secOpenHead'));
  wireCollapseHead(document.getElementById('secRack'), document.getElementById('secRackHead'));
}
// 分区面板计数徽标：0 时隐藏，避免「0」这种无信息量的噪音
function setSecCount(id, n) {
  const el = document.getElementById(id);
  if (!el) return;
  el.textContent = String(n);
  el.classList.toggle('hidden', !n);
}
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
function setLayoutZoom(z, anchor) {
  const box=document.querySelector('.layout-canvas'),svg=document.getElementById('layoutSvg');
  const rect=box.getBoundingClientRect();
  const focus=anchor || {clientX:rect.left+box.clientWidth/2,clientY:rect.top+box.clientHeight/2};
  const point=svgPoint(svg,focus),oldScale=layoutScale();
  layoutZoom=Math.max(0.3,Math.min(6,z));renderLayout();updateLayoutZoomLbl();
  // 固定鼠标处（按钮缩放时为视口中心）的世界位置，滚动边界以浏览器钳制为准。
  const ratio=layoutScale()/oldScale,p=svg.createSVGPoint();
  p.x=(point.x-LPAD)*ratio+LPAD;p.y=(point.y-LPAD)*ratio+LPAD;
  const screen=p.matrixTransform(svg.getScreenCTM());
  box.scrollLeft+=screen.x-focus.clientX;box.scrollTop+=screen.y-focus.clientY;
}
function updateLayoutZoomLbl() { const el = document.getElementById('layoutZoomLbl'); if (el) el.textContent = `缩放 ${Math.round(layoutZoom * 100)}%`; }
function w2s(x, z, W, D, s) { return [(x + W / 2) * s + LPAD, (z + D / 2) * s + LPAD]; }
function s2w(sx, sy, W, D, s) { return [(sx - LPAD) / s - W / 2, (sy - LPAD) / s - D / 2]; }
function svgPoint(svg, e) { const p = svg.createSVGPoint(); p.x = e.clientX; p.y = e.clientY; const m = svg.getScreenCTM().inverse(); const r = p.matrixTransform(m); return { x: r.x, y: r.y }; }

// 门/窗数据规范化（前端兜底，兼容字符串旧格式）：→ [{ side, offset }]
function normOpeningsFE(v) {
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
      const L = sideLen(side); // 该墙的像素长度
      const Lm = L / s;         // 该墙的真实长度（米），与 3D 生成器一致
      const isDouble = (op.type === 'door' && op.double);
      // 按真实米制计算开口宽度，与 spaceGenerator 保持一致
      const openM = op.type === 'door'
        ? (isDouble ? Math.min(Lm * 0.8, 2.2) : Math.min(Lm * 0.45, 1.1))
        : Math.min(Lm * 0.4, 1.8);
      // ⚠️ 这里原来还有一层像素钳制（门窗各一对 minPx/maxPx），必须去掉。
      // 平面图是按比例的：一旦 openM*s 超过 maxPx，2D 画出来的开口就不是真实尺寸了。
      // 实测 12m 墙上的 1.8m 窗：放大到比例 49px/m 时被压到 1.52m，70px/m 时只剩 1.07m，
      // 而 3D（spaceGenerator.addFloorOpening）始终按真实 1.8m 画 → 两边长度对不上。
      const openPx = openM * s;
      const half = (openPx / L) / 2;
      const g0 = Math.max(prev, Math.min(1, op.offset - half));
      const g1 = Math.max(g0, Math.min(1, op.offset + half));
      if (g0 > prev) { // 开口左侧的实墙段
        const p1 = lerpPt(S.a, S.b, prev), p2 = lerpPt(S.a, S.b, g0);
        mkLine(p1[0], p1[1], p2[0], p2[1], 'wall');
      }
      const c = lerpPt(S.a, S.b, (g0 + g1) / 2);
      const spanPx = (g1 - g0) * L;
      if (op.type === 'door') drawDoorSymbol(svg, c[0], c[1], S.dir, S.n, spanPx, isDouble, op.flip);
      else drawWindowSymbol(svg, c[0], c[1], S.dir, S.n, spanPx);
      prev = Math.max(prev, g1);
    }
    if (prev < 1) { // 最后一个开口右侧的实墙段
      const p1 = lerpPt(S.a, S.b, prev);
      mkLine(p1[0], p1[1], S.b[0], S.b[1], 'wall');
    }
  }
}

function drawDoorSymbol(svg, cx, cy, dir, n, openPx, double, flip) {
  const color = '#d97706';
  // 镜像开门方向：把「沿墙方向」取反 → 门轴换到墙的另一端（左开/右开互换）。
  // cross 用取反后的方向重算，弧线 sweep 会自动跟着反向，仍然朝室内（n 一侧）开。
  const dd = flip ? [-dir[0], -dir[1]] : dir;
  const cross = dd[0] * n[1] - dd[1] * n[0];
  const sweep = cross > 0 ? 0 : 1; // 弧线扫向方向（保证向室内 n 一侧）
  const mkLine = (a, b, w) => {
    const l = document.createElementNS(SVGNS, 'line');
    l.setAttribute('x1', a[0]); l.setAttribute('y1', a[1]); l.setAttribute('x2', b[0]); l.setAttribute('y2', b[1]);
    l.setAttribute('stroke', color); l.setAttribute('stroke-width', w || 3); svg.appendChild(l);
  };
  const mkArc = (start, end, r, sweep, sw) => {
    const p = document.createElementNS(SVGNS, 'path');
    p.setAttribute('d', `M ${start[0].toFixed(1)} ${start[1].toFixed(1)} A ${r} ${r} 0 0 ${sweep} ${end[0].toFixed(1)} ${end[1].toFixed(1)}`);
    p.setAttribute('fill', 'none'); p.setAttribute('stroke', color); p.setAttribute('stroke-width', sw || 2); svg.appendChild(p);
  };
  const mkDot = (a) => {
    const c = document.createElementNS(SVGNS, 'circle');
    c.setAttribute('cx', a[0]); c.setAttribute('cy', a[1]); c.setAttribute('r', 2.5);
    c.setAttribute('fill', color); svg.appendChild(c);
  };
  if (double) {
    // 双开门：左右两扇对开，门扇线垂直于墙、向室内（n）伸出，弧线从末端扫回中线
    const halfW = openPx / 2;
    const leftHinge = [cx - dd[0] * openPx / 2, cy - dd[1] * openPx / 2];
    const rightHinge = [cx + dd[0] * openPx / 2, cy + dd[1] * openPx / 2];
    const leftTip = [leftHinge[0] + n[0] * halfW, leftHinge[1] + n[1] * halfW];
    const rightTip = [rightHinge[0] + n[0] * halfW, rightHinge[1] + n[1] * halfW];
    const center = [cx, cy];
    const sweepL = cross > 0 ? 0 : 1;
    const sweepR = cross > 0 ? 1 : 0;
    // 左扇：门扇线 leftHinge→leftTip（垂直于墙），弧线 leftTip→center（圆心 leftHinge）
    mkLine(leftHinge, leftTip); mkArc(leftTip, center, halfW, sweepL); mkDot(leftHinge);
    // 右扇：门扇线 rightHinge→rightTip（垂直于墙），弧线 rightTip→center（圆心 rightHinge）
    mkLine(rightHinge, rightTip); mkArc(rightTip, center, halfW, sweepR); mkDot(rightHinge);
    const t = document.createElementNS(SVGNS, 'text');
    t.setAttribute('x', cx + n[0] * (openPx * 0.55)); t.setAttribute('y', cy + n[1] * (openPx * 0.55) + 4);
    t.setAttribute('text-anchor', 'middle'); t.setAttribute('font-size', 10); t.setAttribute('font-weight', 'bold'); t.setAttribute('fill', color);
    t.textContent = '双开门'; svg.appendChild(t);
    return;
  }
  // 单门：门扇线垂直于墙、向室内（n）伸出，弧线从末端扫回门洞另一端
  const hinge = [cx - dd[0] * openPx / 2, cy - dd[1] * openPx / 2];
  const tip = [hinge[0] + n[0] * openPx, hinge[1] + n[1] * openPx];        // 完全开启末端（室内，垂直于墙）
  const openEnd = [cx + dd[0] * openPx / 2, cy + dd[1] * openPx / 2];      // 门洞另一端（沿墙）
  mkLine(hinge, tip);             // 门扇闭合线：垂直于墙，向室内伸出
  mkArc(tip, openEnd, openPx, sweep); // 开启弧线：从室内末端扫回门洞另一端
  mkDot(hinge);                   // 铰链点
  const t = document.createElementNS(SVGNS, 'text');
  t.setAttribute('x', cx + n[0] * (openPx * 0.55)); t.setAttribute('y', cy + n[1] * (openPx * 0.55) + 4);
  t.setAttribute('text-anchor', 'middle'); t.setAttribute('font-size', 11); t.setAttribute('font-weight', 'bold'); t.setAttribute('fill', color);
  t.textContent = '门'; svg.appendChild(t);
}

function drawWindowSymbol(svg, cx, cy, dir, n, openPx) {
  const color = '#38bdf8';
  // 窗框内缩深度随真实宽度比例缩放（≈0.25 倍开口宽度），保证不同米制尺寸下都可见
  const t = Math.max(4, Math.min(14, openPx * 0.25));
  const s0 = [cx - dir[0] * openPx / 2, cy - dir[1] * openPx / 2];
  const s1 = [cx + dir[0] * openPx / 2, cy + dir[1] * openPx / 2];
  const inner0 = [s0[0] + n[0] * t, s0[1] + n[1] * t];
  const inner1 = [s1[0] + n[0] * t, s1[1] + n[1] * t];
  const poly = document.createElementNS(SVGNS, 'polygon');
  poly.setAttribute('points', `${s0[0]},${s0[1]} ${s1[0]},${s1[1]} ${inner1[0]},${inner1[1]} ${inner0[0]},${inner0[1]}`);
  poly.setAttribute('fill', 'rgba(56,189,248,.22)'); poly.setAttribute('stroke', color); poly.setAttribute('stroke-width', 2); svg.appendChild(poly);
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

// 把布局里的坐标/旋转同步到 3D 货架组（围绕自身底座旋转），并刷新格位中心便于镜头飞行
function applyTransform(f) {
  requestSceneRender();
  const g = furnByCode[f.code];
  if (g) {
    g.position.x = f.x; g.position.z = f.z; g.rotation.y = f.rot;
    g.updateMatrixWorld(true);
    for (const c of cellRegistry) if (c.rackCode === f.code) c.center.copy(g.localToWorld(c.localCenter.clone()));
  }
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
      if (f._el.label) f._el.label.classList.toggle('hide', !on);
    }
  }
  renderList();
  updateSelHint();
  window.dispatchEvent(new Event('layout-object-selected'));
}
function snapValue(v, grid) { return grid > 0 ? Math.round(v / grid) * grid : v; }
function clampInRoom(f) {
  const W = layoutState.room.width, D = layoutState.room.depth;
  const {x:hw,z:hd} = halfExtents(f);
  f.x = Math.max(-W / 2 + hw, Math.min(W / 2 - hw, f.x));
  f.z = Math.max(-D / 2 + hd, Math.min(D / 2 - hd, f.z));
}
function updateFurnEl(f) {
  if (!f._el) return;
  const W = layoutState.room.width, D = layoutState.room.depth, s = layoutScale();
  const [cx, cy] = w2s(f.x, f.z, W, D, s);
  const deg = -f.rot * 180 / Math.PI;
  f._el.g.setAttribute('transform', `translate(${cx.toFixed(2)},${cy.toFixed(2)}) rotate(${deg.toFixed(2)})`);
  if (cadShowDims) drawFurnDims(document.getElementById('layoutSvg'), f, s);
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
  const canvas=document.querySelector('.layout-canvas');
  svg.style.marginTop=Math.max(0,(canvas.clientHeight-vh)/2)+'px';
  svg.innerHTML = '';
  drawGrid(svg, W, D, s);
  const [rx, ry] = w2s(-W / 2, -D / 2, W, D, s);
  const room = document.createElementNS(SVGNS, 'rect');
  room.setAttribute('x', rx); room.setAttribute('y', ry);
  room.setAttribute('width', W * s); room.setAttribute('height', D * s);
  room.setAttribute('class', 'room');
  svg.appendChild(room);
  drawRoom(svg, W, D, s, layoutState.room.door, layoutState.room.window);
  drawRoomDims(svg, W, D, s);
  drawOpeningHits(svg, W, D, s);
  drawOpeningHighlight(svg);
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
    // 隔断：按列数画竖向分隔线（开放柜更明显，呈商品陈列格）
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
    txt.setAttribute('class', 'furn-label' + (layoutSel === f.code ? '' : ' hide'));
    txt.textContent = (f.label || '').trim() || f.code;
    g.appendChild(txt);
    const labelTitle = document.createElementNS(SVGNS, 'title');
    labelTitle.textContent = txt.textContent;
    g.appendChild(labelTitle);
    // 旋转手柄：放置于货架右上角外侧，并仅当选中时可见——与「拖动主体移动」彻底分开，避免误触。
    const isSelected = (f.code === layoutSel);
    const knobLink = document.createElementNS(SVGNS, 'line');
    knobLink.setAttribute('x1', w / 2); knobLink.setAttribute('y1', -h / 2);
    knobLink.setAttribute('x2', w / 2 + KOFF); knobLink.setAttribute('y2', -(h / 2 + KOFF));
    knobLink.setAttribute('class', 'knob-link' + (isSelected ? '' : ' hide'));
    g.appendChild(knobLink);
    const knob = document.createElementNS(SVGNS, 'circle');
    knob.setAttribute('cx', w / 2 + KOFF); knob.setAttribute('cy', -(h / 2 + KOFF)); knob.setAttribute('r', 9);
    knob.setAttribute('class', 'knob' + (isSelected ? '' : ' hide'));
    g.appendChild(knob);
    const tip = document.createElementNS(SVGNS, 'text');
    tip.setAttribute('x', cx); tip.setAttribute('y', cy + h / 2 + 16); tip.setAttribute('text-anchor', 'middle');
    tip.setAttribute('class', 'drag-tip' + (isSelected ? '' : ' hide'));
    tip.textContent = `X ${f.x.toFixed(2)}  Z ${f.z.toFixed(2)}  ${Math.round(f.rot * 180 / Math.PI)}°`;
    svg.appendChild(tip);
    svg.appendChild(g);
    f._el = { g, rect, knob, knobLink, tip, label: txt };
    attachFurn(g, rect, knob, f);
  }
  if (cadShowDims) {
    for (const f of layoutState.furniture) drawFurnDims(svg, f, s);
  }
  updateLayoutEmpty();
  updateSelHint();
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
  // 旋转：记录按下时的光标角度，之后按「角度增量」跟随光标转动，
  // 避免一按下货架就跳到光标方向（旧实现是直接用光标方向覆盖旋转角）。
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
    if (!mode) return;
    mode = null; start = null;
    rect.classList.remove('dragging');
    for (const el of [rect, knob]) {
      try { if (el && el.hasPointerCapture && el.hasPointerCapture(e.pointerId)) el.releasePointerCapture(e.pointerId); } catch (_) { /* 已释放 */ }
    }
    markDirty(); // 移动/旋转完成，标记未保存（需点「保存布局」写回）
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
    // 优先：选中的门/窗沿墙微调（←/↑ 往墙起点，→/↓ 往墙终点；Shift 更精细）
    if (cadSel && cadSel.kind === 'opening') {
      const o = openingRef(cadSel.type, cadSel.index);
      if (!o) return;
      e.preventDefault();
      const step = e.shiftKey ? 0.002 : 0.01;
      const towardStart = (e.key === 'ArrowLeft' || e.key === 'ArrowUp');
      if (!setOpeningOffset(cadSel.type, cadSel.index, o.offset + (towardStart ? -step : step))) return;
      renderLayout(); renderOpeningListCAD();
      schedulePersistRoom();   // 门窗修改标记为未保存
      return;
    }
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
    markDirty();
  }
});

// 布局编辑器：选中货架后，在右侧货架列表上方跳出该货架的编辑面板
function renderFurnSelPanel() {
  const panel = document.getElementById('furnSelPanel');
  if (!panel) return;
  // 编辑面板输入框正在打字时不重建，避免拖拽/列表刷新打断输入
  if (document.activeElement && panel.contains(document.activeElement) && panel.dataset.rack===layoutSel) return;
  delete panel.dataset.invalid;
  panel.dataset.rack=layoutSel||'';
  if (!layoutSel || !layoutState) { panel.classList.add('hidden'); panel.innerHTML = ''; return; }
  const f = layoutState.furniture.find((x) => x.code === layoutSel);
  if (!f) { panel.classList.add('hidden'); panel.innerHTML = ''; return; }
  panel.classList.remove('hidden');
  // 记住折叠状态：如果之前展开过就保持，否则默认收起
  const wasExpanded = !panel.classList.contains('collapsed');
  const cellCount = (f.rows || 0) * (f.cols || 0);
  const safe = esc;
  panel.innerHTML = `
    <div class="fp-head" id="fp_head">
      <svg class="fp-chevron" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M6 9l6 6 6-6"/></svg>
      <span class="fp-title">📦 ${safe(f.label || f.code)} <span class="fp-code">${esc(f.code)}</span></span>
      <span class="fp-toggle-hint">${wasExpanded ? '收起' : '展开'}</span>
    </div>
    <div class="fp-body" id="fp_body">
    <div class="fp-hint">${cellCount} 个格位 · 修改后自动更新草稿，保存布局后生效。</div>
    <div class="fp-row"><label>名称</label><input id="fp_name" value="${safe(f.label)}" placeholder="如：A区开放式货架" /></div>
    <div class="fp-row"><label>类型</label>
      <select id="fp_type">
        <option value="shelf" ${f.type === 'shelf' ? 'selected' : ''}>开放式轻型货架</option>
        <option value="rack" ${f.type === 'rack' ? 'selected' : ''}>横梁式仓储货架</option>
        <option value="drivein" ${f.type === 'drivein' ? 'selected' : ''}>驶入式/贯通式货架</option>
        <option value="shuttle" ${f.type === 'shuttle' ? 'selected' : ''}>穿梭式货架</option>
        <option value="pushback" ${f.type === 'pushback' ? 'selected' : ''}>压入式货架</option>
        <option value="doubledeep" ${f.type === 'doubledeep' ? 'selected' : ''}>双深度货架</option>
        <option value="vna" ${f.type === 'vna' ? 'selected' : ''}>窄巷道货架（VNA）</option>
        <option value="flow" ${f.type === 'flow' ? 'selected' : ''}>流利式/重力式货架</option>
        <option value="cantilever" ${f.type === 'cantilever' ? 'selected' : ''}>悬臂式货架</option>
        <option value="mezzanine" ${f.type === 'mezzanine' ? 'selected' : ''}>阁楼式货架</option>
        <option value="asrs" ${f.type === 'asrs' ? 'selected' : ''}>自动化立体库货架</option>
        <option value="pegboard" ${f.type === 'pegboard' ? 'selected' : ''}>挂板/孔板</option>
        <option value="wardrobe" ${f.type === 'wardrobe' ? 'selected' : ''}>封闭储物柜</option>
        <option value="box" ${f.type === 'box' ? 'selected' : ''}>周转料箱（封闭）</option>
        <option value="cabinet" ${f.type === 'cabinet' ? 'selected' : ''}>抽屉式零件柜</option>
        <option value="mold" ${f.type === 'mold' ? 'selected' : ''}>模具架/抽屉式</option>
        <option value="mesh" ${f.type === 'mesh' ? 'selected' : ''}>仓储笼/钢制料笼</option>
        <option value="mobile" ${f.type === 'mobile' ? 'selected' : ''}>移动式密集架</option>
        <option value="floor" ${f.type === 'floor' ? 'selected' : ''}>地面区（贴地网格）</option>
      </select>
    </div>
    <div class="fp-grid">
      <label>宽(m)<input id="fp_w" type="number" min="0" step="any" value="${f.w != null ? f.w : ''}" /></label>
      <label>高(m)<input id="fp_h" type="number" min="0" step="any" value="${f.h != null ? f.h : ''}" /></label>
      <label>深(m)<input id="fp_d" type="number" min="0" step="any" value="${f.d != null ? f.d : ''}" /></label>
      <label id="fp_rows_label">层数<input id="fp_rows" type="number" min="1" max="100" value="${f.rows != null ? f.rows : ''}" /></label>
      <label>列数<input id="fp_cols" type="number" min="1" max="100" value="${f.cols != null ? f.cols : ''}" /></label>
    </div>
    <details class="layout-precision"><summary>精确定位</summary><div class="fp-grid">
      <label>X 位置(m)<input id="fp_x" type="number" step="0.1" value="${f.x}" /></label>
      <label>Z 位置(m)<input id="fp_z" type="number" step="0.1" value="${f.z}" /></label>
      <label>角度(°)<input id="fp_rot" type="number" step="5" value="${+(f.rot*180/Math.PI).toFixed(3)}" /></label>
    </div></details>
    <div id="fp_msg" class="fp-msg" role="status"></div>
    <div class="fp-actions">
      <button class="fp-save" id="fp_saveBtn">应用到草稿</button>
      <button class="fp-clone" id="fp_cloneBtn">📋 复制</button>
      <button class="fp-clone" id="fp_cellsBtn">格位划分</button>
      <button class="fp-del" id="fp_delBtn">🗑 删除</button>
    </div>
    </div>`;
  // 收放：沿用上次的展开/收起状态（用户说前期编辑完基本不动，所以默认是收起）
  // 这里是重建 innerHTML 后的首次定态，不做动画，避免每次渲染都抖一下
  setPanelCollapsed(panel, !wasExpanded, false);
  wireCollapseHead(panel, document.getElementById('fp_head'));
  const syncFloorFields = () => {
    const isFloor = document.getElementById('fp_type').value === 'floor';
    document.getElementById('fp_rows_label').firstChild.textContent = isFloor ? '行数' : '层数';
    const height = document.getElementById('fp_h');
    height.disabled = isFloor;
    if (isFloor) height.value = 0.05;
    else if (+height.value < 0.3) height.value = RACK_TYPES[document.getElementById('fp_type').value]?.h || 1.8;
    document.getElementById('fp_d').removeAttribute('max');
  };
  document.getElementById('fp_type').onchange = syncFloorFields;
  syncFloorFields();
  const msg = document.getElementById('fp_msg');
  document.getElementById('fp_saveBtn').onclick = () => {
    const candidate={...f,label:document.getElementById('fp_name').value.trim(),type:document.getElementById('fp_type').value};
    for(const key of ['w','h','d','rows','cols'])candidate[key]=Number(document.getElementById('fp_'+key).value);
    const fail=message=>{panel.dataset.invalid='true';msg.className='fp-msg err';msg.textContent=message;};
    for(const key of ['x','z'])candidate[key]=Number(document.getElementById('fp_'+key).value);
    candidate.rot=Number(document.getElementById('fp_rot').value)*Math.PI/180;
    if(!candidate.label)return fail('请填写名称');
    if(![candidate.x,candidate.z,candidate.rot].every(Number.isFinite))return fail('位置和角度须为有效数字');
    const error=rackInputError(candidate);if(error){fail(error);return;}
    const problem=placementError(candidate,layoutState.room,layoutState.furniture);
    if(problem){fail(problem+'，原草稿未改变');return;}
    candidate.open=RACK_TYPES[candidate.type]?.open ?? f.open;
    delete panel.dataset.invalid;
    Object.assign(f,candidate);
    applyTransform(f); updateFurnEl(f); renderLayout(); renderList();
    markDirty();
    msg.className = 'fp-msg ok'; msg.textContent = '已更新草稿';
  };
  panel.querySelectorAll('input,select').forEach(input=>input.addEventListener('change',()=>document.getElementById('fp_saveBtn').click()));
  document.getElementById('fp_cellsBtn').onclick=()=>openMergeModal(f.code);
  document.getElementById('fp_cloneBtn').onclick = () => {
    try { appendDraftRack(f); } catch(error) { layoutMsg(error.message); }
  };
  document.getElementById('fp_delBtn').onclick = () => removeDraftRack(f.code);

}

function renderList() {
  for(const code of layoutMultiSelect)if(!layoutState.furniture.some(f=>f.code===code))layoutMultiSelect.delete(code);
  document.getElementById('layoutArrangeCount').textContent='已选 '+layoutMultiSelect.size+' 架';
  const ul=document.getElementById('layoutList');ul.replaceChildren();
  setSecCount('secRackCnt',layoutState.furniture.length);
  wireCollapseHead(document.getElementById('secRack'),document.getElementById('secRackHead'));
  for(const f of layoutState.furniture){
    f.x=Number(f.x)||0;f.z=Number(f.z)||0;f.rot=Number(f.rot)||0;
    const li=document.createElement('li');li.className=layoutSel===f.code?'sel':'';
    const head=document.createElement('div');head.className='ll-head';
    const check=document.createElement('input');check.type='checkbox';check.checked=layoutMultiSelect.has(f.code);
    check.style.cssText='width:16px;height:16px;flex:0 0 16px;margin:0;padding:0';check.setAttribute('aria-label','选择排列 '+(f.label||f.code));
    check.onchange=()=>{if(check.checked)layoutMultiSelect.add(f.code);else layoutMultiSelect.delete(f.code);document.getElementById('layoutArrangeCount').textContent='已选 '+layoutMultiSelect.size+' 架';};
    const button=document.createElement('button');button.type='button';button.className='layout-object-name';button.textContent=f.label||f.code;
    const small=document.createElement('small');small.textContent=(f.type==='floor'?'地面存放区':'货架 / 储位')+' · '+f.rows+' × '+f.cols+' 格';button.append(small);
    button.onclick=()=>selectLayout(f.code);head.append(check,button);li.append(head);ul.append(li);
  }
  renderFurnSelPanel();
}
// 布局窗口内所有货架操作只改草稿，最终由 /api/layout 一次提交。
function editingLayout() { return layoutState && !layoutModal.classList.contains('hidden'); }
function appendDraftRack(source) {
  const [position]=computeClonePositions(source,1,layoutState.furniture,layoutState.room.width,layoutState.room.depth);
  const {label,type,rows,cols,open,w,h,d,rot}=source;
  const rack={label,type,rows,cols,open,w,h,d,rot,...position,code:'draft-'+globalThis.spatialRandomUUID(),
    merges:structuredClone(source.merges || {}),cellNames:structuredClone(source.cellNames || {})};
  layoutState.furniture.push(rack); layoutSel=rack.code;
  markDirty(); renderLayout(); renderList(); layoutMsg('已加入草稿，保存布局后生成正式格位编码');
  window.dispatchEvent(new Event('layout-object-selected'));
}
async function removeDraftRack(code) {
  const rack=layoutState.furniture.find(f=>f.code===code); if(!rack)return;
  if(!await appConfirm('从布局草稿移除「'+(rack.label || code)+'」及其格位？保存布局后才会生效。外部库存或映射仍引用时将拒绝保存。',{danger:true}))return;
  layoutState.furniture=layoutState.furniture.filter(f=>f.code!==code);
  layoutReplacePending=true;
  layoutSel=layoutState.furniture[0]?.code || null;
  markDirty(); renderLayout(); renderList(); layoutMsg('已从草稿移除，尚未写入');
}

// 加载当前房间布局到 layoutState（不打开弹窗），供「打开编辑器」与「拖拽导入」共用
async function loadLayoutState() {
  const res = await fetch('/api/layout' + (currentRoomCode ? `?room=${encodeURIComponent(currentRoomCode)}` : ''));
  if(!res.ok)throw Error('布局读取失败，请重试');
  const data=await res.json();
  layoutState = data;
  layoutMultiSelect.clear();
  layoutReplacePending = false;
  layoutHistory.reset(layoutSnapshot());updateHistoryButtons();
  return data;
}
mountLayoutWorkspace();
document.getElementById('layoutBtn').onclick = async () => {
  if ((IS_INTEGRATION || IS_SUPOS) && !document.documentElement.classList.contains('space-editor')) return;
  layoutMsg('加载中…');
  try {
    await loadLayoutState();
  } catch (e) { layoutMsg('加载失败：' + e.message); return; }
  layoutSel = layoutState.furniture[0] ? layoutState.furniture[0].code : null;
  layoutZoom = 1;               // 每次打开先回到「适应窗口」
  layoutModal.classList.remove('hidden'); // 先显示再渲染：便于按画布实际尺寸计算适应比例
  clearDirty();                 // 打开时重置未保存标记
  // 收放接线放在这里：保证「打开布局编辑器」时必定生效。
  // 之前门窗头的点击是在 renderOpeningListCAD() 里接的，一旦它前面的 renderLayout() 抛异常，
  // 门窗分区就永远点不动（表现就是点了没反应）。
  wireLayoutSections();
  // 弹窗从 display:none 切换到 flex 后，浏览器需要一帧完成尺寸布局；
  // 若同步渲染，画布 clientHeight 可能还未稳定，导致 SVG 只有一半高、下方出现大片空白，用户滚动后会看到门/窗但看不到货架。
  setTimeout(() => {
    const c = document.querySelector('.layout-canvas');
    if (c) c.scrollTop = 0;     // 打开时始终回到左上角（背墙/货架区），避免上次滚动遗留位置
    try {
      renderLayout(); renderList(); renderOpeningListCAD(); setCadTool('select'); updateLayoutZoomLbl(); updateCadDimBtn();
      // 首帧渲染时画布往往还没拿到最终高度（行高由内容反推，会形成
      // 「SVG 越高 → 行被挤得越矮 → 画布越小 → 比例又被钳到 1」的反向锁死）。
      // 等布局稳定后按真实画布尺寸再算一次，SVG 就不会大到要在一个小画布里狂滚。
      requestAnimationFrame(() => requestAnimationFrame(() => { try { renderLayout(); } catch (_) {} }));
    } catch (err) {
      // 渲染偶发异常也要尽量呈现列表，避免空白 + 「加载中…」卡死
      console.error('布局渲染异常:', err);
      try { renderList(); } catch (_) {}
      toast('布局渲染部分异常：' + (err.message || err));
    } finally {
      if (!layoutState.furniture.length) {
        layoutMsg('当前库区还没有货架，点击顶部「＋ 添加」，选择货架或地面存放区开始');
      } else {
        layoutMsg('');
      }
    }
  }, 0);
};
async function closeLayout() {
  if (layoutSaving || layoutClosePending) return;
  layoutClosePending = true;
  try {
    if (layoutDirty && !(await appConfirm('布局草稿有未保存的改动，关闭将放弃本次新增、复制、删除、规格、格位及位置调整。', { title: '放弃未保存的布局？', okText: '放弃并关闭', danger: true }))) return;
    clearTimeout(openingPersistTimer);
    layoutModal.classList.add('hidden');
    layoutPendingRefresh=false;
    clearDirty();
    // 撤销布局预览，同时保留进入编辑前的格位与视角。
    await window.SPATIAL_REFRESH_VIEW();
    layoutState = null;
  } finally { layoutClosePending = false; }
}
document.getElementById('layout_close').onclick = closeLayout;
window.addEventListener('beforeunload', e => {
  if (layoutDirty || layoutSaving) { e.preventDefault(); e.returnValue = ''; }
});
document.getElementById('layout_add_rack').onclick = () => {
  if (!currentRoomCode) { toast('请先选择库区'); return; }
  layoutPendingRefresh = true;
  furnModal.classList.remove('hidden');
  document.getElementById('furn_msg').textContent = '';
};
document.getElementById('layoutZoomIn').onclick = () => setLayoutZoom(layoutZoom * 1.25);
document.getElementById('layoutZoomOut').onclick = () => setLayoutZoom(layoutZoom / 1.25);
document.getElementById('layoutZoomFit').onclick = () => setLayoutZoom(1);
// 聚焦只改变视图；以旋转后的包围尺寸适配，不产生布局草稿或历史记录。
document.getElementById('layoutFocus').onclick = () => {
  const f=layoutState?.furniture.find(f=>f.code===layoutSel);if(!f)return;
  const box=document.querySelector('.layout-canvas'),svg=document.getElementById('layoutSvg');
  const extent=halfExtents(f),scale=Math.min(box.clientWidth*0.7/(2*extent.x),box.clientHeight*0.7/(2*extent.z));
  layoutZoom=Math.max(0.3,Math.min(6,scale/layoutFitScale()));renderLayout();updateLayoutZoomLbl();
  const [x,y]=w2s(f.x,f.z,layoutState.room.width,layoutState.room.depth,layoutScale());
  const point=svg.createSVGPoint();point.x=x;point.y=y;
  const screen=point.matrixTransform(svg.getScreenCTM()),rect=box.getBoundingClientRect();
  box.scrollLeft+=screen.x-(rect.left+box.clientWidth/2);box.scrollTop+=screen.y-(rect.top+box.clientHeight/2);
};
document.getElementById('layoutArrange').onclick=()=>{
  if(layoutSaving)return;
  try {
    const positions=arrangeRacks(layoutState.furniture,[...layoutMultiSelect],layoutState.room,document.getElementById('layoutArrangeAxis').value,Number(document.getElementById('layoutArrangeGap').value));
    for(const position of positions){const rack=layoutState.furniture.find(f=>f.code===position.code);Object.assign(rack,position);applyTransform(rack);}
    markDirty();renderLayout();renderList();layoutMsg('已排列 '+positions.length+' 架，可撤销；保存布局后生效');
  }catch(error){layoutMsg('未应用排列：'+error.message);}
};
document.getElementById('layoutPropertiesToggle').onclick=e=>{
  const hidden=document.querySelector('.layout-row').classList.toggle('properties-hidden');
  e.currentTarget.textContent=hidden?'展开面板':'收起面板';
  e.currentTarget.setAttribute('aria-expanded',String(!hidden));
  renderLayout();
};

// Ctrl / ⌘ + 滚轮 = 缩放画布；普通滚轮仍用于滚动（放大后需要平移）
document.querySelector('.layout-canvas').addEventListener('wheel', (e) => {
  if (!e.ctrlKey && !e.metaKey) return;
  e.preventDefault();
  setLayoutZoom(layoutZoom * (e.deltaY < 0 ? 1.12 : 1 / 1.12),e);
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
document.getElementById('layout_save').onclick = async () => {
  if (layoutSaving) return;
  if(document.getElementById('furnSelPanel').dataset.invalid){layoutMsg('请先修正选中属性中的错误，再保存布局');window.dispatchEvent(new Event('layout-object-selected'));return;}
  layoutSaving = true;
  layoutModal.inert = true;
  layoutModal.setAttribute('aria-busy', 'true');
  layoutMsg('保存中…');
  try {
    const payload = {
      room: layoutState.room,
      revision: layoutState.revision,
      roomId: currentRoomCode,
      replace: layoutReplacePending, // 草稿删除或整份替换：由服务端同一事务删除未保留货架
      // 必须带上 rows/cols/type/open：新建家具（拍照生成 / 外部导入）靠它决定格位划分，
      // 漏传会让服务端退回默认 3×3，导致识别出的层数/位数丢失。
      furniture: layoutState.furniture.map((f) => ({ code: f.code, label: f.label, x: f.x, z: f.z, rot: f.rot, w: f.w, h: f.h, d: f.d, rows: f.rows, cols: f.cols, type: f.type, open: f.open, merges:f.merges,cellNames:f.cellNames,mergeCapacities:f.mergeCapacities,mergeCapacityRevision:f.mergeCapacityRevision })),
    };
    for (const f of payload.furniture) {
      const problem = placementError(f, payload.room, payload.furniture);
      if (problem) throw new Error(f.code + '：' + problem);
    }
    const res = await fetch('/api/layout', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
    if (!res.ok) throw new Error((await res.json()).error || '保存失败');
    layoutReplacePending = false;
    layoutMsg('已保存 ✓');
    clearDirty();
    await loadScene();
    layoutModal.classList.add('hidden');
    layoutState=null;
    window.dispatchEvent(new Event('spatial-layout-saved'));
  } catch (e) { layoutMsg('保存失败：' + e.message); }
  finally {
    layoutSaving = false;
    layoutModal.inert = false;
    layoutModal.removeAttribute('aria-busy');
  }
};
function currentLayoutData() {
  return { room: layoutState.room, furniture: layoutState.furniture.map((f) => ({ code: f.code, label: f.label, x: f.x, z: f.z, rot: f.rot, w: f.w, h: f.h, d: f.d, rows: f.rows, cols: f.cols, type: f.type, open: f.open, merges:f.merges,cellNames:f.cellNames,mergeCapacities:f.mergeCapacities,mergeCapacityRevision:f.mergeCapacityRevision })) };
}
document.getElementById('layout_export').onclick = () => {
  if (!layoutState) return;
  const dxf = templateToDXF(currentLayoutData());
  const blob = new Blob([dxf], { type: 'application/dxf' });
  const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = '空间布局.dxf'; a.click();
  layoutMsg('已导出 DXF（可用 AutoCAD / FreeCAD 打开）');
};
document.getElementById('layout_export_json').onclick = () => {
  if (!layoutState) return;
  const blob = new Blob([JSON.stringify(currentLayoutData(), null, 2)], { type: 'application/json' });
  const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = '空间布局模板.json'; a.click();
  layoutMsg('已导出布局模板 JSON');
};
document.getElementById('layout_import_btn').onclick = () => document.getElementById('layout_file').click();
document.getElementById('layout_file').onchange = async (e) => {
  const file = e.target.files[0]; if (!file) return;
  await importLayoutFile(file, false);
  e.target.value = '';
};

// 共享：把 CAD/BIM/JSON 文件解析为规范模板并套用到布局编辑器（拖拽与按钮共用）
async function importLayoutFile(file, fromDrop) {
  if((IS_INTEGRATION || IS_SUPOS) && !document.documentElement.classList.contains('space-editor')) { toast('当前账号没有空间编辑权限'); return; }
  const name = (file && file.name || '').toLowerCase();
  if (!/\.(dxf|ifc|json)$/.test(name)) {
    layoutMsg('仅支持 .dxf / .ifc / .json 布局文件');
    return;
  }
  try {
    let data, kindLabel = '';
    if (name.endsWith('.dxf') || name.endsWith('.ifc')) {
      // 外部工具（CAD/BIM/SketchUp/FreeCAD）导出文件 → 经服务端解析为规范模板
      layoutMsg('解析 ' + file.name + ' 中…');
      const text = await file.text();
      const res = await fetch('/api/import-layout', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ filename: file.name, content: text }),
      });
      if (!res.ok) throw new Error((await res.json()).error || '导入失败');
      const j = await res.json();
      data = j.template;
      kindLabel = (j.kind || '').toUpperCase();
    } else {
      // 平台自有 JSON 模板
      data = JSON.parse(await file.text());
    }
    await applyImportedTemplate(data, kindLabel);
  } catch (err) { layoutMsg('解析失败：' + err.message); }
}

// 把模板套用到编辑器：CAD/拍照/文件都视为「该文件即权威布局」→ 替换模式，
// 弹确认避免误删库存。仅还原位置/尺寸/旋转，行×列/类型由用户在编辑器内补。
async function applyImportedTemplate(data, kindLabel) {
  if (!data || !Array.isArray(data.furniture) || !data.room) throw new Error('布局模板须包含库区和货架列表');
  if (!layoutState || layoutModal.classList.contains('hidden')) await loadLayoutState();
  const old = (layoutState && Array.isArray(layoutState.furniture)) ? layoutState.furniture.length : 0;
  const nw = (data.furniture || []).length;
  if (old) {
    const ok = await appConfirm(
      `导入将【替换】现有 ${old} 件家具（新 ${nw} 件）。\n\n` +
      `· 没有被导入结果包含的旧货架，会在你点「保存布局」时被删除\n` +
      `· 被外部库存或库位映射引用的旧货架不能删除或改变格位结构\n\n` +
      `现在只是套用到编辑器，尚未写入数据库。确定继续吗？`,
      { danger: true }
    );
    if (!ok) return;
  }
  layoutReplacePending = true;
  layoutModal.classList.remove('hidden'); // 同上：先显示，适应比例才量得准
  applyTemplateToLayout(data, kindLabel || '导入', { replace: true });
  layoutMsg(`已导入 ${nw} 个货架（位置/尺寸已还原）。请在右侧设置每排货架的「层数×列数 / 类型」，再点「保存布局」写入`);
}

// ================= 拖拽导入 CAD/IFC/JSON 布局（直接拖到 3D 画面） =================
(function setupDropImport() {
  const overlay = document.getElementById('dropOverlay');
  let depth = 0;
  const isFileDrag = (e) => !!(e.dataTransfer && Array.from(e.dataTransfer.types || []).includes('Files'));
  document.addEventListener('dragenter', (e) => {
    if (!isFileDrag(e)) return;
    e.preventDefault(); depth++; overlay.classList.remove('hidden');
  });
  document.addEventListener('dragover', (e) => {
    if (!isFileDrag(e)) return;
    e.preventDefault();
    if (e.dataTransfer) e.dataTransfer.dropEffect = 'copy';
  });
  document.addEventListener('dragleave', (e) => {
    if (!isFileDrag(e)) return;
    depth = Math.max(0, depth - 1);
    if (depth === 0) overlay.classList.add('hidden');
  });
  document.addEventListener('drop', async (e) => {
    if (!isFileDrag(e)) return;
    e.preventDefault(); depth = 0; overlay.classList.add('hidden');
    const file = e.dataTransfer.files && e.dataTransfer.files[0];
    if (file) await importLayoutFile(file, true);
  });
})();

// 把规范化布局模板套用到当前布局编辑器（导入模板 / 拍照生成 / DXF·IFC 共用）
// 拍照生成「替换」后置为 true，保存布局时通知服务端删除未被包含的旧家具
let layoutReplacePending = false;
function applyTemplateToLayout(data, kindLabel, opts = {}) {
  if (data.room) {
    layoutState.room = Object.assign({}, layoutState.room, data.room);
    rebuildRoom(layoutState.room);
  }
  // 替换模式：先清空，避免识别结果被「叠加」到原有家具上（两者 code 规则不同，永远匹配不上）
  if (opts.replace) layoutState.furniture = [];
  if (Array.isArray(data.furniture)) {
    for (const nf of data.furniture) {
      const f = layoutState.furniture.find((x) => x.code === nf.code);
      if (f) {
        f.x = nf.x != null ? nf.x : f.x; f.z = nf.z != null ? nf.z : f.z;
        f.rot = nf.rot != null ? nf.rot : f.rot; f.w = nf.w != null ? nf.w : f.w;
        f.h = nf.h != null ? nf.h : f.h; f.d = nf.d != null ? nf.d : f.d;
        if (nf.rows != null) f.rows = nf.rows; if (nf.cols != null) f.cols = nf.cols;
        if (nf.type) f.type = nf.type; if (nf.open != null) f.open = nf.open;
        if(nf.merges) f.merges=nf.merges; if(nf.cellNames) f.cellNames=nf.cellNames;
        applyTransform(f);
      } else {
        // 外部导入的新货架：加入布局编辑器（保存时由服务端创建）
        layoutState.furniture.push(Object.assign({ label: nf.code, type: 'rack', open: 1, rows: 3, cols: 3 }, nf));
      }
    }
  }
  // 替换模式下旧家具已清空，选中项与缩放一并重置，避免残留指向已删除的货架
  if (opts.replace) {
    layoutSel = layoutState.furniture.length ? layoutState.furniture[0].code : null;
    layoutZoom = 1;
  }
  renderLayout(); renderList(); updateLayoutZoomLbl();
  markDirty();
  layoutMsg(kindLabel ? `已通过 ${kindLabel} 解析（点「保存布局」写入服务端）` : '已导入模板（点「保存布局」写入服务端）');
}

// ================= 拍照生成 3D 场景（多图 + 先验尺寸 + 并排校对） =================
const photoModalEl = document.getElementById('photoModal');
let photoDataUrls = [];
let photoResult = null;

function photoMsg(t) { const el = document.getElementById('photo_msg'); if (el) el.textContent = t || ''; }

// 拍照识别错误分类提示（P2-10）：把后端/网络错误转成用户可操作的文案
function classifyPhotoError(status, msg) {
  const m = String(msg || '');
  if (status === 401) return '登录已失效或无权限（需 admin/operator），请重新登录后重试。';
  if (status === 403) return '当前账号无权限执行识别（需 admin/operator 角色）。';
  if (status === 413) return '图片过大，请压缩后再试。';
  if (status >= 500) return '识别服务异常，请稍后重试。';
  // 网络层（fetch 抛错，无状态码）
  if (status === 0 || /failed to fetch|networkerror|网络/i.test(m)) return '网络错误，无法连接识别服务，请检查网络或服务端。';
  // 业务错误（后端 400 + 文案）
  if (/未配置视觉模型/.test(m)) return '未配置视觉识别 Key：服务端需设置 PHOTO_VISION_API_KEY（或临时 MOCK=1 联调）。也可改用「布局」手动编辑。';
  const apiErr = /视觉API错误\s*(\d+)/.exec(m);
  if (apiErr) {
    const code = apiErr[1];
    if (code === '401') return '视觉模型 API Key 无效或已过期，请检查 PHOTO_VISION_API_KEY。';
    return '视觉识别服务返回错误（' + code + '），请稍后重试或联系管理员。';
  }
  if (/未返回可解析的 JSON/.test(m)) return '识别结果无法解析，请重拍（正对货架、画面清晰、光线充足）后重试。';
  if (/布局模板不合规/.test(m)) return '识别出的布局不合规：' + m.replace(/生成的布局模板不合规：/, '');
  if (/需提供 image/.test(m)) return '请先拍摄或选择至少一张照片。';
  return '识别失败：' + m;
}

function downscaleToDataUrl(file, max = 1000) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const img = new Image();
      img.onload = () => {
        const scale = Math.min(1, max / Math.max(img.width, img.height));
        const cv = document.createElement('canvas');
        cv.width = Math.round(img.width * scale); cv.height = Math.round(img.height * scale);
        cv.getContext('2d').drawImage(img, 0, 0, cv.width, cv.height);
        resolve(cv.toDataURL('image/jpeg', 0.82));
      };
      img.onerror = reject;
      img.src = reader.result;
    };
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}

function showPhotoPreview(i) {
  const pv = document.getElementById('photo_preview');
  if (!photoDataUrls[i]) return;
  pv.src = photoDataUrls[i]; pv.style.display = '';
  const ph = document.getElementById('photo_preview_ph');
  if (ph) ph.style.display = 'none';
}

function renderPhotoThumbs() {
  const box = document.getElementById('photo_thumbs');
  if (!box) return;
  box.innerHTML = '';
  photoDataUrls.forEach((u, i) => {
    const w = document.createElement('div');
    w.style.position = 'relative';
    const im = document.createElement('img');
    im.src = u;
    im.style.cssText = 'width:64px;height:64px;object-fit:cover;border-radius:6px;cursor:pointer';
    im.onclick = () => showPhotoPreview(i);
    const x = document.createElement('span');
    x.textContent = '×';
    x.style.cssText = 'position:absolute;top:-6px;right:-6px;background:#dc2626;color:#fff;border-radius:50%;width:18px;height:18px;line-height:18px;text-align:center;font-size:12px;cursor:pointer';
    x.onclick = () => { photoDataUrls.splice(i, 1); renderPhotoThumbs(); };
    w.appendChild(im); w.appendChild(x); box.appendChild(w);
  });
  if (photoDataUrls.length) showPhotoPreview(0);
  else {
    const pv = document.getElementById('photo_preview');
    if (pv) pv.style.display = 'none';
    const ph = document.getElementById('photo_preview_ph');
    if (ph) ph.style.display = '';
  }
}

// 生成俯视图用于照片校对：低置信度画橙色
function renderPhotoPlan(tpl) {
  const host = document.getElementById('photo_plan');
  if (!host) return;
  if (!tpl) { host.innerHTML = '<div style="font-size:12px;color:var(--muted)">（尚未识别）</div>'; return; }
  const W = 210, H = 170, pad = 12;
  const rw = Number(tpl.room.width) || 10, rd = Number(tpl.room.depth) || 8;
  const s = Math.min((W - pad * 2) / rw, (H - pad * 2) / rd);
  const cx = W / 2, cy = H / 2;
  let svg = `<svg width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">`;
  svg += `<rect x="${(cx - rw * s / 2).toFixed(1)}" y="${(cy - rd * s / 2).toFixed(1)}" width="${(rw * s).toFixed(1)}" height="${(rd * s).toFixed(1)}" fill="#f1f5f9" stroke="#94a3b8" stroke-width="1"/>`;
  for (const f of tpl.furniture) {
    const fw = Math.max(5, Number(f.w) * s), fd = Math.max(5, Number(f.d) * s);
    const x = cx + Number(f.x) * s - fw / 2, y = cy + Number(f.z) * s - fd / 2;
    const low = f.confidence === 'low';
    svg += `<rect x="${x.toFixed(1)}" y="${y.toFixed(1)}" width="${fw.toFixed(1)}" height="${fd.toFixed(1)}" rx="2" fill="${low ? '#fef3c7' : '#dbeafe'}" stroke="${low ? '#f59e0b' : '#3b82f6'}" stroke-width="1.5"/>`;
    svg += `<text x="${(x + fw / 2).toFixed(1)}" y="${(y + fd / 2 + 3.5).toFixed(1)}" text-anchor="middle" font-size="10" fill="${low ? '#92400e' : '#1e40af'}">${f.code}</text>`;
  }
  svg += '</svg>';
  svg += `<div style="font-size:11px;color:var(--muted);margin-top:4px">房间 ${rw} × ${rd} m，共 ${tpl.furniture.length} 件</div>`;
  host.innerHTML = svg;
}

document.getElementById('layout_photo_btn').onclick = () => {
  photoDataUrls = []; photoResult = null;
  renderPhotoThumbs(); renderPhotoPlan(null);
  const wl = document.getElementById('photo_warn'); if (wl) wl.innerHTML = '';
  const ap = document.getElementById('photo_apply'); if (ap) ap.disabled = true;
  photoMsg('');
  if (photoModalEl) photoModalEl.classList.remove('hidden');
};
document.getElementById('photoClose').onclick = () => photoModalEl.classList.add('hidden');
document.getElementById('photo_cancel').onclick = () => photoModalEl.classList.add('hidden');
document.getElementById('photo_pick').onclick = () => document.getElementById('photo_files').click();
document.getElementById('photo_files').onchange = async (e) => {
  const files = Array.from(e.target.files || []);
  if (!files.length) return;
  photoMsg('处理图片…');
  try {
    for (const f of files) photoDataUrls.push(await downscaleToDataUrl(f));
    renderPhotoThumbs();
    photoMsg(`已选 ${photoDataUrls.length} 张照片`);
  } catch (err) { photoMsg('图片处理失败：' + err.message); }
  e.target.value = '';
};
document.getElementById('photo_go').onclick = async () => {
  if (!photoDataUrls.length) { photoMsg('请先选择照片'); return; }
  const n = (id) => document.getElementById(id).value;
  const hints = {
    rackW: n('ph_rackW'), rackD: n('ph_rackD'),
    rackRows: n('ph_rows'), rackCols: n('ph_cols'),
    roomW: n('ph_roomW'), roomD: n('ph_roomD'),
  };
  photoMsg('识别中…');
  let photoStatus = 0;
  try {
    const res = await fetch('/api/import-layout-photo', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ images: photoDataUrls, hints, reference: n('photo_ref') }),
    });
    photoStatus = res.status;
    if (!res.ok) {
      let serverMsg = '';
      try { serverMsg = (await res.json()).error || ''; } catch (_) {}
      throw new Error(serverMsg || ('HTTP ' + res.status));
    }
    const j = await res.json();
    photoResult = j;
    renderPhotoPlan(j.template);
    const wl = document.getElementById('photo_warn');
    wl.innerHTML = '';
    const warns = j.warnings || [];
    if (!warns.length) {
      const li = document.createElement('li');
      li.style.color = '#86efac';
      li.textContent = '自检通过：未发现越界或重叠。';
      wl.appendChild(li);
    } else {
      for (const w of warns) {
        const li = document.createElement('li');
        li.style.color = w.level === 'error' ? '#fca5a5' : '#fbbf24';
        li.textContent = w.text;
        wl.appendChild(li);
      }
    }
    const low = j.lowConfidence || 0;
    photoMsg(`识别完成：${j.template.furniture.length} 件${low ? `，其中 ${low} 件不确定（橙框）` : ''}`);
    document.getElementById('photo_apply').disabled = false;
  } catch (err) { photoMsg(classifyPhotoError(photoStatus, err.message)); }
};
document.getElementById('photo_apply').onclick = async () => {
  if (!photoResult || !photoResult.template) return;
  const old = (layoutState && Array.isArray(layoutState.furniture)) ? layoutState.furniture.length : 0;
  const nw = photoResult.template.furniture.length;
  if (old) {
    const ok = await appConfirm(
      `识别结果将【替换】现有 ${old} 件家具（新 ${nw} 件）。\n\n` +
      `· 没有被识别结果包含的旧货架，会在你点「保存布局」时被删除\n` +
      `· 被外部库存或库位映射引用的旧货架不能删除或改变格位结构\n\n` +
      `现在只是套用到编辑器，尚未写入数据库。确定继续吗？`,
      { danger: true }
    );
    if (!ok) return;
  }
  layoutReplacePending = true;
  applyTemplateToLayout(photoResult.template, 'PHOTO', { replace: true });
  photoModalEl.classList.add('hidden');
  layoutMsg(`已替换为识别结果 ${nw} 件，检查无误后点「保存布局」写入`);
};

// ================= 扫码定位 =================
const scanModal = document.getElementById('scanModal');
let scanStream = null, scanRAF = null, scanGeneration = 0;

document.getElementById('scanBtn').onclick = () => { scanModal.classList.remove('hidden'); document.getElementById('scanCode').focus(); };
document.getElementById('scan_camera').onclick=()=>startScan();
window.addEventListener('pagehide', stopScan);
async function locateScannedCode(raw) {
  stopScan();const msg=document.getElementById('scanMsg');msg.style.color='';
  try {
    const target=parseWarehouseCode(raw,location.origin);
    if(target.sku && !IS_INTEGRATION)await doSearch(target.sku);else await locateTarget(target);
    scanModal.classList.add('hidden');
  }catch(e){msg.textContent=e.message;}
}
document.getElementById('scan_submit').onclick=()=>locateScannedCode(document.getElementById('scanCode').value);
document.getElementById('scanCode').addEventListener('keydown',event=>{if(event.key==='Enter'){event.preventDefault();locateScannedCode(event.target.value);}});
document.getElementById('scan_cancel').onclick = () => { stopScan(); scanModal.classList.add('hidden'); };

async function startScan() {
  stopScan();
  const generation = scanGeneration;
  const video = document.getElementById('scanVideo');
  const msg = document.getElementById('scanMsg');
  msg.style.color = '';
  msg.textContent = '正在请求摄像头，请在浏览器提示中允许访问；也可以使用上方输入框输入仓储码。';
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment' } });
    // 关闭窗口或重新开启后，晚到的授权结果只能释放，不能启动旧会话。
    if (generation !== scanGeneration) { stream.getTracks().forEach(t => t.stop()); return; }
    scanStream = stream;
    video.srcObject = stream;
    await video.play();
    if (generation !== scanGeneration) return;
    msg.textContent = '将二维码对准摄像头…';
    const tick = () => {
      if (generation !== scanGeneration) return;
      if (video.readyState === video.HAVE_ENOUGH_DATA && video.videoWidth) {
        const cv = document.createElement('canvas');
        cv.width = video.videoWidth; cv.height = video.videoHeight;
        const ctx = cv.getContext('2d');
        ctx.drawImage(video, 0, 0, cv.width, cv.height);
        const img = ctx.getImageData(0, 0, cv.width, cv.height);
        const code = window.jsQR(img.data, img.width, img.height, { inversionAttempts: 'dontInvert' });
        if (code && code.data) {
          locateScannedCode(code.data);
          return;
        }
      }
      scanRAF = requestAnimationFrame(tick);
    };
    scanRAF = requestAnimationFrame(tick);
  } catch (e) {
    if (generation !== scanGeneration) return;
    stopScan();
    msg.style.color = '#fca5a5'; msg.textContent = '无法开启摄像头：' + e.message;
  }
}

function stopScan() {
  scanGeneration++;
  if (scanRAF != null) cancelAnimationFrame(scanRAF);
  scanRAF = null;
  if (scanStream) { scanStream.getTracks().forEach((t) => t.stop()); scanStream = null; }
  const video = document.getElementById('scanVideo');
  video.pause(); video.srcObject = null;
}

// ---- 3D 视图直接拖拽货架模式 ----
let drag3dMode = false;
let positionSaving=false, positionStarting=false, positionOriginal=null, openingOriginal=[];
const positionBar=document.createElement('div');
positionBar.id='positionEditBar';positionBar.hidden=true;
positionBar.style.cssText='position:fixed;bottom:64px;left:50%;transform:translateX(-50%);z-index:1000;background:#172238;border:1px solid #60a5fa;border-radius:12px;padding:12px;max-width:90vw;box-shadow:0 4px 20px #0006';
positionBar.innerHTML='<span role="status" id="positionEditMessage">拖动货架或门窗后，点击保存位置</span> <button class="toolbtn" id="positionSave">保存位置</button> <button class="toolbtn" id="positionExport">导出草稿</button> <button class="toolbtn" id="positionCancel">取消调整</button>';
document.body.append(positionBar);
function positionMessage(text) { positionBar.querySelector('[role="status"]').textContent=text; }
function positionBusy(on) {
  positionSaving=on;
  positionBar.querySelectorAll('button').forEach(button=>{button.disabled=on;});
}
async function beginPositionEdit() {
  if(positionStarting || positionSaving)return;
  positionStarting=true;
  try {
    const roomCode=currentRoomCode;
    await loadLayoutState();
    if(currentRoomCode!==roomCode)throw Error('库区已切换，请重新开始');
    positionOriginal=structuredClone(layoutState);
    openingOriginal=(roomGroup?.userData.openings || []).map(op=>({op,side:op.side,offset:op.offset}));
    clearDirty();setDrag3dMode(true);
    positionMessage('拖动货架或门窗后，点击保存位置；取消可恢复');
  }catch(error){toast('无法开始位置调整：'+error.message);}
  finally{positionStarting=false;}
}
function cancelPositionEdit() {
  if(positionSaving)return;
  for(const saved of positionOriginal?.furniture || []) {
    const current=sceneFurniture.find(f=>f.code===saved.code);
    if(current){current.x=saved.x;current.z=saved.z;current.rot=saved.rot;applyTransform(current);}
  }
  for(const {op,side,offset} of openingOriginal) {
    op.side=side;op.offset=offset;placeOpening(op.obj,side,offset,roomGroup.userData.width,roomGroup.userData.depth);
  }
  drag3d=null;setDrag3dMode(false);clearDirty();layoutState=null;positionOriginal=null;openingOriginal=[];
}
function positionDraft() {
  const payload=structuredClone(layoutState);
  payload.roomId=currentRoomCode;
  const ops=roomGroup?.userData.openings || [];
  if(ops.length)for(const type of ['door','window'])payload.room[type]=ops.filter(o=>o.type===type).map(o=>({side:o.side,offset:o.offset,...(o.double?{double:true}:{}),...(o.flip?{flip:true}:{})}));
  return payload;
}
async function savePositionEdit() {
  if(positionSaving || !drag3dMode || drag3d)return;
  positionBusy(true);positionMessage('正在保存位置…');
  try {
    const payload=positionDraft();
    for(const f of payload.furniture){const error=placementError(f,payload.room,payload.furniture);if(error)throw Error(f.code+'：'+error);}
    const response=await fetch('/api/layout',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(payload)});
    if(!response.ok)throw Error((await response.json()).error || '保存失败');
    setDrag3dMode(false);clearDirty();layoutState=null;positionOriginal=null;openingOriginal=[];
    await loadScene(currentRoomCode);toast('位置已保存');
  }catch(error){positionMessage('保存失败，草稿已保留：'+error.message);}
  finally{positionBusy(false);}
}
positionBar.querySelector('#positionSave').onclick=savePositionEdit;
positionBar.querySelector('#positionCancel').onclick=cancelPositionEdit;
positionBar.querySelector('#positionExport').onclick=()=>{
  if(!layoutState || positionSaving)return;
  const payload=positionDraft();delete payload.revision;
  const url=URL.createObjectURL(new Blob([JSON.stringify(payload,null,2)],{type:'application/json'}));
  const a=document.createElement('a');a.href=url;a.download='位置调整草稿.json';a.click();
  setTimeout(()=>URL.revokeObjectURL(url),1000);
};
// 编辑期间保持库区和场景不变，防止其他工具重建场景并覆盖草稿。
document.addEventListener('click',event=>{
  if(event.target.closest('#confirmModal'))return;
  if((!drag3dMode && !positionStarting) || positionBar.contains(event.target) || event.target.closest('#drag3dBtn') || event.target===renderer.domElement)return;
  event.preventDefault();event.stopImmediatePropagation();toast('请先保存或取消3D位置调整');
},true);
document.addEventListener('keydown',event=>{
  if(positionExitPending)return; // 由退出确认框处理 Esc、Enter 与焦点操作。
  if(!drag3dMode || positionBar.contains(event.target) || event.key==='Tab')return;
  event.preventDefault();event.stopImmediatePropagation();
  if(event.key==='Escape')cancelPositionEdit();
},true);

const floorPlane = new THREE.Mesh(
  new THREE.PlaneGeometry(200, 200),
  new THREE.MeshBasicMaterial({ visible: false })
);
floorPlane.rotation.x = -Math.PI / 2;
scene.add(floorPlane);
let drag3d = null;

function setDrag3dMode(on) {
  requestSceneRender();
  drag3dMode = on;
  window.SPATIAL_POSITION_EDITING=on;positionBar.hidden=!on;
  const btn = document.getElementById('drag3dBtn');
  btn.classList.toggle('active', on);
  btn.querySelector('.lb').textContent = on ? '退出位置调整' : '3D 位置调整';
  btn.title=on?'再次点击退出；未保存的位置调整将恢复':'调整货架和门窗位置，保存后生效';
  btn.setAttribute('aria-pressed',String(on));
  renderer.domElement.style.cursor = on ? 'crosshair' : '';
  controls.enabled = !on;
  refreshShellOpacity();
  // 门/窗：进入拖拽模式时把不可见拾取代理显形，提示「这里可以拖」
  const ops = (roomGroup && Array.isArray(roomGroup.userData.openings)) ? roomGroup.userData.openings : [];
  for (const op of ops) {
    const h = op.obj && op.obj.userData && op.obj.userData.hit;
    if (!h) continue;
    h.material.visible = !!on;
    if (on) { h.material.transparent = true; h.material.opacity = 0.3; h.material.color.setHex(op.type === 'door' ? 0xd97706 : 0x38bdf8); }
  }
}
let positionExitPending=false;
document.getElementById('drag3dBtn').onclick = async () => {
  if(positionSaving || positionStarting || positionExitPending)return;
  if(!drag3dMode){beginPositionEdit();return;}
  positionExitPending=true;
  try {
    if(layoutDirty && !(await appConfirm('位置调整尚未保存，放弃修改并退出？')))return;
    cancelPositionEdit();
  } finally {positionExitPending=false;}
};

// 根据 3D 拖拽模式统一刷新货架外壳不透明度：
//   3D 拖拽时半透明高亮（方便拖拽且能看清内部）；
//   否则还原各货架自身原始不透明度（开放柜 0.06 / 封闭柜 0.16）。
function refreshShellOpacity() {
  for (const g of rackGroups) {
    const sh = g.userData.shell;
    if (!sh) continue;
    const base = (sh.userData && sh.userData.baseOpacity != null) ? sh.userData.baseOpacity : 0.16;
    const op = drag3dMode ? 0.35 : base;
    sh.material.opacity = op;
    sh.material.emissive.setHex(drag3dMode ? 0x2244aa : 0x000000);
  }
}

// 隔离模式：仅保留一个货架（isolateCode），其余整体隐藏，视线与点击都不会再被前方货架挡住。
let isolateMode = false;
let isolateCode = null;
function getRackCode(g) {
  return g.userData && g.userData.shell ? g.userData.shell.userData.code : null;
}
function applyIsolate() {
  requestSceneRender();
  for (const g of rackGroups) {
    g.visible = !isolateMode || getRackCode(g) === isolateCode;
  }
  for (const g of assetGroups) {
    g.visible = !isolateMode || g.userData.rackCode === isolateCode;
  }
}
function populateIsolateSel() {
  const sel = document.getElementById('isolateSel');
  if (!sel) return;
  setLocationOptions(sel, rackGroups.map(g => {
    const code = getRackCode(g);
    const f = (sceneFurniture || []).find(x => x.code === code);
    return {loc_code:code, name:(f?.label || '')+'（'+code+'）'};
  }));
  if (isolateCode) sel.value = isolateCode;
  sel.onchange = () => { isolateCode = sel.value; applyIsolate(); };
}
function setIsolateMode(on) {
  isolateMode = on;
  const btn = document.getElementById('isolateBtn');
  const sel = document.getElementById('isolateSel');
  btn.classList.toggle('active', on);
  btn.innerHTML = '<span class="ic">🎯</span><span class="lb">' + (on ? '单架查看中' : '单架查看') + '</span>';
  if (on) {
    // 优先使用当前选中格位所属的货架；无选中时沿用上次或取第一个
    const picked = (selected && selected.rackCode) || null;
    if (picked) {
      isolateCode = picked;
    } else if (!isolateCode || !rackGroups.some((g) => getRackCode(g) === isolateCode)) {
      isolateCode = rackGroups[0] ? getRackCode(rackGroups[0]) : null;
    }
    populateIsolateSel();
    sel.classList.remove('hidden');
  } else {
    sel.classList.add('hidden');
  }
  // 整库区 GLB 无法按货架拆分，单架查看时使用可独立显示的货架模型或示意外观。
  if (realisticMode && savedSceneSpec.assets?.[currentRoomCode]) {
    rebuildRoom(savedSceneSpec.room || savedSceneSpec.roomSize);
    buildScene(savedSceneSpec, false);
  }
  applyIsolate();
  toast(on ? ('隔离已开启：仅保留「' + (isolateCode || '') + '」，其余货架已隐藏') : '隔离已关闭，所有货架恢复显示');
}
document.getElementById('isolateBtn').onclick = () => setIsolateMode(!isolateMode);

// 格位编号开关：关闭后远景近景都不再显示编号
const cellLabelBtn = document.getElementById('cellLabelBtn');
if (cellLabelBtn) {
  cellLabelBtn.onclick = () => {
    showCellLabels = !showCellLabels;
    requestSceneRender();
    cellLabelBtn.classList.toggle('active', showCellLabels);
  };
}
// 写实 / 示意图 切换：加载客户用 Blender 构建的 GLB 模型，或回到参数化示意图
const realBtn = document.getElementById('realBtn');
function syncRealBtn() {
  if (!realBtn) return;
  // 注意用 innerHTML 保留 .tb-lbl 包裹：窄屏下靠它把文字收掉只留图标，
  // 直接写 textContent 会把 span 冲掉、窄屏压缩失效。
  realBtn.innerHTML = '<span class="ic">' + (realisticMode ? '🎨' : '📐') + '</span><span class="lb">' + (realisticMode ? '写实 ✓' : '示意图 ✓') + '</span>';
  realBtn.title = '当前：' + (realisticMode ? '写实' : '示意图') + '；点击切换到' + (realisticMode ? '示意图' : '写实');
  realBtn.setAttribute('aria-pressed', String(realisticMode));
  realBtn.classList.toggle('active', realisticMode);
}
if (realBtn) {
  realBtn.onclick = async () => {
    if (window.SPATIAL_POSITION_EDITING) { toast('请先保存或取消3D位置调整'); return; }
    realisticMode = !realisticMode;
    localStorage.setItem('spatial_realistic', realisticMode ? '1' : '0');
    syncRealBtn();
    // 只切换表现层，保留相机位置、观察中心和缩放，不重新导航或自动取景。
    rebuildRoom(savedSceneSpec.room || savedSceneSpec.roomSize);
    buildScene(savedSceneSpec, false);
    initSidebar();
    const keys = Object.keys(sceneAssets || {});
    if (realisticMode) {
      if (keys.length) {
        toast(`已切换到写实视图，共 ${keys.length} 个关联模型`);
      } else {
        toast('本库区还没有写实模型，点「🧊 模型」上传客户用 Blender 构建的 GLB');
      }
    } else {
      toast('已切换回示意图模式');
    }
  };
  syncRealBtn();
}

// 使用帮助：顶栏「? 帮助」随时可开；首次登录自动弹一次（localStorage 标记，之后不再打扰）
const helpModal = document.getElementById('helpModal');
function openHelp() { if (helpModal) helpModal.classList.remove('hidden'); }
function closeHelp() { if (helpModal) helpModal.classList.add('hidden'); }
const helpBtn = document.getElementById('helpBtn');
if (helpBtn) helpBtn.onclick = openHelp;
const helpClose = document.getElementById('helpClose');
if (helpClose) helpClose.onclick = closeHelp;
if (helpModal) helpModal.addEventListener('click', (e) => { if (e.target === helpModal) closeHelp(); });
function maybeAutoHelp() {
  try {
    if (localStorage.getItem('spatial_help_seen')) return;
    localStorage.setItem('spatial_help_seen', '1');
    openHelp();
  } catch (e) { /* 隐私模式下 localStorage 不可用，忽略 */ }
}

// 按业务路线学习；读取现有界面状态，不通过引导发起业务写入。
const guidedTour = mountGuidedTour({
  standalone: !IS_INTEGRATION,
  canOperate: () => workspaceAccess().canOperate,
  canEdit: () => workspaceAccess().canManage,
  openHelp,
  readState: () => ({
    account:JSON.parse(localStorage.getItem(USER_KEY)||'null')?.id,
    canOperate:workspaceAccess().canOperate,
    businessOpen:!!document.querySelector('.modal:not(.hidden),dialog.work-dialog[open]:not(.assistant-window)'),
    rackCount:(savedSceneSpec.furniture||[]).length, itemCount:cellRegistry.reduce((n,c)=>n+c.items.length,0),
    site:currentSiteCode, room:currentRoomCode, roomWidth:sceneRoomDims.width, roomDepth:sceneRoomDims.depth,
    roomSettingsOpen:!roomModal.classList.contains('hidden'),
    integration:IS_INTEGRATION, sceneLoaded, searchVersion:inventorySearchVersion,
    searchReady:!!document.querySelector('#searchMsg .inventory-hit, #searchMsg a[data-loc]'),
    selected:selected?.locCode, located:document.getElementById('searchMsg').textContent === `已定位：${selected?.locCode}`,
    layoutOpen:!layoutModal.classList.contains('hidden'), rack:layoutSel, layoutDirty,
    draftCount:layoutState?.furniture?.length||0,
    furnOpen:!furnModal.classList.contains('hidden'),furnType:document.getElementById('furn_type').value,
    furnName:document.getElementById('furn_name').value.trim(),
    furnWidth:Number(document.getElementById('furn_w').value),furnHeight:Number(document.getElementById('furn_h').value),furnDepth:Number(document.getElementById('furn_d').value),
    furnRows:Number(document.getElementById('furn_rows').value),furnCols:Number(document.getElementById('furn_cols').value),
    cellsOpen:!!document.querySelector('#spaceManagement:not(.hidden)')
  })
});
function startTour() { closeHelp(); guidedTour.choose(); }
workspaceNavigation=mountWorkspaceNavigation({document,window,getAccess:workspaceAccess,
  getState:()=>({account:JSON.parse(localStorage.getItem(USER_KEY)||'null')?.id,room:currentRoomCode})});
document.getElementById('tourBtn').onclick = startTour;
document.getElementById('helpTourBtn').onclick = startTour;
function maybeAutoTour() { guidedTour.offer(); }

// ================= 弹窗通用行为：Esc 关闭 + 焦点陷阱（P2-8） =================
// 所有 .modal 弹窗统一支持：Esc 关闭最上层、Tab 在弹窗内循环（键盘可达性）。
// confirmModal 自带 Esc 处理（捕获阶段已 stopPropagation + 自动聚焦），不在此列表，避免重复关闭。
const MODAL_IDS = ['modal', 'furnModal', 'furnSetModal', 'mergeModal', 'labelModal', 'roomModal',
  'layoutModal', 'photoModal', 'scanModal', 'helpModal', 'assetModal', 'impModal', 'overviewModal', 'adminModal', 'inputModal',
  // 下面这几个原先漏了 —— 按 Esc 毫无反应（只能点背景遮罩关），补上
  'transferModal', 'exportModal', 'batchModal', 'qrModal', 'histModal', 'locPickerModal'];
const FOCUSABLE_SEL = 'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';
// 取当前**视觉上最上层**的弹窗。
// ⚠️ 不能简单地返回 MODAL_IDS 里第一个可见项 —— 那个列表顺序与层级无关。
// 反例（实测过）：布局编辑器(z-index 20) + 「复制货架」弹出的输入框(z-index 100) 同时打开时，
//   旧实现返回列表里更靠前的 layoutModal，按 Esc 会把**下面**的布局编辑器关掉，输入框反而留在屏幕上。
// 正确顺序：z-index 大者优先；z-index 相同则 DOM 中靠后者优先（同层时后写的覆盖先写的）。
function topVisibleModal() {
  const all = [...document.querySelectorAll('.modal, .cellModal')];
  let best = null, bestZ = -Infinity, bestDom = -1;
  for (const id of MODAL_IDS) {
    const el = document.getElementById(id);
    if (!el || el.classList.contains('hidden')) continue;
    const raw = parseInt(getComputedStyle(el).zIndex, 10);
    const z = Number.isFinite(raw) ? raw : 0;
    const dom = all.indexOf(el);
    if (z > bestZ || (z === bestZ && dom > bestDom)) { best = el; bestZ = z; bestDom = dom; }
  }
  return best;
}
function closeModalById(id) {
  const el = document.getElementById(id);
  if (!el) return;
  switch (id) {
    case 'layoutModal': closeLayout(); break;
    case 'modal': pendingReopenAdd = false; el.classList.add('hidden'); break; // 录入弹窗 Esc 直接关，不重开
    case 'scanModal': if (typeof stopScan === 'function') stopScan(); el.classList.add('hidden'); break;
    case 'helpModal': closeHelp(); break;
    default: el.classList.add('hidden');
  }
}
document.addEventListener('keydown', (e) => {
  if (e.target.closest?.('#guideCoach, #guideChoice, #spaceManagement, .assistant-guide') || document.querySelector('dialog[open]:not(.assistant-window)')) return;
  if (e.key === 'Escape') {
    const m = topVisibleModal();
    if (m) { e.preventDefault(); closeModalById(m.id); return; } // 弹窗优先关闭
    // 无弹窗可见时，若已选中格位，Esc 取消选中（与「点空白 / 拖拽旋转」并列的键盘方式）。
    // 正在输入框（搜索 / 标签 / 名称等）打字时不拦截，避免误清选中。
    const ae = document.activeElement;
    const typing = ae && (ae.tagName === 'INPUT' || ae.tagName === 'TEXTAREA' || ae.isContentEditable);
    if (selected && !typing) { e.preventDefault(); clearCellSelection(); }
    return;
  }
  const m = topVisibleModal();
  if (!m) return; // 无弹窗时不拦截键盘
  if (e.key === 'Tab') {
    const f = [...m.querySelectorAll(FOCUSABLE_SEL)].filter((x) => x.offsetParent !== null);
    if (!f.length) { e.preventDefault(); return; }
    const first = f[0], last = f[f.length - 1];
    if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
    else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
  }
});
// 弹窗打开（移除 hidden）时自动聚焦首个可聚焦元素，增强键盘 / 无障碍体验
MODAL_IDS.forEach((id) => {
  const el = document.getElementById(id);
  if (!el) return;
  const obs = new MutationObserver(() => {
    if (!el.classList.contains('hidden')) {
      setTimeout(() => { const f = el.querySelector(FOCUSABLE_SEL); if (f) f.focus(); }, 0);
    }
  });
  obs.observe(el, { attributes: true, attributeFilter: ['class'] });
});
// 所有普通弹窗支持点击背景（遮罩）关闭；confirmModal/inputModal 由各自的 resolve 逻辑管理遮罩点击，避免 promise 无法 resolve
MODAL_IDS.forEach((id) => {
  const el = document.getElementById(id);
  if (!el || id === 'confirmModal' || id === 'inputModal') return;
  el.addEventListener('click', (e) => { if (e.target === el) closeModalById(id); });
});

// ---------- 写实模型上传 / 管理（Blender GLB，按 loc_code 关联库区/货架） ----------
const assetModal = document.getElementById('assetModal');
const assetTarget = document.getElementById('assetTarget');
const assetFile = document.getElementById('assetFile');
const assetX = document.getElementById('assetX');
const assetY = document.getElementById('assetY');
const assetZ = document.getElementById('assetZ');
const assetRot = document.getElementById('assetRot');
const assetScale = document.getElementById('assetScale');
const assetMsg = document.getElementById('assetMsg');
function fileToBase64(file) {
  return new Promise((resolve, reject) => {
    const fr = new FileReader();
    fr.onload = () => resolve(fr.result);
    fr.onerror = reject;
    fr.readAsDataURL(file);
  });
}
function loadAssetInfo() {
  document.getElementById('assetDelete').disabled=true;
  assetMsg.textContent='正在读取模型信息…';
  const locCode = assetTarget && assetTarget.value;
  if (!locCode) return;
  fetch('/api/node/' + encodeURIComponent(locCode) + '/asset').then((r) => (r.ok ? r.json() : null)).then((a) => {
    if (assetTarget.value !== locCode) return;
    if (!a) {
      assetX.value = assetY.value = assetZ.value = assetRot.value = 0;
      assetScale.value = 1;
      assetMsg.textContent = '所选对象暂无模型，上传后仅绑定到此对象。'; return;
    }
    document.getElementById('assetDelete').disabled=false;
    const t = a.transform || {};
    assetX.value = t.x || 0; assetY.value = t.y || 0; assetZ.value = t.z || 0;
    assetRot.value = Math.round((t.rotY || 0) * 180 / Math.PI);
    assetScale.value = t.scale || 1;
    assetMsg.textContent = '已绑定模型：' + decodeURIComponent((a.assetUrl || '').split('/').pop() || 'GLB 模型') + '。可重新上传覆盖或移除。';
  }).catch(() => {});
}
function openAssetModal() {
  if (!assetTarget) return;
  assetTarget.innerHTML = '';
  const roomLabel = roomSel?.selectedOptions[0]?.textContent || currentRoomCode || '未选择';
  document.getElementById('assetContext').textContent = '当前库区：' + roomLabel + '（' + (currentRoomCode || '') + '）';
  const optRoom = document.createElement('option');
  optRoom.value = currentRoomCode || ''; optRoom.textContent = '整库区外观 · ' + roomLabel + '（' + (currentRoomCode || '') + '）';
  assetTarget.appendChild(optRoom);
  // 若从布局编辑器打开，优先用布局里的家具列表（可能与 3D 场景实时同步一致）
  const furnList = (layoutState && layoutModal && !layoutModal.classList.contains('hidden')) ? layoutState.furniture : (sceneFurniture || []);
  for (const f of furnList) {
    const o = document.createElement('option');
    o.value = f.code; o.textContent = '货架 ' + f.code + (f.label ? '（' + f.label + '）' : '');
    assetTarget.appendChild(o);
  }
  assetMsg.textContent = '';
  if (assetFile) assetFile.value = '';
  loadAssetInfo();
  assetModal.classList.remove('hidden');
}
if (assetTarget) assetTarget.onchange = loadAssetInfo;
const assetBtn = document.getElementById('assetBtn');
if (assetBtn) assetBtn.onclick = openAssetModal;
const layoutAssetBtn = document.getElementById('layout_asset_btn');
if (layoutAssetBtn) layoutAssetBtn.onclick = openAssetModal;
if (document.getElementById('assetClose')) document.getElementById('assetClose').onclick = () => assetModal.classList.add('hidden');
if (document.getElementById('assetUpload')) document.getElementById('assetUpload').onclick = async () => {
  const locCode = assetTarget.value;
  const file = assetFile.files[0];
  if (!locCode) { assetMsg.textContent = '请选择关联库位'; return; }
  if (!file || !/\.glb$/i.test(file.name) || file.size>32*1024*1024) { assetMsg.textContent = '请选择不超过32MB的 .glb 文件'; return; }
  assetMsg.textContent = '上传中…';
  try {
    const dataUrl = await fileToBase64(file);
    const body = { data: dataUrl, transform: {
      x: +assetX.value || 0, y: +assetY.value || 0, z: +assetZ.value || 0,
      rotY: (+assetRot.value || 0) * Math.PI / 180, scale: +assetScale.value || 1 } };
    const res = await fetch('/api/node/' + encodeURIComponent(locCode) + '/asset', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    if (!res.ok) throw new Error((await res.json()).error || '上传失败');
    assetMsg.textContent = '✅ 已绑定到 ' + locCode + '。关闭窗口后切换「写实」查看，当前库区不变。';
    syncRealBtn();
    invalidateAssetCache(); // 模型已更新，清除旧缓存避免重建场景时仍用旧 GLB
    if (realisticMode) loadScene();
  } catch (e) { assetMsg.textContent = '❌ ' + e.message; }
};
if (document.getElementById('assetDelete')) document.getElementById('assetDelete').onclick = async () => {
  const locCode = assetTarget.value;
  if (!locCode) return;
  if (!(await appConfirm('确定移除该库位的写实模型？', { danger: true }))) return;
  try {
    const res = await fetch('/api/node/' + encodeURIComponent(locCode) + '/asset', { method: 'DELETE' });
    if (!res.ok) throw new Error((await res.json()).error || '删除失败');
    assetMsg.textContent = '已移除';
    if (realisticMode) loadScene();
  } catch (e) { assetMsg.textContent = '❌ ' + e.message; }
};

renderer.domElement.addEventListener('pointerdown', (e) => {
  if (!drag3dMode || positionSaving) return;
  e.stopPropagation(); // 阻止冒泡到格位拾取
  const rect = renderer.domElement.getBoundingClientRect();
  const ndc = new THREE.Vector2(((e.clientX - rect.left) / rect.width) * 2 - 1, -((e.clientY - rect.top) / rect.height) * 2 + 1);
  raycaster.setFromCamera(ndc, camera);
  // 只命中货架的不可见 hitBox 代理，不会误触半透明格位/物品，避免「点空白也拖动货架」
  const hitBoxes = rackGroups.map((g) => g.userData.hitBox).filter(Boolean);
  const hits = raycaster.intersectObjects(hitBoxes);
  if (hits.length) {
    const code = hits[0].object.userData.code;
    const fs = findFurnData(code);
    if (!fs) return;
    drag3d = { kind: 'furniture', code, fs, dirty: false, startX: fs.x, startZ: fs.z };
    renderer.domElement.setPointerCapture(e.pointerId);
    e.preventDefault();
    return;
  }
  // 门/窗开口：命中其拾取代理即可拖到任意墙面、沿墙任意位置
  const ops = (roomGroup && Array.isArray(roomGroup.userData.openings)) ? roomGroup.userData.openings : [];
  const proxies = ops.map((o) => o.obj && o.obj.userData.hit).filter(Boolean);
  if (proxies.length) {
    const oh = raycaster.intersectObjects(proxies);
    if (oh.length) {
      const op = ops.find((o) => o.obj && o.obj.userData.hit === oh[0].object);
      if (op) {
        drag3d = { kind: 'opening', op, dirty: false, start: { side: op.side, offset: op.offset } };
        renderer.domElement.setPointerCapture(e.pointerId);
        e.preventDefault();
      }
    }
  }
});
renderer.domElement.addEventListener('pointercancel', () => { if(drag3d)rollbackPositionDrag(drag3d);drag3d=null; });

// 拖动门/窗：吸附到指针最近的墙，并沿墙定位（钳制保证开口完整落在墙上）
function dragOpeningTo(p) {
  requestSceneRender();
  const W = (roomGroup && roomGroup.userData.width) || 4;
  const D = (roomGroup && roomGroup.userData.depth) || 3;
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
  if (!drag3dMode || !drag3d || positionSaving) return;
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
  const W = (roomGroup && roomGroup.userData.width) || (layoutState && layoutState.room.width) || 4;
  const D = (roomGroup && roomGroup.userData.depth) || (layoutState && layoutState.room.depth) || 3;
  const {x:hw,z:hd} = halfExtents(drag3d.fs);
  nx = Math.max(-W / 2 + hw, Math.min(W / 2 - hw, nx));
  nz = Math.max(-D / 2 + hd, Math.min(D / 2 - hd, nz));
  drag3d.fs.x = nx; drag3d.fs.z = nz;
  applyTransform(drag3d.fs);
  // 同步到布局编辑器状态（如果已打开）
  if (layoutState) {
    const lf = layoutState.furniture.find((x) => x.code === drag3d.code);
    if (lf) { lf.x = nx; lf.z = nz; updateFurnEl(lf); }
  }
  drag3d.dirty = true;
});
function rollbackPositionDrag(d) {
  requestSceneRender();
  if(d.kind==='opening') {
    d.op.side=d.start.side;d.op.offset=d.start.offset;
    placeOpening(d.op.obj,d.start.side,d.start.offset,roomGroup.userData.width,roomGroup.userData.depth);
  }else {
    d.fs.x=d.startX;d.fs.z=d.startZ;applyTransform(d.fs);
    const draft=layoutState?.furniture.find(f=>f.code===d.code);
    if(draft){draft.x=d.startX;draft.z=d.startZ;}
  }
}
renderer.domElement.addEventListener('pointerup', e => {
  if(!drag3d)return;
  const d=drag3d;drag3d=null;
  renderer.domElement.releasePointerCapture(e.pointerId);
  if(!d.dirty)return;
  if(d.kind!=='opening') {
    const problem=placementError(d.fs,sceneRoomDims,sceneFurniture);
    if(problem){rollbackPositionDrag(d);positionMessage(problem+'，已恢复拖动前位置');return;}
  }
  markDirty();positionMessage('位置已调整，尚未保存');
});
// 轻量 toast 提示
function toast(text) {
  let t = document.getElementById('__toast');
  if (!t) { t = document.createElement('div'); t.id = '__toast'; t.style.cssText = 'position:fixed;left:50%;bottom:28px;transform:translateX(-50%);background:#1e293b;color:#f1f5f9;padding:10px 16px;border-radius:8px;font-size:13px;z-index:9999;box-shadow:0 4px 12px rgba(0,0,0,.4)'; document.body.appendChild(t); }
  t.textContent = text; t.style.opacity = '1';
  clearTimeout(t._timer); t._timer = setTimeout(() => { t.style.transition = 'opacity .4s'; t.style.opacity = '0'; }, 2600);
}

// 通用输入弹窗（替换原生 window.prompt）：支持多字段，返回字段对象或 null（取消）
function askInputs(title, fields) {
  return new Promise((resolve) => {
    const modal = document.getElementById('inputModal');
    if (!modal) return resolve(null);
    document.getElementById('inputTitle').textContent = title;
    const box = document.getElementById('inputFields');
    box.innerHTML = '';
    const inputs = {};
    fields.forEach((f) => {
      const lab = document.createElement('label');
      lab.textContent = f.label + (f.required ? ' *' : '');
      const inp = document.createElement('input');
      inp.type = f.type || 'text';
      inp.placeholder = f.placeholder || '';
      inp.value = f.default != null ? f.default : '';
      lab.appendChild(inp);
      box.appendChild(lab);
      inputs[f.key] = inp;
    });
    const done = (val) => { modal.onclick = null; modal.classList.add('hidden'); resolve(val); };
    document.getElementById('inputOk').onclick = () => {
      const out = {};
      for (const f of fields) {
        const v = inputs[f.key].value.trim();
        if (f.required && !v) { toast((f.label || '该项') + '不能为空'); return; }
        out[f.key] = v;
      }
      done(out);
    };
    document.getElementById('inputCancel').onclick = () => done(null);
    modal.onclick = (e) => { if (e.target === modal) done(null); };
    modal.classList.remove('hidden');
    setTimeout(() => { const first = inputs[fields[0].key]; if (first) first.focus(); }, 0);
  });
}

// 应用内确认弹窗（替换原生 confirm/alert）：Esc 或点遮罩取消，返回 Promise<boolean>
function appConfirm(message, opts = {}) {
  return new Promise((resolve) => {
    const modal = document.getElementById('confirmModal');
    document.getElementById('confirmTitle').textContent = opts.title || '请确认';
    document.getElementById('confirmMsg').textContent = message;
    const ok = document.getElementById('confirmOk');
    ok.textContent = opts.okText || '确定';
    ok.className = opts.danger ? 'btn-danger' : 'btn-primary';
    let settled=false;
    const close = (val) => {
      if(settled)return;settled=true;
      modal.classList.add('hidden');
      if(modal.open)modal.close();
      document.removeEventListener('keydown', onKey, true);
      modal.removeEventListener('cancel', onCancel);
      window.removeEventListener('spatial-auth-required', onAccessLost);
      modal.onclick = null;
      resolve(val);
    };
    const onKey = (e) => { if (e.key === 'Escape') { e.preventDefault();e.stopPropagation();close(false); } };
    const onCancel=e=>{e.preventDefault();close(false);};
    const onAccessLost=()=>close(false);
    ok.onclick = () => close(true);
    document.getElementById('confirmCancel').onclick = () => close(false);
    modal.onclick = (e) => { if (e.target === modal) close(false); };
    document.addEventListener('keydown', onKey, true);
    modal.addEventListener('cancel', onCancel);
    window.addEventListener('spatial-auth-required', onAccessLost);
    modal.classList.remove('hidden');
    modal.showModal();
    ok.focus();
  });
}

// ---- 渲染循环 ----
const clock = new THREE.Clock();
document.addEventListener('visibilitychange', requestSceneRender);
function animate() {
  requestAnimationFrame(animate);
  const dt = clock.getDelta();
  if (document.hidden) return;
  const flying = !!tween;
  if (tween) {
    tween.t = Math.min(1, tween.t + dt / tween.dur);
    const e = easeInOut(tween.t);
    camera.position.lerpVectors(tween.fromPos, tween.toPos, e);
    controls.target.lerpVectors(tween.fromTarget, tween.toTarget, e);
    if (tween.t >= 1) tween = null;
  }
  const cameraChanged = controls.update();
  // 保留阻尼和飞行动画的每一帧；静止时不遍历格位、不向GPU重复提交场景。
  if (!sceneRenderDirty && !cameraChanged && !flying) return;
  sceneRenderDirty = false;
  updateCellLabels();
  renderer.render(scene, camera);
}
animate();

// ---- 登录交互绑定 ----
document.getElementById('loginBtn').onclick = () =>
  doLogin(document.getElementById('loginUser').value.trim(), document.getElementById('loginPass').value);
document.getElementById('bootstrapBtn').onclick = doBootstrap;
['loginUser', 'loginPass'].forEach((id) => {
  document.getElementById(id).addEventListener('keydown', (e) => {
    if (e.key !== 'Enter') return;
    if (document.getElementById('loginBootstrap').style.display === 'block') doBootstrap();
    else doLogin(document.getElementById('loginUser').value.trim(), document.getElementById('loginPass').value);
  });
});
// 以前是单击立即登出 —— 用户想点名字看看信息就掉线了；布局编辑器有未保存改动时更会直接丢。
// 改成先确认，并把"有未保存改动"这件事说清楚。
document.getElementById('userChip').onclick = async () => {
  const title = IS_SUPOS ? '返回平台' : '退出登录';
  let msg = IS_SUPOS
    ? '返回平台首页？账号会保持登录，如需退出账号，请在平台操作。'
    : '确定退出登录？';
  if (layoutDirty) msg += '布局编辑器里有未保存的改动，离开后会丢失。';
  if (!(await appConfirm(msg, { title, okText: IS_SUPOS ? '返回平台' : '退出', danger: layoutDirty }))) return;
  doLogout();
};

// ---- 系统管理面板（仅管理员可见：服务凭证 + ERP 编码映射） ----
function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }
let adminReady = false;
function initAdminPanel() {
  if (adminReady) return; adminReady = true;
  const modal = document.getElementById('adminModal');
  if (!modal) return;
  const close = () => modal.classList.add('hidden');
  const modelSettings=createAssistantSettingsUI(document.getElementById('assistantModelSettings'));
  document.getElementById('adminBtn').onclick = () => { modal.classList.remove('hidden'); loadSvcList(); };
  document.getElementById('adminClose').onclick = close;
  document.getElementById('adminClose2').onclick = close;
  document.getElementById('itemCodesBtn').onclick=()=>openItemCodes({onChanged:()=>window.SPATIAL_REFRESH_VIEW()}).catch(error=>toast(error.message,false));
  modal.querySelectorAll('.tab').forEach((t) => t.onclick = () => {
    modal.querySelectorAll('.tab').forEach((x) => x.classList.remove('active'));
    t.classList.add('active');
    const pane = t.dataset.tab;
    modal.querySelectorAll('.tabpane').forEach((p) => p.classList.toggle('hidden', p.dataset.pane !== pane));
    if (pane === 'users') loadUserList();
    if (pane === 'io') loadIoLog();
    if (pane === 'model') modelSettings.refresh();
  });
  document.getElementById('ioRefresh').onclick = () => loadIoLog(true);
  document.getElementById('ioMore').onclick = () => loadIoLog(false);
  document.getElementById('ioType').onchange = () => loadIoLog(true);
  document.getElementById('ioActor').addEventListener('keydown', (e) => { if (e.key === 'Enter') loadIoLog(true); });
  // 创建服务凭证
  document.getElementById('svcCreate').onclick = async () => {
    const name = document.getElementById('svcName').value.trim();
    const scopes = [];
    if (document.getElementById('svcScopeErp').checked) scopes.push('erp:sync');
    if (document.getElementById('svcScopeSupos').checked) scopes.push('supos:device');
    if (!name) { toast('请填写凭证名称'); return; }
    try {
      const res = await fetch('/api/admin/service-token', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name, scopes }) });
      const d = await res.json();
      if (!res.ok) { toast(d.error || '创建失败'); return; }
      const box = document.getElementById('svcTokenBox');
      document.getElementById('svcTokenText').textContent = d.token;
      box.classList.remove('hidden');
      loadSvcList();
    } catch (e) { toast('网络错误：' + e.message); }
  };
  document.getElementById('svcCopy').onclick = () => {
    const txt = document.getElementById('svcTokenText').textContent;
    if (navigator.clipboard) navigator.clipboard.writeText(txt).then(() => {
      const b = document.getElementById('svcCopy'); b.textContent = '已复制'; setTimeout(() => (b.textContent = '复制'), 1500);
    });
  };
  // ERP 编码批量导入
  document.getElementById('mapImport').onclick = async () => {
    const val = document.getElementById('mapInput').value.trim();
    const out = document.getElementById('mapResult');
    if (!val) { out.textContent = '请先粘贴对照数据'; return; }
    let payload;
    if (val.startsWith('[')) {
      try { payload = { rows: JSON.parse(val) }; } catch (e) { out.textContent = 'JSON 解析失败：' + e.message; return; }
    } else payload = { csv: val };
    try {
      const res = await fetch('/api/admin/erp-mapping-import', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
      const d = await res.json();
      if (!res.ok) { out.textContent = '失败：' + (d.error || res.status); return; }
      const errs = d.errors && d.errors.length ? `，失败 ${d.errors.length} 条（详见控制台）` : '';
      out.textContent = `完成：新增 ${d.created} / 更新 ${d.updated} / 共 ${d.total}${errs}`;
      if (d.errors && d.errors.length) console.warn('ERP 映射导入失败行：', d.errors);
    } catch (e) { out.textContent = '网络错误：' + e.message; }
  };
  // 新建子账号
  const uCreate = document.getElementById('uCreate');
  if (uCreate) uCreate.onclick = async () => {
    const username = document.getElementById('uUser').value.trim();
    const name = document.getElementById('uName').value.trim();
    const pw = document.getElementById('uPw').value;
    const role = document.getElementById('uRole').value;
    if (!username) { toast('请填写用户名'); return; }
    if (String(pw).length < 8) { toast('初始密码至少 8 位'); return; }
    try {
      const r = await fetch('/api/users', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username, name: name || username, password: pw, role }) });
      const d = await r.json().catch(() => ({}));
      if (!r.ok) { toast(d.error || '创建失败'); return; }
      toast('子账号已创建：' + username);
      document.getElementById('uUser').value = ''; document.getElementById('uName').value = ''; document.getElementById('uPw').value = '';
      loadUserList();
    } catch (e) { toast('网络错误：' + e.message); }
  };
}
const ROLE_LABEL = { admin: '管理员', operator: '操作员', viewer: '只读' };
async function loadUserList() {
  const box = document.getElementById('userList');
  if (!box) return;
  try {
    const res = await fetch('/api/users');
    if (!res.ok) { const d = await res.json().catch(() => ({})); box.innerHTML = `<p style="color:#f87171">加载失败：${esc(d.error || res.status)}</p>`; return; }
    const list = await res.json();
    if (!Array.isArray(list) || !list.length) { box.innerHTML = '<p style="color:var(--muted);font-size:13px">暂无其他账号。</p>'; return; }
    const meId = (JSON.parse(localStorage.getItem(USER_KEY) || '{}').id) || '';
    box.innerHTML = '<table><thead><tr><th>用户名</th><th>姓名</th><th>角色</th><th>状态</th><th>最近登录</th><th>操作</th></tr></thead><tbody>'
      + list.map((u) => {
        const self = u.id === meId;
        const roleOpts = ['admin', 'operator', 'viewer'].map((r) => `<option value="${r}" ${u.role === r ? 'selected' : ''}>${ROLE_LABEL[r]}</option>`).join('');
        const statusBtn = u.status === 'active'
          ? `<button class="sm-btn ${self ? '' : 'warn'}" data-disable="${esc(u.id)}" ${self ? 'disabled title="不能禁用自己"' : ''}>禁用</button>`
          : `<button class="sm-btn" data-enable="${esc(u.id)}">启用</button>`;
        return `<tr>
          <td><code>${esc(u.username)}</code>${self ? ' <span style="color:var(--muted);font-size:11px">（我）</span>' : ''}</td>
          <td>${esc(u.name || '')}</td>
          <td><select data-role="${esc(u.id)}" ${self ? 'disabled' : ''} style="padding:4px 6px;border-radius:6px;border:1px solid var(--border);background:var(--surface);color:var(--text)">${roleOpts}</select></td>
          <td>${u.status === 'active' ? '<span style="color:var(--success)">正常</span>' : '<span style="color:var(--muted)">已禁用</span>'}</td>
          <td style="font-size:12px;color:var(--muted)">${esc((u.last_login_at || '').replace('T', ' ')) || '—'}</td>
          <td style="display:flex;gap:6px;flex-wrap:wrap">
            ${statusBtn}
            <button class="sm-btn" data-pw="${esc(u.id)}">重置密码</button>
          </td></tr>`;
      }).join('')
      + '</tbody></table>';
    box.querySelectorAll('[data-role]').forEach((s) => s.onchange = async () => {
      const id = s.dataset.role, role = s.value, uname = s.closest('tr').querySelector('code').textContent;
      if (!(await appConfirm(`将 ${esc(uname)} 的角色改为「${ROLE_LABEL[role]}」？`))) { loadUserList(); return; }
      try {
        const r = await fetch('/api/users/' + id, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ role }) });
        const d = await r.json().catch(() => ({})); if (!r.ok) { toast(d.error || '失败'); loadUserList(); return; } toast('角色已更新');
      } catch (e) { toast('网络错误：' + e.message); }
    });
    box.querySelectorAll('[data-disable]').forEach((b) => b.onclick = async () => {
      if (!(await appConfirm('禁用后该账号将无法登录。确定？', { danger: true }))) return;
      try {
        const r = await fetch('/api/users/' + b.dataset.disable, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ status: 'disabled' }) });
        const d = await r.json().catch(() => ({})); if (!r.ok) { toast(d.error || '失败'); return; } toast('已禁用'); loadUserList();
      } catch (e) { toast('网络错误：' + e.message); }
    });
    box.querySelectorAll('[data-enable]').forEach((b) => b.onclick = async () => {
      try {
        const r = await fetch('/api/users/' + b.dataset.enable, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ status: 'active' }) });
        const d = await r.json().catch(() => ({})); if (!r.ok) { toast(d.error || '失败'); return; } toast('已启用'); loadUserList();
      } catch (e) { toast('网络错误：' + e.message); }
    });
    box.querySelectorAll('[data-pw]').forEach((b) => b.onclick = async () => {
      const np = await askInputs('重置密码', [{ key: 'pw', label: '新密码（≥8 位）', type: 'password' }]);
      if (!np) return;
      if (String(np.pw).length < 8) { toast('密码至少 8 位'); return; }
      try {
        const r = await fetch('/api/users/' + b.dataset.pw, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ password: np.pw }) });
        const d = await r.json().catch(() => ({})); if (!r.ok) { toast(d.error || '失败'); return; } toast('密码已重置');
      } catch (e) { toast('网络错误：' + e.message); }
    });
  } catch (e) { box.innerHTML = '<p style="color:#f87171">加载失败：' + esc(e.message) + '</p>'; }
}
// ---- 出入库记录（管理员审计流水，GET /api/v1/audit） ----
const IO_TYPE_LABEL = { opening:'期初建账',stocktake:'盘点调账',inbound: '入库', outbound: '出库', move: '移库', merge: '合并', relocate: '重定位', erp_sync: 'ERP同步' };
let ioOffset = 0;
function ioTypeTag(t) {
  const cls = ['inbound', 'outbound', 'move', 'merge', 'relocate', 'erp_sync'].includes(t) ? t : 'other';
  return `<span class="io-tag ${cls}">${esc(IO_TYPE_LABEL[t] || t || '其他')}</span>`;
}
async function loadIoLog(reset = false) {
  const body = document.getElementById('ioBody');
  const msg = document.getElementById('ioMsg');
  const more = document.getElementById('ioMore');
  if (!body) return;
  if (reset) ioOffset = 0;
  const type = document.getElementById('ioType').value;
  const actor = document.getElementById('ioActor').value.trim();
  const params = new URLSearchParams({ limit: '50', offset: String(ioOffset) });
  if (type) params.set('move_type', type);
  if (actor) params.set('actor', actor);
  msg.textContent = '加载中…';
  try {
    const res = await fetch('/api/v1/audit?' + params.toString());
    if (!res.ok) { const d = await res.json().catch(() => ({})); body.innerHTML = `<tr><td colspan="7" style="text-align:center;color:#f87171;padding:14px">加载失败：${esc(d.error || res.status)}</td></tr>`; more.classList.add('hidden'); msg.textContent = ''; return; }
    const rows = await res.json();
    if (!ioOffset) body.innerHTML = '';
    if (!rows.length) {
      if (!ioOffset) body.innerHTML = '<tr><td colspan="7" style="text-align:center;color:var(--muted);padding:14px">暂无记录</td></tr>';
      msg.textContent = ioOffset ? '已到末尾' : '暂无记录';
      more.classList.add('hidden');
      return;
    }
    const html = rows.map((m) => {
      let loc;
      if (m.from_loc && m.to_loc) loc = esc(m.from_loc) + ' → ' + esc(m.to_loc);
      else if (m.to_loc) loc = '入库 → ' + esc(m.to_loc);
      else if (m.from_loc) loc = esc(m.from_loc) + ' → 出库/外部';
      else loc = '—';
      const synced = m.synced_at ? '<span style="color:var(--success)">已同步</span>' : '<span style="color:var(--muted)">未同步</span>';
      const t = formatBusinessTime(m.occurred_at);
      return `<tr>
        <td style="font-size:12px">${esc(t)}</td>
        <td>${ioTypeTag(m.move_type)}</td>
        <td>${esc(m.item_name || '(未知货品)')}</td>
        <td>${esc(String(m.qty))}</td>
        <td style="font-size:12px">${loc}</td>
        <td>${esc(m.actor_name || '—')}</td>
        <td style="font-size:12px">${synced}</td>
      </tr>`;
    }).join('');
    body.insertAdjacentHTML('beforeend', html);
    ioOffset += rows.length;
    more.classList.toggle('hidden', rows.length < 50);
    msg.textContent = `已加载 ${ioOffset} 条`;
  } catch (e) {
    body.innerHTML = `<tr><td colspan="7" style="text-align:center;color:#f87171;padding:14px">网络错误：${esc(e.message)}</td></tr>`;
    more.classList.add('hidden'); msg.textContent = '';
  }
}
async function loadSvcList() {
  const box = document.getElementById('svcList');
  try {
    const res = await fetch('/api/admin/service-tokens');
    const list = await res.json();
    if (!Array.isArray(list) || !list.length) { box.innerHTML = '<p style="color:var(--muted);font-size:13px">暂无服务凭证。</p>'; return; }
    box.innerHTML = '<table><thead><tr><th>名称</th><th>前缀</th><th>作用域</th><th>创建时间</th><th>状态</th><th></th></tr></thead><tbody>'
      + list.map((t) => `<tr><td>${esc(t.name)}</td><td><code>${esc(t.token_prefix)}…</code></td><td>${(t.scopes || []).join(', ')}</td><td>${esc((t.created_at || '').replace('T', ' '))}</td><td class="${t.revoked ? 'revoked' : ''}">${t.revoked ? '已吊销' : '有效'}</td><td><button class="sm-btn danger" data-revoke="${esc(t.id)}">吊销</button></td></tr>`).join('')
      + '</tbody></table>';
    box.querySelectorAll('[data-revoke]').forEach((b) => b.onclick = async () => {
      if (!(await appConfirm('确定吊销该服务凭证？吊销后对应 ERP/设备网关将立即失去访问权限。', { danger: true }))) return;
      try { await fetch('/api/admin/service-token/' + b.dataset.revoke, { method: 'DELETE' }); loadSvcList(); }
      catch (e) { toast('吊销失败：' + e.message); }
    });
  } catch (e) { box.innerHTML = '<p style="color:#f87171">加载失败：' + esc(e.message) + '</p>'; }
}

// 启动：有 token 直接进；没有则弹登录（bootstrap 面板由 status 接口决定）
(async () => {
  renderUserChip();
  initAdminPanel();
  const t = apiGetToken();
  if (!t && !IS_SUPOS) { showLogin(''); return; }
  const r = await _rawFetch('/api/auth/me', { headers: { Authorization: 'Bearer ' + t } });
  if (!r.ok) { showLogin(''); return; }
  const d = await r.json();
  localStorage.setItem(USER_KEY, JSON.stringify(d.user));
  hideLogin();
  renderUserChip();
  // 完成身份校验后才加载业务数据，避免登录页产生权限和定位失败的旧提示。
  await refreshSites()
  .then(async () => {
    await refreshRooms(); await loadFirstRoomOfSite();
    maybeAutoTour();
    if(IS_INTEGRATION) hostBridge=createHostBridge({window,allowedOrigins:window.SPATIAL_RUNTIME?.hostOrigins || [],locate:locateTarget,onConnectionChange:updateBusinessLinks});
    await locateInitialTarget();
  })
  .catch(e=>toast(e.message))
  .finally(hideBoot); // 流程结束（成功或失败）都撤掉首屏遮罩
})().catch(e=>{hideBoot();showLogin('暂时无法连接仓库服务，请稍后重试。');});
window.addEventListener('resize', onResize);
// 登录完成、侧栏与内置浏览器面板变化均可能只改变容器尺寸，不触发 window.resize。
const sceneSizeObserver = new ResizeObserver(onResize);
sceneSizeObserver.observe(container);

// 状态栏刷新保留当前库区、镜头和选中库位，避免整页重载丢失上下文。
window.SPATIAL_REFRESH_VIEW = async () => {
  if (window.SPATIAL_POSITION_EDITING || layoutDirty || layoutSaving || !layoutModal.classList.contains('hidden')) throw new Error('请先保存或关闭布局编辑器，再刷新库存');
  const loc=selected?.locCode;
  const position=camera.position.clone(), target=controls.target.clone();
  if (await loadScene(currentRoomCode, true) === false) return false;
  camera.position.copy(position);controls.target.copy(target);controls.update();
  if(loc){const entry=cellRegistry.find(c=>c.locCode===loc);if(entry)selectCell(entry);}
  await inventoryFilterUI?.refreshOptions();
  const query=document.getElementById('searchInput').value;
  if(query.trim() || [...document.querySelectorAll('#inventoryFilters input')].some(input=>input.value.trim())) await doSearch(query);
};

async function refreshLiveInventory(){
  const room=currentRoomCode,version=sceneBuildVersion;
  const next=await readNavigationJSON('/api/scene?room='+encodeURIComponent(room));
  if(room!==currentRoomCode||version!==sceneBuildVersion)return;
  if(liveInventoryBusy())throw Error('正在操作，稍后同步');
  const delta=inventoryDelta(savedSceneSpec,next);
  if(delta.rebuild){await window.SPATIAL_REFRESH_VIEW();return;}
  const loc=selected?.locCode;
  if(hoverCell && delta.changed.includes(hoverCell.rackCode))setHoverCell(null);
  for(const code of delta.changed){
    const f=next.furniture.find(f=>f.code===code),old=furnByCode[code];
    const hiddenShell=old && [...old.children].some(o=>o.visible===false);
    scene.remove(old);disposeGroup(old,true);
    cellRegistry=cellRegistry.filter(c=>c.rackCode!==code);
    const group=createFurniture({...f,...(IS_INTEGRATION?{inventoryVisualLimit:8,lazyCellLabels:true,batchInventory:true,batchCellSurfaces:true}:{})},cellRegistry);
    rackGroups[rackGroups.indexOf(old)]=group;furnByCode[code]=group;scene.add(group);
    if(realisticMode && (hiddenShell || assetGroups.some(g=>g.userData.rackCode===code) || roomGroup?.visible===false))hideShellKeepCells(group,code);
    group.visible=!isolateMode||isolateCode===code;
  }
  savedSceneSpec=next;
  window.dispatchEvent(new Event('spatial-inventory-refreshed'));
  if(delta.changed.length){
    if(loc){const entry=cellRegistry.find(c=>c.locCode===loc);if(entry)selectCell(entry);else clearCellSelection();}
    else initSidebar();
    const query=document.getElementById('searchInput').value;
    if(query.trim())await doSearch(query);
    requestSceneRender();
  }
}
const liveStatus=document.createElement('span');liveStatus.setAttribute('role','status');
liveStatus.style.cssText='font-size:12px;color:#a7c7e7;margin-left:8px';
const liveStatusHost=document.querySelector('#syncStatusBar .sync-status-row')||document.getElementById('topbar');liveStatusHost?.append(liveStatus);
function liveInventoryBusy(){
  const active=document.activeElement;
  const editingField=['INPUT','TEXTAREA','SELECT'].includes(active?.tagName)&&!['searchInput','searchScope'].includes(active?.id)&&!active?.closest('.assistant-window');
  const dirtySidebar=[...document.querySelectorAll('#sidebar input,#sidebar textarea,#sidebar select')].some(field=>field.tagName==='SELECT'
    ? [...field.options].some(option=>option.selected!==option.defaultSelected)
    : field.value!==field.defaultValue);
  return window.SPATIAL_POSITION_EDITING||layoutDirty||layoutSaving||!!document.querySelector('dialog[open]:not(.assistant-window),.modal:not(.hidden),.cellModal:not(.hidden)')||editingField||dirtySidebar;
}
mountLiveInventory({
  getRoom:()=>sceneLoaded?currentRoomCode:'',refresh:refreshLiveInventory,
  onAccessLost:()=>{window.SPATIAL_ACCESS=null;document.documentElement.classList.remove('stock-operator','space-editor');window.dispatchEvent(new Event('spatial-access-change'));},
  isBusy:liveInventoryBusy,
  status:message=>{liveStatus.textContent=inventorySyncMessage(message,savedSceneSpec?.sync);}
});
