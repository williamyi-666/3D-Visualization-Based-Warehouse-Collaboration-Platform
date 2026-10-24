import {workApi} from './work-request.mjs';
const el=(tag,text,className)=>{const node=document.createElement(tag);if(text!==undefined)node.textContent=text;if(className)node.className=className;return node;};
const button=(text,fn)=>{const node=el('button',text);node.type='button';node.onclick=fn;return node;};
function styles(){if(document.querySelector('link[data-knowledge]'))return;const link=el('link');link.rel='stylesheet';link.href=new URL('./knowledge.css',import.meta.url).href;link.dataset.knowledge='';document.head.append(link);}
function field(form,title,name,type='text'){
  const label=el('label',title),input=el(type==='textarea'?'textarea':type==='select'?'select':'input');
  if(!['textarea','select'].includes(type))input.type=type;input.name=name;label.append(input);form.append(label);return input;
}
const roleNames={operator:'库存操作',spaceAdmin:'空间维护',viewer:'只读查看'};
export function createKnowledgeSettingsUI(host){
  styles();host.classList.add('knowledge-settings');
  host.append(el('h3','知识库连接'),el('p','知识资料与实时库存分别查询。基础仓储始终独立运行。','knowledge-muted'));
  const form=el('form'),mode=field(form,'连接方式','mode','select');
  for(const [value,text] of [['off','关闭'],['enterprise','接入企业服务'],['local','本地知识服务']]){const option=el('option',text);option.value=value;mode.append(option);}
  const description=el('p','','knowledge-muted'),connection=el('div',undefined,'knowledge-fields'),url=field(connection,'完整检索接口地址','url'),key=field(connection,'接口密钥（仅保存在后台）','api_key','password'),knowledgeId=field(form,'知识库标识','knowledge_id');
  url.placeholder='https://企业知识服务/retrieval';url.maxLength=500;key.autocomplete='new-password';key.maxLength=2000;knowledgeId.maxLength=150;
  const clearKey=el('input');clearKey.type='checkbox';const clearLabel=el('label',undefined,'knowledge-check');clearLabel.append(clearKey,el('span','清除已保存的密钥'));connection.append(clearLabel);
  form.append(description,connection,knowledgeId.parentElement);
  const permissions=el('fieldset'),legend=el('legend','使用范围'),roleBox=el('div',undefined,'knowledge-roles'),roleChecks={};
  for(const [role,text] of Object.entries(roleNames)){const label=el('label',undefined,'knowledge-check'),check=el('input');check.type='checkbox';roleChecks[role]=check;label.append(check,el('span',text));roleBox.append(label);}
  permissions.append(legend,el('p','管理员始终可用。请仅共享当前知识库内已获准使用的资料。','knowledge-muted'),roleBox);
  const rooms=field(permissions,'适用库区（不选表示当前账号有权限的全部库区）','rooms','select');rooms.multiple=true;rooms.size=4;form.append(permissions);
  const actions=el('div',undefined,'knowledge-actions'),save=el('button','保存设置'),test=button('检测连接',()=>run(async()=>{const result=await workApi('/api/admin/knowledge/test',{},'POST');message.textContent=result.message;if(mode.value==='local')await listDocuments();}));save.type='submit';actions.append(save,test);form.append(actions);
  const message=el('p','','knowledge-message');message.setAttribute('role','status');host.append(form,message);
  const documents=el('details',undefined,'knowledge-documents'),summary=el('summary','本地资料管理'),docList=el('div'),editor=el('form'),title=field(editor,'资料标题','title'),source=field(editor,'来源链接（可选）','source'),content=field(editor,'资料正文','content','textarea'),file=field(editor,'导入 TXT / Markdown（UTF-8）','file','file');
  title.maxLength=150;source.type='url';content.rows=10;content.maxLength=200000;file.accept='.txt,.md,.markdown';
  const docActions=el('div',undefined,'knowledge-actions'),publish=el('button','保存并建立索引'),cancel=button('新建另一份资料',()=>resetEditor());publish.type='submit';docActions.append(publish,cancel);editor.append(docActions);
  documents.append(summary,el('p','适合操作规程、产品说明等文本资料。PDF、Word请先转为文本。首版采用全文检索，不额外占用模型显存。','knowledge-muted'),docList,editor);host.append(documents);
  let loaded=false,busy=false,dirty=false,editing='',savedUrl='',version=0;
  function paint(){
    const enterprise=mode.value==='enterprise',enabled=mode.value!=='off';connection.hidden=!enterprise;permissions.hidden=knowledgeId.parentElement.hidden=!enabled;documents.hidden=mode.value!=='local'||dirty;
    description.textContent=mode.value==='off'?'关闭后不发起知识检索，原有库存作业照常使用。':enterprise?'复用企业知识服务；接口采用外部知识检索格式。密钥应仅能访问指定知识库。':'资料存放在当前仓储后台，随数据库一起备份。模型可用时结合原文回答，不可用时仍能检索资料。';
    for(const control of host.querySelectorAll('input,textarea,select,button'))control.disabled=!loaded||busy;
    test.disabled=!loaded||busy||dirty||!enabled;url.required=enterprise;content.required=title.required=true;knowledgeId.required=enabled;
  }
  function fill(config){mode.value=config.mode;url.value=config.url;knowledgeId.value=config.knowledge_id;key.value='';clearKey.checked=false;key.placeholder=config.has_key?'已保存，留空保留':'填写仅供此知识库使用的密钥';savedUrl=config.url;for(const [role,check] of Object.entries(roleChecks))check.checked=config.roles.includes(role);for(const option of rooms.options)option.selected=config.rooms.includes(option.value);dirty=false;loaded=true;paint();}
  async function run(fn){if(busy)return;busy=true;paint();message.textContent='处理中…';try{await fn();}catch(error){message.textContent=error.message;}finally{busy=false;paint();}}
  async function refresh(){if(busy||loaded)return;await run(async()=>{const [result,availableRooms]=await Promise.all([workApi('/api/admin/knowledge'),workApi('/api/rooms')]);rooms.replaceChildren();for(const room of availableRooms){const option=el('option',room.name+' · '+room.loc_code);option.value=room.loc_code;rooms.append(option);}fill(result.config);message.textContent='';if(mode.value==='local')await listDocuments();});}
  function resetEditor(){version++;editing='';title.value=source.value=content.value=file.value='';publish.textContent='保存并建立索引';}
  async function listDocuments(){const rows=await workApi('/api/admin/knowledge/documents');docList.replaceChildren();if(!rows.length)docList.append(el('p','暂无资料，请在下方添加。','knowledge-muted'));
    for(const row of rows){const item=el('div',undefined,'knowledge-document');item.append(el('strong',row.title),el('small',`${row.active?'已启用':'已停用'} · 第${row.version}版 · ${row.chunks}个片段`),button('编辑',()=>run(async()=>{const result=await workApi('/api/admin/knowledge/documents/'+row.id);editing=row.id;title.value=result.title;source.value=result.source;content.value=result.content;publish.textContent='更新资料并重建索引';content.focus();message.textContent='正在编辑：'+result.title;})),button(row.active?'停用':'启用',()=>run(async()=>{await workApi('/api/admin/knowledge/documents/'+row.id,{active:!row.active},'PUT');await listDocuments();message.textContent=row.active?'资料已停用，不再参与检索，可随时重新启用。':'资料已启用。';})));docList.append(item);}}
  form.addEventListener('input',()=>{dirty=true;message.textContent='连接设置尚未保存';paint();});
  form.onsubmit=event=>{event.preventDefault();void run(async()=>{const config={mode:mode.value,url:url.value,knowledge_id:knowledgeId.value,roles:Object.entries(roleChecks).filter(([,input])=>input.checked).map(([role])=>role),rooms:[...rooms.selectedOptions].map(option=>option.value),clear_key:clearKey.checked};if(key.value)config.api_key=key.value;else if(url.value!==savedUrl)config.clear_key=true;const result=await workApi('/api/admin/knowledge',config,'PUT');fill(result.config);resetEditor();message.textContent='知识库设置已保存。';if(mode.value==='local')await listDocuments();});};
  file.onchange=async()=>{const current=++version,selected=file.files?.[0];if(!selected)return;try{if(!/\.(txt|md|markdown)$/i.test(selected.name)||selected.size>800000)throw Error('请选择800 KB以内的 UTF-8 文本或 Markdown 文件');const value=await selected.text();if(current!==version)return;if(value.includes('\ufffd'))throw Error('文本编码无法识别，请另存为 UTF-8 后导入');content.value=value;if(!title.value)title.value=selected.name.replace(/\.[^.]+$/,'');message.textContent='已读入文本，核对后点击保存建立索引。';}catch(error){message.textContent=error.message;}finally{file.value='';}};
  editor.onsubmit=event=>{event.preventDefault();void run(async()=>{await workApi('/api/admin/knowledge/documents'+(editing?'/'+editing:''),{title:title.value,content:content.value,source:source.value},editing?'PUT':'POST');resetEditor();await listDocuments();message.textContent='资料已保存，检索索引已更新。';});};
  paint();return {refresh};
}

