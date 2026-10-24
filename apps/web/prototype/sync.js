let accessUsers=[],accessRows=[];
if(window.SPATIAL_RUNTIME?.provider!=='supos'){
  const managementFetch=window.fetch.bind(window);
  window.fetch=(url,options={})=>{const headers=new Headers(options.headers),token=localStorage.getItem('spatial_token');if(token)headers.set('Authorization','Bearer '+token);return managementFetch(url,{...options,headers});};
}
import {openItemCodes} from './item-codes-ui.mjs';
import {createAssistantSettingsUI} from './assistant-settings-ui.mjs';
import {createKnowledgeSettingsUI} from './knowledge-ui.mjs';
const modelSettings=createAssistantSettingsUI(document.getElementById('assistantModelSettings'));
const knowledgeSettings=createKnowledgeSettingsUI(document.getElementById('knowledgeSettings'));
const standalone=window.SPATIAL_RUNTIME?.mode==='standalone';
if(standalone){const entry=document.createElement('button');entry.textContent='货品编码整理 · 条码与正式编号';entry.type='button';entry.style.margin='12px 0';entry.onclick=()=>openItemCodes().catch(error=>{document.getElementById('message').textContent=error.message;});document.querySelector('main')?.prepend(entry);}
const accessRoleName=role=>({admin:'平台管理员',spaceAdmin:'空间维护',operator:'库存操作',viewer:'只读查看'})[role] || '沿用部署配置';
let spacePage=1;
import {renderReconcile as renderReconcileTable} from './reconcile-view.mjs';
import {parseReconcile,reconcileCSV} from './reconcile-file.mjs';
let exportReconcile=null;
function renderReconcile(doc,result,caption){
  exportReconcile=result?{result,caption}:null;
  doc.getElementById('reconcileExport').disabled=!result;
  renderReconcileTable(doc,result,caption);
}
import {auditChanges} from './audit-diff.mjs';
const $ = id => document.getElementById(id);
function showPanel(name) {
  if(standalone&&!['permissions','audit','model'].includes(name))name='permissions';
  if(!['running','connection','permissions','audit','model'].includes(name))name='running';
  document.querySelectorAll('section[data-panel]').forEach(section=>{section.hidden=section.dataset.panel!==name;});
  document.querySelectorAll('#managementNav button').forEach(button=>button.setAttribute('aria-pressed',String(button.dataset.panel===name)));
  if(name==='model'){void modelSettings.refresh();void knowledgeSettings.refresh();}
}
document.querySelectorAll('#managementNav button').forEach(button=>{button.onclick=()=>{location.hash=button.dataset.panel;showPanel(button.dataset.panel);};});
window.addEventListener('hashchange',()=>showPanel(location.hash.slice(1)));
showPanel(location.hash.slice(1));
const message = text => { $('message').textContent = text; };
let historyRows=[],historyPage=1,historyPages=1,historyThrough=null,historyVersion=0;
let auditSelection=0,reconcileSelection=0;
async function api(path, options) {
  const res = await fetch('/api/integration/' + path, options);
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || '请求失败');
  return data;
}
const date = value => value ? new Date(value.includes('T') ? value : value + 'Z').toLocaleString() : '—';
function cell(row, text) { const td = document.createElement('td'); td.textContent = text; row.append(td); return td; }
async function loadBackupStatus() {
  try {
    const res=await fetch('/api/admin/backup/status');
    if(!res.ok)throw new Error('备份状态读取失败（HTTP '+res.status+'），请重试');
    const s=await res.json();
    $('backupStatus').textContent=[s.enabled?'自动备份已启用 · 间隔 '+Math.round(s.interval_ms/60000)+' 分钟 · 保留 '+s.keep+' 份':'自动备份未启用：'+s.config_error,
      '最近尝试：'+date(s.last_attempt_at),'最近成功：'+date(s.last_success_at),
      '最近结果：'+({none:'尚无记录（启动后约30秒首次执行）',success:'成功',failed:'失败：'+s.error})[s.last_result],
      s.bundle?'最近成功备份：'+s.bundle:'',s.persistence_error || ''].filter(Boolean).join('\n');
    $('backupStatus').style.whiteSpace='pre-wrap';
    $('backupStatus').classList.toggle('failed',!s.enabled || s.last_result==='failed' || !!s.persistence_error);
  } catch(error){$('backupStatus').textContent=error.message;$('backupStatus').classList.add('failed');}
}
async function refresh() {
  await loadWarehouseAccess();
  await loadBackupStatus();
  const spaceQuery=new URLSearchParams(new FormData($('spaceAuditFilter')));spaceQuery.set('page',spacePage);
  const [credentials, mappings, operationPage, status] = await Promise.all([standalone?[]:api('credentials'), standalone?[]:api('locations'), api('space-history?'+spaceQuery), standalone?{sources:[]}:api('status')]);
  $('knownSources').replaceChildren();
  for(const name of [...new Set([...status.sources.map(s=>s.source),...credentials.map(c=>c.source).filter(Boolean)])].sort()) {
    const option=document.createElement('option');option.value=name;$('knownSources').append(option);
  }
  $('sourceStates').replaceChildren();
  for(const source of status.sources) {
    const row=document.createElement('tr');
    cell(row,source.source);cell(row,({ok:'正常',stale:'更新超时',failed:'最近同步失败',waiting:'尚未同步',unconfigured:'未配置周期'})[source.state]+(source.state==='failed' && source.stale?' · 旧库存已超时':''));
    cell(row,date(source.received_at));cell(row,source.expected_interval_minutes?source.expected_interval_minutes+' 分钟':'未配置');
    const edit=document.createElement('button');edit.textContent='修改周期';edit.onclick=()=>{
      $('sourcePolicyForm').elements.namedItem('source').value=source.source;
      $('sourcePolicyForm').elements.namedItem('expected_interval_minutes').value=source.expected_interval_minutes;
    };cell(row,'').append(edit);$('sourceStates').append(row);
  }
  if(!status.sources.length){const row=document.createElement('tr');cell(row,'暂无来源，可先配置周期等待首次同步。').colSpan=5;$('sourceStates').append(row);}
  const operations=operationPage.rows;spacePage=operationPage.page;
  $('spacePage').textContent='第 '+spacePage+' / '+operationPage.pages+' 页，共 '+operationPage.total+' 条';
  $('spacePrev').disabled=spacePage<=1;$('spaceNext').disabled=spacePage>=operationPage.pages;
  $('spaceHistory').replaceChildren();
  const actionNames={cloneRack:'复制货架',setCellMeta:'修改格位属性',setCellsMeta:'批量修改格位属性',createSite:'新增仓库',createRoomNode:'新增库区',setRoom:'修改库区',updateRack:'修改货架',setRackCells:'格位合并与命名',setRackMerges:'合并格位',setCellNames:'格位命名',saveLayout:'保存布局',createRack:'新增货架',deleteRack:'删除货架',deleteRoom:'删除库区'};
  for (const op of operations) {
    const row=document.createElement('tr'); cell(row,date(op.created_at));cell(row,op.actor_name);cell(row,actionNames[op.action] || op.action);cell(row,op.changed_count);
    const button=document.createElement('button');button.textContent='查看';button.onclick=async()=>{
      const selection=++auditSelection;
      button.disabled=true;
      try {
        const d=await api('space-history/'+op.id);
        if(selection!==auditSelection)return;
        $('spaceDetail').textContent=JSON.stringify(d,null,2);
        $('auditRows').replaceChildren();
        for(const change of auditChanges(d.before,d.after)) {
          const tr=document.createElement('tr');
          for(const key of ['node','action','field','before','after'])cell(tr,change[key]);
          $('auditRows').append(tr);
        }
        if(!$('auditRows').children.length){const tr=document.createElement('tr');cell(tr,'未发现字段差异').colSpan=5;$('auditRows').append(tr);}
        $('auditCaption').textContent=`${actionNames[op.action] || op.action} · ${d.actor_name} · ${date(op.created_at)}`;
        $('spaceDetailBox').hidden=false;$('spaceDetailBox').open=true;
        $('spaceDetailBox').scrollIntoView({behavior:'smooth',block:'nearest'});
      } catch(e){message(e.message);} finally {button.disabled=false;}
    };cell(row,'').append(button);$('spaceHistory').append(row);
  }
  if (!operations.length) {const row=document.createElement('tr');cell(row,spaceQuery.get('actor') || spaceQuery.get('action') ? '没有符合筛选条件的记录，可清除筛选查看全部。' : '暂无空间操作记录，保存布局或修改格位后可在此查看。').colSpan=5;$('spaceHistory').append(row);}
  $('mappings').replaceChildren();
  for (const m of mappings) {
    const row=document.createElement('tr'); cell(row,m.source); cell(row,m.external_loc_code);
    const link=document.createElement('a'); link.href='./index.html?loc='+encodeURIComponent(m.loc_code); link.textContent=m.loc_code;
    cell(row,'').append(link);
    const action=cell(row,'');
    const edit=document.createElement('button'); edit.textContent='编辑'; edit.onclick=()=>{
      for (const key of ['source','external_loc_code','loc_code']) $('mappingForm').elements.namedItem(key).value=m[key];
      $('mappingForm').scrollIntoView({behavior:'smooth',block:'center'});
    };
    const remove=document.createElement('button'); remove.textContent='删除'; remove.style.marginLeft='8px';
    remove.className='danger';
    remove.onclick=async()=>{if(!confirm(`删除映射 ${m.source} / ${m.external_loc_code} → ${m.loc_code}？后续按该外部库位同步时需要重新配置。`))return;remove.disabled=true;try{await api('locations/'+m.id,{method:'DELETE'});await refresh();message('未引用的映射已删除');}catch(e){message(e.message);}finally{remove.disabled=false;}};
    action.append(edit,remove); $('mappings').append(row);
  }
  if (!mappings.length) { const row=document.createElement('tr'); cell(row,'暂无映射，请先填写来源、外部库位和三维格位。').colSpan=4; $('mappings').append(row); }
  $('credentials').replaceChildren();
  for (const t of credentials) {
    const row = document.createElement('tr');
    cell(row,t.name); cell(row,t.source); cell(row,t.revoked?'已吊销':'有效'); cell(row,date(t.last_used_at));
    const action = cell(row,'');
    if (!t.revoked) {
      const button = document.createElement('button'); button.textContent = '吊销';
      button.onclick = async () => {
        if (!confirm(`吊销“${t.name}”后，该凭证立即失效。可以新建凭证恢复接入。`)) return;
        try { await api('credentials/' + encodeURIComponent(t.id), {method:'DELETE'}); await refresh(); message('凭证已吊销'); }
        catch(e) { message(e.message); }
      };
      action.append(button);
    }
    $('credentials').append(row);
  }
  if(!standalone)await loadHistory();
}
function renderHistory() {
  $('history').replaceChildren();
  const history=historyRows;
  for (const t of history) {
    const row = document.createElement('tr');
    cell(row,date(t.created_at)); cell(row,t.source); cell(row,t.version); cell(row,t.row_count);
    cell(row,({snapshot:'全量',delta:'增量',reconcile:'对账',events:'业务事件'})[t.kind] || t.kind);
    cell(row,({applied:'已应用',skipped:'已跳过',failed:'失败',matched:'一致',different:'存在差异'})[t.result] || t.result).className=t.result;
    cell(row,t.message+(t.retry_of?'（补发自 #'+t.retry_of+'）':''));
    const action=cell(row,'');
    if(t.retryable) {
      const button=document.createElement('button');button.textContent='补发';
      button.onclick=async()=>{button.disabled=true;try{const result=await api('retry/'+t.id,{method:'POST'});await refresh();message(result.reason || (result.reconciled?'对账已重新执行':'补发已应用'));}catch(e){message(e.message);await refresh();}finally{button.disabled=false;}};
      action.append(button);
    }
    if(t.kind==='reconcile' && ['matched','different'].includes(t.result)) {
      const detail=document.createElement('button');detail.textContent='查看对账';
      detail.onclick=async()=>{
        const selection=++reconcileSelection;detail.disabled=true;
        try {
          const data=await api('history/detail/'+t.id);
          if(selection!==reconcileSelection)return;
          renderReconcile(document,data.details,`${data.source} · 版本 ${data.version} · ${date(data.created_at)}`);
          message('正在查看历史对账结果：'+data.source+' · 版本 '+data.version);
          showPanel('connection');location.hash='connection';
          $('reconcileResultBox').scrollIntoView({behavior:'smooth',block:'start'});
        } catch(error){message(error.message);}finally{detail.disabled=false;}
      };
      action.append(detail);
    }
    $('history').append(row);
  }
  if (!history.length) { const row=document.createElement('tr'); cell(row,'当前查询条件下没有同步记录').colSpan=8; $('history').append(row); }
}
$('create').onsubmit = async event => {
  event.preventDefault(); const button=event.submitter; button.disabled=true;
  try {
    const values=Object.fromEntries(new FormData(event.target));
    const data=await api('credentials',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(values)});
    $('secret').value=data.token; $('secretBox').hidden=false;
    message('凭证已创建，请保存后配置到 ERP/WMS 的服务端。'); await refresh();
  } catch(e) { message(e.message); } finally { button.disabled=false; }
};
$('clearSecret').onclick=()=>{$('secret').value='';$('secretBox').hidden=true;};
$('mappingForm').onsubmit=async event=>{
  event.preventDefault(); const button=event.submitter; button.disabled=true;
  try { await api('locations',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(Object.fromEntries(new FormData(event.target)))}); await refresh(); message('库位映射已保存；同来源、同外部库位再次保存可修改目标格位。'); }
  catch(e){message(e.message);}finally{button.disabled=false;}
};
let reconcileFileVersion=0;
const inputSummary=input=>input.source+' · 版本 '+input.version+' · '+input.rows.length+' 条记录；格式检查通过，库位映射和版本将在对账时校验';
$('reconcileValidate').onclick=()=>{
  try{
    const summary=inputSummary(parseReconcile($('reconcileInput').value));
    $('reconcileFileStatus').textContent=summary;message(summary);
  }catch(error){$('reconcileFileStatus').textContent=error.message;message(error.message);}
};
$('reconcileFile').onchange=async event=>{
  const file=event.target.files[0],version=++reconcileFileVersion;if(!file)return;
  try{
    if(file.size>50*1024*1024)throw Error('文件不能超过50MB');
    const text=await file.text();const input=parseReconcile(text);
    if(version!==reconcileFileVersion)return;
    $('reconcileInput').value=JSON.stringify(input,null,2);
    $('reconcileFileStatus').textContent=file.name+' · '+inputSummary(input);
    $('reconcileResultBox').hidden=true;
  }catch(error){if(version===reconcileFileVersion)$('reconcileFileStatus').textContent='未导入，原输入保留：'+error.message;}
};
$('reconcileInput').addEventListener('input',()=>{reconcileFileVersion++;$('reconcileFileStatus').textContent='已手动修改，请重新检查格式';});
$('reconcileExport').onclick=()=>{
  if(!exportReconcile)return;
  const blob=new Blob([reconcileCSV(exportReconcile.result,exportReconcile.caption)],{type:'text/csv;charset=utf-8'});
  const url=URL.createObjectURL(blob),link=document.createElement('a');link.href=url;link.download='库存对账差异.csv';link.click();setTimeout(()=>URL.revokeObjectURL(url),1000);
};
$('reconcileForm').onsubmit=async event=>{
  event.preventDefault();const button=event.submitter;const selection=++reconcileSelection;button.disabled=true;$('reconcileResultBox').hidden=true;
  try {
    const input=parseReconcile($('reconcileInput').value);
    $('reconcileFileStatus').textContent=inputSummary(input);
    const result=await api('snapshot',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({...input,mode:'reconcile'})});
    if(selection===reconcileSelection)renderReconcile(document,result,`${input.source} · 版本 ${input.version}`);
    message(result.matched?'对账一致':'发现 '+result.difference_count+' 项差异，库存未修改');await refresh();
  }catch(e){message(e.message);}finally{button.disabled=false;}
};
async function loadHistory(page=1,reset=true) {
  const version=++historyVersion;
  const params=new URLSearchParams({page,page_size:25,result:$('historyFilter').value});
  const source=$('historySource').value.trim();if(source)params.set('source',source);
  for(const [id,key] of [['historyFrom','from'],['historyTo','to']]) {
    const value=$(id).value;if(!value)continue;
    const boundary=new Date(value+'T00:00:00');if(key==='to')boundary.setDate(boundary.getDate()+1);
    params.set(key,boundary.toISOString());
  }
  if(!reset && historyThrough!==null)params.set('through_id',historyThrough);
  for(const id of ['historyQuery','historyPrev','historyNext'])$(id).disabled=true;
  $('history').setAttribute('aria-busy','true');
  $('historySummary').textContent='正在查询历史…';
  try {
    const data=await api('history/page?'+params);
    if(version!==historyVersion)return;
    historyRows=data.rows;historyPage=data.page;historyPages=data.pages;historyThrough=data.through_id;
    renderHistory();
    $('historySummary').textContent=`符合条件 ${data.total} 条 · 失败 ${data.failed} 条 · 对账差异 ${data.different} 条 · 本页 ${data.rows.length} 条`;
    $('historyPage').textContent=`第 ${data.page} / ${data.pages} 页`;
  } catch(error) {
    if(version===historyVersion){$('historySummary').textContent='历史查询失败：'+error.message+'（表格保留上次结果）';throw error;}
  } finally {
    if(version===historyVersion){
      $('history').removeAttribute('aria-busy');$('historyQuery').disabled=false;
      $('historyPrev').disabled=historyPage<=1;$('historyNext').disabled=historyPage>=historyPages;
    }
  }
}
const queryHistory=(page=1,reset=true)=>loadHistory(page,reset).catch(error=>message(error.message));
$('historyFilter').onchange=()=>queryHistory();
$('historyQuery').onclick=()=>queryHistory();
for(const id of ['historySource','historyFrom','historyTo'])$(id).onchange=()=>queryHistory();
$('historyPrev').onclick=()=>queryHistory(historyPage-1,false);
$('historyNext').onclick=()=>queryHistory(historyPage+1,false);
$('historyReset').onclick=()=>{
  for(const id of ['historySource','historyFrom','historyTo'])$(id).value='';
  $('historyFilter').value='all';queryHistory();
};
$('refresh').onclick=async()=>{const button=$('refresh');button.disabled=true;try{await refresh();message('管理数据已刷新');}catch(e){message(e.message);}finally{button.disabled=false;}};
try {
  const res=await fetch('/api/auth/me'); const data=await res.json();
  if (!res.ok || data.user?.role!=='admin') throw new Error('请使用管理员账号登录后访问系统管理。');
  $('content').hidden=false;
  if(standalone){
    document.querySelector('main > p.muted').textContent='独立库存由本应用维护；在此设置账号操作权限、仓库范围并查看空间审计与备份。';
    document.querySelector('section[data-panel="permissions"] > p').textContent='选择已登录过本应用的账号。库存操作员负责入出库，空间维护员负责布局与格位；平台管理员具有全部权限。';
    if(data.user?.provider!=='supos'){
      document.querySelector('section[data-panel="permissions"] > p').textContent='选择本地账号并分配可访问的仓库。账号角色在用户管理中设置，管理员具有全部仓库权限。';
      document.querySelectorAll('section[data-panel="permissions"] > p')[1].textContent='先在用户管理中创建账号，再点击刷新账号。既有未配置账号保留原角色和全库范围；不选仓库会禁止全部仓库。';
    }
    for(const button of document.querySelectorAll('#managementNav button'))button.hidden=!['permissions','audit','model'].includes(button.dataset.panel);
    const option=document.createElement('option');option.value='operator';option.textContent='库存操作';$('warehouseAccessForm').elements.role.append(option);
    showPanel(location.hash.slice(1));
  }
  const cellsResponse=await fetch('/api/cells');
  if (!cellsResponse.ok) throw new Error('三维格位列表加载失败');
  for (const c of await cellsResponse.json()) { const option=document.createElement('option'); option.value=c.loc_code; option.label=c.name; $('spatialCells').append(option); }
  const endpoint=location.origin+(window.SPATIAL_RUNTIME?.basePath || '').replace(/\/$/,'')+'/api/integration/snapshot';
  $('endpoint').textContent=endpoint;
  $('example').textContent=`POST ${endpoint}\nAuthorization: Bearer <同步凭证>\nContent-Type: application/json\n\n`+JSON.stringify({source:'与凭证绑定的来源一致',version:1,rows:[{sku:'BEARING-6204',name:'深沟球轴承6204',external_loc_code:'A-01-01',qty:120,unit:'套',unit_weight_kg:0.5,batch_no:'202609-A',status:'可用'}]},null,2)+'\n\n先配置 A-01-01 的映射。也可沿用 loc_code 直接传三维格位；两种编码只能选一个。';
  $('example').textContent+='\n\n按SKU归位时使用 placement: "sku" 和 warehouse_code，不提供库位编码。未绑定的货品进入待分配，格位保存SKU后自动归入。对账也支持此格式：\n'+JSON.stringify({source:'与凭证绑定的来源一致',version:1,rows:[{placement:'sku',warehouse_code:'WH',sku:'BEARING-6204',name:'深沟球轴承6204',qty:120,unit:'套'}]},null,2);
  $('example').textContent+='\n\n增量示例（先成功同步 v1；qty 为绝对数量，重试必须保留 message_id 和原内容）：\n'+JSON.stringify({mode:'delta',source:'与凭证绑定的来源一致',message_id:'erp-event-001',base_version:1,version:2,changes:[{op:'upsert',sku:'BEARING-6204',name:'深沟球轴承6204',external_loc_code:'A-01-01',qty:100,unit:'套',batch_no:'202609-A',status:'可用'}]},null,2)+'\n删除行使用 op: delete，并提供 sku、库位、batch_no、status。对账使用同一入口，将 mode 设为 reconcile，传当前 version 和完整 rows。';
  $('example').textContent+='\n\n单位重量 unit_weight_kg 为可选非负数，单位 kg/库存单位；缺省代表未知，不能据此判断未超载。\n业务事件使用相同入口及来源凭证，不修改库存：\n'+JSON.stringify({mode:'events',source:'与凭证绑定的来源一致',events:[{event_id:'receipt-001-line-1',type:'inbound',loc_code:'WH-1-A-L01-B01',sku:'BEARING-6204',name:'深沟球轴承6204',qty:10,unit:'套',occurred_at:'2026-09-16T08:00:00+08:00',document_no:'receipt-001'}]},null,2)+'\n事件 event_id 在同一来源内唯一，重试需保持内容不变。type 支持 inbound/outbound/adjustment；调整数量可带负号。移库传同单据的出库与入库两条事件。每批最多1000条，时间必须带时区。';
  await refresh(); message('管理员 · '+(standalone?'独立库存管理':'同步管理'));
} catch(e) { message(e.message); }

