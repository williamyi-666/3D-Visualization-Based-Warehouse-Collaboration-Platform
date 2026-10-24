import test from 'node:test';
import assert from 'node:assert/strict';
import express from '../apps/api/node_modules/express/index.js';
import {extractMediaFields} from '../apps/api/assistant-media-fields.mjs';
import {createLocalMedia,mountAssistantMedia} from '../apps/api/assistant-media.mjs';

test('标签编号和规格不充当数量，语音与标签字段都只取明确内容',()=>{
  const label=extractMediaFields('货 品 名 称 : 深 沟 球 轴 承\n规格型号: 6204\nSKU: BRG-6204\n数量: 24 套');
  assert.equal(label.fields.name,'深沟球轴承');assert.equal(label.fields.spec,'6204');assert.equal(label.fields.sku,'BRG-6204');assert.equal(label.fields.qty,24);assert.equal(label.fields.unit,'套');assert.equal(label.fields.operation,'');
  assert.equal(extractMediaFields('SKU: BRG-6204\n规格: 6204').fields.qty,null);
  assert.equal(extractMediaFields('品名: 24个装垫圈\n规格:1.20米').fields.qty,null);
  assert.equal(extractMediaFields('出库轴承-3套').fields.qty,-3);
  const speech=extractMediaFields('入库 轴承 三 套');assert.equal(speech.fields.operation,'in');assert.equal(speech.fields.qty,3);assert.equal(speech.fields.name,'轴承');
  assert.equal(extractMediaFields('入库轴承3套、垫圈5盒').fields.qty,null);
  assert.equal(extractMediaFields('盘点轴承0套').fields.qty,0);
  assert.equal(extractMediaFields('出库轴承三五套').fields.qty,null);
});

test('未启用识别时如实返回，不假装识别成功',async()=>{
  const media=createLocalMedia({enabled:false});assert.equal((await media.status()).speech,false);await assert.rejects(media.recognize('speech','data:audio/wav;base64,AAAA'),error=>error.status===503);
});

test('输入识别逐次检查登录与库区，不允许通过上传或重提取跳过权限',async()=>{
  const app=express();app.use(express.json());let authenticated=true,allowed=true,calls=0;
  mountAssistantMedia(app,{authorize:req=>{req.user={id:'test-viewer',role:'viewer'};return authenticated;},tools:{context:async req=>{if(!allowed||req.body.room!=='WH-2')throw Object.assign(Error('没有此库区权限'),{status:403});}},media:{status:async()=>({speech:true,photo:true}),recognize:async kind=>{calls++;return {kind:'media',source:kind,...extractMediaFields('SKU:TEST-6204\n数量:3套')};}}});
  const server=app.listen(0,'127.0.0.1');await new Promise(resolve=>server.once('listening',resolve));
  const api=(path,body)=>fetch('http://127.0.0.1:'+server.address().port+'/api/assistant/media/'+path,body?{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)}:{});
  try{
    const parsed=await api('text',{room:'WH-2',text:'数量:3套'});assert.equal((await parsed.json()).fields.qty,3);
    assert.equal((await api('recognize',{room:'WH-2',kind:'speech',data:'test'})).status,200);assert.equal(calls,1);
    allowed=false;assert.equal((await api('recognize',{room:'WH-2',kind:'photo',data:'test'})).status,403);assert.equal(calls,1);assert.equal((await api('text',{room:'WH-2',text:'数量:3套'})).status,403);
    authenticated=false;assert.equal((await api('status?room=WH-2')).status,401);
  }finally{server.closeAllConnections();await new Promise(resolve=>server.close(resolve));}
});
