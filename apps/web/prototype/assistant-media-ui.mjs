const el=(tag,text,className)=>{const node=document.createElement(tag);if(text!=null)node.textContent=text;if(className)node.className=className;return node;};
const button=(title,click)=>{const node=el('button',title);node.type='button';node.onclick=click;return node;};
const readData=blob=>new Promise((resolve,reject)=>{const reader=new FileReader();reader.onload=()=>resolve(reader.result);reader.onerror=()=>reject(Error('无法读取文件，请重新选择'));reader.readAsDataURL(blob);});

export function createAssistantInput({host,before,guard,onBusy,onResult,recognize,onError}){
  const root=el('div',null,'assistant-input-controls'),hint=el('p','','work-hint');hint.setAttribute('role','status');
  const voiceFile=el('input'),photoFile=el('input');voiceFile.type=photoFile.type='file';voiceFile.accept='audio/*';photoFile.accept='image/*';photoFile.setAttribute('capture','environment');voiceFile.hidden=photoFile.hidden=true;
  voiceFile.setAttribute('aria-label','选择录音文件');photoFile.setAttribute('aria-label','选择标签照片');
  let recorder,stream,timer,serial=0,recording=false;
  const sayError=error=>{hint.textContent=error.message;onError?.(error);};
  const attachments=el('details',null,'assistant-attachments'),attachmentToggle=el('summary','＋');attachmentToggle.title='更多附件';attachmentToggle.setAttribute('aria-label','更多附件');
  const voice=button('语音',()=>start().catch(sayError)),photo=button('照片',()=>{try{guard();photoFile.click();}catch(error){sayError(error);}}),upload=button('录音文件',()=>{try{guard();attachments.open=false;voiceFile.removeAttribute('capture');voiceFile.click();}catch(error){sayError(error);}});
  voice.setAttribute('aria-label','语音输入');voice.title='语音输入';photo.setAttribute('aria-label','标签识别');photo.title='拍摄或选择标签照片';attachments.append(attachmentToggle,upload);
  root.append(voice,photo,attachments,voiceFile,photoFile,hint);host.insertBefore(root,before);
  function idle(){recording=false;clearInterval(timer);stream?.getTracks().forEach(track=>track.stop());stream=null;recorder=null;voice.textContent='语音';voice.setAttribute('aria-label','语音输入');voice.disabled=photo.disabled=upload.disabled=false;onBusy(false);}
  function cancel(){serial++;if(recorder?.state==='recording')recorder.stop();idle();}
  async function process(blob,kind,version=++serial){
    if(blob.size>(kind==='photo'?5:8)*1024*1024)throw Error('文件过大，请缩短录音或只拍摄货品标签');
    onBusy(true);voice.disabled=photo.disabled=upload.disabled=true;hint.textContent=kind==='photo'?'正在读取标签文字…':'正在转写录音…';
    try{const data=await readData(blob),result=await recognize(kind,data);if(version!==serial)return;hint.textContent='识别完成，请核对下方内容。';onBusy(false);onResult({...result,...(kind==='photo'?{photo:data}:{audio:data})});}
    catch(error){if(version===serial)throw error;}
    finally{if(version===serial){onBusy(false);voice.disabled=photo.disabled=upload.disabled=false;}}
  }
  async function start(){
    if(recording){recorder.stop();return;}
    guard();
    if(!window.isSecureContext||!navigator.mediaDevices?.getUserMedia||!window.MediaRecorder){voiceFile.setAttribute('capture','user');hint.textContent='请使用系统录音，录完选择该文件；每段不超过60秒。';voiceFile.click();return;}
    const version=++serial;onBusy(true);hint.textContent='请允许麦克风，然后说出货品、数量和位置。';
    try{
      const ownStream=await navigator.mediaDevices.getUserMedia({audio:true});if(version!==serial){ownStream.getTracks().forEach(track=>track.stop());return;}stream=ownStream;
      const mime=['audio/webm;codecs=opus','audio/mp4','audio/ogg;codecs=opus'].find(type=>MediaRecorder.isTypeSupported(type));
      recorder=new MediaRecorder(stream,mime?{mimeType:mime}:{});const ownRecorder=recorder,parts=[];recording=true;photo.disabled=upload.disabled=true;voice.textContent='停止录音 · 0秒';voice.setAttribute('aria-label',voice.textContent);
      recorder.ondataavailable=event=>{if(event.data.size)parts.push(event.data);};
      recorder.onstop=()=>{if(version!==serial)return;const type=ownRecorder.mimeType||parts[0]?.type||'audio/webm';idle();void process(new Blob(parts,{type}),'speech',version).catch(sayError);};
      recorder.onerror=()=>{if(version===serial){cancel();sayError(Error('录音中断，可使用“录音文件”重新选择'));}};
      const began=Date.now();recorder.start();hint.textContent='正在录音，再点一次结束；最长60秒。';
      timer=setInterval(()=>{const seconds=Math.floor((Date.now()-began)/1000);voice.textContent=`停止录音 · ${seconds}秒`;voice.setAttribute('aria-label',voice.textContent);if(seconds>=60)recorder?.stop();},1000);
    }catch(error){idle();throw Error(error.name==='NotAllowedError'?'未获得麦克风权限，可点“录音文件”上传录音。':'无法打开麦克风，可点“录音文件”上传录音。');}
  }
  voiceFile.onchange=()=>{const file=voiceFile.files[0];voiceFile.value='';if(file)try{guard();void process(file,'speech').catch(sayError);}catch(error){sayError(error);}};
  photoFile.onchange=async()=>{
    const file=photoFile.files[0];photoFile.value='';if(!file)return;
    let version;
    try{
      guard();version=++serial;onBusy(true);const image=await createImageBitmap(file),scale=Math.min(1,2200/Math.max(image.width,image.height));
      const canvas=el('canvas');canvas.width=Math.round(image.width*scale);canvas.height=Math.round(image.height*scale);const ctx=canvas.getContext('2d');ctx.fillStyle='#fff';ctx.fillRect(0,0,canvas.width,canvas.height);ctx.drawImage(image,0,0,canvas.width,canvas.height);image.close();
      const blob=await new Promise(resolve=>canvas.toBlob(resolve,'image/jpeg',0.9));if(version!==serial)return;if(!blob)throw Error('无法读取图片，请选择PNG或JPEG照片');await process(blob,'photo',version);
    }catch(error){sayError(error);}finally{if(version===serial)onBusy(false);}
  };
  const hidden=()=>{if(document.hidden&&recording){cancel();hint.textContent='录音已停止，请回到页面重新开始。';}};
  document.addEventListener('visibilitychange',hidden);
  return {root,cancel,clearHint(){hint.textContent='';attachments.open=false;},stop(){cancel();document.removeEventListener('visibilitychange',hidden);}};
}