window.SPATIAL_REFRESH_VIEW = async () => { await refresh(); message('管理数据已刷新'); };

$('sourcePolicyForm').onsubmit=async event=>{
  event.preventDefault();const form=event.currentTarget,button=form.querySelector('button');button.disabled=true;
  try {
    await api('source-policy',{method:'PUT',headers:{'Content-Type':'application/json'},body:JSON.stringify({source:form.elements.namedItem('source').value,expected_interval_minutes:Number(form.elements.namedItem('expected_interval_minutes').value)})});
    await refresh();message('来源更新周期已保存');
  }catch(e){message(e.message);}finally{button.disabled=false;}
};

setInterval(()=>{if(!document.hidden && !$('content').hidden)loadBackupStatus();},60000);

function refreshSpaceAudit(page) {
  spacePage=page;
  // 筛选或翻页后，旧详情和正在返回的详情请求都不再属于当前结果。
  auditSelection++;
  $('spaceDetailBox').hidden=true;
  $('spaceDetailBox').open=false;
  refresh().catch(error=>message(error.message));
}
$('spaceAuditFilter').onsubmit=event=>{event.preventDefault();refreshSpaceAudit(1);};
$('spaceClear').onclick=()=>{$('spaceAuditFilter').reset();refreshSpaceAudit(1);};
$('spacePrev').onclick=()=>refreshSpaceAudit(Math.max(1,spacePage-1));
$('spaceNext').onclick=()=>refreshSpaceAudit(spacePage+1);

