// packages/integration/outbox.mjs
// 事件发件箱派发器：读取未发事件 → 找到能处理该事件类型的 Adapter → 幂等发送（带重试）→ 标记已发/死信。
// 这是「开放 API Webhook + WMS/ERP 上行同步」的统一引擎：核心域只管 emit()，同步全在这里发生。
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import * as db from '../../apps/api/db/index.mjs';
import { ConsoleAdapter } from './adapters/consoleAdapter.mjs';
import { GenericHttpAdapter } from './adapters/genericHttpAdapter.mjs';
import { SupOSAdapter } from './adapters/suposUnsAdapter.mjs';
import { SupOSEventAdapter } from './adapters/suposEventAdapter.mjs';
import { dispatchBatch } from './dispatch.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const MAP = join(__dirname, 'mapping');

const adapters = [];
let suposRef = null; // 记下 supos 适配器实例，便于状态 introspection
export function registerAdapter(a) { adapters.push(a); }

// 初始化：注册演示适配器；若配置了外部 REST 地址则自动注册通用适配器
export function init() {
  adapters.length = 0;
  suposRef = null;
  if (process.env.OUTBOUND_CONSOLE === '1') registerAdapter(new ConsoleAdapter(join(MAP, 'console-demo.yaml')));
  if (process.env.OUTBOUND_BASE_URL) {
    registerAdapter(new GenericHttpAdapter(join(MAP, 'generic-rest.yaml')));
    console.log('[integration] 已注册 generic-rest 适配器（OUTBOUND_BASE_URL 已配置）');
  }
  // supOS UNS 适配器：配了 Broker 走真实 MQTT；仅设 SUPOS_DRYRUN=1 则 dry-run（无 Broker 也能验证链路）
  if (process.env.SUPOS_MQTT_URL || process.env.SUPOS_DRYRUN || process.env.SUPOS_UNS_EVENT_ALIAS) {
    const Adapter = process.env.SUPOS_UNS_EVENT_ALIAS ? SupOSEventAdapter : SupOSAdapter;
    suposRef = new Adapter(join(MAP, 'supos-uns.yaml'));
    registerAdapter(suposRef);
    console.log('[integration] 已注册 supos-uns 适配器（Open supOS UNS / MQTT）');
  }
  console.log(`[integration] 已注册 ${adapters.length} 个出站适配器:`, adapters.map((a) => a.system).join(', '));
}

// 派发一轮未发事件。返回 {dispatched, failed, pending}
let inFlight;
export function dispatchOnce() {
  if (!inFlight) inFlight = dispatchBatch(db, adapters).finally(() => { inFlight = null; });
  return inFlight;
}

// 接口自检：列出已注册适配器状态；即使 supos 未启用也暴露「配置意图」，方便将来直接置入。
export function integrationStatus() {
  const list = adapters.map((a) => ({ system: a.system, ...(a.getStatus ? a.getStatus() : {}) }));
  if (!suposRef) {
    list.push({
      system: 'supos-uns',
      configured: !!process.env.SUPOS_MQTT_URL,
      mode: process.env.SUPOS_MQTT_URL
        ? 'live (not started — restart to enable)'
        : (process.env.SUPOS_DRYRUN ? 'dry (not started — restart to enable)' : 'disabled'),
      broker: process.env.SUPOS_MQTT_URL || null,
      tenant: process.env.SUPOS_TENANT || 'myfactory',
      connected: false,
      mqttInstalled: null,
      hint: '未接入：设置 SUPOS_MQTT_URL 并安装 mqtt 后重启即启用；未接入前事件在 outbox_event 中缓冲，启用后由启动派发 / POST /api/admin/sync 自动补发。',
    });
  }
  return {
    adapters: list,
    note: '事件仅在全部已配置目标确认后标记成功；模拟发送和失败保持 pending。至少一次投递，接收方须按事件 ID 去重。历史 sent 事件不自动回放。',
  };
}
