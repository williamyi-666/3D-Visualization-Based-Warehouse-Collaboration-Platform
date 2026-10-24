// 企业级 P0：登录 / 会话 / 角色权限 / 操作人上下文
// 密码用 node:crypto 的 scrypt + 随机盐（零第三方依赖），比对用 timingSafeEqual 防时序攻击。
// 会话 token 存 session 表（服务端可吊销、可过期清理），不把用户信息塞进客户端。
import { randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';
import * as db from './db/index.mjs';
import { actorStore } from './context.mjs';
import { platformEnabled, integrationMode, inventoryMode, verifySuposUser, sameOriginWrite } from './platform.mjs';

// 作用域常量：机器令牌可申请的权限。erp:sync 允许推送库存增量；supos:device 允许 Open supOS 设备网关复用同一入口。
export const SVC_SCOPES = ['erp:sync', 'supos:device'];

const KEYLEN = 64;

export function hashPassword(pw) {
  const pw_salt = randomBytes(16).toString('hex');
  const pw_hash = scryptSync(String(pw), pw_salt, KEYLEN).toString('hex');
  return { pw_hash, pw_salt };
}
export function verifyPassword(pw, user) {
  if (!user || !user.pw_hash || !user.pw_salt) return false;
  const h = scryptSync(String(pw), user.pw_salt, KEYLEN).toString('hex');
  const a = Buffer.from(h, 'hex'), b = Buffer.from(String(user.pw_hash), 'hex');
  return a.length === b.length && timingSafeEqual(a, b);
}

// ---------- 中间件 ----------
/** 解析 Authorization: Bearer <token>，并把操作人放进 AsyncLocalStorage（供数据层写流水）。
 *  同时支持两类调用方：
 *   1) 人工会话（session 表）→ 真实用户，按角色鉴权；
 *   2) 机器令牌（service_token 表）→ 合成 operator 用户 + 作用域，供 ERP / 设备网关自动调用。 */
export async function attachUser(req, res, next) {
  if (platformEnabled) {
    if ((!req.path.startsWith('/api/') && !req.path.startsWith('/uploads/')) || req.path === '/api/health') return next();
    try {
      // 机器凭证只可写绑定来源的快照，不能读取库存或进入管理接口。
      const auth = req.get('authorization') || '';
      if (integrationMode && req.path === '/api/integration/snapshot' && req.method === 'POST' && auth.startsWith('Bearer ')) {
        const svc = db.getServiceTokenByRaw(auth.slice(7).trim());
        const scope = svc?.scopes.find(s => s.startsWith('snapshot:source:'));
        if (!scope) return res.status(401).json({ error: '同步凭证无效或已吊销' });
        req.syncSource = scope.slice('snapshot:source:'.length);
        req.user = { id: 'svc:' + svc.id, name: svc.name, role: 'operator', isService: true };
        return actorStore.run(req.user, next);
      }
      req.user = await verifySuposUser(req.get('cookie'));
      if (req.user && !['GET', 'HEAD', 'OPTIONS'].includes(req.method) && !sameOriginWrite(req)) {
        return res.status(403).json({ error: '请求来源校验失败' });
      }
      return actorStore.run(req.user || null, next);
    } catch (_) { return res.status(503).json({ error: '平台身份服务暂不可用，请稍后重试' }); }
  }
  const auth = String(req.get('authorization') || '');
  const token = auth.startsWith('Bearer ') ? auth.slice(7).trim()
    : ((req.query && req.query.token) ? String(req.query.token) : null);
  let user = token ? db.getSessionUser(token) : null;
  let svc = null;
  if (!user && token) {
    svc = db.getServiceTokenByRaw(token);
    if(svc&&integrationMode){
      // 独立登录的ERP协同部署同样使用来源专用凭证，且机器不能读取业务页面数据。
      const scope=svc.scopes.find(s=>s.startsWith('snapshot:source:'));
      if(!scope||req.path!=='/api/integration/snapshot'||req.method!=='POST')return res.status(401).json({error:'同步凭证仅可推送绑定来源的库存'});
      req.syncSource=scope.slice('snapshot:source:'.length);
    }
    if (svc) user = { id: 'svc:' + svc.id, name: svc.name, role: 'operator', isService: true };
  }
  req.user = user || null;
  req.token = token || null;
  req.serviceToken = svc;
  const actor = user ? { id: user.id, name: user.name, role: user.role } : null;
  actorStore.run(actor, () => next());
}
export function requireAuth(req, res, next) {
  if (!req.user) return res.status(401).json({ error: '未登录或会话已过期' });
  next();
}
/** 角色门禁：admin 全权 / operator 出入库与布局 / viewer 只读 */
export function requireRole(...roles) {
  return (req, res, next) => {
    if (!req.user) return res.status(401).json({ error: '未登录或会话已过期' });
    if (!roles.includes(req.user.role)) {
      return res.status(403).json({ error: '权限不足，需要角色：' + roles.join(' / ') });
    }
    next();
  };
}

// ---------- 路由 ----------
export function mountAuth(app) {
  // 健康检查（公开，给负载均衡/容器探针用）
  app.get('/api/health', (_req, res) => {
    res.json({ ok: true, service: 'spatial-inventory', time: new Date().toISOString() });
  });

  // 初始化状态（公开、只读）：前端据此决定是否显示「创建首个管理员」
  app.get('/api/auth/status', (_req, res) => {
    res.json({ initialized: platformEnabled || db.countUsers() > 0, provider: platformEnabled ? 'supos' : 'local', mode: inventoryMode });
  });

  if (platformEnabled) {
    app.get('/api/auth/me', requireAuth, (req, res) => res.json({ user: req.user, roles: db.ROLES, mode: inventoryMode }));
    app.all(['/api/auth/login', '/api/auth/bootstrap', '/api/auth/logout', '/api/users', '/api/users/:id'], (_req, res) => res.status(403).json({ error: '请通过 Open supOS 管理账号和登录状态' }));
    return;
  }

  // 首次启动引导：仅当系统中一个用户都没有时才开放，避免硬编码默认管理员密码
  app.post('/api/auth/bootstrap', (req, res) => {
    try {
      if (db.countUsers() > 0) return res.status(403).json({ error: '系统已初始化，请直接登录' });
      const { username, password, name } = req.body || {};
      if (!username || !password) return res.status(400).json({ error: 'username 与 password 必填' });
      if (String(password).length < 8) return res.status(400).json({ error: '密码至少 8 位' });
      const { pw_hash, pw_salt } = hashPassword(password);
      const u = db.createUser({ username, pw_hash, pw_salt, name: name || '管理员', role: 'admin' });
      res.json({ ok: true, user: u, hint: '首个管理员已创建，请登录' });
    } catch (e) { res.status(400).json({ error: e.message }); }
  });

  app.post('/api/auth/login', (req, res) => {
    try {
      const { username, password } = req.body || {};
      if (!username || !password) return res.status(400).json({ error: 'username 与 password 必填' });
      const u = db.getUserByUsername(username);
      if (!u || u.status !== 'active' || !verifyPassword(password, u)) {
        return res.status(401).json({ error: '用户名或密码错误' });
      }
      db.touchLogin(u.id);
      const s = db.createSession(u.id);
      res.json({ ok: true, token: s.token, expires_at: s.expires_at,
        user: { id: u.id, username: u.username, name: u.name, role: u.role } });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  app.post('/api/auth/logout', requireAuth, (req, res) => {
    try { db.deleteSession(req.token); res.json({ ok: true }); }
    catch (e) { res.status(500).json({ error: e.message }); }
  });

  app.get('/api/auth/me', requireAuth, (req, res) => {
    res.json({ user: req.user, roles: db.ROLES, mode: inventoryMode });
  });

  // ---- 用户管理（仅 admin）----
  app.get('/api/users', requireRole('admin'), (_req, res) => {
    try { res.json(db.listUsers()); } catch (e) { res.status(500).json({ error: e.message }); }
  });
  app.post('/api/users', requireRole('admin'), (req, res) => {
    try {
      const { username, password, name, role = 'operator' } = req.body || {};
      if (!username || !password) return res.status(400).json({ error: 'username 与 password 必填' });
      if (String(password).length < 8) return res.status(400).json({ error: '密码至少 8 位' });
      const { pw_hash, pw_salt } = hashPassword(password);
      res.json(db.createUser({ username, pw_hash, pw_salt, name: name || username, role }));
    } catch (e) { res.status(400).json({ error: e.message }); }
  });
  app.patch('/api/users/:id', requireRole('admin'), (req, res) => {
    try {
      const p = req.body || {};
      const patch = {};
      if (p.name != null) patch.name = p.name;
      if (p.role != null) patch.role = p.role;
      if (p.status != null) patch.status = p.status;
      if (p.password != null) {
        if (String(p.password).length < 8) return res.status(400).json({ error: '密码至少 8 位' });
        Object.assign(patch, hashPassword(p.password));
      }
      res.json(db.updateUser(req.params.id, patch));
    } catch (e) { res.status(400).json({ error: e.message }); }
  });

  // 定期清理过期会话（每 6 小时一次）
  const purge = () => { try { db.purgeExpiredSessions(); } catch (_) {} };
  purge();
  setInterval(purge, 6 * 3600 * 1000).unref?.();
}
