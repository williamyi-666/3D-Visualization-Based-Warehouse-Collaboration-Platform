import {photoDocumentTable} from './document-photo-table.mjs';
const el=(tag,text,cls)=>{const node=document.createElement(tag);if(text!=null)node.textContent=text;if(cls)node.className=cls;return node;};
const button=(text,action)=>{const node=el('button',text);node.type='button';node.onclick=action;return node;};
function field(parent,title,tag='input'){
  const label=el('label',title),node=el(tag);label.htmlFor=node.id='document-'+window.spatialRandomUUID();parent.append(label,node);return node;
}

export function renderDocumentImport(host,{api,mediaApi,run,onJob,onDirty,onBusy,onCancel}){
  host.replaceChildren(el('strong','导入整张单据'),el('p','先读取原文，再核对货品与位置。此处不会修改库存。','work-hint'));
  const form=el('div',null,'assistant-document-form'),operation=field(form,'办理业务','select');
  for(const [value,text] of [['out','出库 / 领料'],['in','入库 / 收货'],['move','移库']]){const option=el('option',text);option.value=value;operation.append(option);}
  const file=field(form,'选择Excel、CSV或单据照片');file.type='file';file.accept='.xlsx,.xls,.csv,.tsv,.txt,image/jpeg,image/png,image/webp';
  const sheetLabel=el('div'),sheet=field(sheetLabel,'选择工作表','select');sheetLabel.hidden=true;
  const text=field(form,'单据原文 / 从Excel复制的表格','textarea');text.rows=7;text.maxLength=30000;text.placeholder='SKU\t品名\t数量\t单位\t来源格位\nBRG-6204\t深沟球轴承6204\t3\t套\tWH-2-A-L01-B01';form.append(sheetLabel);
  const mappingBox=el('details'),mappingLabel=el('label',null,'assistant-source-ack'),manual=el('input');manual.type='checkbox';mappingLabel.append(manual,el('span','按我选择的列解析'));mappingBox.append(el('summary','表头不规范？手动选择列'),mappingLabel);form.append(mappingBox);
  const headerRow=field(mappingBox,'表头在第几行');headerRow.type='number';headerRow.min='1';headerRow.max='150';headerRow.value='1';const columns=el('div');mappingBox.append(columns);let columnInputs={};
  const status=el('p','','work-message'),preview=el('div',null,'assistant-document-preview'),actions=el('div',null,'work-actions');
  let rows,sourceKind='text',sourceName='粘贴单据',original='',parsed,businessInputs={},titleInput,worker,workerTimer,readVersion=0,busy=false;
  const requestId=window.spatialRandomUUID();
  const payload=()=>({operation:operation.value,text:text.value,rows,source_kind:sourceKind,source_name:sourceName,original_text:original,...(manual.checked?{header_row:Number(headerRow.value)-1,mapping:Object.fromEntries(Object.entries(columnInputs).filter(([,node])=>node.value!=='').map(([key,node])=>[key,Number(node.value)]))}:{})});
  function invalidate(){parsed=null;preview.replaceChildren();save.disabled=true;onDirty(true);}
  text.oninput=()=>{rows=undefined;invalidate();};operation.onchange=invalidate;
  function mappingFields(){
    columns.replaceChildren();columnInputs={};
    const grid=rows||text.value.split(/\r?\n/).map(line=>line.split(text.value.includes('\t')?'\t':',')),head=grid[Number(headerRow.value)-1]||[];
    const count=Math.min(40,Math.max(head.length,...grid.map(row=>row.length)));
    for(const [key,title] of [['sku','SKU / 物料编码列'],['name','品名列'],['qty','数量列'],['unit','单位列'],['specification','规格列'],['from_hint','来源格位列'],['to_hint','目标格位列']]){
      const select=field(columns,title,'select'),blank=el('option','不使用此列');blank.value='';select.append(blank);
      for(let index=0;index<count;index++){const option=el('option',`第${index+1}列${head[index]?' · '+head[index]:''}`);option.value=index;select.append(option);}columnInputs[key]=select;select.onchange=invalidate;
    }
  }
  mappingBox.addEventListener('toggle',()=>{if(mappingBox.open)mappingFields();});manual.onchange=invalidate;headerRow.onchange=()=>{mappingFields();invalidate();};
  const closeWorker=()=>{clearTimeout(workerTimer);worker?.terminate();worker=null;};
  const observer=new MutationObserver(()=>{if(!host.isConnected){closeWorker();observer.disconnect();}});observer.observe(document.body,{childList:true,subtree:true});
  const perform=fn=>run(async()=>{
    if(busy)return;busy=true;onBusy(true);const controls=[...host.querySelectorAll('input,select,textarea,button')].map(n=>[n,n.disabled]);controls.forEach(([n])=>n.disabled=true);
    try{await fn();}finally{busy=false;onBusy(false);for(const [n,disabled] of controls)if(n.isConnected)n.disabled=disabled;save.disabled=!parsed;}
  });
  function readSheet(action,data){
    return new Promise((resolve,reject)=>{
      if(!worker){reject(Error('请重新选择Excel文件'));return;}
      clearTimeout(workerTimer);workerTimer=setTimeout(()=>{closeWorker();reject(Error('表格读取超时，请另存为CSV或缩小单据区域'));},10000);
      worker.onmessage=event=>{clearTimeout(workerTimer);event.data.error?reject(Error(event.data.error)):resolve(event.data);};
      worker.onerror=()=>{closeWorker();reject(Error('表格读取失败，请另存为CSV后重试'));};
      worker.postMessage({action,...data});
    });
  }
  function displayRows(value){rows=value;text.value=value.map(row=>row.join('\t')).join('\n');original=text.value;invalidate();status.textContent='已读取表格，请检查原文后点击“解析单据”。';}
  file.onchange=()=>perform(async()=>{
    invalidate();const selected=file.files[0];if(!selected)return;
    const version=++readVersion;sourceName=selected.name;rows=undefined;original='';sheetLabel.hidden=true;manual.checked=false;mappingBox.open=false;closeWorker();text.value='';
    if(/^image\//.test(selected.type)){
      if(selected.size>5*1024*1024)throw Error('单据照片最多5MB，请拍摄清晰的单页');sourceKind='photo';status.textContent='正在本地识别单据照片…';
      const data=await new Promise((resolve,reject)=>{const reader=new FileReader();reader.onload=()=>resolve(reader.result);reader.onerror=()=>reject(Error('照片读取失败'));reader.readAsDataURL(selected);});
      const result=await mediaApi({kind:'photo',data});if(version!==readVersion||!host.isConnected)return;
      original=result.text;rows=photoDocumentTable(result.lines);text.value=rows?rows.map(row=>row.join('\t')).join('\n'):result.text;
      status.textContent=rows?'已按照片位置整理表格列，每项仍需对照原图核对。':'已识别文字，未识别出完整表格列；请补齐品名、数量和单位，或从Excel复制表格。';
    }else{
      if(selected.size>2*1024*1024)throw Error('单据文件最多2MB，请只保留需要办理的区域');sourceKind='table';
      if(/\.xlsx?$/i.test(selected.name)){
        status.textContent='正在读取工作表…';worker=new Worker(new URL('./document-sheet-worker.js',import.meta.url));
        const result=await readSheet('open',{data:await selected.arrayBuffer()});if(version!==readVersion||!host.isConnected)return;
        sheet.replaceChildren();const blank=el('option','请选择需要办理的工作表');blank.value='';sheet.append(blank);
        for(const name of result.sheets){const option=el('option',name);option.value=name;sheet.append(option);}sheetLabel.hidden=false;status.textContent='请选择工作表，系统不会自动导入其他工作表。';
      }else{
        const bytes=await selected.arrayBuffer();let value=new TextDecoder('utf-8').decode(bytes);if(value.includes('\uFFFD'))value=new TextDecoder('gb18030').decode(bytes);
        text.value=value.replace(/^\uFEFF/,'');original=text.value;status.textContent='已读取文字，请检查后解析单据。';
      }
    }
    invalidate();
  });
  sheet.onchange=()=>perform(async()=>{invalidate();if(sheet.value)displayRows((await readSheet('sheet',{sheet:sheet.value})).rows);});
  const parse=button('解析单据',()=>perform(async()=>{
    const result=await api('/document/preview',payload(),'POST');if(!host.isConnected)return;parsed=result;preview.replaceChildren();businessInputs={};
    preview.append(el('strong',`${result.rows.length} 项 · ${result.needs_review} 项需要补充或对照核对`));
    titleInput=field(preview,'清单名称');titleInput.maxLength=120;titleInput.value=result.title;
    const business=el('details');business.append(el('summary','单据信息'));preview.append(business);
    for(const [key,label] of [['document_no','业务单号'],['department','部门'],['recipient','领用人'],['purpose','用途']]){businessInputs[key]=field(business,label);businessInputs[key].value=result.business[key]||'';}
    const list=el('ol',null,'assistant-document-lines');
    for(const row of result.rows){const li=el('li');li.append(el('strong',`${row.input.query||'待选货品'} · ${row.input.qty??'待填数量'} ${row.input.unit||'待核对单位'}`),el('small',`原文第${row.source.line}行：${row.source.raw}`));if(row.source.issues.length)li.append(el('p',row.source.issues.join('；'),'work-message'));list.append(li);}preview.append(list);
    if(result.source.notes.length){const notes=el('details');notes.append(el('summary',`另有 ${result.source.notes.length} 行说明 / 合计，不作为货品办理`));for(const row of result.source.notes)notes.append(el('p',`第${row.line}行：${row.raw}（${row.reason}）`));preview.append(notes);}
    status.textContent='解析完成，保存后逐项核对系统匹配的SKU和位置。';save.disabled=false;
  }));
  const save=button('保存为待核对清单',()=>perform(async()=>{
    if(!parsed)throw Error('请先解析单据');
    const business=Object.fromEntries(Object.entries(businessInputs).map(([key,node])=>[key,node.value.trim()]));
    const job=await api('/document',{...payload(),title:titleInput.value.trim(),business,request_id:requestId},'POST');if(!host.isConnected)return;
    onDirty(false);closeWorker();observer.disconnect();onJob(job);
  }));save.disabled=true;save.classList.add('primary');
  actions.append(parse,save,button('取消导入',()=>{readVersion++;closeWorker();observer.disconnect();onDirty(false);onCancel();}));
  host.append(form,status,preview,actions);onDirty(true);
}
