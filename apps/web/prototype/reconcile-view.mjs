const labels={sku:'SKU',name:'名称',loc_code:'三维库位',external_loc_code:'外部库位',qty:'数量',unit:'单位',batch_no:'批次',status:'状态',source:'来源',category:'分类'};
const text=value=>value==null?'—':typeof value==='object'?JSON.stringify(value):String(value);
export function reconcileRows(result) {
  return (result.differences || []).flatMap(diff=>{
    const expected=diff.expected,actual=diff.actual,identity=expected || actual || {};
    const base={kind:{missing:'展示库存缺失',unexpected:'展示库存多余',changed:'内容不一致'}[diff.kind] || diff.kind,sku:identity.sku || '—',loc:identity.loc_code || '—',batch:identity.batch_no || '无',status:identity.status || '—'};
    const keys=new Set([...Object.keys(expected || {}),...Object.keys(actual || {})]);
    return [...keys].filter(key=>!['id','item_id'].includes(key) && JSON.stringify(expected?.[key])!==JSON.stringify(actual?.[key]))
      .map(key=>({...base,field:labels[key] || key,expected:text(expected?.[key]),actual:text(actual?.[key])}));
  });
}

export function renderReconcile(doc,result,caption) {
  const get=id=>doc.getElementById(id);
  get('reconcileResultBox').hidden=false;
  get('reconcileCaption').textContent=caption;
  get('reconcileRows').replaceChildren();
  if(!result){get('reconcileSummary').textContent='该历史记录未保存差异明细，请使用对应来源的当前版本重新对账。';get('reconcileResult').textContent='未保存历史明细';return;}
  get('reconcileSummary').textContent=`${result.matched?'对账一致':'发现 '+result.difference_count+' 条库存差异'} · ERP/WMS ${result.expected_count} 条 / 当前展示 ${result.actual_count} 条。库存未修改。`+
    (result.truncated?` 当前仅保存并展示前 ${result.differences.length} 条差异，不能将此列表当作完整结果。`:'');
  for(const item of reconcileRows(result)) {
    const tr=doc.createElement('tr');
    for(const key of ['kind','sku','loc','batch','status','field','expected','actual']){const td=doc.createElement('td');td.textContent=item[key];tr.append(td);}
    get('reconcileRows').append(tr);
  }
  get('reconcileResult').textContent=JSON.stringify(result,null,2);
}
