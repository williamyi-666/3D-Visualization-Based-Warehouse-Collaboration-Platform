// 电脑出入库台与手机连续作业使用同一组业务字段，不写入货品资料。
(() => {
  const fields=[['document_no','业务单号',120],['recipient','领用人 / 班组',80],['department','部门',80],['purpose','用途',300]];
  const describe=(value={})=>fields.filter(([key])=>value[key]).map(([key,label])=>label+'：'+value[key]).join(' · ');
  function mount(parent,{prefix='',value={},onChange=()=>{}}={}){
    const root=document.createElement('details'),summary=document.createElement('summary'),grid=document.createElement('div'),inputs={};
    root.className='business-fields';root.style.margin='12px 0';grid.style.cssText='display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:8px 12px';root.append(summary,grid);parent.append(root);
    const read=()=>Object.fromEntries(fields.map(([key])=>[key,inputs[key].value.trim()]).filter(([,text])=>text));
    function update(){const data=read();summary.textContent='业务信息（可选）'+(Object.keys(data).length?' · '+(data.document_no||data.recipient||'已填写'):'');}
    for(const [key,text,length] of fields){const label=document.createElement('label'),input=document.createElement('input');label.textContent=text;input.maxLength=length;input.setAttribute('aria-label',(prefix?prefix+' · ':'')+text);input.value=value[key]||'';label.append(input);grid.append(label);inputs[key]=input;input.addEventListener('input',()=>{update();onChange();});}
    const clear=document.createElement('button');clear.type='button';clear.textContent='清空业务信息';clear.style.marginTop='10px';grid.after(clear);
    const set=data=>{for(const [key] of fields)inputs[key].value=data?.[key]||'';update();};
    clear.onclick=()=>{set({});onChange();};update();return {root,read,set,clear:()=>set({})};
  }
  window.SpatialBusiness={mount,describe};
})();
