// packages/integration/adapter.mjs
// 集成基建：YAML 字段映射加载（极简点号键格式）、映射应用、指数退避重试、幂等键封装。
import { readFileSync, existsSync } from 'node:fs';
import { OutboundAdapter } from './port.mjs';

// ---- 极简 YAML 加载（仅支持 `key: value` 与 `a.b.c: value` 点号嵌套，够用且稳健）----
export function loadMapping(path) {
  if (!existsSync(path)) throw new Error('映射文件不存在: ' + path);
  const out = {};
  for (const raw of readFileSync(path, 'utf8').split('\n')) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const idx = line.indexOf(':');
    if (idx < 0) continue;
    const key = line.slice(0, idx).trim();
    const val = line.slice(idx + 1).trim();
    if (!key) continue;
    setDeep(out, key.split('.'), val);
  }
  return out;
}
function setDeep(obj, keys, val) {
  let cur = obj;
  for (let i = 0; i < keys.length - 1; i++) {
    if (typeof cur[keys[i]] !== 'object' || cur[keys[i]] === null) cur[keys[i]] = {};
    cur = cur[keys[i]];
  }
  cur[keys[keys.length - 1]] = val;
}

// 按 'a.b.c' 取嵌套值（用于事件类型点号键）
export function getNested(obj, dotted) {
  let cur = obj;
  for (const k of dotted.split('.')) {
    if (cur == null) return undefined;
    cur = cur[k];
  }
  return cur;
}

// 把本地 payload 按映射段转成外部系统字段对象
//   mapSection 形如 { name:'name', qty:'quantity' }（远程字段 -> 本地字段）
//   返回 { name: payload.name, quantity: payload.qty }
export function applyMapping(mapSection, payload = {}) {
  const out = {};
  if (!mapSection) return out;
  for (const [remoteKey, localKey] of Object.entries(mapSection)) {
    if (localKey in payload) out[remoteKey] = payload[localKey];
  }
  return out;
}

// 指数退避重试（默认 5 次）
export async function withRetry(fn, attempts = 5) {
  let lastErr;
  for (let i = 0; i < attempts; i++) {
    try { return await fn(); }
    catch (e) { lastErr = e; if (i < attempts - 1) { const wait = Math.min(1000 * 2 ** i, 30000); await new Promise((r) => setTimeout(r, wait)); } }
  }
  throw lastErr;
}

// 通用出站适配器基类：负责「取映射 → 转字段 → 幂等发送 → 重试」
export class MappingOutboundAdapter extends OutboundAdapter {
  constructor(system, mappingPath) {
    super(system);
    this.mapping = loadMapping(mappingPath);
  }
  // 子类实现真正传输：sendOne(eventType, remoteBody, idemKey)
  async send(eventType, payload) {
    const section = getNested(this.mapping, eventType);
    const body = applyMapping(section, payload);
    return withRetry(() => this.sendOne(eventType, body, payload._idem || eventType));
  }
  async sendOne(/* eventType, body, idemKey */) { throw new Error('sendOne not implemented'); }
}
