// 使用 textContent 渲染外部业务文本，避免把来源系统字段当作 HTML。
let requestId=0;
export async function showExternalHistory(locCode,page=1) {
  const version=++requestId,box=document.getElementById('histBox');
  document.getElementById('histTitle').textContent='外部业务时间线 · '+locCode;
  document.getElementById('histModal').classList.remove('hidden');box.textContent='加载中…';
  try {
    const response=await fetch('/api/integration/events?'+new URLSearchParams({loc_code:locCode,page}));
    const data=await response.json();if(!response.ok)throw new Error(data.error||'加载失败');
    if(version!==requestId)return;
    box.replaceChildren();
    const hint=document.createElement('p');hint.className='muted';hint.textContent='由 ERP/WMS 回传的业务事件；库存同步日志不作为业务流水。';box.append(hint);
    if(!data.total){const empty=document.createElement('p');empty.textContent='暂无回传业务事件，可能尚未接入；不代表此格位没有历史业务。';box.append(empty);return;}
    const types={inbound:'入库',outbound:'出库',adjustment:'调整'};
    for(const row of data.rows){
      const card=document.createElement('article');card.className='card';
      const title=document.createElement('strong');title.textContent=types[row.type]+' · '+row.name+' · '+row.qty+' '+row.unit;
      const detail=document.createElement('p');detail.textContent=new Date(row.occurred_at).toLocaleString()+' · 来源 '+row.source+' · SKU '+row.sku+' · 批次 '+(row.batch_no||'无')+' · 单据 '+(row.document_no||'未提供');
      card.append(title,detail);box.append(card);
    }
    const footer=document.createElement('p');footer.textContent=`第 ${data.page}/${data.pages} 页 · 共 ${data.total} 条 `;
    for(const [label,target,disabled] of [['上一页',data.page-1,data.page<=1],['下一页',data.page+1,data.page>=data.pages]]){
      const button=document.createElement('button');button.textContent=label;button.disabled=disabled;button.onclick=()=>showExternalHistory(locCode,target);footer.append(button);
    }box.append(footer);
  }catch(error){if(version===requestId)box.textContent='加载失败：'+error.message;}
}
