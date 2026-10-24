import {SupOSAdapter} from './suposUnsAdapter.mjs';
import {getNested} from '../adapter.mjs';

// 显式选用的UNS事件信封模式；只读核对预建模型，不创建或修改平台模型。
export class SupOSEventAdapter extends SupOSAdapter {
 constructor(mappingPath,{fetcher=fetch,sleep=ms=>new Promise(r=>setTimeout(r,ms))}={}) {
  super(mappingPath);
  this.alias=process.env.SUPOS_UNS_EVENT_ALIAS || '';
  this.expectedPath=process.env.SUPOS_UNS_EVENT_PATH || '';
  this.apiBase=process.env.SUPOS_INTERNAL_API || 'http://backend:8080';
  this.fetcher=fetcher;this.sleep=sleep;
  this.lastVerifiedEvent=null;
  if(!this.alias || !this.expectedPath)throw Error('UNS事件模式需要模型别名和预期路径');
 }
 async request(route,body){
  const r=await this.fetcher(this.apiBase.replace(/\/$/,'')+route,{method:body===undefined?'GET':'POST',
   headers:{'Content-Type':'application/json'},...(body===undefined?{}:{body:JSON.stringify(body)}),signal:AbortSignal.timeout(10000)});
  const result=await r.json();
  if(!r.ok || ![0,200].includes(result.code))throw Error(result.msg || 'UNS模型接口失败');
  return result.data;
 }
 async send(eventType,payload){
  if(!getNested(this.mapping,eventType))return {ok:false,skipped:true};
  if(process.env.SUPOS_DRYRUN==='1')return {ok:false,dry:true};
  const {_idem,...data}=payload;
  if(typeof _idem!=='string'||!_idem)throw Error('UNS事件必须提供独立事件ID');
  const model=await this.request('/open-api/uns/file/'+encodeURIComponent(this.alias));
  if(model.alias!==this.alias||model.path!==this.expectedPath||model.dataType!==1)throw Error('UNS事件模型标识或类型不匹配');
  const fields=model.definition?.filter(f=>!f.systemField) || [];
  if(fields.length!==3 || !['event_id','event_type','payload'].every(name=>fields.some(f=>f.name===name&&f.type==='STRING')))throw Error('UNS事件模型字段不匹配');
  const message={event_id:_idem,event_type:eventType,payload:JSON.stringify(data),timeStamp:Date.now(),quality:192};
  for(const field of fields){
   if(!Number.isInteger(field.maxLen)||field.maxLen<1||Buffer.byteLength(message[field.name],'utf8')>field.maxLen)throw Error('UNS事件字段超过模型长度：'+field.name);
  }
  const sent=await this.publish(model.path,message,_idem);
  if(!sent?.ok||sent.dry)return sent;
  for(let i=0;i<20;i++){
   const current=(await this.request('/open-api/uns/file/current/batchQuery',[this.alias]))?.[this.alias];
   if(current?.event_id===_idem&&Number(current.timeStamp)===message.timeStamp&&current.event_type===eventType&&current.payload===message.payload){
    this.lastVerifiedEvent=_idem;
    return {ok:true,acknowledgement:'uns-current-value'};
   }
   if(i<19)await this.sleep(250);
  }
  throw Error('Broker已确认，但UNS未读回同一事件，保持待发送');
 }
 getStatus(){return {...super.getStatus(),transport:'uns-event-model',modelAlias:this.alias,modelPath:this.expectedPath,
  acknowledgement:'UNS当前值读回；不代表持久化或ERP处理成功',lastVerifiedEvent:this.lastVerifiedEvent};}
}
