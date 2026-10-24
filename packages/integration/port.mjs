// packages/integration/port.mjs
// 集成端口定义（六边形架构）。核心域只依赖这些接口，不认识任何具体 WMS/ERP。
//
//  OutboundPort：本平台 → 外部（上架位置、移库、领用出库、盘点结果）
//  InboundPort ：外部 → 本平台（SKU 主数据、库位主数据、外部单据）
//
// 新增一个 WMS = 新写一个实现了这些接口的 Adapter，并注册到 outbox 派发器，核心代码零改动。

/**
 * @typedef {Object} OutboundPort
 * @property {string} system           外部系统标识（如 'kingdee' / 'generic-rest'）
 * @property {(eventType:string, payload:object) => Promise<void>} send  发送一条事件
 */

/**
 * @typedef {Object} InboundPort
 * @property {string} system
 * @property {() => Promise<any[]>} pullItems        拉取外部 SKU 主数据
 * @property {() => Promise<any[]>} pullLocations    拉取外部库位主数据
 */

export class OutboundAdapter {
  constructor(system) { this.system = system; }
  // 子类必须实现
  async send(eventType, payload) { throw new Error('not implemented'); }
}

export class InboundAdapter {
  constructor(system) { this.system = system; }
  async pullItems() { throw new Error('not implemented'); }
  async pullLocations() { throw new Error('not implemented'); }
}
