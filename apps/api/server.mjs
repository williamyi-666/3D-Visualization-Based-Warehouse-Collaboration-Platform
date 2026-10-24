import {startWarehouseUns} from './warehouse-uns.mjs';
import {mountLiveScene} from './live-scene.mjs';
import {startDispatchLoop} from '../../packages/integration/scheduler.mjs';
import {createWarehouseAccess} from './warehouse-access.mjs';
import {createStocktakes} from './stocktake.mjs';
import {mountWarehouseWork} from './warehouse-work-routes.mjs';
import {createAssistantTools} from './assistant-tools.mjs';
import {createLocalAssistantModel} from './assistant-model.mjs';
import {createAssistantSettings,mountAssistantSettings} from './assistant-settings.mjs';
import {mountKnowledge} from './knowledge.mjs';
import {mountAssistant} from './assistant-routes.mjs';
import {createAssistantJobs} from './assistant-jobs.mjs';
import {mountAssistantJobs} from './assistant-job-routes.mjs';
import {mountWorkStatus} from './work-status.mjs';
import {createTeamTasks,mountTeamTasks} from './team-tasks.mjs';
import {createItemStorage,mountItemStorage} from './item-storage.mjs';
import {createLocalMedia,mountAssistantMedia} from './assistant-media.mjs';
import * as sqliteDb from './db.mjs';
import {mountErpStocktakes} from './erp-stocktake-routes.mjs';
import { randomUUID } from 'node:crypto';
import {createBackupMonitor} from './backup-status.mjs';
import { searchInventory, inventoryFacets } from './inventory-query.mjs';
// apps/api/server.mjs
// 轻量后端：静态托管前端 + 物品录入/检索/集成 API。
// 录入不依赖多模态 AI：位置靠扫码/下拉选择，物品信息人工填写，照片以 base64 存入数据库。
// 数据层经 db/index.mjs 选择 SQLite（默认，零守护进程）或 PostgreSQL（DB_DRIVER=pg）。
import express from 'express';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import * as db from './db/index.mjs';
import { recognize, getProviderName } from '../../packages/ai/recognizer.mjs';
import { init as initIntegration, dispatchOnce, integrationStatus, importLayout, importLayoutPhoto } from '../../packages/integration/index.mjs';
import { attachUser, mountAuth, requireAuth, requireRole } from './auth.mjs';
import { existsSync, mkdirSync, writeFileSync, unlinkSync, readFileSync } from 'node:fs';
import https from 'node:https';
import os from 'node:os';
import { platformEnabled, integrationMode, inventoryMode, basePath } from './platform.mjs';
import { createInventoryView } from './inventory-view.mjs';
import sqlite, {resolveImportLoc} from './db.mjs';
import { isSpaceWrite, createSpacePolicy } from './space-policy.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..', '..'); // spatial-inventory/
const PORT = process.env.PORT || 3000;
const DATA_DIR = process.env.SPATIAL_DATA_DIR || join(ROOT, 'data');
const UPLOAD_DIR = process.env.SPATIAL_UPLOAD_DIR || join(ROOT, 'uploads');
if (integrationMode && process.env.DB_DRIVER === 'pg') throw new Error('集成快照首版仅支持 SQLite');
const inventoryView = integrationMode ? createInventoryView(sqlite,{ getUsableCells:()=>new Set(db.getCells().map(c=>c.loc_code)) }) : null;
const warehouseAccess=process.env.DB_DRIVER!=='pg'?createWarehouseAccess(sqlite,{standalone:!integrationMode,localUsers:!platformEnabled,resolveImportLoc}):null;
const visibleInventory=req=>inventoryView.list().filter(row=>!req.canAccessLocation||req.canAccessLocation(row.loc_code || row.warehouse_code));
const checkSpaceWrite = inventoryView ? createSpacePolicy(sqlite,inventoryView) : null;

let warehouseUnsState={state:'disabled'};
const backupMonitor=createBackupMonitor(DATA_DIR,UPLOAD_DIR,{keep:Number(process.env.BACKUP_KEEP || 28),intervalMs:Number(process.env.BACKUP_INTERVAL_MS || 21600000)});
const app = express();
// 路由大小写与鉴权路径判断保持一致，避免 /API 绕过 /api 门禁。
app.set('case sensitive routing', true);
app.get('/runtime.js', (_req, res) => res.type('js').send(`window.SPATIAL_RUNTIME=${JSON.stringify({ basePath, provider: platformEnabled ? 'supos' : 'local', mode: inventoryMode, hostOrigins: [process.env.SPATIAL_PUBLIC_ORIGIN, ...(process.env.SPATIAL_HOST_ORIGINS || '').split(',')].filter(Boolean) })};`));
app.use(express.json({ limit: '50mb' })); // 接收含 base64 照片 / 写实模型(GLB) 的 JSON

// 开发态：JS/HTML/CSS 等前端资源禁止缓存，保证改完刷新即生效（ES 模块默认会被浏览器缓存，
// 否则会出现「改了 spaceGenerator.js 但页面仍是旧逻辑、合并后 3D 不更新」这类问题）。
app.use((req, res, next) => {
  if (/\.(js|mjs|html|css|map)$/i.test(req.path)) res.set('Cache-Control', 'no-store');
  next();
});

