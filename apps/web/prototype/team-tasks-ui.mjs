import {createWorkDialog} from './warehouse-work-ui.mjs';
import {workApi,sendWork,pendingWork,retryWork,setWorkUser} from './work-request.mjs';
import {createFieldDrafts} from './field-drafts.mjs';
import {formatBusinessTime} from './business-time.mjs';
import {openRoutePreview} from './route-preview-ui.mjs';

const states={open:'待领取',assigned:'已分派 · 待领取',active:'办理中',blocked:'现场异常 · 已暂停',handover:'等待接收交接',awaiting_check:'已办完 · 待管理员确认',completed:'已完成',cancelled:'已取消剩余任务'};
const operations={in:'收货入库',out:'领用出库',move:'移库'};
const actions={created:'发布任务',claim:'领取任务',assign:'重新分派',execute:'办理库存',handover:'发起交接',accept_handover:'确认接手',withdraw_handover:'退回或撤回交接',shortage:'反馈现场异常',resume:'恢复办理',cancel:'取消剩余任务',confirm:'确认完成'};
const number=value=>Number(value||0).toLocaleString('zh-CN',{maximumFractionDigits:8});
const el=(tag,text,className)=>{const node=document.createElement(tag);if(text!==undefined)node.textContent=text;if(className)node.className=className;return node;};
const button=(text,action,primary=false)=>{const node=el('button',text,primary?'primary':'');node.type='button';node.onclick=action;return node;};
function field(host,text,value='',tag='input'){const box=el('label',text),input=el(tag);input.value=value;input.setAttribute('aria-label',text);box.append(input);host.append(box);return input;}
function select(host,text,choices,value=''){const input=field(host,text,'','select');for(const [key,name] of choices){const option=el('option',name);option.value=key;input.append(option);}input.value=value;return input;}

