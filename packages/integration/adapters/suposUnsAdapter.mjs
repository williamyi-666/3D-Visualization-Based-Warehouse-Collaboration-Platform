// MQTT 事件出站适配；非保留消息、QoS 1，仅代表 Broker 确认。
// 不等同于 Open supOS UNS 模型注册或 ERP/WMS 业务处理成功。
import { MappingOutboundAdapter, applyMapping, getNested, withRetry } from '../adapter.mjs';

// 把 LOC 编码转成 UNS 路径段数组（仅在 WH- 仓库体系下做结构化解析）
function locToUnsSegments(loc) {
  if (!loc) return ['node', 'unknown'];
  const p = String(loc).split('-');
  if (p[0] === 'WH' && p.length >= 2) {
    const segs = [`WH-${p[1]}`];
    for (let i = 2; i < p.length; i++) {
      const s = p[i];
      if (/^F\d+$/.test(s)) segs.push('floor', s);      // F1/F2… 地面区
      else if (/^L\d+$/.test(s)) segs.push('layer', s); // L01… 层
      else if (/^B\d+$/.test(s)) segs.push('bin', s);   // B01… 位
      else segs.push('rack', s);                        // A/B/C… 货架
    }
    return segs;
  }
  return ['node', String(loc)];
}

// 从 payload 取 LOC（不同事件的字段名不同）
function locFromPayload(eventType, payload) {
  if (payload.loc_code) return payload.loc_code;
  if (payload.rack_code) return payload.rack_code;
  if (payload.furn_code) return payload.furn_code;
  if (payload.room_code) return payload.room_code;
  if (payload.site_code) return payload.site_code;
  return null;
}

// 解析 ${ENV} 与 ${ENV:default}
function envResolve(str) {
  if (typeof str !== 'string') return str;
  return str.replace(/\$\{(\w+)(?::([^}]*))?\}/g, (_, n, d) => (process.env[n] ?? (d ?? '')));
}

export class SupOSAdapter extends MappingOutboundAdapter {
  constructor(mappingPath) {
    super('supos-uns', mappingPath);
    this.brokerUrl = envResolve(this.mapping.broker_url || '');
    this.tenant = envResolve(this.mapping.tenant || 'myfactory');
    this.username = envResolve(this.mapping.username || '');
    this.password = envResolve(this.mapping.password || '');
    this.qos = 1;
    this.connected = false;
    this._mqttOk = null;   // 懒加载结果：true 已装 / false 缺失 / null 未尝试
    this._client = null;
    this._connecting = null;
  }

  // 事件类型 → UNS topic（模板占位符替换）
  topicFor(eventType, payload) {
    const tpl = getNested(this.mapping, 'topic.' + eventType);
    if (!tpl) return null;
    const loc=locFromPayload(eventType,payload);
    if(!loc) return null;
    const uns = locToUnsSegments(loc).map(encodeURIComponent).join('/');
    return tpl
      .replace(/\{tenant\}/g, encodeURIComponent(this.tenant))
      .replace(/\{uns\}/g, uns)
      .replace(/\{attr\}/g, getNested(this.mapping, 'attr.' + eventType) || '')
      .replace(/\/+$/g, '');
  }

  // 懒连接：仅在配置了 Broker 且 mqtt 可用时尝试；否则保持待发送。
  // 断线由现有 MQTT 客户端自动重连；Broker 不可达不会判事件死信。
  async ensureClient() {
    if (!this.brokerUrl) return null;            // 无 Broker 配置：发布失败
    if (this._client && this.connected) return this._client;
    if (this._client) return this._client; // MQTT 客户端自行重连，避免每轮创建新连接。
    if (this._connecting) return this._connecting;
    this._connecting = (async () => {
      let mqtt;
      try { mqtt = await import('mqtt'); this._mqttOk = true; }
      catch {
        this._mqttOk = false;
        console.warn('[supos-uns] 未安装 mqtt 包，事件保持待发送。安装：npm i mqtt');
        throw new Error('mqtt 依赖未安装');
      }
      const client = mqtt.connect(this.brokerUrl, {
        username: this.username || undefined,
        password: this.password || undefined,
        reconnectPeriod: 3000,
        connectTimeout: 8000,
      });
      client.on('connect', () => {
        this.connected = true;
        console.log('[supos-uns] 已连接 Broker:', this.brokerUrl);
      });
      this._client = client;
      client.on('close', () => { this.connected = false; });
      client.on('offline', () => { this.connected = false; });
      client.on('error', (e) => console.error('[supos-uns] Broker 错误:', e.message));
      // 等待首次连接；失败保持待发送，后续重连可恢复
      await new Promise((res) => {
        const t = setTimeout(() => res(), 8000);
        client.once('connect', () => { clearTimeout(t); res(); });
        client.once('error', () => { clearTimeout(t); res(); });
      });
      if (this.connected) this._client = client;
      return this._client;
    })();
    try { return await this._connecting; } finally { this._connecting = null; }
  }

  async publish(topic, payload, idemKey) {
    if (process.env.SUPOS_DRYRUN === '1') return { ok: false, dry: true };
    const client = await this.ensureClient();
    if (!this.brokerUrl || !client || !this.connected) {
      // 仅在显式 dry-run 时打印，避免无 Broker 配置刷屏
      if (process.env.SUPOS_DRYRUN) {
        console.log(`[outbox→supos-uns|dry] ${topic} idem=${idemKey}`, JSON.stringify(payload));
      }
      throw new Error('MQTT 未连接，事件保持待发送');
    }
    await new Promise((res, rej) => {
      const timer = setTimeout(() => rej(new Error('MQTT 确认超时')), 10000);
      client.publish(topic, JSON.stringify({ ...payload, event_id: idemKey }), { qos: this.qos, retain: false }, (e) => { clearTimeout(timer); e ? rej(e) : res(); });
    });
    return { ok: true };
  }

  // 覆盖基类 send：先算 UNS topic，再按映射转字段，最后发布（withRetry 幂等重试）
  async send(eventType, payload) {
    const topic = this.topicFor(eventType, payload);
    if (!topic) { console.warn(`[supos-uns] 缺少 topic 映射或可靠库位，保留待发送 ${eventType}`); return { ok: false, skipped: true }; }
    const { _idem, ...data } = payload;
    const body = { ...data, ...applyMapping(getNested(this.mapping, eventType), payload), event_type: eventType };
    // 透传关键标识，方便 supOS 侧关联本地 / ERP 主键
    if (payload.item_id) body.item_id = payload.item_id;
    if (payload.erp_code) body.erp_code = payload.erp_code;
    return withRetry(() => this.publish(topic, body, payload._idem || eventType));
  }

  // 状态自检（供 /api/admin/integration 使用）
  getStatus() {
    const mode = !this.brokerUrl
      ? 'disabled (no broker configured)'
      : (this.connected ? 'live' : 'disconnected / pending');
    return {
      system: 'supos-uns',
      configured: !!this.brokerUrl,
      mode,
      broker: this.brokerUrl || null,
      tenant: this.tenant,
      connected: !!this.connected,
      mqttInstalled: this._mqttOk,
    };
  }
}
