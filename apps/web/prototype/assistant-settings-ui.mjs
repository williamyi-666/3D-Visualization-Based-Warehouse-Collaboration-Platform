import {workApi} from './work-request.mjs';
import {assistantModelState} from './assistant-model-state.mjs';
const el=(tag,text,className)=>{const node=document.createElement(tag);if(text)node.textContent=text;if(className)node.className=className;return node;};
export function createAssistantSettingsUI(host){
  if(!document.querySelector('link[data-assistant-settings]')){const link=el('link');link.rel='stylesheet';link.href=new URL('./assistant-settings.css',import.meta.url);link.dataset.assistantSettings='';document.head.append(link);}
  host.classList.add('assistant-settings');
  const title=el('h3','智能模型'),intro=el('p','基础仓储独立运行，智能助手按需接入。','model-muted'),form=el('form'),toggle=el('label',undefined,'model-toggle'),enabled=el('input');enabled.type='checkbox';toggle.append(enabled,el('span','启用智能模型'));
  const fields=el('div',undefined,'model-fields');
  function field(labelText,name,placeholder){const label=el('label',labelText),input=el('input');input.name=name;input.placeholder=placeholder;input.type='text';input.autocomplete='off';input.maxLength=name==='url'?500:150;label.append(input);fields.append(label);return input;}
  const url=field('模型服务地址','url','http://模型服务器:11434'),model=field('模型名称','model','填写 Ollama 中已安装的完整模型名称');
  const help=el('p','连接本机或企业内网的 Ollama 服务。地址必须能从仓储后台访问，无需在每台操作设备上安装模型。','model-muted');
  const status=el('div',undefined,'model-status'),badge=el('strong','正在读取'),detail=el('p');status.setAttribute('role','status');status.append(badge,detail);
  const actions=el('div',undefined,'model-actions'),save=el('button','保存设置'),connect=el('button','检测连接'),message=el('p',undefined,'model-message');message.setAttribute('role','status');save.type='submit';connect.type='button';actions.append(save,connect);form.append(toggle,fields,help,status,actions,message);host.append(title,intro,form);
  let loaded=false,busy=false,refreshing=false,dirty=false,lastHealth;
  function controls(){for(const input of [enabled,url,model,save])input.disabled=busy||!loaded;connect.disabled=busy||!loaded||dirty||!lastHealth?.enabled;url.disabled=model.disabled=busy||!loaded||!enabled.checked;url.required=model.required=enabled.checked;}
  function paint(health){lastHealth=health;const view=assistantModelState(health);status.dataset.state=view.state;badge.textContent=view.label;detail.textContent=view.hint;controls();}
  function fill(config){enabled.checked=config.enabled;url.value=config.url;model.value=config.model;dirty=false;loaded=true;controls();}
  async function refresh(){
    if(busy||refreshing)return;refreshing=true;
    try{const result=await workApi('/api/admin/assistant-model'+(loaded?'?active=1':''));if(!loaded)fill(result.config);paint(result.status);}
    catch(error){message.textContent=error.message;if([401,403].includes(error.status)){loaded=false;controls();}}
    finally{refreshing=false;}
  }
  form.addEventListener('input',()=>{dirty=true;message.textContent='设置尚未保存';controls();});
  form.onsubmit=async event=>{
    event.preventDefault();busy=true;controls();message.textContent='正在保存…';
    try{const result=await workApi('/api/admin/assistant-model',{enabled:enabled.checked,url:url.value,model:model.value},'PUT');fill(result.config);paint(result.status);message.textContent=result.config.enabled?'设置已保存。':'已停用智能模型，基础仓储照常使用。';}
    catch(error){message.textContent=error.message;}finally{busy=false;controls();}
  };
  connect.onclick=async()=>{busy=true;controls();message.textContent='正在检测…';try{const result=await workApi('/api/admin/assistant-model/connect',{},'POST');paint(result.status);message.textContent='';}catch(error){message.textContent=error.message;}finally{busy=false;controls();}};
  const timer=setInterval(()=>{if(!document.hidden&&host.getClientRects().length)void refresh();},5000);
  window.addEventListener('pagehide',()=>clearInterval(timer),{once:true});controls();
  return {refresh};
}
