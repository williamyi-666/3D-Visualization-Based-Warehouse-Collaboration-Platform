// 至少一次投递：所有目标确认后才标记成功，接收方用事件 ID 去重。
import { getNested } from './adapter.mjs';
export async function dispatchBatch(db, adapters) {
  const events = await db.getPendingOutbox();
  let dispatched = 0, failed = 0;
  for (const ev of events) {
    const targets = adapters.filter(a => !a.preview && getNested(a.mapping, ev.event_type));
    if (!targets.length) continue;
    try {
      const raw=JSON.parse(ev.payload_json);
      const payload=db.prepareOutboundPayload ? await db.prepareOutboundPayload(raw) : raw;
      for (const adapter of targets) {
        const result = await adapter.send(ev.event_type, { ...payload, _idem: ev.id });
        if (!result?.ok || result.dry || result.skipped) throw new Error(adapter.system + ' 未确认真实投递');
      }
      await db.markOutboxSent(ev.id);
      dispatched++;
    } catch (e) {
      await db.markOutboxRetry(ev.id, e);
      failed++;
    }
  }
  return { total: events.length, dispatched, failed, pending: events.length - dispatched };
}