export function renderMediaReview(host,result,{canOperate,canCount,getContext,api,preview,onText,onDiscard,onDirty,run}){
  host.replaceChildren(el('strong',result.source==='speech'?'语音内容核对':'标签内容核对'),el('p','核对后生成预览，确认后才记账。','work-hint'));onDirty(true);
  const source=el('details',null,'assistant-input-source');source.append(el('summary','查看识别原文'));host.append(source);
  if(result.photo){const image=el('img');image.src=result.photo;image.alt='待核对标签照片';image.className='assistant-input-photo';source.append(image);}
  if(result.audio){const audio=el('audio');audio.src=result.audio;audio.controls=true;audio.setAttribute('aria-label','回听原录音');source.append(audio);}
  const label=el('label','识别原文'),raw=el('textarea');label.htmlFor=raw.id='input-text-'+window.spatialRandomUUID();raw.rows=3;raw.maxLength=4000;raw.value=result.text;source.append(label,raw);
  source.append(button('按修改后的原文更新建议',()=>run(async()=>{
    const controls=[...host.querySelectorAll('button,input,select,textarea')].map(node=>[node,node.disabled]);controls.forEach(([node])=>node.disabled=true);
    try{const next=await api('/api/assistant/media/text',{text:raw.value,source:result.source});if(host.isConnected)renderMediaReview(host,{...result,...next},{canOperate,canCount,getContext,api,preview,onText,onDiscard,onDirty,run});}
    finally{for(const [node,disabled] of controls)if(node.isConnected)node.disabled=disabled;}
  })));
  const form=el('div',null,'assistant-input-fields'),fields=result.fields||{};host.append(form);
  function field(title,value='',type='text'){const box=el('div',null,'assistant-input-field'),label=el('label',title),node=el(type==='select'?'select':'input');label.htmlFor=node.id='input-'+window.spatialRandomUUID();if(type!=='select'){node.type=type;node.value=value??'';if(type==='number'){node.min='0';node.step='any';}}box.append(label,node);form.append(box);return node;}
  const operation=field('办理业务','','select');
  for(const [value,title] of [['','请选择'],['query','查询货品'],...(canOperate?[['in','入库'],['out','出库'],['move','移库']]:[]),...(canCount?[['count','盘点实盘数量']]:[])]){const option=el('option',title);option.value=value;operation.append(option);}
  operation.value=fields.operation&&[...operation.options].some(option=>option.value===fields.operation)?fields.operation:'query';
  const name=field('货品名称',fields.name),spec=field('规格 / 型号',fields.spec),sku=field('SKU / 物料编号',fields.sku),quantity=field('本次数量 / 实盘总数',fields.qty??'','number'),unit=field('单位',fields.unit),from=field('源格位',fields.from_hint),to=field('目标格位',fields.to_hint);
  for(const node of [operation,name,from,to])node.parentElement.classList.add('wide');
  const newLabel=el('label',null,'assistant-job-new'),newItem=el('input');newItem.type='checkbox';newLabel.append(newItem,el('span','登记为新货品（仅入库）'));form.append(newLabel);
  const actions=el('div',null,'work-actions'),submit=button('生成作业预览',()=>run(async()=>{
    const kind=operation.value,query=sku.value.trim()||[name.value.trim(),spec.value.trim()].filter(Boolean).join(' ');
    if(!kind)throw Error('请选择办理业务');if(!query)throw Error('请填写货品名称、规格或SKU');
    if(kind!=='query'&&(quantity.value===''||!Number.isFinite(Number(quantity.value))||Number(quantity.value)<0||(kind!=='count'&&Number(quantity.value)===0)))throw Error('请核对办理数量；盘点可填0，出入库须大于0');
    const disabled=[...host.querySelectorAll('button,input,select,textarea')].map(node=>[node,node.disabled]);disabled.forEach(([node])=>node.disabled=true);
    try{const applied=await preview(kind,{query,name:[name.value.trim(),spec.value.trim()].filter(Boolean).join(' '),sku:sku.value.trim(),qty:Number(quantity.value),unit:unit.value.trim(),from_hint:from.value.trim(),to_hint:to.value.trim(),new_item:newItem.checked});if(applied!==false)onDirty(false);}finally{for(const [node,value] of disabled)if(node.isConnected)node.disabled=value;}
  }));submit.classList.add('primary');actions.append(submit,button('仅填入对话',()=>{onDirty(false);onText(raw.value);}),button('放弃识别结果',()=>{onDirty(false);onDiscard();}));host.append(actions);
  function visibility(){const kind=operation.value;newLabel.hidden=kind!=='in';quantity.previousElementSibling.textContent=kind==='count'?'实盘总数量':'本次办理数量';for(const node of [quantity,unit])node.parentElement.hidden=kind==='query';from.parentElement.hidden=!['out','move','count'].includes(kind);to.parentElement.hidden=!['in','move'].includes(kind);submit.textContent=kind==='query'?'查询实际库存':'生成作业预览';const loc=getContext().loc_code;if(loc&&['out','move','count'].includes(kind)&&!from.value)from.value=loc;if(loc&&kind==='in'&&!to.value)to.value=loc;}
  operation.onchange=visibility;visibility();host.scrollIntoView({block:'start'});
}