// ---- 企业级 P0：登录 / 会话 / 权限 / 操作人审计 ----
// 注意顺序：attachUser 必须先挂载，否则 mountAuth 注册的 /api/auth/me、/api/users 等
// 会先于该中间件命中路由，导致 req.user 恒为空而误报 401。
app.use(attachUser);
if(warehouseAccess)app.use(warehouseAccess.identityMiddleware);            // 解析 token → req.user，并把操作人写入 AsyncLocalStorage（数据层写流水时自动带上）
mountAuth(app); // 注册公开端点和平台身份查询
if(warehouseAccess)app.use(warehouseAccess.middleware);
app.use((req, res, next) => {
  if (!integrationMode || !req.path.startsWith('/api/')) return next();
  if(/^\/api\/admin\/knowledge(?:\/|$)/.test(req.path)||(req.method==='PUT'&&req.path==='/api/admin/assistant-model')||(req.method==='POST'&&req.path==='/api/admin/assistant-model/connect'))return requireRole('admin')(req,res,next);
  if(req.method==='POST'&&req.path==='/api/assistant/knowledge/ask')return next();
  if(req.method==='POST'&&['/api/assistant/ask','/api/assistant/preview','/api/assistant/session/reset','/api/assistant/media/recognize','/api/assistant/media/text'].includes(req.path))return next(); // 查询、草稿与会话；工具逐次核对权限，不能提交库存。
  if(/^\/api\/erp-stocktakes(?:\/|$)/.test(req.path))return next(); // 差异单独立审核，不修改外部库存。
  if (isSpaceWrite(req.method,req.path)) {
    return requireRole('admin','spaceAdmin')(req,res,()=>{
      try { checkSpaceWrite(req.method,req.path,req.body || {}); next(); }
      catch(e) { res.status(409).json({error:e.message}); }
    });
  }
  const syncWrite = /^\/api\/integration\/warehouse-access(?:\/[^/]+)?$/.test(req.path) || (req.method === 'PUT' && req.path === '/api/integration/source-policy') || req.path === '/api/integration/snapshot' || /^\/api\/integration\/(credentials|locations)(?:\/[^/]+)?$/.test(req.path) || (req.method === 'POST' && /^\/api\/integration\/retry\/\d+$/.test(req.path));
  if (!['GET','HEAD','OPTIONS'].includes(req.method) && !syncWrite) {
    return res.status(403).json({ error: '集成预览为只读，库存业务请在 ERP/WMS 操作' });
  }
  next();
});
// 除公开端点外，所有 /api/* 必须登录；页面与静态资源不拦截（否则登录页也打不开）
//
// 本机打包豁免：离线包生成脚本（bundle.mjs）需要读取 /api/rooms、/api/scene 内联场景数据，
// 但加鉴权后这些接口要求登录。故提供显式开关：仅当 SPATIAL_LOCAL_BYPASS=1 且请求来自回环地址
// 时才放行，默认关闭，生产环境请勿开启。
const LOCAL_BYPASS = !platformEnabled && process.env.SPATIAL_LOCAL_BYPASS === '1';
if (LOCAL_BYPASS) console.warn('[security] SPATIAL_LOCAL_BYPASS=1：本机回环请求免鉴权（仅用于离线打包，生产勿开）');
const isLoopback = (req) => {
  const ip = String(req.ip || '');
  return ip === '127.0.0.1' || ip === '::1' || ip === '::ffff:127.0.0.1';
};
app.use((req, res, next) => {
  if (!req.path.startsWith('/api/')) return next();
  if (req.path === '/api/health' || /^\/api\/auth\//.test(req.path)) return next();
  if (LOCAL_BYPASS && isLoopback(req)) return next();
  return requireAuth(req, res, next);
});
// 管理类端点仅 admin（同步、集成自检、备份）
app.use((req, res, next) => {
  if (req.path.startsWith('/api/admin/')) return requireRole('admin')(req, res, next);
  next();
});
// 写操作门禁：出入库/移库/布局保存/删除等变更类请求，viewer（只读）一律拒绝。
// 登录、登出、引导这类与业务无关的端点不在此限。
const WRITE_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);
app.use((req, res, next) => {
  if (!req.path.startsWith('/api/')) return next();
  if (/^\/api\/auth\//.test(req.path)) return next();
  if (!WRITE_METHODS.has(req.method)) return next();
  if(req.method==='POST'&&req.path==='/api/assistant/knowledge/ask')return next();
  if(req.method==='POST'&&['/api/assistant/ask','/api/assistant/preview','/api/assistant/session/reset','/api/assistant/media/recognize','/api/assistant/media/text'].includes(req.path))return next();
  if (platformEnabled && !integrationMode && !req.user?.isService) {
    if(isSpaceWrite(req.method,req.path))return requireRole('admin','spaceAdmin')(req,res,next);
    const inventoryWrite=['/api/counter/inbound','/api/counter/outbound','/api/counter/move','/api/items','/api/v1/items','/api/import','/api/work/opening'].includes(req.path)||/^\/api\/items\/[^/]+$/.test(req.path)||/^\/api\/stocktakes(?:\/|$)/.test(req.path)||/^\/api\/team-tasks(?:\/|$)/.test(req.path)||/^\/api\/assistant\/jobs(?:\/|$)/.test(req.path);
    return requireRole(...(inventoryWrite?['admin','operator']:['admin']))(req,res,next);
  }
  return requireRole('admin', 'operator', 'spaceAdmin')(req, res, next);
});

// 静态资源：3D 原型 + 二维码页（从仓库根挂载，使 /apps/web/... 直接可访问）
// 长连接重新验证身份和仓库范围，撤权后不再发布更新。
async function refreshRequestAccess(req) {
  delete req.canAccessLocation;delete req.allowedLocations;delete req.warehouseSites;delete req.scopeRoom;
  const run=middleware=>new Promise(resolve=>{
    const guard={status(){return this;},json(){resolve(false);}};
    Promise.resolve(middleware(req,guard,()=>resolve(true))).catch(()=>resolve(false));
  });
  if(!await run(attachUser)||!req.user||req.user.isService)return false;
  if(warehouseAccess&&(!await run(warehouseAccess.identityMiddleware)||!await run(warehouseAccess.middleware)))return false;
  return true;
}
mountLiveScene(app,{
  readScene:async req=>{
    const scene=await db.getScene(req.query.room || req.scopeRoom || null);
    if(!inventoryView)return scene;
    const external=inventoryView.scene(scene);
    if(req.canAccessLocation)external.sync=external.sync.filter(s=>visibleInventory(req).some(r=>r.source===s.source));
    return external;
  },
  authorize:refreshRequestAccess
});
app.use('/apps/web', express.static(join(ROOT, 'apps', 'web')));
app.use('/packages/three-kit', express.static(join(ROOT, 'packages', 'three-kit')));
// 写实模型文件（Blender 导出的 GLB）静态托管
app.use('/uploads', requireAuth, express.static(UPLOAD_DIR));
app.get('/', (_req, res) => res.redirect(basePath + '/apps/web/prototype/index.html'));
if (warehouseAccess) {
  app.get('/api/integration/space-history', requireRole('admin'), (req,res)=>{try{res.json(req.query.page ? db.pageSpaceOperations(req.query) : db.listSpaceOperations());}catch(error){res.status(400).json({error:error.message});}});
  app.get('/api/integration/space-history/:id', requireRole('admin'), (req,res)=>{
    const entry=db.getSpaceOperation(req.params.id);
    if (!entry) return res.status(404).json({error:'空间操作记录不存在'});
    res.json(entry);
  });

  app.get('/api/integration/access-users',requireRole('admin'),(_req,res)=>res.json(warehouseAccess.users()));
  app.get('/api/integration/warehouse-access',requireRole('admin'),(_req,res)=>res.json(warehouseAccess.list()));
  app.put('/api/integration/warehouse-access',requireRole('admin'),(req,res)=>{
    try{res.json(warehouseAccess.save(req.body,req.user.id));}catch(e){res.status(400).json({error:e.message});}
  });
  app.delete('/api/integration/warehouse-access/:id',requireRole('admin'),(req,res)=>res.json(warehouseAccess.remove(req.params.id)));
  app.get('/api/access/status',(req,res)=>res.json({mode:inventoryMode,canManage:['admin','spaceAdmin'].includes(req.user.role),canOperate:!integrationMode&&['admin','operator'].includes(req.user.role),canAdmin:req.user.role==='admin',warehouseSites:req.warehouseSites??null,warehouseSync:!req.warehouseSites||req.warehouseSites.includes(warehouseUnsState.site)?warehouseUnsState:null}));
}
if(!integrationMode&&process.env.DB_DRIVER!=='pg'){
  mountItemStorage(app,{storage:createItemStorage(sqlite,{tenant:db.TENANT,emit:db.emit}),requireRole});
  const codes=sqliteDb.itemCodes;
  const codeRoute=fn=>(req,res)=>{try{res.set('Cache-Control','no-store').json(fn(req));}catch(error){res.status(error.status||400).json({error:error.message});}};
  app.get('/api/admin/item-codes',codeRoute(req=>codes.list(req.query.q)));
  app.get('/api/admin/item-codes/:id',codeRoute(req=>codes.get(req.params.id)));
  app.get('/api/admin/item-codes/:id/history',codeRoute(req=>codes.history(req.params.id)));
  app.post('/api/admin/item-codes/:id',codeRoute(req=>codes.save(req.params.id,req.body,req.user)));
  const stocktakes=createStocktakes(sqlite,{tenant:db.TENANT,logMovement:db.logMovement,emit:db.emit});
  const run=(fn,status=200)=>(req,res)=>{try{res.status(status).json(fn(req));}catch(error){res.status(error.status||400).json({error:error.message});}};
  app.get('/api/stocktakes',run(req=>req.query.limit!==undefined
    ? stocktakes.page(req.query.loc_code,req.query,req.canAccessLocation)
    : stocktakes.list(req.query.loc_code,req.canAccessLocation)));
  app.get('/api/stocktakes/:id',run(req=>stocktakes.get(req.params.id,req.canAccessLocation)));
  app.get('/api/stocktakes/:id/events',run(req=>stocktakes.history(req.params.id,req.query,req.canAccessLocation)));
  app.post('/api/stocktakes',requireRole('admin','operator'),run(req=>stocktakes.create(req.body,req.user,req.canAccessLocation),201));
  app.put('/api/stocktakes/:id',requireRole('admin','operator'),run(req=>stocktakes.save(req.params.id,req.body,req.user,req.canAccessLocation)));
  app.post('/api/stocktakes/:id/finish',requireRole('admin','operator'),run(req=>stocktakes.finish(req.params.id,req.body,req.user,req.canAccessLocation)));
}
if(process.env.DB_DRIVER!=='pg') {
  const work=mountWarehouseWork(app,{sql:sqlite,db,sqliteDb,integrationMode,requireRole});
  const teamTasks=!integrationMode?createTeamTasks({sql:sqlite,db:sqliteDb,work,access:warehouseAccess}):null;
  if(teamTasks)mountTeamTasks(app,{tasks:teamTasks,requireRole});
  const tools=createAssistantTools({db:sqliteDb,work,teamTasks,integrationMode,readInventory:req=>inventoryView?visibleInventory(req):db.listInventory().filter(row=>!req.canAccessLocation||req.canAccessLocation(row.loc_code))});
  const jobs=createAssistantJobs({sql:sqlite,db:sqliteDb,tools,teamTasks,integrationMode});
  mountAssistantJobs(app,{jobs,authorize:refreshRequestAccess});
  mountWorkStatus(app,{sql:sqlite,db:sqliteDb,work,authorize:refreshRequestAccess,integrationMode,teamTasks});
  mountAssistantMedia(app,{media:createLocalMedia(),tools,authorize:refreshRequestAccess});
  const settings=createAssistantSettings(sqlite),model=createLocalAssistantModel(settings.get());
  mountAssistantSettings(app,{settings,model,authorize:refreshRequestAccess,requireRole});
  mountKnowledge(app,{sql:sqlite,tools,model,authorize:refreshRequestAccess,requireRole});
  mountAssistant(app,{tools,jobs,model,authorize:refreshRequestAccess,requireRole});
}
if (inventoryView) {
  mountErpStocktakes(app,{sql:sqlite,inventoryView,requireRole});

  app.get('/api/cell/:code/sku-binding', (req,res)=>res.json(inventoryView.skuPlacement.get(req.params.code)));
  app.put('/api/cell/:code/sku-binding', requireRole('admin','spaceAdmin'), (req,res)=>{
    try{res.json(inventoryView.skuPlacement.save(req.params.code,req.body || {}));}
    catch(e){res.status(e.status || 400).json({error:e.message,...(e.sources?{sources:e.sources,bindingIndex:e.bindingIndex}:{})});}
  });
  app.get('/api/integration/events', (req,res)=>{
    try {res.json(inventoryView.businessEvents.page(req.query));}catch(e){res.status(400).json({error:e.message});}
  });
  app.get('/api/integration/inventory/page', (req,res)=>{
    try {res.json(inventoryView.inventoryPage(req.query,req.canAccessLocation));}catch(e){res.status(e.status || 400).json({error:e.message});}
  });
  app.get('/api/integration/facets', (req,res)=>res.json(inventoryFacets(visibleInventory(req))));
  app.get('/api/integration/status', (req, res) => res.json({ mode: 'integration', canManage: ['admin','spaceAdmin'].includes(req.user.role), canAdmin: req.user.role === 'admin', warehouseSites:req.warehouseSites ?? null, sources: inventoryView.status().filter(s=>!req.canAccessLocation||visibleInventory(req).some(r=>r.source===s.source)) }));
  app.put('/api/integration/source-policy', requireRole('admin'), (req,res)=>{
    try {res.json(inventoryView.saveSourcePolicy(req.body));}catch(e){res.status(400).json({error:e.message});}
  });
  app.get('/api/integration/history/detail/:id', requireRole('admin'), (req,res)=>{
    const detail=inventoryView.historyDetail(req.params.id);
    if(!detail)return res.status(404).json({error:'历史记录不存在'});
    res.json(detail);
  });
  app.get('/api/integration/history/page', requireRole('admin'), (req,res)=>{
    try {res.json(inventoryView.historyPage(req.query));}catch(e){res.status(400).json({error:e.message});}
  });
  app.get('/api/integration/history', requireRole('admin'), (_req, res) => res.json(inventoryView.history()));
  app.post('/api/integration/retry/:id', requireRole('admin'), (req,res) => {
    try { res.json(inventoryView.retry(req.params.id,req.user.id)); }
    catch(e) { res.status(e.status || 400).json({error:e.message}); }
  });
  app.get('/api/integration/locations', requireRole('admin'), (_req,res) => res.json(inventoryView.mappings()));
  app.post('/api/integration/locations', requireRole('admin'), (req,res) => {
    try { res.json(inventoryView.saveMapping(req.body || {})); } catch(e) { res.status(400).json({error:e.message}); }
  });
  app.delete('/api/integration/locations/:id', requireRole('admin'), (req,res) => {
    try { res.json(inventoryView.deleteMapping(req.params.id)); } catch(e) { res.status(400).json({error:e.message}); }
  });
  app.get('/api/integration/credentials', requireRole('admin'), (_req, res) => res.json(db.listServiceTokens()
    .filter(t => t.scopes.some(s => s.startsWith('snapshot:source:')))
    .map(t => ({ ...t, source: t.scopes.find(s => s.startsWith('snapshot:source:')).slice('snapshot:source:'.length) }))));
  app.post('/api/integration/credentials', requireRole('admin'), (req, res) => {
    const { name, source } = req.body || {};
    if (typeof source !== 'string' || !source.trim() || source !== source.trim() || source.length > 120) return res.status(400).json({ error: '来源必填、不超过120字且首尾无空格' });
    try {
      res.set('Cache-Control', 'no-store').json(db.createServiceToken({ name, scopes: ['snapshot:source:' + source], createdBy: req.user.id }));
    } catch (e) { res.status(400).json({ error: e.message }); }
  });
  app.delete('/api/integration/credentials/:id', requireRole('admin'), (req, res) => {
    const t = db.listServiceTokens().find(t => t.id === req.params.id && t.scopes.some(s => s.startsWith('snapshot:source:')));
    if (!t) return res.status(404).json({ error: '同步凭证不存在' });
    res.json(db.revokeServiceToken(t.id));
  });
  app.post('/api/integration/snapshot', (req, res) => {
    if (req.user.role !== 'admin' && !req.syncSource) return res.status(403).json({ error: '需要管理员或专用同步凭证' });
    if (req.syncSource && req.body?.source !== req.syncSource) return res.status(403).json({ error: '凭证仅能同步绑定的数据来源' });
    try { res.json(inventoryView.receive(req.body, req.user.id)); } catch (e) { res.status(e.status || 400).json({ error: e.message }); }
  });
  app.get('/api/scene', async (req, res) => {
    try { const scene=inventoryView.scene(await db.getScene(req.query.room || req.scopeRoom || null));
      if(req.canAccessLocation)scene.sync=scene.sync.filter(s=>visibleInventory(req).some(r=>r.source===s.source));
      res.json(scene); } catch (e) { res.status(500).json({ error: e.message }); }
  });
  app.get(['/api/v1/inventory', '/api/v1/items'], (req, res) => res.json(visibleInventory(req)));
  app.get('/api/search', (req, res) => res.json(searchInventory(visibleInventory(req),req.query)));
  app.get('/api/cells/:code/items', (req, res) => res.json(visibleInventory(req).filter(r => r.loc_code === req.params.code)));
  app.get('/api/v1/movements', (_req, res) => res.json({ movements: [], count: 0, source: 'external' }));
}

// 出入库台友好入口
app.get('/counter.html', (_req, res) => {
  res.redirect(basePath + '/apps/web/prototype/counter.html');
});

// 空间场景（位置树 + 各格位物品），前端据此渲染 3D；?room=<id|loc_code> 切换房间
app.get('/api/scene', async (req, res) => {
  try { res.json(await db.getScene(req.query.room || req.scopeRoom || null)); } catch (e) { res.status(500).json({ error: e.message }); }
});

// ---------- 写实模型资源（Blender 导出的 glTF/GLB，按 loc_code 关联库区/货架） ----------
const ASSET_DIR = join(UPLOAD_DIR, 'assets');
mkdirSync(ASSET_DIR, { recursive: true });
app.post('/api/node/:loc_code/asset', async (req, res) => {
  try {
    const locCode = req.params.loc_code;
    const { data, transform, submeshMap } = req.body || {};
    if (!data || typeof data !== 'string') return res.status(400).json({ error: '缺少模型数据（base64）' });
    const base64 = data.includes(',') ? data.split(',')[1] : data;
    const buf = Buffer.from(base64, 'base64');
    if (!buf.length) return res.status(400).json({ error: '模型数据为空' });
    if (buf.length > 32 * 1024 * 1024) return res.status(413).json({ error: '模型过大（上限 32MB）' });
    if(buf.length<20 || buf.toString('ascii',0,4)!=='glTF' || buf.readUInt32LE(4)!==2 || buf.readUInt32LE(8)!==buf.length) return res.status(400).json({error:'请选择有效的 GLB 2.0 文件'});
    const filename=randomUUID()+'.glb', assetUrl='/uploads/assets/'+filename;
    const assetPath=join(ASSET_DIR,filename);
    writeFileSync(assetPath,buf);
    let rec;
    try { rec=db.setNodeAsset({locCode,assetUrl,transform:transform || {},submeshMap:submeshMap || {}}); }
    catch(error) { unlinkSync(assetPath); throw error; }
    res.json({ ok: true, asset: rec });
  } catch (e) { res.status(400).json({ error: e.message }); }
});
app.get('/api/node/:loc_code/asset', async (req, res) => {
  try {
    const a = db.getNodeAsset(req.params.loc_code);
    if (!a) return res.status(404).json({ error: '无写实模型' });
    res.json(a);
  } catch (e) { res.status(e.status||500).json({ error: e.message }); }
});
app.delete('/api/node/:loc_code/asset', async (req, res) => {
  try {
    const url = db.deleteNodeAsset(req.params.loc_code);
    if (url) {
      const file=String(url).split('/').pop();
      if(/^[A-Za-z0-9_-]+\.glb$/.test(file))try { unlinkSync(join(ASSET_DIR,file)); } catch (_) {}
    }
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// 房间列表（多房间切换）
app.get('/api/sites', async (_req, res) => {
  try { res.json(await db.listSites()); } catch (e) { res.status(500).json({ error: e.message }); }
});
app.post('/api/site', async (req, res) => {
  try { res.status(201).json(await db.createSite(req.body || {})); }
  catch (e) { res.status(400).json({ error: e.message }); }
});
app.get('/api/rooms', async (req, res) => {
  try { res.json(await db.listRooms(req.query.site || null)); } catch (e) { res.status(500).json({ error: e.message }); }
});
app.post('/api/rooms', async (req, res) => {
  try { res.status(201).json(await db.createRoomNode(req.body || {})); }
  catch (e) { res.status(400).json({ error: e.message }); }
});
app.delete('/api/rooms/:id', async (req, res) => {
  try { res.json(await db.deleteRoom(req.params.id)); }
  catch (e) { res.status(400).json({ error: e.message }); }
});

// 可录入的格位（下拉用）
app.get('/api/cells', async (_req, res) => {
  try { res.json(await db.getCells()); } catch (e) { res.status(500).json({ error: e.message }); }
});

// 位置树（场地→房间→家具→格）
app.get('/api/locations/tree', async (_req, res) => {
  try { res.json(await db.getLocationTree()); } catch (e) { res.status(500).json({ error: e.message }); }
});

// 录入物品：name / category / qty / loc_code / photo(base64) / note
app.post('/api/items', async (req, res) => {
  try { res.status(201).json(await db.createItem(req.body || {})); }
  catch (e) { res.status(400).json({ error: e.message }); }
});

// 编辑货品资料；数量及位置统一走有流水和复核规则的库存作业。
app.put('/api/items/:id', async (req, res) => {
  try {
    if(!integrationMode&&(req.body?.qty!==undefined||req.body?.loc_code!==undefined))return res.status(400).json({error:'货品资料不能直接修改库存数量或位置，请使用入库、出库、移库或盘点'});
    res.json(await db.updateItem(req.params.id, req.body || {}));
  }
  catch (e) { res.status(400).json({ error: e.message }); }
});

// 删除物品（连带库存与流水）
app.delete('/api/items/:id', async (req, res) => {
  try { res.json(await db.deleteItem(req.params.id)); }
  catch (e) { res.status(400).json({ error: e.message }); }
});

// 批量导入（CSV/Excel 解析后的行数组）
app.post('/api/import', async (req, res) => {
  try { res.status(req.body?.preview?200:201).json(await db.importItems(req.body && req.body.rows,{preview:req.body?.preview===true,request_id:req.body?.request_id})); }
  catch (e) { res.status(400).json({ error: e.message }); }
});

// 运行时创建参数化货架（横梁货架/封闭柜/料箱/地面区…）+ 自动生成格位
// 新路径 /api/rack；旧路径 /api/furniture 作为兼容别名保留（ERP / supOS / 自研脚本不受影响）。
const createRackHandler = async (req, res) => {
  try { res.status(201).json(await db.createRack(req.body || {})); }
  catch (e) { res.status(400).json({ error: e.message }); }
};
app.post('/api/rack/:code/clone', async (req,res) => {
  try { res.json(await db.cloneRack(req.params.code,req.body)); }
  catch(e) { res.status(400).json({error:e.message}); }
});
app.post('/api/rack', createRackHandler);
app.post('/api/furniture', createRackHandler);

// ---------------- 出入库台（扫码出入库） ----------------
// 某格位内的在库物品（出库时列出可出选项）
app.get('/api/cells/:code/items', async (req, res) => {
  try { const r = await db.getCellItems(req.params.code); res.json(r || []); }
  catch (e) { res.status(400).json({ error: e.message }); }
});
// 格位现场照片：上传一张（dataURL），追加到该格位，返回更新后的数组
app.post('/api/cell/:code/photo', async (req, res) => {
  try {
    const { photo } = req.body || {};
    if (typeof photo!=='string' || !/^data:image\/(png|jpeg|webp);base64,[A-Za-z0-9+/=]+$/.test(photo) || photo.length>7*1024*1024) return res.status(400).json({error:'请选择不超过5MB的 PNG、JPEG 或 WebP 照片'});
    const photos = await db.addCellPhoto(req.params.code, photo);
    res.json({ ok: true, photos });
  } catch (e) { res.status(400).json({ error: e.message }); }
});
app.delete('/api/cell/:code/photo', async (req,res) => {
  try { const {index,photo}=req.body || {}; res.json({ok:true,photos:await db.removeCellPhoto(req.params.code,index,photo)}); }
  catch(error){res.status(409).json({error:error.message});}
});
// 格位扩展属性（容量/承重/状态/标签/备注）：单格位
app.put('/api/cell/:code/meta', async (req, res) => {
  try {
    const {revision, ...meta} = req.body || {};
    if(typeof revision !== 'string' || !revision)return res.status(428).json({error:'请刷新格位属性后再保存'});
    const r = await db.setCellMeta(req.params.code, meta, revision);
    res.json(r);
  } catch (e) { res.status(e.status || 400).json({ error: e.message }); }
});
// 格位扩展属性：批量（codes 为全码数组 + 统一 meta）
app.post('/api/cells/meta', async (req, res) => {
  try {
    const { codes = [], meta = {}, revisions } = req.body || {};
    if (!Array.isArray(codes) || !codes.length) return res.status(400).json({ error: 'codes 不能为空' });
    if(!revisions || codes.some(code=>typeof revisions[code] !== 'string' || !revisions[code]))return res.status(428).json({error:'请刷新格位属性后再批量保存'});
    const r = await db.setCellsMeta(codes, meta, revisions);
    res.json(r);
  } catch (e) { res.status(e.status || 400).json({ error: e.message }); }
});
// 格位流转时间线：涉及该格位的 movement 记录
app.get('/api/cell/:code/history', async (req, res) => {
  try { res.json(await db.getCellHistory(req.params.code,req.allowedLocations)); }
  catch (e) { res.status(400).json({ error: e.message }); }
});
// 入库：按 sku（优先）/ 名称复用货品、叠加库存、记 inbound 流水
app.post('/api/counter/inbound', async (req, res) => {
  try { res.status(201).json(await db.inbound(req.body || {})); }
  catch (e) { res.status(400).json({ error: e.message }); }
});
// 货品扫码识别：按 sku / erp_code / item.id 解析货品（手机扫货品二维码用）
app.get('/api/items/by-code', async (req, res) => {
  try {
    const code = (req.query.code || '').toString().trim();
    if (!code) return res.status(400).json({ error: '缺少 code 参数' });
    const item = await db.getItemByCode(code);
    if (!item) return res.status(404).json({ error: '未找到匹配货品' });
    res.json(item);
  } catch (e) { res.status(e.status||500).json({ error: e.message }); }
});
// 出库：扣减库存、记 outbound 流水（to=NULL 表示出库/外部）
app.post('/api/counter/outbound', async (req, res) => {
  try { res.json(await db.outbound(req.body || {})); }
  catch (e) { res.status(400).json({ error: e.message }); }
});
// 移库：跨格位转移库存，记 move 流水（from→to）
app.post('/api/counter/move', async (req, res) => {
  try { res.json(await db.moveItem(req.body || {})); }
  catch (e) { res.status(400).json({ error: e.message }); }
});

// 别名词表：检索同义扩展
app.get('/api/aliases', async (_req, res) => {
  try { res.json(await db.getAliases()); } catch (e) { res.status(500).json({ error: e.message }); }
});
app.post('/api/aliases', async (req, res) => {
  try { res.status(201).json(await db.addAlias((req.body || {}).word, (req.body || {}).target)); }
  catch (e) { res.status(400).json({ error: e.message }); }
});

// 拍照识别（插件式：默认 manual 退化为手动；AI_PROVIDER=visionApi + 密钥可开启）
app.post('/api/recognize', async (req, res) => {
  try { res.json(await recognize((req.body || {}).photo)); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

// 关键词检索（中文子串 + 别名词表；PG 模式可升级 pg_bigm/向量）
app.get('/api/search', async (req, res) => {
  try { res.json(await db.search(req.query.q || '',req.allowedLocations)); } catch (e) { res.status(500).json({ error: e.message }); }
});

// ---------------- 开放平台 v1（供第三方/WMS 接入，见 docs/openapi.yaml） ----------------
app.post('/api/v1/items', async (req, res) => {
  try { res.status(201).json(await db.createItem(req.body || {})); }
  catch (e) { res.status(400).json({ error: e.message }); }
});
app.get('/api/v1/inventory', async (_req, res) => {
  try { res.json(await db.listInventory()); } catch (e) { res.status(500).json({ error: e.message }); }
});
app.get('/api/v1/movements', async (req, res) => {
  try {
    const limit = Math.min(Number(req.query.limit) || 50, 500);
    const after = Number(req.query.after) || 0;
    const rows = await db.listMovements({ limit, after, allowedLocations:req.allowedLocations });
    res.json({
      after, limit, count: rows.length,
      next_after: rows.length ? rows[rows.length - 1].id : after,
      movements: rows,
    });
  }
  catch (e) { res.status(500).json({ error: e.message }); }
});

// 货品清单（ERP 全量对齐用），可选按 erp_code 过滤
app.get('/api/v1/items', async (req, res) => {
  try { res.json(await db.listItems({ erpCode: req.query.erp_code || null })); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

// ERP 拉取增量后回执：标记这些流水已同步（幂等，重复回执不会覆盖已有时间）
app.post('/api/v1/movements/ack', async (req, res) => {
  try {
    const ids = (req.body && req.body.ids) || [];
    const marked = await db.markMovementsSynced(ids);
    res.json({ marked });
  } catch (e) { res.status(400).json({ error: e.message }); }
});

// ERP → 本系统：按 ERP 物料编码推送库存增量（delta>0 入 / <0 出）
// 鉴权：① 人工 operator/admin 会话；② 携带 erp:sync 或 supos:device 作用域的服务令牌（机器/设备网关）。
app.post('/api/v1/sync/erp-stock', async (req, res) => {
  try {
    const svc = req.serviceToken;
    const humanOk = req.user && !req.user.isService && ['admin', 'operator'].includes(req.user.role);
    const svcOk = svc && (svc.scopes.includes('erp:sync') || svc.scopes.includes('supos:device'));
    if (!humanOk && !svcOk) {
      return res.status(svc || req.user ? 403 : 401).json({ error: '无权执行 ERP 库存同步（需 operator/admin 会话或 erp:sync 服务令牌）' });
    }
    const body = req.body || {};
    const idemKey = body.idempotency_key != null ? body.idempotency_key
      : (req.get('idempotency-key') || req.get('Idempotency-Key') || null);
    res.json(await db.syncErpStock({ ...body, idempotency_key: idemKey }));
  } catch (e) { res.status(400).json({ error: e.message }); }
});

// ---- 服务凭证管理（admin 专属）：机器令牌供 ERP / 设备网关调用 /api/v1/sync/erp-stock ----
app.post('/api/admin/service-token', requireRole('admin'), (req, res) => {
  try {
    const { name, scopes } = req.body || {};
    const r = db.createServiceToken({ name, scopes, createdBy: req.user?.id });
    res.json({ ok: true, ...r, warning: '请立即复制 token，关闭后无法再次查看' });
  } catch (e) { res.status(400).json({ error: e.message }); }
});
app.get('/api/admin/service-tokens', requireRole('admin'), (_req, res) => {
  try { res.json(db.listServiceTokens()); } catch (e) { res.status(500).json({ error: e.message }); }
});
app.delete('/api/admin/service-token/:id', requireRole('admin'), (req, res) => {
  try { res.json(db.revokeServiceToken(req.params.id)); } catch (e) { res.status(400).json({ error: e.message }); }
});

// ---- ERP 编码批量导入（admin 专属）：建立 本地码 ↔ ERP 编码 对照 ----
// 接受 JSON：{ rows: [{ local_code, erp_code, local_type }] } 或 { csv: "local_code,erp_code,local_type\\n..." }
function parseErpCsv(csv) {
  const lines = String(csv || '').split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  if (!lines.length) return [];
  const head = lines[0].toLowerCase().split(',').map((s) => s.trim());
  const hasHeader = head.includes('local_code') || head.includes('erp_code') || head.includes('local_type') || head.includes('type');
  const data = hasHeader ? lines.slice(1) : lines;
  return data.map((line) => {
    const c = line.split(',').map((s) => s.trim());
    if (hasHeader) {
      const m = {}; head.forEach((h, i) => { m[h] = c[i]; });
      return { local_code: m.local_code, erp_code: m.erp_code, local_type: m.local_type || m.type || 'item' };
    }
    return { local_code: c[0], erp_code: c[1], local_type: c[2] || 'item' };
  });
}
app.post('/api/admin/erp-mapping-import', requireRole('admin'), (req, res) => {
  try {
    let rows = req.body?.rows;
    if (!rows && req.body?.csv) rows = parseErpCsv(req.body.csv);
    if (!Array.isArray(rows) || !rows.length) return res.status(400).json({ error: '请提供 rows 数组或 csv 文本' });
    res.json(db.importErpMappings(rows));
  } catch (e) { res.status(400).json({ error: e.message }); }
});
app.get('/api/v1/locations/tree', async (_req, res) => {
  try { res.json(await db.getLocationTree()); } catch (e) { res.status(500).json({ error: e.message }); }
});

// 手动触发 outbox 派发（开放 API Webhook + WMS/ERP 上行同步引擎）
app.post('/api/admin/sync', async (_req, res) => {
  try { res.json(await dispatchOnce()); } catch (e) { res.status(500).json({ error: e.message }); }
});

// 集成接口自检：当前已注册适配器与 supOS 配置意图（未接工厂也可查看，确认接口就位）
app.get('/api/admin/integration', (_req, res) => {
  try { res.json(integrationStatus()); } catch (e) { res.status(500).json({ error: e.message }); }
});

// 每份备份包含独立数据库、上传文件及校验清单，与停机备份工具使用相同恢复格式。
app.get('/api/admin/backup/status', (_req,res)=>res.json(backupMonitor.status()));
app.post('/api/admin/backup', (_req, res) => {
  try { res.json(backupMonitor.execute()); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

function runAutoBackup() {
  try {
    const result = backupMonitor.execute();
    console.log(`[backup] 成套备份完成：${result.bundle}`);
  } catch (e) { console.error('[backup] 自动备份失败:', e.message); }
}

function scheduleAutoBackup() {
  const {enabled,interval_ms:intervalMs,config_error}=backupMonitor.status();
  if(!enabled){console.error('[backup] 自动备份未启用:',config_error);return;}
  setTimeout(runAutoBackup, 30 * 1000); // 启动后稍候首备，避开初始化写冲突
  setInterval(runAutoBackup, intervalMs);
  console.log(`[backup] 自动备份已启用：间隔 ${Math.round(intervalMs / 1000)}s，保留最近 ${process.env.BACKUP_KEEP || 28} 份（BACKUP_KEEP / BACKUP_INTERVAL_MS 可配）`);
}

// 审计流水：带操作人，可按人/类型筛选（分页）。含操作人姓名，属敏感信息，仅 admin 可查
app.get('/api/v1/audit', requireRole('admin'), (req, res) => {
  try { res.json(db.listAuditMovements(req.query || {})); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

// 外部工具布局导入（CAD/BIM/SketchUp 导出的 .dxf/.ifc，或平台自有 .json 模板）
// 请求体：{ filename, content }（content 为文件文本）；返回归一化后的 canonical 布局模板。
app.post('/api/import-layout', async (req, res) => {
  try {
    const { filename, content } = req.body || {};
    if (!content || !filename) throw new Error('需提供 filename 与 content');
    const { kind, template } = await importLayout(content, filename);
    res.json({ ok: true, kind, template });
  } catch (e) { res.status(400).json({ error: e.message }); }
});

// 拍照生成布局：照片（data URL）→ 视觉大模型识别 → 规范布局模板（与 DXF/IFC 同源）＋ 自检告警。
// 请求体：{ image } 或 { images:[...] }；可选 hints（已知尺寸）、reference（参照物预设 key）。
// 返回 { ok, kind, template, warnings, lowConfidence }。需 admin|operator（POST 写方法由全局中间件保障）。
app.post('/api/import-layout-photo', async (req, res) => {
  try {
    const { image, images, hints, reference } = req.body || {};
    const r = await importLayoutPhoto({ image, images, hints, reference });
    res.json({
      ok: true,
      kind: r.kind,
      template: r.template,
      warnings: r.warnings || [],
      lowConfidence: r.lowConfidence || 0,
    });
  } catch (e) { res.status(400).json({ error: e.message }); }
});

// 设置房间门/窗方向 + 尺寸
app.post('/api/room', async (req, res) => {
  try { res.json(await db.setRoom(req.body || {})); }
  catch (e) { res.status(400).json({ error: e.message }); }
});

// 更新单个货架的位置 / 旋转 / 尺寸（新路径 /api/rack，旧路径 /api/furniture 保留为别名）
const updateRackHandler = async (req, res) => {
  try { res.json(await db.updateRack(req.params.code, req.body || {})); }
  catch (e) { res.status(400).json({ error: e.message }); }
};
app.put('/api/rack/:code', updateRackHandler);
app.put('/api/furniture/:code', updateRackHandler);

// 格位合并方案：把一层里相邻的列合并成一个宽格位（如 L01 的 B01+B02）
// body: { merges: { "L01": [[1,2],[4,6]] } }；合并区间的库存会自动迁到首列
const setRackMergesHandler = async (req, res) => {
  try { res.json(await db.setRackMerges(req.params.code, (req.body || {}).merges || {})); }
  catch (e) { res.status(400).json({ error: e.message }); }
};
app.put('/api/rack/:code/cells', async (req, res) => {
  const {merges, names, capacities, capacityRevision} = req.body || {};
  if (!merges || Array.isArray(merges) || typeof merges !== 'object' || !names || Array.isArray(names) || typeof names !== 'object')
    return res.status(400).json({error:'需要格位合并方案与名称'});
  try { res.json(await db.setRackCells(req.params.code, {merges, names, capacities, capacityRevision})); }
  catch (e) { res.status(e.status || 400).json({error:e.message}); }
});
app.put('/api/rack/:code/merges', setRackMergesHandler);
app.put('/api/furniture/:code/merges', setRackMergesHandler);

// 给货架下的每一格设置自定义名称：body { names: { "L01-B01": "螺丝区", ... } }
const setCellNamesHandler = async (req, res) => {
  try { res.json(await db.setCellNames(req.params.code, (req.body || {}).names || {})); }
  catch (e) { res.status(400).json({ error: e.message }); }
};
app.put('/api/rack/:code/cell-names', setCellNamesHandler);
app.put('/api/furniture/:code/cell-names', setCellNamesHandler);

// 删除单个货架（级联清理格位/库存/物品）
const deleteRackHandler = async (req, res) => {
  try { res.json(await db.deleteRack(req.params.code)); }
  catch (e) { res.status(400).json({ error: e.message }); }
};
app.delete('/api/rack/:code', deleteRackHandler);
app.delete('/api/furniture/:code', deleteRackHandler);

// 布局模板：整体导出 / 导入（供「按真实场地摆放」）；?room= 指定房间，POST body 含 roomId
app.get('/api/layout', async (req, res) => {
  try { res.json(await db.getLayout(req.query.room || req.scopeRoom || null)); } catch (e) { res.status(500).json({ error: e.message }); }
});
app.post('/api/layout', async (req, res) => {
  if(typeof req.body?.revision!=='string' || !req.body.revision)return res.status(428).json({error:'请重新打开布局，读取最新版本后保存'});
  try { res.json(await db.saveLayout(req.body || {})); }
  catch (e) { res.status(e.status || 400).json({ error: e.message }); }
});

const httpServer = app.listen(Number(PORT), () => {
  console.log(`[spatial-api] running at http://localhost:${httpServer.address().port}`);
  console.log(`  3D 原型:   http://localhost:${PORT}/apps/web/prototype/index.html`);
  console.log(`  出入库台: http://localhost:${PORT}/counter.html`);
  console.log(`  二维码页: http://localhost:${PORT}/apps/web/labels/index.html`);
  console.log(`  AI 识别 provider: ${getProviderName()}`);
  // 自动备份：定时快照到 data/backup/（启动 30s 后首备，之后每 BACKUP_INTERVAL_MS）
  scheduleAutoBackup();
  try {
    const stopWarehouseUns=startWarehouseUns(sqlite,DATA_DIR,state=>{warehouseUnsState=state;});
    httpServer.once('close',stopWarehouseUns);
  } catch(error) {warehouseUnsState={state:'error',site:process.env.SUPOS_WAREHOUSE_SITE};console.error('[warehouse-uns] 未启用：',error.message);}
  // 初始化集成层（注册适配器），并派发一次历史未发事件
  try {
    initIntegration();
    const intervalMs=Number(process.env.OUTBOUND_INTERVAL_MS || 0);
    if(!Number.isFinite(intervalMs)||intervalMs<0||(intervalMs>0&&intervalMs<1000))throw Error('OUTBOUND_INTERVAL_MS 必须为0或至少1000毫秒');
    const stopDispatch=startDispatchLoop({dispatch:dispatchOnce,intervalMs,
      report:r=>{if(r.total)console.log('[integration] 派发:',JSON.stringify(r));},
      onError:e=>console.error('[integration] 派发异常',e.message)});
    httpServer.once('close',stopDispatch);
  } catch (e) {
    console.error('[integration] 初始化失败（不影响主流程）:', e.message);
  }
});

// ---- 手机扫码前置：HTTPS 安全上下文 ----
// 浏览器仅在 https:// 或 localhost 下允许 getUserMedia 开摄像头。手机用 http://局域网IP 访问时
// 会被拦截，导致出入库台扫码不可用。设 SPATIAL_HTTPS=1 即用自签名证书额外起一个 HTTPS 监听，
// 手机须信任签发证书的CA，且证书包含访问IP或域名；不能仅跳过证书警告作为扫码验收。
if (process.env.SPATIAL_HTTPS === '1') {
  const keyPath = process.env.SPATIAL_TLS_KEY || join(ROOT, 'certs', 'server.key');
  const certPath = process.env.SPATIAL_TLS_CERT || join(ROOT, 'certs', 'server.crt');
  try {
    const key = readFileSync(keyPath);
    const cert = readFileSync(certPath);
    const httpsPort = Number(process.env.HTTPS_PORT || 3443);
    const tlsServer=https.createServer({ key, cert }, app);
    tlsServer.on('error',e=>console.error('[https] HTTPS监听失败：',e.message));
    tlsServer.listen(httpsPort, () => {
      console.log(`[spatial-api] HTTPS running at https://localhost:${httpsPort}`);
      const lanIPs = [];
      for (const k in os.networkInterfaces()) {
        for (const a of os.networkInterfaces()[k]) {
          if (a.family === 'IPv4' && !a.internal) lanIPs.push(a.address);
        }
      }
      const urls = ['localhost', ...lanIPs].map((ip) => `https://${ip}:${httpsPort}/apps/web/prototype/mobile.html`).join('  ·  ');
      console.log(`  手机作业访问: ${urls} （请使用证书包含的地址，并在设备上信任签发CA）`);
    });
  } catch (e) {
    console.warn('[https] 未找到证书或启动失败，已跳过 HTTPS 监听：', e.message);
  }
}
