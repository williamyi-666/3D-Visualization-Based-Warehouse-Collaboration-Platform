import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {extractMediaFields} from './assistant-media-fields.mjs';

const execute=promisify(execFile),worker=fileURLToPath(new URL('../../packages/ai/media_worker.py',import.meta.url));
const fail=(message,status=400)=>{throw Object.assign(Error(message),{status});};
export function createLocalMedia({enabled=process.env.SPATIAL_INPUT_ENABLED==='1',python=process.env.SPATIAL_INPUT_PYTHON||'python3'}={}){
  let busy=false,cached,checkedAt=0;
  const invoke=async args=>{try{const {stdout}=await execute(python,[worker,...args],{timeout:50000,maxBuffer:1024*1024,windowsHide:true});const value=JSON.parse(stdout);if(value.error)fail(value.error);return value;}catch(error){let value;try{value=JSON.parse(error.stdout);}catch{}fail(value?.error||'本地识别暂不可用，请稍后重试',503);}};
  async function status(){
    if(!enabled)return {speech:false,photo:false,message:'尚未启用本地输入识别'};
    if(!cached||Date.now()-checkedAt>30000){cached=await invoke(['status']);checkedAt=Date.now();}return cached;
  }
  async function recognize(kind,data){
    if(!['speech','photo'].includes(kind))fail('请选择语音或标签照片');
    if(!enabled)fail('尚未启用本地输入识别',503);
    if(typeof data!=='string'||data.length>12*1024*1024)fail('请选择不超过8MB的录音或5MB的标签照片');
    const found=data.match(/^data:([^;,]+)(?:;codecs=[^;,]+)?;base64,([A-Za-z0-9+/=]+)$/);
    const allowed=kind==='photo'?/^image\/(jpeg|png|webp)$/:/^(?:audio\/(?:wav|x-wav|wave|webm|ogg|mp4|mpeg|aac|amr|3gpp)|video\/(?:webm|mp4|3gpp))$/;
    if(!found||!allowed.test(found[1]))fail('不支持此文件格式，请选择常见录音文件或PNG、JPEG照片');
    const bytes=Buffer.from(found[2],'base64');if(bytes.length>(kind==='photo'?5:8)*1024*1024)fail('文件过大，请缩短录音或只拍摄货品标签');
    if(busy)fail('识别服务正在处理另一段输入，请稍后再试',429);
    busy=true;let folder;
    try{
      folder=await mkdtemp(join(tmpdir(),'warehouse-input-'));const path=join(folder,'input');await writeFile(path,bytes);
      const result=await invoke([kind,path]);if(!result.text?.trim())fail(kind==='speech'?'没有听清内容，请重新录音或手动输入':'没有识别到标签文字，请靠近标签重新拍摄');
      return {kind:'media',source:kind,...result,...extractMediaFields(result.text),message:'请核对识别原文与填写建议。此步骤尚未改变库存。'};
    }finally{busy=false;if(folder)await rm(folder,{recursive:true,force:true});}
  }
  return {status,recognize};
}

export function mountAssistantMedia(app,{media,tools,authorize}){
  const run=fn=>async(req,res)=>{try{if(!await authorize(req))fail('登录或仓库权限已变化，请重新登录',401);req.body={...req.body,room:req.body?.room||req.query.room};await tools.context(req);res.set('Cache-Control','no-store').json(await fn(req));}catch(error){res.status(error.status||400).json({error:error.message});}};
  app.get('/api/assistant/media/status',run(()=>media.status()));
  app.post('/api/assistant/media/recognize',run(req=>media.recognize(req.body.kind,req.body.data)));
  app.post('/api/assistant/media/text',run(req=>{if(typeof req.body.text!=='string'||req.body.text.length>4000)fail('识别原文最多4000字');return {kind:'media',source:req.body.source,...extractMediaFields(req.body.text)};}));
}
