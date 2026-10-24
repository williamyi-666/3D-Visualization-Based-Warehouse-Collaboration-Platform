// 可复制到 ERP/WMS 的宿主侧。跨域接入时还需服务端配置 SPATIAL_HOST_ORIGINS 和平台登录。
import {resolveBusinessInventory} from './business-example.mjs';
const frame=document.getElementById('warehouse');
const targetOrigin=new URL(frame.src).origin;
const button=document.getElementById('locate');
const status=document.getElementById('status');
const business=document.getElementById('business');
let businessRequest=0;
function backToWarehouse(){businessRequest++;business.hidden=true;frame.hidden=false;}
document.getElementById('backToWarehouse').onclick=backToWarehouse;
async function openBusiness(payload){
  const request=++businessRequest;
  business.hidden=false;frame.hidden=true;
  const info=document.getElementById('businessStatus'),fields=document.getElementById('businessFields');
  fields.replaceChildren();info.textContent='正在读取当前同步库存…';
  try{
    const row=await resolveBusinessInventory(payload,{basePath:window.SPATIAL_RUNTIME?.basePath || ''});
    if(request!==businessRequest)return;
    info.textContent='数据来自本应用同步视图，仅用于宿主业务跳转联调。';
    for(const [label,value] of [['来源',row.source],['SKU',row.sku],['物料',row.name],['库位',row.loc_code],['外部库位',row.external_loc_code],['数量',`${row.qty} ${row.unit}`],['批次',row.batch_no],['状态',row.status],['快照版本',row.snapshot_version],['接收时间',row.received_at]]){
      const term=document.createElement('dt'),detail=document.createElement('dd');
      term.textContent=label;detail.textContent=String(value ?? '—');fields.append(term,detail);
    }
  }catch(e){if(request===businessRequest)info.textContent=e.message;}
}
const send=(type,payload={})=>frame.contentWindow.postMessage({channel:'spatial-inventory',version:1,type,payload,requestId:String(Date.now())},targetOrigin);
let attempts=0;
// 三维场景异步初始化，收到 ready 后停止握手重试。
const timer=setInterval(()=>{
  if(++attempts>30) {clearInterval(timer);status.textContent='连接超时，请检查平台登录后刷新';return;}
  send('hello');
},1000);
window.addEventListener('message',event=>{
  if(event.source!==frame.contentWindow || event.origin!==targetOrigin) return;
  const data=event.data;
  if(data?.channel!=='spatial-inventory' || data.version!==1) return;
  if(data.type==='ready') {clearInterval(timer);status.textContent='已连接';button.disabled=false;}
  if(['located','error','open-business'].includes(data.type)) document.getElementById('result').textContent=JSON.stringify(data,null,2);
  if(data.type==='open-business')openBusiness(data.payload);
});
button.onclick=()=>{backToWarehouse();send('locate',{sku:document.getElementById('sku').value});};
