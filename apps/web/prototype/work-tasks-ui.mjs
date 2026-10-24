import {formatBusinessTime} from './business-time.mjs';
const el=(tag,text,className)=>{const node=document.createElement(tag);if(text!=null)node.textContent=text;if(className)node.className=className;return node;};
export function renderWorkTasks(host,state,{canOperate,run,openJob,openCounter,openCount,locate,openTeam}){
  host.replaceChildren();
  const counts=state.counts;
  host.append(el('strong',`当前待办 · ${state.total} 项`),el('p',`盘点 ${counts.count+counts.draft}${counts.review?' · 待复核 '+counts.review:''} · 低库存 ${counts.low} · 作业清单 ${counts.jobs}${state.team?.total?' · 团队任务 '+state.team.total:''}`,'work-hint'));
  if(!state.total)host.append(el('p','当前没有待办。'));
  const attention=state.attention||[],handled=new Set(attention.map(row=>row.kind+':'+(row.id||row.item_id||row.loc_code)));
  if(attention.length){
    host.append(el('strong',`优先处理 · ${attention.length} 项`),el('p','按作业受阻、盘点复核、交接、低库存和盘点进度排序；同类按缺口比例或记录时间排列。','work-hint'));
    const expanded=host.dataset.attentionExpanded==='1';
    for(const task of expanded?attention:attention.slice(0,10)){
      const row=el('div',null,'work-row');row.append(el('strong',`${task.label} · ${task.title}`),el('small',[task.loc_code,task.detail,task.updated_at?formatBusinessTime(task.updated_at):''].filter(Boolean).join(' · ')));
      const evidence=el('details');evidence.append(el('summary','查看依据'));const data=task.evidence||{};
      if(data.task_id)evidence.append(el('p',`任务编号：${data.task_id}`),el('p',data.note||'状态来自团队任务办理记录。'));
      for(const line of data.lines||[])evidence.append(el('p',`${line.name}：计划 ${line.qty} ${line.unit}，已办 ${line.done_qty} ${line.unit}`));
      if(data.stocktake_id)evidence.append(el('p',`盘点单：${data.stocktake_id}`));
      for(const line of data.triggers||[])evidence.append(el('p',`${line.name}：账面 ${line.book_qty}，实盘 ${line.actual_qty}，差异 ${line.difference} ${line.unit}；${(line.reasons||[]).join('；')}`));
      if(task.kind==='low')evidence.append(el('p',`当前库区账面数量 ${data.qty} ${data.unit}，设置的最低数量 ${data.minimum} ${data.unit}。`));
      if(task.kind==='count')evidence.append(el('p',`盘点周期 ${data.count_days} 天；${data.last_counted_at?'上次核对 '+formatBusinessTime(data.last_counted_at):'尚无已确认的盘点或建账记录'}。`));
      if(task.kind==='draft')evidence.append(el('p','此盘点单尚未确认，未按草稿数量调整库存。'));
      row.append(evidence);
      if(task.kind==='team'){if(openTeam)action(row,'打开团队任务',()=>openTeam(task.id));}
      else if(canOperate)action(row,task.kind==='low'?'办理入库':task.kind==='review'?(state.role==='admin'?'复核盘点':'查看复核进度'):'打开盘点',()=>task.kind==='low'?openCounter(task.loc_code,'in',{itemCode:task.sku||task.item_id}):openCount(task.loc_code,{recordId:task.id}));
      if(task.loc_code&&locate)action(row,'3D定位',()=>locate(task.loc_code));host.append(row);
    }
    if(attention.length>10)action(host,expanded?'收起优先事项':`显示其余 ${attention.length-10} 项`,()=>{host.dataset.attentionExpanded=expanded?'0':'1';renderWorkTasks(host,state,{canOperate,run,openJob,openCounter,openCount,locate,openTeam});});
  }
  for(const task of state.team?.rows||[]){if(handled.has('team:'+task.id))continue;const row=el('div',null,'work-row');row.append(el('strong',task.title),el('small',`团队任务 · ${task.assignee_name} · 已办完 ${task.completed} / ${task.total} 项`));if(openTeam)action(row,'打开团队任务',()=>openTeam(task.id));host.append(row);}
  if(state.team?.total>state.team.rows.length&&openTeam)action(host,'查看全部团队任务',()=>openTeam());
  for(const job of state.jobs){
    const row=el('div',null,'work-row');row.append(el('strong',job.title),el('small',`作业清单 · 已完成 ${job.completed} / ${job.total} 项`));
    action(row,'继续清单',()=>openJob(job.id));host.append(row);
  }
  if(counts.jobs>state.jobs.length)host.append(el('small',`当前显示最近 ${state.jobs.length} 份，更多记录可到“我的作业清单”查看。`));
  for(const task of state.tasks.rows){
    if(handled.has(task.kind+':'+(task.id||task.item_id||task.loc_code)))continue;
    const row=el('div',null,'work-row');row.append(el('strong',task.title),el('small',[task.loc_code,task.detail].filter(Boolean).join(' · ')));
    if(canOperate)action(row,task.kind==='low'?'办理入库':task.kind==='draft'?'继续盘点':task.kind==='review'?(state.role==='admin'?'复核盘点':'查看复核进度'):'开始盘点',()=>task.kind==='low'?openCounter(task.loc_code,'in',{itemCode:task.sku||task.item_id}):openCount(task.loc_code,{recordId:task.id}));
    if(task.loc_code&&locate)action(row,'3D定位',()=>locate(task.loc_code));host.append(row);
  }
  function action(parent,title,fn){const button=el('button',title);button.type='button';button.onclick=()=>run(fn);parent.append(button);}
}