export function createTeamTasksUI({getRoom,onChanged=async()=>{},locate,confirm,showRoute}){
  async function open(initialId=''){
    const who=await workApi('/api/auth/me');if(who.mode==='integration'||!['admin','operator'].includes(who.user.role))throw Error('团队任务需要独立仓储的管理员或操作员账号');
    setWorkUser(who.user.id);const roomCode=getRoom(),room=(await workApi('/api/rooms')).find(row=>row.loc_code===roomCode);if(!room)throw Error('请选择可访问库区');
    const drafts=createFieldDrafts({userId:who.user.id,roomId:room.id,kind:'team-create'}),admin=who.user.role==='admin';
    const panel=createWorkDialog('团队任务'),{body,root,run,message}=panel;root.classList.add('team-task-dialog');
    const recovery=el('div'),notice=el('div'),navigation=el('div',undefined,'work-actions'),content=el('section');body.append(recovery,notice,navigation,content);
    let mode='list',task,dirty=false,busy=false,page=1,viewVersion=0,lastStatus='',filterValue=admin?'pending':'mine';
    const filter=select(navigation,'任务范围',[['pending','全部未完成'],['mine','分派给我 / 待我接手'],['pool','可领取任务'],['history','已完成与已取消']],filterValue);
    filter.onchange=()=>{filterValue=filter.value;page=1;run(loadList);};
    navigation.append(button('刷新列表',()=>run(()=>loadList())));if(admin)navigation.append(button('＋ 新建团队任务',()=>run(newTask),true));
    function showRecovery(){
      recovery.replaceChildren();const pending=pendingWork();if(!pending)return;recovery.className='work-recovery';
      recovery.append(el('p','有一笔操作结果待确认。先核对原请求，避免重复领取或扣账。'),button('核对原请求',()=>run(async()=>{
        const result=await retryWork();message.textContent='原请求已核对，不会重复办理。';showRecovery();
        if(result.task_id){const saved=drafts.get('new');if(pending.path==='/api/team-tasks'&&saved){const {updated_at,...input}=saved;if(JSON.stringify(input)===JSON.stringify(pending.body))drafts.remove('new');}await detail(result.task_id);}else await loadList();await changed();
      })));
    }
    async function changed(){try{await onChanged();}catch(error){message.textContent='任务操作已完成，场景稍后刷新：'+error.message;}}
    async function loadList(){
      if(busy)return;const version=++viewVersion;mode='list';task=null;dirty=false;notice.replaceChildren();navigation.hidden=false;
      const result=await workApi('/api/team-tasks?'+new URLSearchParams({room:roomCode,filter:filterValue,page}));if(version!==viewVersion||!root.isConnected)return;
      content.replaceChildren(el('p',`共 ${result.total} 份任务 · 第 ${result.page} / ${result.pages} 页`,'work-hint'));
      if(!result.rows.length)content.append(el('p','当前范围没有任务。'));
      for(const row of result.rows){const card=button('',()=>run(()=>detail(row.id)));card.className='work-choice';card.append(el('strong',row.title),el('small',`${states[row.status]} · ${row.assignee_name}`),el('small',`已办完 ${row.completed} / ${row.total} 项${row.has_partial?' · 已有办理记录':''}`));content.append(card);}
      const pagination=el('div',undefined,'work-actions'),previous=button('上一页',()=>{page--;run(loadList);}),next=button('下一页',()=>{page++;run(loadList);});previous.disabled=page<=1;next.disabled=page>=result.pages;pagination.append(previous,next);content.append(pagination);
      if(admin&&drafts.get('new'))content.prepend(button('继续未发布的任务草稿',()=>run(newTask)));
    }
    async function newTask(){
      if(busy)return;const version=++viewVersion;mode='new';task=null;dirty=true;navigation.hidden=true;notice.replaceChildren();
      const [members,catalogue,progress]=await Promise.all([workApi('/api/team-tasks/members?room='+encodeURIComponent(roomCode)),workApi('/api/work/catalogue?room='+encodeURIComponent(roomCode)),workApi('/api/work/progress?room='+encodeURIComponent(roomCode))]);
      if(version!==viewVersion||!root.isConnected)return;
      const saved=drafts.get('new')||{};content.replaceChildren(el('h3','发布团队作业'),el('p','先核对作业与接收人。发布后，领用和移库数量会预占，实际办理时才扣减在库数量。','work-hint'));
      const grid=el('div',undefined,'work-grid'),rows=el('div'),preview=el('div');content.append(grid,rows);
      const title=field(grid,'任务名称',saved.title||''),assignee=select(grid,'分派给',[['','放入任务池，等待领取'],...members.map(user=>[user.id,user.name+' · '+user.username])],saved.assignee_id||'');
      const documentNo=field(grid,'业务单号',saved.document_no||''),recipient=field(grid,'领用人 / 班组',saved.recipient||''),department=field(grid,'部门',saved.department||''),purpose=field(grid,'用途',saved.purpose||'');
      const locations=[['','请选择格位'],...progress.rows.map(cell=>[cell.loc_code,cell.loc_code])];
      function addRow(value={}){
        const row=el('section',undefined,'work-row'),fields=el('div',undefined,'work-grid'),newFields=el('div',undefined,'work-grid');rows.append(row);row.append(fields,newFields);
        const operation=select(fields,'作业类型',Object.entries(operations),value.operation||'out'),item=select(fields,'货品',[['','新货品（仅收货）'],...catalogue.map(item=>[item.item_id,item.name+' · '+(item.sku||'未编号')])],value.item_id||'');
        const qty=field(fields,'计划数量',value.qty??1);qty.type='number';qty.min='0';qty.step='any';
        const from=select(fields,'源格位',locations,value.from_loc||''),to=select(fields,'目标格位',locations,value.to_loc||'');
        const name=field(newFields,'新货品名称',value.name||''),sku=field(newFields,'新货品编号（可留空）',value.sku||''),unit=field(newFields,'库存单位',value.unit||'件');
        function update(){from.disabled=operation.value==='in';to.disabled=operation.value==='out';newFields.hidden=!!item.value||operation.value!=='in';preview.replaceChildren();persist();}
        operation.onchange=item.onchange=update;
        row.read=()=>{const selected=catalogue.find(product=>product.item_id===item.value);return {operation:operation.value,...(selected?{item_id:selected.item_id,name:selected.name,sku:selected.sku||'',unit:selected.unit||'件'}:{new_item:operation.value==='in',name:name.value.trim(),sku:sku.value.trim(),unit:unit.value.trim()}),qty:Number(qty.value),from_loc:from.disabled?'':from.value,to_loc:to.disabled?'':to.value,
          ...(from.disabled?{}:{from_node_id:progress.rows.find(cell=>cell.loc_code===from.value)?.node_id}),...(to.disabled?{}:{to_node_id:progress.rows.find(cell=>cell.loc_code===to.value)?.node_id})};};
        row.append(button('移除此项',()=>{row.remove();persist();preview.replaceChildren();}));from.disabled=operation.value==='in';to.disabled=operation.value==='out';newFields.hidden=!!item.value||operation.value!=='in';
      }
      const read=()=>({room:roomCode,room_id:room.id,title:title.value.trim(),assignee_id:assignee.value||null,document_no:documentNo.value.trim(),recipient:recipient.value.trim(),department:department.value.trim(),purpose:purpose.value.trim(),lines:[...rows.children].map(row=>row.read())});
      function persist(){try{drafts.save('new',read());}catch(error){message.textContent=error.message;}}
      for(const line of saved.lines||[{}])addRow(line);
      const controls=el('div',undefined,'work-actions');controls.append(button('＋ 添加一项',()=>run(()=>{if(rows.children.length>=50)throw Error('每个任务最多50项');addRow();persist();preview.replaceChildren();})),button('返回列表',()=>run(loadList)),button('预览任务',()=>run(async()=>{
        const input=read(),signature=JSON.stringify(input);if(!input.title||!input.lines.length)throw Error('请填写任务名称和至少一项作业');
        const used=new Map();
        for(const line of input.lines){
          if(!Number.isFinite(line.qty)||line.qty<=0)throw Error('计划数量须大于零');
          if(line.operation!=='in'&&!line.item_id)throw Error('领用和移库请选择已有货品');
          if(line.operation==='in'&&(!line.name||!line.unit))throw Error('请填写收货货品与库存单位');
          if(line.operation!=='in'&&!line.from_loc||line.operation!=='out'&&!line.to_loc)throw Error('请选择完整的源格位和目标格位');
          if(line.operation==='move'&&line.from_loc===line.to_loc)throw Error('移库源格位和目标格位不能相同');
          if(line.from_loc){const stock=await workApi('/api/work/opening?loc_code='+encodeURIComponent(line.from_loc));if(stock.node_id!==line.from_node_id)throw Error('布局已变化，请重新打开任务并选择格位');
            const item=stock.items.find(item=>item.item_id===line.item_id),key=line.from_loc+':'+line.item_id,total=(used.get(key)||0)+line.qty;used.set(key,total);
            if(total>(item?.available_qty??item?.qty??0))throw Error(line.from_loc+' 的可用库存不足，已有任务预占数量不再重复分配');}
          if(line.to_loc){const target=await workApi('/api/work/opening?loc_code='+encodeURIComponent(line.to_loc));if(target.node_id!==line.to_node_id)throw Error('目标格位已变化，请重新选择');}
        }
        if(signature!==JSON.stringify(read()))throw Error('填写内容已变化，请重新预览');
        preview.replaceChildren();const summary=el('div',undefined,'work-recovery');summary.append(el('strong',input.title),el('p','接收人：'+(members.find(user=>user.id===input.assignee_id)?.name||'任务池待领取')));
        for(const [index,line] of input.lines.entries())summary.append(el('p',`${index+1}. ${operations[line.operation]} · ${line.name} · ${number(line.qty)} ${line.unit}\n${line.from_loc||'外部'} → ${line.to_loc||'外部'}`));
        summary.append(button('发布任务并预占库存',()=>run(async()=>{
          if(signature!==JSON.stringify(read()))throw Error('填写内容已变化，请重新预览');if(busy)return;busy=true;content.inert=true;
          try{const result=await sendWork('/api/team-tasks',input);drafts.remove('new');dirty=false;await detail(result.task_id);message.textContent='任务已发布，实际库存将在办理时更新。';await changed();}
          finally{busy=false;content.inert=false;showRecovery();}
        }),true));preview.append(summary);
      }),true));content.append(controls,preview);
      content.oninput=content.onchange=()=>{preview.replaceChildren();persist();};
    }
    async function detail(id){
      const version=++viewVersion;mode='detail';navigation.hidden=true;notice.replaceChildren();const result=await workApi('/api/team-tasks/'+encodeURIComponent(id));if(version!==viewVersion||!root.isConnected)return;renderDetail(result);
    }
    function renderDetail(value){
      task=value;mode='detail';dirty=false;content.oninput=content.onchange=()=>{dirty=true;};content.replaceChildren();
      content.append(button('返回任务列表',()=>run(loadList)),el('h3',task.title),el('p',`${states[task.status]} · 接收人：${task.assignee_name}`,'work-hint'));
      if(task.assignment_issue)content.append(el('p',task.assignment_issue,'work-message'));
      if(task.handover_to)content.append(el('div',`交接给 ${task.handover_name}：${task.handover_note}`,'work-recovery'));
      if(task.note)content.append(el('p','最近说明：'+task.note));
      const business=Object.entries(task.business).map(([key,value])=>({recipient:'领用人 / 班组',department:'部门',purpose:'用途',document_no:'业务单号'})[key]+'：'+value).join(' · ');if(business)content.append(el('p',business,'work-hint'));
      if(task.permissions.claim)content.append(button('领取并开始办理',()=>run(()=>act('claim')),true));
      if(task.permissions.accept_handover)content.append(button('确认接手任务',()=>run(()=>act('accept_handover')),true));
      const picking=task.lines.filter(line=>line.remaining>0&&line.operation!=='in').map(line=>line.from_loc);
      if(picking.length)content.append(button('规划本任务取货路线',()=>run(()=>openRoutePreview({room:roomCode,locations:picking,
        onShow:showRoute?async route=>{await showRoute(route);root.close();}:null,locate:locate?async code=>{await locate(code);root.close();}:null})),true));
      for(const [index,line] of task.lines.entries()){
        const row=el('section',undefined,'work-row');row.append(el('strong',`${index+1}. ${operations[line.operation]} · ${line.current_name}`),el('small',`${line.current_sku||'未编号'} · 已办理 ${number(line.done_qty)} / ${number(line.qty)} ${line.unit}`),el('p',`${line.from_loc||'外部'} → ${line.to_loc||'外部'}`));
        if(line.from_loc)row.append(el('small',`当前在库 ${number(line.stock_qty)} ${line.unit} · 此任务剩余预占 ${number(line.reserved_qty)} · 库位可用 ${number(line.available_qty)}`));
        if(task.permissions.execute&&line.remaining>0){
          const qty=field(row,`本次办理数量（第${index+1}项）`);qty.type='number';qty.min='0';qty.max=line.remaining;qty.step='any';qty.inputMode='decimal';
          row.append(button('核对办理第'+(index+1)+'项',()=>run(async()=>{const amount=Number(qty.value);if(!Number.isFinite(amount)||amount<=0||amount>line.remaining)throw Error('本次数量须大于零且不超过剩余数量');
            if(!await confirm(`${operations[line.operation]} ${line.current_name} ${number(amount)} ${line.unit}\n${line.from_loc||'外部'} → ${line.to_loc||'外部'}\n本笔确认后更新库存。`))return;
            await act('execute',{line_id:line.id,qty:amount});
          }),true));
        }
        if(locate)for(const code of [...new Set([line.from_loc,line.to_loc].filter(Boolean))])row.append(button('3D定位 '+code,()=>{root.close();locate(code);}));content.append(row);
      }
      if(task.permissions.confirm)content.append(button('核对完成，关闭任务',()=>run(()=>act('confirm')),true));
      const p=task.permissions;
      if(p.handover||p.assign||p.cancel||p.resume||p.withdraw_handover||p.execute){
        const management=el('details');management.append(el('summary','交接、异常与任务管理'));const controls=el('div',undefined,'work-grid');management.append(controls);content.append(management);
        const note=field(controls,'交接 / 异常说明','','textarea');note.rows=3;
        let target;
        if(p.handover||p.assign){target=select(controls,'接收人',[['','请选择接收人']]);void workApi('/api/team-tasks/members?room='+encodeURIComponent(roomCode)).then(members=>{for(const member of members){const option=el('option',member.name+' · '+member.username);option.value=member.id;target.append(option);}}).catch(error=>{message.textContent=error.message;});}
        const buttons=el('div',undefined,'work-actions');management.append(buttons);
        const withNote=(action,extra={})=>run(async()=>{if(!note.value.trim())throw Error('请填写说明');await act(action,{note:note.value.trim(),...extra});});
        if(p.handover)buttons.append(button('发起交接',()=>withNote('handover',{assignee_id:target.value})));
        if(p.assign)buttons.append(button('管理员重新分派',()=>withNote('assign',{assignee_id:target.value})));
        if(p.execute)buttons.append(button('反馈缺货 / 现场异常',()=>withNote('shortage')));
        if(p.resume)buttons.append(button('异常已处理，恢复办理',()=>withNote('resume')));
        if(p.withdraw_handover)buttons.append(button('退回 / 撤回交接',()=>withNote('withdraw_handover')));
        if(p.cancel)buttons.append(button('取消剩余任务',()=>run(async()=>{if(!note.value.trim())throw Error('请填写取消原因');if(await confirm('取消尚未办理的数量并释放预占？已完成的库存动作和流水保留。'))await act('cancel',{note:note.value.trim()});})));
      }
      const history=el('details'),entries=el('div');history.append(el('summary','办理与交接记录'),entries);content.append(history);let cursor=task.history.next_before;
      const more=button('加载更早记录',()=>run(async()=>{const result=await workApi('/api/team-tasks/'+task.id+'/events?before='+cursor);appendEvents(result.rows);cursor=result.next_before;more.hidden=!cursor;}));history.append(more);more.hidden=!cursor;
      function appendEvents(rows){for(const entry of rows){const row=el('div',undefined,'work-row');row.append(el('strong',`${actions[entry.action]||entry.action} · ${entry.actor_name}`),el('small',formatBusinessTime(entry.created_at)));if(entry.details.qty!=null)row.append(el('p','本次数量 '+number(entry.details.qty)));if(entry.details.note)row.append(el('p',entry.details.note));entries.append(row);}}
      appendEvents(task.history.rows);
    }
    async function act(action,extra={}){
      if(busy)return;busy=true;content.inert=true;const id=task.id,input={action,revision:task.revision,...extra};
      try{const result=await sendWork('/api/team-tasks/'+id+'/actions',input);renderDetail(result.task);notice.replaceChildren();message.textContent='已'+(actions[action]||'办理任务')+'。';await changed();}
      finally{busy=false;content.inert=false;showRecovery();}
    }
    const refresh=()=>run(()=>mode==='detail'?detail(task.id):loadList());
    const updated=event=>{
      const state=event.detail;if(state.room!==roomCode||state.user_id!==who.user.id||state.team_revision===lastStatus)return;const previous=lastStatus;lastStatus=state.team_revision;if(!previous||busy)return;
      if(mode==='new'||dirty){notice.replaceChildren(el('p','团队任务有更新，当前填写已保留。','work-hint'),button('重新加载并核对',refresh));return;}
      if(mode==='detail')void run(()=>detail(task.id));else void run(loadList);
    };
    window.addEventListener('spatial-work-status',updated);const lost=()=>root.close();window.addEventListener('spatial-auth-required',lost);
    root.querySelector('.work-head button').onclick=()=>{if(busy){message.textContent='正在提交，请等待作业结果。';return;}root.close();};root.addEventListener('cancel',event=>{if(busy)event.preventDefault();});
    root.addEventListener('close',()=>{window.removeEventListener('spatial-work-status',updated);window.removeEventListener('spatial-auth-required',lost);},{once:true});
    showRecovery();if(initialId)await run(()=>detail(initialId));else await run(loadList);return panel;
  }
  return {open};
}
