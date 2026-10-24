import {createWorkDialog,ensureWorkStyles} from './warehouse-work-ui.mjs';
import {createAssistantLauncher} from './assistant-launcher.mjs';
import {workApi} from './work-request.mjs';
import {renderAssistantPreview} from './assistant-preview-ui.mjs';
import {renderAssistantJob,renderAssistantJobList} from './assistant-job-ui.mjs';
import {watchWorkStatus} from './work-status.mjs';
import {renderWorkTasks} from './work-tasks-ui.mjs';
import {createAssistantInput,renderMediaReview} from './assistant-media-ui.mjs';
import {assistantModelState} from './assistant-model-state.mjs';
import {renderDocumentImport} from './assistant-document-ui.mjs';
import {createKnowledgeQuestionUI} from './knowledge-ui.mjs';

const el=(tag,text,className)=>{const n=document.createElement(tag);if(text!==undefined)n.textContent=text;if(className)n.className=className;return n;};
const button=(text,action,primary=false)=>{const b=el('button',text,primary?'primary':'');b.type='button';b.onclick=action;return b;};
function input(parent,title,value,type='text') {
  const id='assistant-'+window.spatialRandomUUID(),label=el('label',title),field=el('input');label.htmlFor=id;field.id=id;field.type=type;field.value=value??'';if(type==='number'){field.min='0';field.step='any';}parent.append(label,field);return field;
}
function select(parent,title,choices) {
  const id='assistant-'+window.spatialRandomUUID(),label=el('label',title),field=el('select');label.htmlFor=id;field.id=id;
  const blank=el('option','请选择');blank.value='';field.append(blank);
  for(const [value,name] of choices){const option=el('option',name);option.value=value;field.append(option);}
  if(choices.length===1)field.value=choices[0][0];parent.append(label,field);return field;
}
export function createAssistantUI({getRoom,getContext=()=>({}),locate,openCounter,openCount,openTasks,openTeam,openQuickBuild,openOpening,openGuide,onAuthRequired,onError}) {
  ensureWorkStyles();
  if(!document.querySelector('link[data-assistant-document]')){const style=document.createElement('link');style.rel='stylesheet';style.href=new URL('./assistant-document.css',import.meta.url).href;style.dataset.assistantDocument='';document.head.append(style);}
  let activePanel,activeUser,available=false,workStatus,monitor;
  const {launcher,keepInView}=createAssistantLauncher(async()=>{
    try{await open();}catch(error){onError?.(error);}
  });
  const reveal=()=>{launcher.hidden=!available;keepInView();};
  const close=()=>{activePanel?.root.close();activePanel=null;activeUser=null;reveal();};
  const updateBadge=value=>{const count=value?.enabled?value.total:0;launcher.textContent='✦ 智能助手'+(count?' · '+count:'');launcher.setAttribute('aria-label',count?`打开智能助手，${count}项待办`:'打开智能助手');keepInView();};
  window.addEventListener('spatial-auth-ready',()=>{
    available=true;if(!activePanel||activePanel.root.hidden)reveal();monitor?.stop();
    monitor=watchWorkStatus({getRoom,onUpdate:async value=>{
      if(activeUser&&activeUser!==value.user_id)close();
      workStatus=value;updateBadge(value);window.dispatchEvent(new CustomEvent('spatial-work-status',{detail:value}));
      await activePanel?.workUpdated?.(value);
    },onError:error=>{if(error?.accessLost){window.dispatchEvent(new Event('spatial-auth-required'));onAuthRequired?.();}else if(error&&activePanel)activePanel.syncMessage.textContent=error.message;}});
  });
  window.addEventListener('spatial-auth-required',()=>{available=false;monitor?.stop();workStatus=null;updateBadge(null);close();});
  async function open() {
    const identity=await workApi('/api/auth/me'),room=getRoom(),canOperate=identity.mode!=='integration'&&['admin','operator'].includes(identity.user.role);
    if(!room)throw Error('请先选择一个可访问库区');
    if(activePanel?.root.isConnected&&activeUser===identity.user.id){activePanel.restore();void activePanel.checkHealth?.();if(activePanel.showingSetup)await activePanel.showSetup();else if(activePanel.jobId&&!activePanel.jobDirty)await activePanel.showJob(activePanel.jobId);return;}
    close();
    let inputControl;
    const panel=createWorkDialog('仓储智能助手',{floating:true,launcher,onMinimize:()=>{inputControl?.cancel();keepInView();}}),{body,run,message}=panel;
    activePanel=panel;activeUser=identity.user.id;
    panel.root.addEventListener('close',()=>{if(activePanel===panel){activePanel=null;activeUser=null;}if(!activePanel)reveal();},{once:true});
    const storageKey='spatial-assistant-session:'+identity.user.id;let sessionId=sessionStorage.getItem(storageKey)||window.spatialRandomUUID();sessionStorage.setItem(storageKey,sessionId);
    const head=panel.root.querySelector('.work-head'),heading=head.querySelector('h2'),title=el('div',undefined,'assistant-title'),status=el('span','连接中','assistant-model-state');status.setAttribute('role','status');heading.before(title);title.append(heading,status);
    const menuBox=el('div',undefined,'assistant-menu-wrap'),menuToggle=button('⋯',()=>toggleMenu(menu.hidden)),menu=el('div',undefined,'assistant-menu');menu.hidden=true;menu.setAttribute('role','menu');menuToggle.title='更多操作';menuToggle.setAttribute('aria-label','更多操作');menuToggle.setAttribute('aria-haspopup','menu');menuToggle.setAttribute('aria-expanded','false');menuBox.append(menuToggle,menu);head.querySelector('.work-window-controls').prepend(menuBox);menuBox.addEventListener('pointerdown',event=>event.stopPropagation());
    function toggleMenu(open){menu.hidden=!open;menuToggle.setAttribute('aria-expanded',String(open));}
    const dismissMenu=event=>{if(!menuBox.contains(event.target))toggleMenu(false);};document.addEventListener('pointerdown',dismissMenu);panel.root.addEventListener('close',()=>document.removeEventListener('pointerdown',dismissMenu),{once:true});
    menu.addEventListener('keydown',event=>{if(event.key==='Escape'){event.stopPropagation();toggleMenu(false);menuToggle.focus();}});
    const contextBar=el('div',undefined,'assistant-context-bar'),contextLine=el('p','','assistant-context'),syncLabel=el('span','自动同步','assistant-sync');syncLabel.title='待办与作业清单自动更新';contextBar.append(contextLine,syncLabel);
    const tabs=el('nav',undefined,'assistant-tabs');tabs.setAttribute('role','tablist');tabs.setAttribute('aria-label','助手功能');
    const viewport=el('div',undefined,'assistant-content'),syncMessage=el('p','','assistant-sync-warning'),lastQuestion=el('p','','assistant-question');syncMessage.setAttribute('role','status');panel.syncMessage=syncMessage;viewport.append(syncMessage,message);
    const pages={},hosts={},tabButtons={},views={};let results;
    for(const [name,text] of [['conversation','对话'],['knowledge','知识问答'],...(identity.mode!=='integration'?[['tasks','待办']]:[]),...(canOperate?[['jobs','作业清单']]:[])]){
      const page=el('section',undefined,'assistant-page'),host=el('div'),tab=button(text,()=>run(async()=>{assertClean();if(name==='tasks')await showTasks();else if(name==='jobs')await showJobs();else activateTab(name);}));
      page.id='assistant-page-'+name+'-'+window.spatialRandomUUID();tab.id=page.id+'-tab';tab.setAttribute('role','tab');tab.setAttribute('aria-controls',page.id);page.setAttribute('role','tabpanel');page.setAttribute('aria-labelledby',tab.id);page.append(host);pages[name]=page;hosts[name]=host;tabButtons[name]=tab;tabs.append(tab);viewport.append(page);
      tab.onkeydown=event=>{if(!['ArrowLeft','ArrowRight','Home','End'].includes(event.key))return;event.preventDefault();const list=Object.values(tabButtons),index=list.indexOf(tab),next=event.key==='Home'?0:event.key==='End'?list.length-1:(index+(event.key==='ArrowLeft'?-1:1)+list.length)%list.length;list[next].focus();};
    }
    const welcome=el('section',undefined,'assistant-welcome');welcome.append(el('span','仓库里的事，从这里开始','assistant-eyebrow'),el('h3','需要办理什么？'),el('p','描述你的需求，核对预览后再确认。','work-hint'));
    const starters=el('div',undefined,'assistant-starters'),examplesMore=el('details',undefined,'assistant-more-examples'),examples=el('div',undefined,'assistant-examples');examplesMore.append(el('summary','更多示例'),examples);welcome.append(starters,examplesMore);pages.conversation.prepend(welcome,lastQuestion);
    const composer=el('div',undefined,'assistant-composer'),prompt=el('textarea'),label=el('label','你想办理什么？'),id='assistant-prompt-'+window.spatialRandomUUID();label.htmlFor=id;prompt.id=id;prompt.rows=2;prompt.maxLength=1200;prompt.placeholder='描述需求，例如：查找6204轴承';
    const actions=el('div',undefined,'assistant-composer-actions'),ask=button('发送',()=>run(send),true);ask.classList.add('assistant-send');actions.append(ask);composer.append(label,prompt,actions);body.append(contextBar,tabs,viewport,composer);
    const knowledgePanel=createKnowledgeQuestionUI(hosts.knowledge,{getRoom,onAuthRequired,onBusiness:question=>{activateTab('conversation');prompt.value=question;prompt.focus();}});
    panel.root.addEventListener('close',()=>knowledgePanel.reset(),{once:true});
    function activateTab(name){results=hosts[name];composer.hidden=name!=='conversation';panel.view=name==='knowledge'?'knowledge':views[name]||'';panel.showingSetup=panel.view==='setup_progress';if(name!=='jobs')panel.jobId=panel.rowId=null;for(const [key,page] of Object.entries(pages)){page.hidden=key!==name;tabButtons[key].setAttribute('aria-selected',String(key===name));tabButtons[key].tabIndex=key===name?0:-1;}if(name==='knowledge')void knowledgePanel.refresh();}
    const tabFor=kind=>{const target=['job','job_list','document_import'].includes(kind)?'jobs':['work_status','tasks'].includes(kind)?'tasks':'conversation';return hosts[target]?target:'conversation';};
    function updateWelcome(){welcome.hidden=!!hosts.conversation.childElementCount||!!lastQuestion.textContent;}
    function clearConversation(){hosts.conversation.replaceChildren();lastQuestion.textContent='';views.conversation='';updateWelcome();activateTab('conversation');inputControl?.clearHint();syncMessage.textContent='';message.textContent='';viewport.scrollTop=0;}
    function replaceResult(result){const target=tabFor(result.kind);hosts[target].replaceChildren();render(result);}
    const reconnect=button('重新连接',()=>{toggleMenu(false);return run(()=>checkHealth(true));});
    const fresh=button('新对话',()=>run(async()=>{
      assertClean();contextVersion++;busy=true;fresh.disabled=ask.disabled=prompt.disabled=true;toggleMenu(false);message.textContent='正在开始新对话…';
      try{await call('/api/assistant/session/reset',{});if(!panel.root.isConnected)return;panel.jobId=panel.rowId=null;clearConversation();prompt.value='';message.textContent='';}
      finally{busy=false;fresh.disabled=ask.disabled=prompt.disabled=false;prompt.focus();}
    }));
    menu.append(fresh,button('操作怎么做',()=>{toggleMenu(false);run(()=>{assertClean();activateTab('conversation');prompt.value='门窗在哪里添加？';prompt.focus();});}),reconnect);for(const item of menu.children)item.setAttribute('role','menuitem');
    for(const [text,example] of [['查货','6204轴承在哪里？'],['建仓','帮我在当前库区布置货架'],['建账','在这里登记期初库存'],['推荐上架','这批货应该放哪里？'],['盘点','盘点这里的实际库存'],['查流水','这个格位今天为什么少了货？']])examples.append(button(text,()=>{prompt.value=example;prompt.focus();}));
    panel.showSetup=()=>run(async()=>{assertClean();contextVersion++;replaceResult(await call('/api/assistant/preview',{tool:'setup_progress',input:{}}));viewport.scrollTop=0;});
    function starter(text,detail,action){const node=button('',action);node.append(el('strong',text),el('small',detail),el('span','›','assistant-starter-arrow'));starters.append(node);}
    starter('开始搭建仓库','设置库区、摆放货架、建立底账',panel.showSetup);
    starter('查询货品位置','查库存，并在3D场景中定位',()=>{prompt.value='6204轴承在哪里？';prompt.focus();});
    starter(canOperate?'办理出入库':'了解操作方法',canOperate?'新建作业清单，逐项核对办理':'查看具体操作步骤',()=>canOperate?run(showJobs):run(()=>{prompt.value='门窗在哪里添加？';prompt.focus();}));
    activateTab('conversation');
    let busy=false,queueTimer,contextRoom=getRoom(),contextVersion=0;
    function assertClean(){if(busy||panel.inputBusy)throw Error('请等待当前输入处理完成。');if(panel.jobDirty||panel.inputDirty)throw Error('请先核对当前填写，或放弃填写后继续。');}
    const statePath=()=>'/api/assistant/session?'+new URLSearchParams({room:getRoom(),session_id:sessionId});
    function refreshContext(){
      const ctx=getContext();contextLine.textContent=ctx.loc_code?`${ctx.loc_code}${ctx.item_name?' · '+ctx.item_name:''}`:'未选格位 · 可先查货或点击3D格位';contextLine.title=ctx.loc_code?'已选格位：'+contextLine.textContent:contextLine.textContent;syncLabel.hidden=identity.mode==='integration';
      if(contextRoom!==getRoom()){contextRoom=getRoom();contextVersion++;inputControl?.cancel();panel.jobId=panel.rowId=null;panel.jobDirty=panel.inputDirty=false;for(const [name,host] of Object.entries(hosts))if(name!=='knowledge')host.replaceChildren();knowledgePanel.reset();for(const name of Object.keys(views))delete views[name];clearConversation();syncMessage.textContent='';message.textContent='库区已切换，请重新查询或预览。';monitor?.refresh();}
    }
    refreshContext();const contextTimer=setInterval(refreshContext,1000);
    async function call(path,body) {
      try{return await workApi(path,{room:getRoom(),session_id:sessionId,context:{...getContext(),job_id:panel.jobId||null,row_id:panel.rowId||null},...body},'POST');}
      catch(error){if(error.status===401){panel.root.close();onAuthRequired?.();}throw error;}
    }
    async function jobApi(path='',body,method='GET'){
      try{return await workApi('/api/assistant/jobs'+path,body===undefined?undefined:{room:getRoom(),context:getContext(),...body},method);}
      catch(error){if(error.status===401){panel.root.close();onAuthRequired?.();}else if(error.status===403)panel.root.close();throw error;}
    }
    async function showJobs(){assertClean();const version=++contextVersion,rows=await jobApi('?room='+encodeURIComponent(getRoom()));if(version!==contextVersion)return;replaceResult({kind:'job_list',rows});viewport.scrollTop=0;}
    panel.showJob=async id=>{assertClean();const version=++contextVersion,result=await jobApi('/'+id);if(version!==contextVersion)return;replaceResult(result);};
    async function showTasks(){assertClean();const version=++contextVersion,result=await workApi('/api/work/status?room='+encodeURIComponent(getRoom()));if(version!==contextVersion)return;replaceResult({kind:'work_status',...result});viewport.scrollTop=0;}
    let observedJobs='',observedTasks='',observedTeam='';
    panel.workUpdated=async value=>{
      if(value.room!==getRoom()||!value.enabled||value.user_id!==activeUser)return;
      if(value.role!==identity.user.role){panel.root.close();return;}
      const jobsChanged=observedJobs!==value.jobs_revision,tasksChanged=observedTasks!==value.tasks_revision,teamChanged=observedTeam!==value.team_revision;
      if(panel.jobDirty||panel.jobBusy||panel.inputDirty||panel.inputBusy||busy){if(jobsChanged&&panel.jobId)syncMessage.textContent='清单或库存有更新，当前填写已保留；保存后核对，或放弃填写并刷新。';return;}
      if(panel.root.hidden)return;
      const scroll=viewport.scrollTop;
      if(panel.view==='work_status'&&(jobsChanged||tasksChanged||teamChanged))replaceResult({kind:'work_status',...value});
      else if(panel.view==='tasks'&&(tasksChanged||teamChanged)){const scope=panel.taskScope,rows=(value.attention||value.tasks.rows).filter(row=>scope==='all'||(scope==='count'?['count','draft','review'].includes(row.kind):row.kind===scope));replaceResult({kind:'tasks',scope,rows,total:rows.length});}
      else if(panel.view==='job_list'&&jobsChanged)await showJobs();
      else if(panel.jobId&&jobsChanged)await panel.showJob(panel.jobId);
      observedJobs=value.jobs_revision;observedTasks=value.tasks_revision;observedTeam=value.team_revision;
      viewport.scrollTop=scroll;syncMessage.textContent='';
    };
    async function send() {
      if(busy)return;if(!prompt.value.trim())throw Error('请输入查询或操作要求');
      assertClean();
      refreshContext();const version=contextVersion;
      busy=true;ask.disabled=true;reconnect.disabled=true;fresh.disabled=true;message.textContent='请求已受理，正在准备预览…';
      queueTimer=setInterval(async()=>{try{const job=await workApi(statePath());if(busy)message.textContent=job.state==='queued'?`正在排队，前面还有 ${job.ahead} 条请求。普通作业可继续办理。`:'正在读取本地模型和实际业务数据…';}catch{}},1500);
      try{const question=prompt.value.trim(),answer=await call('/api/assistant/ask',{message:question,request_id:window.spatialRandomUUID()});if(!panel.root.isConnected||version!==contextVersion)return;sessionId=answer.session_id;sessionStorage.setItem(storageKey,sessionId);lastQuestion.textContent=question;const cleared=new Set();for(const result of answer.results){const target=tabFor(result.kind);if(!cleared.has(target)){hosts[target].replaceChildren();cleared.add(target);}render(result);}updateWelcome();if(prompt.value.trim()===question)prompt.value='';message.textContent='';viewport.scrollTop=0;}
      finally{busy=false;clearInterval(queueTimer);ask.disabled=false;reconnect.disabled=false;fresh.disabled=false;}
    }
    prompt.onkeydown=event=>{if(event.key==='Enter'&&(event.ctrlKey||event.metaKey)){event.preventDefault();run(send);}};
    function render(result) {
      const target=tabFor(result.kind);activateTab(target);views[target]=result.kind;
      if(result.kind!=='media')panel.inputDirty=false;
      panel.view=result.kind;
      panel.showingSetup=result.kind==='setup_progress';
      if(result.kind!=='job')panel.jobId=panel.rowId=null;
      const card=el('section',undefined,'work-row');results.append(card);updateWelcome();
      if(result.kind==='media'){
        renderMediaReview(card,result,{canOperate,canCount:['admin','operator'].includes(identity.user.role),getContext,api:call,run,
          onDirty:value=>{panel.inputDirty=value;if(value)contextVersion++;},onText:text=>{prompt.value=[prompt.value.trim(),text].filter(Boolean).join('\n');clearConversation();prompt.focus();},onDiscard:clearConversation,
          preview:async(kind,input)=>{
            const version=contextVersion;
            const next=await call('/api/assistant/preview',kind==='query'?{tool:'find_stock',input:{query:input.query}}:kind==='count'?{tool:'prepare_stocktake',input:{query:input.query,unit:input.unit,actual_qty:input.qty,loc_hint:input.from_hint}}:{tool:'prepare_batch',request_id:window.spatialRandomUUID(),input:{operations:[{...input,operation:kind}]}});
            if(version!==contextVersion||!panel.root.isConnected)return false;panel.inputDirty=false;clearConversation();replaceResult(next);return true;
          }});return;
      }else if(result.kind==='job'){
        renderAssistantJob(card,result,{api:jobApi,run,selectedId:panel.rowId,locate:async loc=>{panel.minimize();await locate(loc);},onContext:(id,row)=>{panel.jobId=id;panel.rowId=row;},onDirty:value=>{panel.jobDirty=value;if(value)contextVersion++;},onBusy:value=>panel.jobBusy=value,onList:showJobs,
          members:identity.user.role==='admin'?()=>workApi('/api/team-tasks/members?room='+encodeURIComponent(getRoom())):null,openTeam:openTeam?async id=>{panel.minimize();await openTeam(id);}:null});return;
      }else if(result.kind==='job_list'){
        renderAssistantJobList(card,result.rows,{run,open:panel.showJob,importDocument:()=>{assertClean();replaceResult({kind:'document_import'});},create:async()=>{const job=await call('/api/assistant/preview',{tool:'prepare_batch',input:{operations:[{operation:'in'}]},request_id:window.spatialRandomUUID()});replaceResult(job);}});return;
      }else if(result.kind==='document_import'){
        renderDocumentImport(card,{api:jobApi,mediaApi:body=>call('/api/assistant/media/recognize',body),run,onJob:replaceResult,onCancel:()=>run(showJobs),onDirty:value=>{panel.inputDirty=value;if(value)contextVersion++;},onBusy:value=>panel.inputBusy=value});return;
      }else if(result.kind==='work_status'){
        renderWorkTasks(card,result,{canOperate,run,openJob:panel.showJob,openTeam:openTeam?async id=>{panel.minimize();await openTeam(id);}:null,openCounter:(...args)=>{panel.minimize();return openCounter(...args);},openCount:(...args)=>{panel.minimize();return openCount(...args);},locate:async loc=>{panel.minimize();await locate(loc);}});return;
      }else if(result.kind==='setup_progress'){
        card.append(el('strong',`${result.room.name} · 起步配置 ${result.completed} / ${result.total}`),el('p',result.message,'work-hint'));
        for(const step of result.steps){const row=el('div',undefined,'assistant-setup-step');row.append(el('strong',`${step.optional?'○':step.done?'✓':'待办'} ${step.title}`),el('small',step.detail));
          const action=button(step.done?'查看 / 调整':step.optional?'打开标签':'开始这一步',()=>run(async()=>{panel.minimize();await openGuide(step.action);}));action.disabled=!step.allowed;row.append(action);card.append(row);}
        card.append(button('更新真实进度',()=>run(async()=>{const next=await call('/api/assistant/preview',{tool:'setup_progress',input:{}});card.remove();render(next);})));return;
      }else if(result.kind==='platform_guide'){
        card.append(el('strong','操作指引'),el('p',result.message,'work-hint'));
        const start=button('打开界面并指引',()=>run(async()=>{panel.minimize();await openGuide(result.topic);}),true);start.disabled=!result.allowed;card.append(start);return;
      }else if(result.kind==='stock') {
        card.append(el('strong',`查询「${result.query}」· ${result.total} 条`),el('p',result.message,'work-hint'));
        for(const row of result.rows){const line=el('div',undefined,'work-row');line.append(el('strong',row.name),el('p',`${row.qty} ${row.unit} · SKU：${row.sku||'未编号'}`),el('small',`${row.room_name||''} ${row.loc_code||'待归位'}`));if(row.loc_code)line.append(button('3D定位',()=>run(async()=>{panel.minimize();await locate(row.loc_code);})));card.append(line);}
      }else if(result.kind==='tasks') {
        panel.taskScope=result.scope;
        const counts=Object.fromEntries(['count','draft','review','low'].map(kind=>[kind,result.rows.filter(row=>row.kind===kind).length]));counts.jobs=0;
        renderWorkTasks(card,{total:result.total,counts,role:identity.user.role,tasks:{rows:result.rows},jobs:[],attention:result.rows.every(row=>row.label)?result.rows:[]},{canOperate,run,openJob:panel.showJob,openTeam:openTeam?async id=>{panel.minimize();await openTeam(id);}:null,openCounter:(...args)=>{panel.minimize();return openCounter(...args);},openCount:(...args)=>{panel.minimize();return openCount(...args);},locate:async loc=>{panel.minimize();await locate(loc);}});
      }else if(result.kind==='draft')renderDraft(card,result);
      else if(['setup','opening','recommendations','stocktake','history'].includes(result.kind))renderAssistantPreview(card,result,{button,input,select,run,preview:(kind,input)=>call('/api/assistant/preview',{tool:{setup:'preview_warehouse',opening:'prepare_opening',recommendations:'recommend_location',stocktake:'prepare_stocktake'}[kind],input}),minimize:panel.minimize,openQuickBuild,openOpening,openCount:(loc,options)=>openCount(loc,{...options,access:{canOperate:['admin','operator'].includes(identity.user.role),canAdmin:identity.user.role==='admin'}}),openCounter,locate});
      else card.append(el('p',result.message||'请补充具体的货品和位置。'));
    }
    function renderDraft(card,result) {
      card.replaceChildren();card.append(el('strong',({in:'入库',out:'出库',move:'移库'}[result.operation]||'库存操作')+'草稿'),el('p',result.message,'work-hint'));
      const source=select(card,result.operation==='in'?'选择货品':'选择货品和源格位',result.choices.map((c,i)=>[String(i),`${c.loc_code?c.loc_code+' · '+c.qty+' '+c.unit+' · ':''}${c.name} · ${c.sku||'未编号'}`]));
      const qty=input(card,'办理数量',result.input.qty??'','number'),unit=input(card,'库存单位',result.input.unit);
      source.onchange=()=>{const chosen=result.choices[Number(source.value)];if(source.value!==''&&chosen&&!unit.value)unit.value=chosen.unit;};
      let destination,manual;
      if(result.operation!=='out') {
        destination=select(card,'目标格位',result.destinations.map(c=>[c.loc_code,[c.loc_code,c.room_name].filter(Boolean).join(' · ')]));
        if(!result.destinations.length)manual=input(card,'完整目标格位码','');
      }
      const footer=el('div',undefined,'work-actions'),open=button('打开作业台核对',()=>{
        panel.minimize();const draft=result.draft;openCounter(draft.loc,result.operation,{itemCode:draft.itemCode,draft});
      },true);open.disabled=!result.ready;footer.append(open);card.append(footer);
      if(!result.choices.length&&result.operation==='in')footer.append(button('打开入库台登记新货品',()=>{panel.minimize();openCounter('','in');}));
      function changed(){open.disabled=true;}
      for(const field of [source,qty,unit,destination,manual].filter(Boolean))field.addEventListener('input',changed);
      footer.prepend(button('更新操作预览',()=>run(async()=>{
        if(source.value==='')throw Error('请选择具体货品和源格位');const chosen=result.choices[Number(source.value)];
        const next=await call('/api/assistant/draft',{room:getRoom(),input:{...result.input,item_id:chosen.item_id,from_loc:chosen.loc_code,to_loc:destination?.value||manual?.value||'',qty:Number(qty.value),unit:unit.value.trim()}});
        renderDraft(card,next);
      })));
      if(result.ready&&result.draft)card.append(el('p',`${result.draft.name} · ${result.draft.qty} ${result.draft.unit} · ${result.draft.from_loc||''}${result.draft.to_loc?' → '+result.draft.to_loc:''}`,'work-receipt'));
      const saveId=window.spatialRandomUUID();
      footer.append(button('保存到作业清单',()=>run(async()=>{
        const chosen=source.value!==''?result.choices[Number(source.value)]:null;
        const next={...result.input,qty:qty.value.trim()===''?null:Number(qty.value),unit:unit.value.trim(),to_loc:destination?.value||manual?.value||''};
        if(chosen){next.item_id=chosen.item_id;next.from_loc=chosen.loc_code;}else{delete next.item_id;delete next.from_loc;}
        const job=await call('/api/assistant/preview',{tool:'prepare_batch',input:{operations:[next]},request_id:saveId});replaceResult(job);
      })));
    }
    let healthTimer;
    panel.root.addEventListener('close',()=>{inputControl?.stop();clearTimeout(healthTimer);clearInterval(queueTimer);clearInterval(contextTimer);},{once:true});
    let inputControls=[];
    inputControl=createAssistantInput({host:actions,before:ask,guard:()=>{assertClean();contextVersion++;},recognize:(kind,data)=>call('/api/assistant/media/recognize',{kind,data}),
      onBusy:value=>{if(panel.inputBusy===value)return;panel.inputBusy=value;if(value){inputControls=[...body.querySelectorAll('button,input,select,textarea')].filter(node=>!inputControl.root.contains(node)).map(node=>[node,node.disabled]);for(const [node] of inputControls)node.disabled=true;}else for(const [node,disabled] of inputControls)if(node.isConnected)node.disabled=disabled;},
      onResult:result=>{contextVersion++;replaceResult(result);},onError:error=>message.textContent=error.message});
    async function checkHealth(retry=false){
      clearTimeout(healthTimer);
      if(!panel.root.open)return;
      let next=10000;
      try{
        if(panel.root.hidden||document.hidden||busy||panel.inputBusy)return;
        const health=await workApi('/api/assistant/status'+(retry?'?retry=1':''));
        if(!panel.root.open)return;
        const view=assistantModelState(health);status.textContent=view.label;status.dataset.state=view.state;status.title=view.hint+(health.enabled?' · '+health.model:'');
        reconnect.disabled=!health.enabled||health.warming||health.busy;
        if(health.warming)next=2500;
      }catch(error){
        if([401,403].includes(error.status)){panel.root.close();if(error.status===401)onAuthRequired?.();return;}
        status.textContent='连接中';status.dataset.state='checking';status.title='连接中断，正在自动重试；当前填写已保留。';
      }finally{if(panel.root.open)healthTimer=setTimeout(()=>void checkHealth(),next);}
    }
    const reconnectOnReturn=()=>{if(!document.hidden)void checkHealth();};
    panel.checkHealth=checkHealth;
    document.addEventListener('visibilitychange',reconnectOnReturn);window.addEventListener('online',reconnectOnReturn);
    panel.root.addEventListener('close',()=>{document.removeEventListener('visibilitychange',reconnectOnReturn);window.removeEventListener('online',reconnectOnReturn);},{once:true});
    void run(checkHealth);
    await run(async()=>{const saved=await workApi(statePath());if(saved.job_id&&canOperate)await panel.showJob(saved.job_id);else if(saved.pending)render(saved.pending);});
    if(workStatus?.room===room)await panel.workUpdated(workStatus);
    if(!panel.jobId&&!panel.showingSetup)prompt.focus();
  }
  return {open,close,showJob:async id=>{await open();await activePanel?.showJob(id);},setup:async()=>{await open();await activePanel?.showSetup();}};
}
