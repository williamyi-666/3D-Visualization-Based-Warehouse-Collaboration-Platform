// 只整理编辑器布局和面板状态；业务草稿仍由原编辑器维护。
export function mountLayoutWorkspace(){
  const $=id=>document.getElementById(id),modal=$('layoutModal'),row=modal.querySelector('.layout-row'),side=modal.querySelector('.layout-list-wrap');
  modal.classList.add('layout-simple');
  const tabs=document.createElement('nav');tabs.className='layout-tabs';tabs.setAttribute('aria-label','编辑面板');
  tabs.innerHTML='<button type="button" data-pane="objects" aria-pressed="true">对象列表</button><button type="button" data-pane="properties" aria-pressed="false">选中属性</button>';
  const objects=document.createElement('div');objects.className='layout-objects';
  objects.append($('secRack'),$('secOpen'));
  const properties=document.createElement('div');properties.className='layout-properties';properties.hidden=true;
  const empty=document.createElement('p');empty.className='layout-property-empty';empty.textContent='点击画布或对象列表中的货架，查看并调整属性。';
  // 分区已移入尚未挂载的 objects，须从该节点取属性面板，document 此时查不到。
  properties.append(empty,objects.querySelector('#furnSelPanel'));side.append(tabs,objects,properties);
  function show(pane){objects.hidden=pane!=='objects';properties.hidden=pane!=='properties';for(const b of tabs.querySelectorAll('button'))b.setAttribute('aria-pressed',String(b.dataset.pane===pane));empty.hidden=!$('furnSelPanel').classList.contains('hidden');}
  tabs.addEventListener('click',e=>{if(e.target.dataset.pane)show(e.target.dataset.pane);});
  window.addEventListener('layout-object-selected',()=>{row.classList.remove('properties-hidden');$('layoutPropertiesToggle').textContent='收起面板';$('layoutPropertiesToggle').setAttribute('aria-expanded','true');show('properties');});
  // 添加入口始终留在顶部，面板收起时也能操作。
  const toolbar=modal.querySelector('.cad-toolbar'),add=$('layout_add_rack');add.textContent='货架';toolbar.prepend(add);
  const more=document.createElement('details');more.className='layout-more';more.innerHTML='<summary>更多 ▾</summary><div></div>';
  const menu=more.querySelector('div');menu.append(...modal.querySelector('.lay-acts-left').children);modal.querySelector('.lay-acts-left').append(more);
  menu.addEventListener('click',e=>{if(e.target.closest('button'))more.open=false;});
  const settings=document.createElement('details');settings.className='layout-more layout-tools';settings.innerHTML='<summary>工具与设置 ▾</summary><div></div>';
  const settingsBody=settings.querySelector('div');
  settingsBody.append($('cadToolSelect').parentElement,$('cadGridToggle').parentElement,$('snapGrid').parentElement,modal.querySelector('.lay-help'));
  toolbar.append(settings);
  const addMenu=document.createElement('details');addMenu.className='layout-more layout-add-menu';addMenu.id='layoutAddMenu';
  addMenu.innerHTML='<summary>＋ 添加 ▾</summary><div></div>';
  toolbar.prepend(addMenu);
  const floor=document.createElement('button');floor.type='button';floor.id='layoutAddFloor';floor.textContent='地面存放区';
  addMenu.querySelector('div').append(add,floor,$('cadToolDoor'),$('cadToolWindow'));
  function setType(type){$('furn_type').value=type;$('furn_type').dispatchEvent(new Event('change',{bubbles:true}));}
  add.addEventListener('click',()=>{setType('shelf');addMenu.open=false;});
  floor.onclick=()=>{add.click();setType('floor');};
  addMenu.querySelector('div').addEventListener('click',e=>{if(e.target.closest('button'))addMenu.open=false;});
  document.addEventListener('pointerdown',e=>{if(!addMenu.contains(e.target))addMenu.open=false;});
  addMenu.addEventListener('keydown',e=>{if(e.key==='Escape'&&addMenu.open){e.preventDefault();e.stopPropagation();addMenu.open=false;addMenu.querySelector('summary').focus();}});
  const zoom=$('layoutZoomIn').parentElement;zoom.className='layout-view-controls';
  const oldControls=zoom.parentElement;modal.querySelector('.layout-canvas').append(zoom);oldControls.remove();
  $('layoutPropertiesToggle').textContent='收起面板';
  $('layoutEmpty').querySelector('.le-sub').textContent='点击顶部「＋ 添加」，选择货架或地面存放区';
  const handle=document.createElement('div');handle.className='layout-resizer';handle.tabIndex=0;handle.setAttribute('role','separator');handle.setAttribute('aria-orientation','vertical');handle.setAttribute('aria-label','调整右侧面板宽度，方向键调整，双击恢复');row.insertBefore(handle,side);
  const key='spatial-layout-panel-width';let width=260;
  try{width=Number(localStorage.getItem(key))||260;}catch{}
  function setWidth(value,save=false){width=Math.max(220,Math.min(420,row.clientWidth*.5||420,value));row.style.setProperty('--layout-panel-width',width+'px');handle.setAttribute('aria-valuenow',String(Math.round(width)));handle.setAttribute('aria-valuemin','220');handle.setAttribute('aria-valuemax',String(Math.max(220,Math.min(420,row.clientWidth*.5))));if(save)try{localStorage.setItem(key,String(width));}catch{}}
  setWidth(width);let drag=null;
  handle.onpointerdown=e=>{if(e.button!==0)return;drag={x:e.clientX,width};handle.setPointerCapture(e.pointerId);e.preventDefault();};
  handle.onpointermove=e=>{if(drag)setWidth(drag.width+drag.x-e.clientX);};
  handle.onpointerup=()=>{drag=null;setWidth(width,true);};handle.onpointercancel=()=>{drag=null;};
  handle.ondblclick=()=>setWidth(260,true);
  handle.onkeydown=e=>{if(e.key==='ArrowLeft'||e.key==='ArrowRight'){e.preventDefault();setWidth(width+(e.key==='ArrowLeft'?20:-20),true);}};
  new ResizeObserver(()=>setWidth(width)).observe(row);
  new MutationObserver(()=>{if(!modal.classList.contains('hidden')){show('objects');more.open=false;settings.open=false;addMenu.open=false;}}).observe(modal,{attributes:true,attributeFilter:['class']});
}
