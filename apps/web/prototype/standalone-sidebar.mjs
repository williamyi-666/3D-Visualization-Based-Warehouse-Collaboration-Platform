import {capacitySummary} from '../../../packages/three-kit/sku-capacity.mjs';
// 独立库存沿用现有卡片样式；库存变化只能从明确的业务操作进入。
export function renderStandaloneSidebar(el,entry,access,actions) {
  const doc=el.ownerDocument;
  const node=(tag,text,className)=>{const e=doc.createElement(tag);if(text!=null)e.textContent=text;if(className)e.className=className;return e;};
  const button=(parent,label,run)=>{const b=node('button',label,'business-link');b.type='button';b.onclick=run;parent.append(b);return b;};
  el.replaceChildren();
  const header=node('div',null,'card cell-summary');header.append(node('h3',entry.meta?.name||entry.locCode),node('p',entry.locCode,'hint'));
  header.append(node('p',`独立库存 · ${entry.items.length} 种货品`,'hint'));
  button(header,'📍 定位到此格位',actions.locate).id='locateBtn';
  header.append(node('p','状态：'+({normal:'正常',locked:'锁定标记',stocktaking:'盘点标记'}[entry.status]||'正常'),'cell-status'));
  if(entry.capacityState) {
    header.append(node('p',capacitySummary(entry.capacityState),'hint'));
    if(entry.capacityState.basis==='estimated')header.append(node('p',entry.capacityState.note+'，请核对现场净空。','hint'));
  }
  if(access?.canManage)button(header,entry.capacityState?.basis==='manual'?'调整SKU容量':'设置SKU容量',actions.capacity || actions.edit).id='cellCapacityBtn';
  const details=node('details',null,'cell-details');details.append(node('summary','查看详细属性'));
  const facts=node('dl',null,'inventory-properties');
  for(const [label,value] of [['SKU容量',entry.capacityState?.capacity==null?'待确认':entry.capacityState.capacity+' '+entry.capacityState.product.unit+'（'+(entry.capacityState.basis==='manual'?'现场核定':'估算')+'）'],['承重',entry.meta?.max_load==null?'未设置':entry.meta.max_load+' kg'],['标签',(entry.meta?.tags||[]).join('、')||'无'],['备注',entry.meta?.note||'无']])facts.append(node('dt',label),node('dd',String(value)));
  details.append(facts);header.append(details);el.append(header);
  if(access?.canOperate){const operations=node('div',null,'card');operations.append(node('h3','库存操作'));const row=node('div',null,'cell-operations');operations.append(row);for(const [key,label] of [['in','入库'],['out','出库'],['move','移库']]){const b=button(row,label,()=>actions.counter(key));b.id='cell-'+key;b.disabled=key!=='in'&&!entry.items.length;}el.append(operations);}
  for(const item of entry.items){const card=node('article',null,'item-card standalone-item');card.append(node('h4',item.name),node('p',`${item.qty} ${item.unit||'件'}`,'inventory-quantity'),node('p','SKU：'+(item.sku||'未设置'),'hint'));if(item.reserved_qty)card.append(node('p',`任务预占 ${item.reserved_qty} · 可用 ${item.available_qty} ${item.unit||'件'}`,'hint'));if(item.note)card.append(node('p',item.note));if(actions.storage&&(item.item_id||item.id))button(card,access?.canOperate?'存放资料 / 推荐':'存放资料',()=>actions.storage(item.item_id||item.id));el.append(card);}
  if(!entry.items.length)el.append(node('p','此格位暂无库存','muted'));
  const tools=node('div',null,'card cell-tools');button(tools,'库存流水',actions.history);button(tools,'打印格位码',actions.qr);
  button(tools,access?.canOperate?'盘点此格位':'查看盘点记录',actions.stocktake).id='cellStocktakeBtn';
  if(access?.canManage)button(tools,'格位属性',actions.edit);
  for(const url of entry.photos||[]){const b=button(tools,'查看现场照片',()=>actions.photo(url));const img=node('img');img.src=url;img.alt='格位现场照片';img.style.cssText='width:72px;height:56px;object-fit:cover';b.replaceChildren(img);}
  if(access?.canManage)button(tools,'拍照 / 管理照片',actions.photos);
  el.append(tools);
}
