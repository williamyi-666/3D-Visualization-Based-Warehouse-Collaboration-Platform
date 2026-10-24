import {cellLayer,filterCells} from './cell-filter.mjs';
// 每页最多100个格位，选择集合独立于分页和筛选，保存时使用完整集合。
export function mountBatchSelection(host,cells,onChange) {
  host.style.maxHeight='none';host.style.overflow='visible';
  const selected=new Set();let matches=cells,page=1;
  host.innerHTML=`<div style="display:flex;gap:8px;flex-wrap:wrap">
    <select aria-label="批量筛选货架" data-rack></select><select aria-label="批量筛选层" data-layer></select>
    <select aria-label="批量筛选状态" data-status><option value="">全部状态</option><option value="normal">正常</option><option value="locked">锁定标记</option><option value="stocktaking">盘点标记</option></select>
    <input aria-label="批量查找格位" data-query placeholder="编码、名称或标签"><button type="button" data-filter>筛选</button>
    <button type="button" data-reset>清除筛选</button></div>
    <p data-count role="status"></p><div style="display:flex;gap:8px;flex-wrap:wrap"><button type="button" data-all>选择全部匹配</button><button type="button" data-none>清空所有选择</button><button type="button" data-only>仅保留匹配选择</button></div>
    <div data-list style="display:grid;gap:6px;padding:10px 0;max-height:30vh;overflow:auto"></div>
    <div style="display:flex;gap:8px;align-items:center"><button type="button" data-prev>上一页</button><span data-page></span><button type="button" data-next>下一页</button></div>`;
  host.querySelectorAll('button').forEach(button=>button.className='toolbtn');
  const q=name=>host.querySelector('[data-'+name+']');
  function options(name,values,label){
    for(const value of ['',...values]){const option=document.createElement('option');option.value=value;option.textContent=value||label;q(name).append(option);}
  }
  options('rack',[...new Set(cells.map(c=>c.rackCode))].sort(),'全部货架');
  options('layer',[...new Set(cells.map(cellLayer).filter(Boolean))].sort(),'全部层');
  const hiddenCount=()=>selected.size-matches.filter(c=>selected.has(c.locCode)).length;
  function counts(){
    q('count').textContent='匹配 '+matches.length+' / '+cells.length+' 格 · 已选 '+selected.size+' 格 · 筛选外已选 '+hiddenCount()+' 格';
    q('all').disabled=!matches.length;q('none').disabled=!selected.size;q('only').disabled=!hiddenCount();
    onChange();
  }
  function render(){
    const pages=Math.max(1,Math.ceil(matches.length/100));page=Math.min(page,pages);
    q('list').replaceChildren();
    for(const cell of matches.slice((page-1)*100,page*100)){
      const label=document.createElement('label'),check=document.createElement('input');label.style.cssText='display:flex;flex-direction:row;align-items:center;gap:8px';check.style.cssText='width:auto;flex:none;margin:0';check.type='checkbox';check.className='cell-chk';check.value=cell.locCode;check.checked=selected.has(cell.locCode);
      check.onchange=()=>{check.checked?selected.add(cell.locCode):selected.delete(cell.locCode);counts();};
      label.append(check,document.createTextNode(' '+cell.locCode+' · '+(cell.meta?.name||'未命名')));q('list').append(label);
    }
    q('page').textContent='第 '+page+' / '+pages+' 页';q('prev').disabled=page<=1;q('next').disabled=page>=pages;counts();
  }
  function filter(){
    matches=filterCells(cells,{rack:q('rack').value,layer:q('layer').value,query:q('query').value}).filter(c=>!q('status').value||(c.status||'normal')===q('status').value);page=1;render();
  }
  q('filter').onclick=filter;q('query').onkeydown=e=>{if(e.key==='Enter'){e.preventDefault();filter();}};
  for(const name of ['rack','layer','status'])q(name).onchange=filter;
  q('reset').onclick=()=>{for(const name of ['rack','layer','status','query'])q(name).value='';filter();};
  q('all').onclick=()=>{matches.forEach(c=>selected.add(c.locCode));render();};
  q('none').onclick=()=>{selected.clear();render();};
  q('only').onclick=()=>{const allowed=new Set(matches.map(c=>c.locCode));for(const code of selected)if(!allowed.has(code))selected.delete(code);render();};
  q('prev').onclick=()=>{page--;render();};q('next').onclick=()=>{page++;render();};
  // 调用方接收实例之后再绘制，避免初始化回调读取尚未赋值的实例。
  return {render,codes:()=>[...selected],hiddenCount};
}
