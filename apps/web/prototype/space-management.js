import {createCellCamera} from './cell-camera.js';
import {cellLayer, filterCells} from './cell-filter.mjs';
import {mountSkuCapacity} from './sku-capacity-ui.mjs';
// 空间属性独立于 ERP/WMS 库存；此面板只调用空间接口。
export function createSpaceManagement({ canManage, cells, selected, refresh, actions, confirm }) {
  const modal = document.createElement('div');
  modal.className = 'modal hidden'; modal.id = 'spaceManagement';
  modal.innerHTML = `<div class="modal-box" style="width:min(640px,94vw);max-height:85vh;overflow:auto" role="dialog" aria-modal="true" aria-labelledby="spaceTitle">
    <h3 id="spaceTitle" tabindex="-1">格位管理</h3>
    <p id="spacePermission" class="muted"></p>
    <details id="spaceFilterDetails"><summary>筛选格位</summary>
    <div id="spaceFilterControls" style="display:flex;gap:8px;flex-wrap:wrap;align-items:end">
      <label>货架 <select id="spaceRackFilter" aria-label="筛选货架"></select></label>
      <label>层 / 行 <select id="spaceLayerFilter" aria-label="筛选层或行"></select></label>
      <label style="flex:1;min-width:180px">查找格位 <input id="spaceQuery" type="search" placeholder="名称、编码或标签" style="width:100%"></label>
      <button type="button" id="spaceApplyFilter" class="toolbtn">筛选格位</button>
      <button type="button" id="spaceResetFilter" class="toolbtn">清除筛选</button>
    </div>
    <p id="spaceFilterCount" role="status" class="muted"></p>
    </details>
    <form id="spaceCellForm">
      <label>当前库区格位<select id="spaceCellCode" style="width:100%;margin:8px 0"></select></label>
      <div style="display:flex;gap:10px;align-items:center;justify-content:space-between;margin:8px 0">
        <button type="button" id="spacePrevious">上一格</button>
        <span id="spacePosition" role="status"></span>
        <button type="button" id="spaceNext">下一格</button>
      </div>
      <fieldset id="spaceFields" style="border:0;padding:0;display:grid;gap:10px">
        <label>3D 标签显示 <select name="label_mode"><option value="code">格位编号 / 自定义名</option><option value="name">货品名称</option><option value="sku">货品 SKU</option><option value="name_sku">货品名称 + SKU</option></select></label>
        <label>格位名称 <input name="name" maxlength="24" placeholder="自定义名称"></label>
        <details id="spaceMore"><summary>更多属性</summary><div class="space-more-grid">
        <label>状态 <select name="status"><option value="normal">正常</option><option value="locked">锁定标记</option><option value="stocktaking">盘点标记</option></select></label>
        <label>承重（kg） <input name="max_load" type="number" min="0" step="any" placeholder="未设置"></label>
        <label>标签 <input name="tags" placeholder="逗号分隔"></label>
        <label>备注 <input name="note"></label>
        </div></details>
      </fieldset>
    </form>
    <section id="skuSection" hidden>
      <fieldset id="skuFields" style="border:0;padding:0;display:grid;gap:10px" disabled>

        <input id="skuWarehouse" type="hidden">
        <div id="skuList"></div>
        <button type="button" id="skuAdd" class="toolbtn">＋ 添加 SKU</button>

      </fieldset>
      <p id="skuResult" class="muted" role="status"></p>
    </section>
    <details id="spacePhotoDetails"><summary>现场照片</summary>
    <div id="spacePhotos" style="display:flex;gap:8px;flex-wrap:wrap"></div>
    <button type="button" id="spaceCamera" class="toolbtn">📷 拍照</button>
    <label>选择图片（立即保存，最多保留12张）<input id="spacePhoto" type="file" accept="image/png,image/jpeg,image/webp"></label>
    </details>
    <details><summary>批量操作</summary><div id="spaceActions" style="display:flex;gap:8px;flex-wrap:wrap;margin:12px 0"></div></details>
    <details><summary>使用说明</summary><p class="muted">填写 SKU 保存后自动归位，多来源时再选择；移除某项 SKU 并保存只解除该项绑定。尚无库存时保留绑定，后续同步自动归入。仅调整本应用显示，不修改 ERP 库位。容量按同一 SKU、同一库存单位计算；尺寸估算需核对现场净空，承重单独核定。</p></details>
    <p id="spaceResult" role="status"></p>
    <button type="button" id="spaceReload" hidden>放弃输入并读取最新属性</button>
    <div class="actions"><button type="submit" form="spaceCellForm" id="spaceSave">保存</button><button type="button" id="spaceClose">关闭</button></div>
  </div>`;
  const mainFields=modal.querySelector('#spaceFields');
  mainFields.insertBefore(modal.querySelector('#skuSection'),modal.querySelector('#spaceMore'));
  const inventory=document.createElement('div');inventory.id='spaceCurrentInventory';
  mainFields.insertBefore(inventory,modal.querySelector('#spaceMore'));
  document.body.append(modal);
  const preview=document.createElement('dialog');
  preview.setAttribute('aria-label','格位照片预览');
  preview.style.cssText='max-width:94vw;max-height:92vh;padding:16px;border:1px solid #475569;border-radius:12px;background:#0f172a;color:#e2e8f0';
  preview.innerHTML='<button type="button" class="toolbtn" style="float:right">关闭预览</button><img alt="格位现场照片大图" style="display:block;max-width:85vw;max-height:75vh;object-fit:contain">';
  preview.querySelector('button').onclick=()=>preview.close();
  preview.addEventListener('close',()=>{preview.querySelector('img').removeAttribute('src');});
  document.body.append(preview);
  const q = selector => modal.querySelector(selector);
  const form = q('form'), picker = q('#spaceCellCode'), fields = q('fieldset'), result = q('#spaceResult');
  let bindingDirty=false,bindingReady=false,bindingRevision=0,bindingRequest=0;
  const bindingEnabled=window.SPATIAL_RUNTIME?.mode==='integration';
  q('#skuSection').hidden=!bindingEnabled;
  let dirty = false, saving = false, current = '', returnFocus, revision;
  const capacityHost=document.createElement('section');capacityHost.id='skuCapacity';
  mainFields.insertBefore(capacityHost,q('#spaceMore'));
  const capacityEditor=mountSkuCapacity(capacityHost,{changed:()=>{dirty=true;result.textContent='SKU容量有未保存修改';},products:()=>cells().flatMap(c=>c.items || []),canManage});
  let appliedFilter={rack:'',layer:'',query:''};
  const rackFilter=q('#spaceRackFilter'), layerFilter=q('#spaceLayerFilter'), query=q('#spaceQuery');
  function options(select,values,all) {
    select.replaceChildren();
    for(const [value,label] of [['',all],...values.map(v=>[v,v])]) {
      const option=document.createElement('option');option.value=value;option.textContent=label;select.append(option);
    }
  }
  function layers() {
    const previous=layerFilter.value;
    options(layerFilter,[...new Set(cells().filter(c=>!rackFilter.value || c.rackCode===rackFilter.value).map(cellLayer).filter(Boolean))].sort(),'全部层 / 行');
    if([...layerFilter.options].some(o=>o.value===previous))layerFilter.value=previous;
  }
  rackFilter.onchange=layers;
  async function listCells(preferred=current,force=false) {
    const matches=filterCells(cells(),{rack:rackFilter.value,layer:layerFilter.value,query:query.value});
    const next=matches.some(c=>c.locCode===preferred)?preferred:(matches[0]?.locCode || '');
    if(!force && next!==current && !(await discard())) {
      rackFilter.value=appliedFilter.rack;layers();layerFilter.value=appliedFilter.layer;query.value=appliedFilter.query;
      return false;
    }
    appliedFilter={rack:rackFilter.value,layer:layerFilter.value,query:query.value};
    picker.replaceChildren();
    for(const cell of matches) {
      const option=document.createElement('option');option.value=cell.locCode;
      option.textContent=cell.locCode+(cell.meta?.name?' · '+cell.meta.name:'');picker.append(option);
    }
    picker.value=next;picker.disabled=saving || !matches.length;
    q('#spaceFilterCount').textContent=matches.length?'匹配 '+matches.length+' / '+cells().length+' 个格位':'未找到匹配格位，请修改条件或清除筛选';
    if(force || next!==current)fill();
    updateNavigation();
    return true;
  }
  q('#spaceApplyFilter').onclick=()=>{if(!saving)listCells();};
  query.onkeydown=event=>{if(event.key==='Enter'){event.preventDefault();if(!saving)listCells();}};
  q('#spaceResetFilter').onclick=()=>{
    if(saving)return;
    rackFilter.value='';layers();layerFilter.value='';query.value='';listCells();
  };
  function busy(on) {
    saving=on;
    q('#spaceSave').disabled=on || !canManage() || !current;
    q('#skuFields').disabled=on || !bindingReady || !canManage() || !current;
    q('#spaceFilterControls').querySelectorAll('input,select,button').forEach(el=>{el.disabled=on;});
    picker.disabled=on || !picker.options.length;
    fields.disabled=on || !canManage() || !current;
    q('#spacePhoto').disabled=on || !canManage() || !current;
    q('#spaceCamera').disabled=on || !canManage() || !current;
    updateNavigation();
  }
  function updateNavigation() {
    const index=picker.selectedIndex,total=picker.options.length;
    q('#spacePosition').textContent=total?'第 '+(index+1)+' / '+total+' 格':'无匹配格位';
    q('#spacePrevious').disabled=saving || index<=0;
    q('#spaceNext').disabled=saving || index<0 || index>=total-1;
  }
  async function stepCell(direction) {
    if(saving)return;
    const next=picker.selectedIndex+direction;
    if(next<0 || next>=picker.options.length || !(await discard()))return;
    picker.selectedIndex=next;result.textContent='';fill();
  }
  q('#spacePrevious').onclick=()=>stepCell(-1);
  q('#spaceNext').onclick=()=>stepCell(1);
  let confirming=false;
  async function ask(message) {
    if(confirming)return false;
    confirming=true;modal.inert=true;
    const focus=document.activeElement;
    try{return await confirm(message);}
    finally{confirming=false;modal.inert=false;focus?.focus();}
  }
  const discard = async () => !(dirty||bindingDirty) || await ask('格位属性尚未保存，放弃修改？');
  async function close() {
    if (saving || !(await discard())) return false;
    modal.classList.add('hidden'); dirty = false; bindingDirty=false; returnFocus?.focus(); return true;
  }
  q('#spaceClose').onclick = close;
  q('#spaceReload').onclick = async () => {
    if(saving || !(await discard()))return;
    busy(true);
    try { await refresh();listCells(current,true);result.textContent='已读取最新属性，请重新核对后修改'; }
    catch(error){result.textContent=error.message;}
    finally {busy(false);}
  };
  modal.addEventListener('keydown', event => {
    if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); close(); }
  });
  for (const [label, run, childId] of actions) {
    const button = document.createElement('button'); button.type = 'button'; button.className = 'toolbtn'; button.textContent = label;
    button.onclick = () => {
      if(!canManage() || saving)return;
      const child=document.getElementById(childId),scroll=q('.modal-box').scrollTop;
      // 暂时隐藏父层；取消子层后恢复原格位、展开状态及尚未保存的输入。
      modal.classList.add('hidden');
      function resume() {
        observer.disconnect();
        if(!dirty && !bindingDirty)listCells(current,true);
        modal.classList.remove('hidden');q('.modal-box').scrollTop=scroll;button.focus({preventScroll:true});
      }
      const observer=new MutationObserver(()=>{if(child.classList.contains('hidden'))resume();});
      if(child)observer.observe(child,{attributes:true,attributeFilter:['class']});
      try {run();} finally {if(!child || child.classList.contains('hidden'))resume();}
    };
    q('#spaceActions').append(button);
  }
  function fill() {
    q('#spaceReload').hidden=true;
    current = picker.value;
    const entry = cells().find(c => c.locCode === current), meta = entry?.meta || {};
    const stock=q('#spaceCurrentInventory');stock.replaceChildren();
    const title=document.createElement('strong');title.textContent='当前库存';stock.append(title);
    const items=entry?.items || [];
    if(!items.length){const empty=document.createElement('p');empty.className='muted';empty.textContent='空格位 · 暂无库存';stock.append(empty);}
    for(const item of items){const line=document.createElement('p');line.textContent=`${item.name || item.sku} · ${item.qty} ${item.unit || '件'}`;stock.append(line);}
    q('#spaceSave').disabled=!canManage() || !entry;
    revision = meta.revision;
    loadBinding();
    for (const name of ['name', 'max_load', 'note']) form.elements[name].value = meta[name] ?? '';
    capacityEditor.fill(entry);
    form.elements.status.value = meta.status || 'normal';
    form.elements.label_mode.value=meta.label_mode || 'code';
    form.elements.tags.value = (meta.tags || []).join(', ');
    fields.disabled = !canManage() || !entry;
    q('#spacePhoto').disabled=!canManage() || !entry;
    q('#spaceCamera').disabled=!canManage() || !entry;
    const gallery=q('#spacePhotos'); gallery.replaceChildren();
    (entry?.photos || []).forEach((url,index)=>{
      const card=document.createElement('div');card.style.cssText='display:grid;gap:6px';
      const view=document.createElement('button');view.type='button';view.className='toolbtn';view.setAttribute('aria-label','放大查看照片 '+(index+1));
      const img=document.createElement('img');img.src=url;img.alt='格位现场照片 '+(index+1);img.style.cssText='width:100px;height:80px;object-fit:contain';view.append(img);
      view.onclick=()=>{preview.querySelector('img').src=url;preview.showModal();};card.append(view);
      if(canManage()) {
        const remove=document.createElement('button');remove.type='button';remove.className='toolbtn';remove.textContent='删除照片 '+(index+1);
        remove.onclick=()=>deletePhoto(entry.locCode,index,url);card.append(remove);
      }
      gallery.append(card);
    });
    if(!entry?.photos?.length)gallery.textContent='暂无现场照片';
    dirty = false;
    updateNavigation();
  }
  function sourceOptions(row,sources,value='') {
    const select=row.querySelector('select');select.replaceChildren();
    for(const source of ['',...sources]) {
      const option=document.createElement('option');option.value=source;option.textContent=source || '自动匹配来源';select.append(option);
    }
    select.value=value;select.parentElement.style.display=sources.length?'':'none';
  }
  function changedBinding(){bindingDirty=true;q('#skuResult').textContent='SKU 列表尚未保存';}
  function addBinding(item={sku:'',source:''}) {
    const row=document.createElement('div');row.className='sku-binding-row';
    row.style.cssText='display:grid;gap:8px;padding:10px 0;border-bottom:1px solid var(--border)';
    row.innerHTML='<label>货品 SKU <input maxlength="200" placeholder="填写 ERP 货品 SKU"></label><label>库存来源 <select></select></label><button type="button" class="toolbtn">移除此 SKU</button>';
    row.querySelector('input').value=item.sku;sourceOptions(row,item.source?[item.source]:[],item.source);
    row.querySelector('input').oninput=()=>sourceOptions(row,[]);
    row.querySelector('button').onclick=()=>{row.remove();changedBinding();};q('#skuList').append(row);
  }
  q('#skuAdd').onclick=()=>{addBinding();changedBinding();};
  async function loadBinding() {
    bindingDirty=false;bindingReady=false;const request=++bindingRequest,code=current;
    q('#skuFields').disabled=true;
    if(!bindingEnabled || !code)return;
    q('#skuResult').textContent='读取归位设置…';
    try {
      const response=await fetch('/api/cell/'+encodeURIComponent(code)+'/sku-binding');
      const data=await response.json();if(!response.ok)throw Error(data.error || '读取失败');
      if(request!==bindingRequest)return;
      bindingRevision=data.revision;
      q('#skuWarehouse').value=data.warehouse_code || '';
      q('#skuList').replaceChildren();
      const items=data.items || (data.mode==='sku'?[data]:[]);
      items.forEach(addBinding);if(!items.length)addBinding();
      bindingReady=true;q('#skuFields').disabled=saving || !canManage();
      q('#skuResult').textContent=data.mode==='sku'?'已绑定：保存后立即按当前快照归位，后续同步自动更新。':'未绑定 SKU，当前按 ERP 库位归入。';
    }catch(error){if(request===bindingRequest)q('#skuResult').textContent=error.message;}
  }
  q('#skuFields').oninput=changedBinding;
  async function deletePhoto(code,index,photo) {
    if(saving || !canManage())return;
    if(dirty||bindingDirty){result.textContent='请先保存格位属性，再删除照片';return;}
    if(!(await ask('删除此格位的第 '+(index+1)+' 张照片？删除后立即生效。')))return;
    busy(true);result.textContent='正在删除照片…';
    try {
      const response=await fetch('/api/cell/'+encodeURIComponent(code)+'/photo',{method:'DELETE',headers:{'Content-Type':'application/json'},body:JSON.stringify({index,photo})});
      if(!response.ok)throw Error((await response.json()).error || '删除失败');
      await refresh();fill();result.textContent='照片已删除';
    }catch(error){result.textContent=error.message;}
    finally{busy(false);}
  }
  picker.onchange = async () => { if (!(await discard())) { picker.value = current; return; } result.textContent = ''; fill(); };
  window.addEventListener('beforeunload', event => { if(dirty || bindingDirty || saving) { event.preventDefault(); event.returnValue=''; } });
  fields.oninput = event => { if(event.target.closest('#skuSection'))return;dirty = true;result.textContent='格位属性有未保存修改'; };
  async function uploadPhoto(code,photo) {
    if(!canManage() || saving)throw Error('当前无法保存照片');
    busy(true);
    try {
      const response=await fetch('/api/cell/'+encodeURIComponent(code)+'/photo',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({photo})});
      if(!response.ok)throw Error((await response.json()).error || '照片保存失败');
      await refresh();fill();result.textContent='照片已保存';
    }finally{busy(false);}
  }
  const camera=createCellCamera({save:uploadPhoto});
  q('#spaceCamera').onclick=()=>{
    if(!canManage() || saving || !current)return;
    if(dirty||bindingDirty){result.textContent='请先保存格位修改，再拍照';return;}
    if((cells().find(c=>c.locCode===current)?.photos || []).length>=12){result.textContent='最多保留12张照片，请先删除旧照片';return;}
    camera.open(current);
  };
  q('#spacePhoto').onchange=async event=>{
    const file=event.target.files[0];event.target.value='';
    if(!file || !canManage() || saving)return;
    if(dirty||bindingDirty){result.textContent='请先保存格位属性，再上传照片';return;}
    if(file.size>5*1024*1024){result.textContent='照片不能超过5MB';return;}
    const code=current;
    try {
      const photo=await new Promise((resolve,reject)=>{const reader=new FileReader();reader.onload=()=>resolve(reader.result);reader.onerror=()=>reject(Error('照片读取失败'));reader.readAsDataURL(file);});
      await uploadPhoto(code,photo);
    }catch(error){result.textContent=error.message;}
  };
  form.onsubmit = async event => {
    event.preventDefault(); if (!canManage() || saving || !current || !form.reportValidity()) return;
    if(!dirty && !bindingDirty){result.textContent='没有需要保存的修改';return;}
    const code=current;busy(true);result.textContent='保存中…';let savedMeta=false;
    try {
      if(dirty) {
        const body={name:form.elements.name.value.trim(),label_mode:form.elements.label_mode.value,status:form.elements.status.value,note:form.elements.note.value.trim(),tags:form.elements.tags.value.split(/[,，]/).map(v=>v.trim()).filter(Boolean),revision};
        body.max_load=form.elements.max_load.value===''?null:Number(form.elements.max_load.value);
        Object.assign(body,capacityEditor.change());
        const response=await fetch('/api/cell/'+encodeURIComponent(code)+'/meta',{method:'PUT',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});
        const data=await response.json();
        if(!response.ok){q('#spaceReload').hidden=response.status!==409 && response.status!==428;throw Error(data.error || '属性保存失败');}
        dirty=false;savedMeta=true;
      }
      if(bindingDirty) {
        const response=await fetch('/api/cell/'+encodeURIComponent(code)+'/sku-binding',{method:'PUT',headers:{'Content-Type':'application/json'},body:JSON.stringify({items:[...q('#skuList').children].filter(row=>row.querySelector('input').value.trim()).map(row=>({sku:row.querySelector('input').value.trim(),source:row.querySelector('select').value})),revision:bindingRevision})});
        const data=await response.json();
        if(!response.ok){if(data.sources){const row=[...q('#skuList').children].filter(r=>r.querySelector('input').value.trim())[data.bindingIndex || 0];if(row)sourceOptions(row,data.sources);}throw Error(data.error || 'SKU 保存失败');}
        bindingRevision=data.revision;bindingDirty=false;
      }
      await refresh();fill();result.textContent=bindingEnabled?'已保存，库存归位已更新':'格位属性已保存';
    } catch(error) {
      // 属性成功而归位失败时保留 SKU 输入，并读取最新属性版本以便重试。
      if(savedMeta){await refresh().catch(()=>{});revision=cells().find(c=>c.locCode===code)?.meta?.revision;}
      result.textContent=(savedMeta?'格位属性已保存；':'')+error.message;
    } finally {busy(false);}
  };
  return {
    previewPhoto(url){preview.querySelector('img').src=url;preview.showModal();},
    open(code = selected()?.locCode, view = {}) {
      returnFocus = document.activeElement; result.textContent = '';
      modal.classList.toggle('photos-only', !!view.photos);
      q('#spaceTitle').textContent = view.photos ? '现场照片 · ' + (code || '') : '格位管理';
      q('#spacePermission').textContent = canManage() ? (bindingEnabled ? '选择格位，填写 SKU 后保存即可自动归位。' : '维护格位名称、显示方式和空间属性；库存数量通过入库、出库或盘点调整。') : '当前账号只读，可查看格位属性。修改空间请使用空间管理员或平台管理员账号。';
      q('#spaceActions').querySelectorAll('button').forEach(b => { b.disabled = !canManage(); });
      options(rackFilter,[...new Set(cells().map(c=>c.rackCode).filter(Boolean))].sort(),'全部货架');
      layers();layerFilter.value='';query.value='';listCells(code,true);
      fill(); modal.classList.remove('hidden'); q('.modal-box').scrollTop = 0; q('#spaceTitle').focus({preventScroll:true});
      if(view.capacity){capacityHost.scrollIntoView({block:'center'});capacityHost.querySelector('select').focus({preventScroll:true});}
      if(view.photos){q('#spacePhotoDetails').open=true;q('#spacePhotoDetails').scrollIntoView({block:'nearest'});}
      if(view.camera)q('#spaceCamera').click();
    }
  };
}