function selectAccessUser(id) {
  const form=$('warehouseAccessForm');form.elements.user_id.value=id;
  const record=accessRows.find(row=>row.user_id===id);
  form.elements.role.value=record?.role || '';
  const user=accessUsers.find(user=>user.id===id),local=user?.provider==='local';form.elements.role.disabled=local;
  form.elements.role.options[0].textContent=local?accessRoleName(user.base_role)+'（角色在用户管理中修改）':'沿用部署配置';
  $('accessSiteChoices').querySelectorAll('input').forEach(input=>{input.checked=record?record.sites.includes(input.value):!!id;});
}
async function loadWarehouseAccess(){
  const [rows,users,response]=await Promise.all([api('warehouse-access'),api('access-users'),fetch('/api/sites')]);
  if(!response.ok)throw Error('仓库列表加载失败');
  const sites=await response.json();accessUsers=users;accessRows=rows;
  const form=$('warehouseAccessForm'),previous=form.elements.user_id.value;
  form.elements.user_id.replaceChildren();
  const placeholder=document.createElement('option');placeholder.value='';placeholder.textContent='请选择账号';form.elements.user_id.append(placeholder);
  for(const user of users.filter(user=>user.base_role!=='admin')) {
    const option=document.createElement('option');option.value=user.id;option.textContent=user.username+' · '+user.name;form.elements.user_id.append(option);
  }
  $('accessSiteChoices').replaceChildren();
  for(const site of sites){const label=document.createElement('label'),input=document.createElement('input');input.type='checkbox';input.value=site.loc_code;label.append(input,document.createTextNode(site.name+'（'+site.loc_code+'）'));$('accessSiteChoices').append(label);}
  selectAccessUser(previous);
  $('warehouseAccessRows').replaceChildren();
  for(const item of rows){
    const user=users.find(user=>user.id===item.user_id),row=document.createElement('tr');
    cell(row,user?user.username+' · '+user.name:item.user_id);cell(row,accessRoleName(user?.provider==='local'?user.base_role:item.role));cell(row,item.sites.join('、')||'禁止全部仓库');cell(row,date(item.updated_at));
    const edit=document.createElement('button');edit.textContent='修改';edit.disabled=!user || user.base_role==='admin';edit.onclick=()=>selectAccessUser(item.user_id);
    const remove=document.createElement('button');remove.textContent='恢复部署默认';remove.onclick=async()=>{
      if(!confirm('恢复后，该账号沿用部署角色并可访问全部仓库。确认恢复？'))return;
      try{await api('warehouse-access/'+encodeURIComponent(item.user_id),{method:'DELETE'});await loadWarehouseAccess();}catch(e){$('warehouseAccessStatus').textContent=e.message;}
    };
    cell(row,'').append(edit,remove);$('warehouseAccessRows').append(row);
  }
}
$('warehouseAccessForm').elements.user_id.onchange=event=>selectAccessUser(event.target.value);
$('accessRefresh').onclick=()=>loadWarehouseAccess().catch(error=>{$('warehouseAccessStatus').textContent=error.message;});
$('warehouseAccessForm').onsubmit=async event=>{
  event.preventDefault();const form=event.currentTarget,button=event.submitter;button.disabled=true;
  try{
    const user_id=form.elements.user_id.value,role=form.elements.role.value || null;
    const sites=[...$('accessSiteChoices').querySelectorAll('input:checked')].map(input=>input.value);
    if(!sites.length && !confirm('未选择任何仓库，该账号将无法访问所有仓库。确认保存？'))return;
    await api('warehouse-access',{method:'PUT',headers:{'Content-Type':'application/json'},body:JSON.stringify({user_id,sites,role})});
    await loadWarehouseAccess();$('warehouseAccessStatus').textContent='权限已保存，下次请求生效；请目标账号刷新页面更新入口。';
  }catch(e){$('warehouseAccessStatus').textContent=e.message;}finally{button.disabled=false;}
};