export function createKnowledgeQuestionUI(host,{getRoom,onBusiness,onAuthRequired}){
  styles();host.classList.add('knowledge-question');
  const intro=el('p','查询企业制度、操作规程和产品资料。当前库存和业务办理请使用“对话”。','knowledge-muted'),status=el('p','','knowledge-message'),form=el('form'),question=field(form,'知识问题','question','textarea'),ask=el('button','检索并回答'),result=el('div');
  question.rows=3;question.maxLength=600;question.placeholder='例如：盘点发现数量差异，应该怎么复核？';ask.type='submit';form.append(ask);host.append(intro,status,form,result);
  let ready=false,busy=false,room='',request=0;
  function controls(){question.disabled=ask.disabled=!ready||busy;}
  async function refresh(){const selected=getRoom();if(room===selected&&ready)return;room=selected;const serial=++request;ready=false;controls();status.textContent='正在读取知识库状态…';try{const value=await workApi('/api/assistant/knowledge/status?'+new URLSearchParams({room:selected}));if(serial!==request)return;ready=value.allowed;status.textContent=value.message;}catch(error){if(serial!==request)return;status.textContent=error.message;if(error.status===401)onAuthRequired?.();}finally{controls();}}
  form.onsubmit=async event=>{event.preventDefault();if(busy||!ready)return;const value=question.value.trim();if(!value){status.textContent='请输入知识问题';return;}const serial=++request,selected=getRoom();busy=true;controls();status.textContent='正在检索资料，准备回答…';result.replaceChildren();try{
    const answer=await workApi('/api/assistant/knowledge/ask',{room:selected,question:value},'POST');if(serial!==request||selected!==getRoom()||!host.isConnected)return;
    status.textContent=answer.state==='answered'?'已根据以下资料生成回答':answer.state==='sources_only'?'已检索到资料 · 请以原文为准':answer.state==='no_match'?'未找到相关资料':'';
    result.append(el('p',answer.answer,'knowledge-answer'));
    if(answer.state==='business_required')result.append(button('转到对话查询',()=>onBusiness(value)));
    for(const source of answer.sources){const details=el('details',undefined,'knowledge-source'),caption=`[${source.index}] ${source.title}${source.section?' · '+source.section:''}`;details.append(el('summary',caption));if(source.version)details.append(el('small','资料版本：'+source.version));details.append(el('p',source.content,'knowledge-excerpt'));if(source.url){const link=el('a','查看原始来源');link.href=source.url;link.target='_blank';link.rel='noopener noreferrer';details.append(link);}result.append(details);}
  }catch(error){if(serial!==request)return;status.textContent=error.message;if(error.status===401)onAuthRequired?.();}finally{if(serial===request){busy=false;controls();}}};
  function reset(){request++;ready=busy=false;room='';question.value='';result.replaceChildren();status.textContent='';controls();}
  controls();return {refresh,reset};
}
