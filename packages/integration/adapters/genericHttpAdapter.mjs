// packages/integration/adapters/genericHttpAdapter.mjs
// 通用 REST 出站适配器：按 YAML 映射把事件转成远程字段，POST 到外部系统。
// 鉴权/地址支持从环境变量解析（映射里写成 ${ENV_NAME}）。新增具体 WMS 可继承它并覆盖路径/签名。
import { MappingOutboundAdapter, getNested } from '../adapter.mjs';

function envResolve(str) {
  if (typeof str !== 'string') return str;
  return str.replace(/\$\{(\w+)\}/g, (_, n) => process.env[n] || '');
}

export class GenericHttpAdapter extends MappingOutboundAdapter {
  constructor(mappingPath) {
    super('generic-rest', mappingPath);
    this.baseUrl = envResolve(this.mapping.base_url || '');
    this.authHeader = envResolve(this.mapping.auth_header || '');
  }
  // 事件类型 → HTTP 路径/方法（映射里可配；缺省 POST /{eventType}）
  routeFor(eventType) {
    const r = getNested(this.mapping, 'route.' + eventType);
    if (r) { const [method, path] = r.split(' '); return { method: (method || 'POST').toUpperCase(), path }; }
    return { method: 'POST', path: '/' + eventType.replace(/\./g, '/') };
  }
  async sendOne(eventType, body, idemKey) {
    if (!this.baseUrl) throw new Error('generic-rest 未配置 base_url（映射里用 ${ENV_NAME} 指向环境变量）');
    const { method, path } = this.routeFor(eventType);
    const resp = await fetch(this.baseUrl + path, {
      method,
      headers: { 'Content-Type': 'application/json', 'Idempotency-Key': String(idemKey), ...(this.authHeader ? { Authorization: this.authHeader } : {}) },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(10000),
    });
    if (!resp.ok) throw new Error('http ' + resp.status);
    return { ok: true };
  }
}
