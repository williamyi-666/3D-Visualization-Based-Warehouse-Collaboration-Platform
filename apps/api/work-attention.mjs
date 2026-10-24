// 按业务状态与实际数值排序，不由模型推断异常；输入已由原业务服务按账号和库区过滤。
export function workAttention(tasks,team){
  const priorities={blocked:[0,'作业受阻'],review:[1,'盘点待复核'],handover:[2,'等待交接'],low:[3,'库存偏低'],count:[4,'到期盘点'],draft:[5,'盘点未完成'],awaiting_check:[6,'作业待确认']};
  return [...(tasks.rows||[]),...(team?.attention||[])].filter(row=>priorities[row.status||row.kind]).map(row=>{
    const [priority,label]=priorities[row.status||row.kind];
    const deficit=row.kind==='low'&&row.evidence?.minimum>0?(row.evidence.minimum-row.evidence.qty)/row.evidence.minimum:0;
    return {...row,priority,label,deficit};
  }).sort((a,b)=>a.priority-b.priority||b.deficit-a.deficit||String(a.updated_at||'').localeCompare(String(b.updated_at||''))||String(a.id||a.item_id||a.loc_code).localeCompare(String(b.id||b.item_id||b.loc_code)));
}
