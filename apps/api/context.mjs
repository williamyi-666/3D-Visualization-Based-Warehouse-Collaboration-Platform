// 请求上下文：用 AsyncLocalStorage 保存「当前操作人」，供数据层写流水时自动带上。
// 选它的原因：并发安全（不靠全局变量），且无需改动 inbound/outbound/moveItem 等函数签名去层层透传 actor。
import { AsyncLocalStorage } from 'node:async_hooks';

export const actorStore = new AsyncLocalStorage();

/** 数据层读取当前操作人；未登录（如系统任务/ERP 同步）返回 null。 */
export function currentActor() {
  return actorStore.getStore() || null;
}
