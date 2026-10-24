// 业务“可用”与同步健康是两种状态；状态轮询不得把页面中的旧快照标成最新。
export function freshness(item, sources) {
  const source = sources?.find(s => s.source === item.source);
  if (!source) return {level:'warning', text:'同步状态未知，请刷新核实'};
  const labels = {failed:'最近同步失败，库存可能过期', stale:'更新超时，库存可能过期', waiting:'等待首次同步', unconfigured:'未设置更新周期，时效未确认'};
  const newer = Date.parse(source.received_at) > Date.parse(item.received_at);
  const text = labels[source.state] || (source.state === 'ok' ? '来源同步正常' : '同步状态未知');
  return {level:source.state === 'ok' && !newer ? 'ok' : 'warning', text:text + (newer ? '；已有更新，请刷新库存' : '')};
}

export function mountFreshness(parent, item) {
  const node=document.createElement('small');
  node.className='inventory-freshness';
  node.dataset.source=item.source || '';
  node.dataset.receivedAt=item.received_at || '';
  parent.append(node);
  paint(node);
}
function paint(node) {
  const value=freshness({source:node.dataset.source,received_at:node.dataset.receivedAt},window.SPATIAL_SOURCE_STATUS);
  node.textContent=value.text;
  node.style.cssText='display:block;margin:6px 0;font-size:12px;line-height:1.5;color:'+(value.level==='ok'?'#a7c7b7':'#fde68a');
}
if(typeof window!=='undefined')window.addEventListener('spatial-source-status',()=>{
  document.querySelectorAll('.inventory-freshness').forEach(paint);
});
