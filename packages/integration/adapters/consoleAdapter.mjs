// packages/integration/adapters/consoleAdapter.mjs
// 演示用出站适配器：把事件打印到控制台（不联网）。用它可在无外部系统的前提下验证
// outbox → Adapter → 标记已发的完整链路。生产接入时换成 genericHttpAdapter 或具体 WMS Adapter。
import { MappingOutboundAdapter } from '../adapter.mjs';

export class ConsoleAdapter extends MappingOutboundAdapter {
  constructor(mappingPath) { super('console-demo', mappingPath); this.preview = true; }
  async sendOne(eventType, body, idemKey) {
    console.log(`[outbox→console] ${eventType} idem=${idemKey}`, JSON.stringify(body));
    return { ok: true };
  }
}
