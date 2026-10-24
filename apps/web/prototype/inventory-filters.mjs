const fields={source:'来源',status:'状态',unit:'单位',batch_no:'批次'};

export function createInventoryFilters({document:doc,search,fetchOptions}) {
  const get=id=>doc.getElementById(id);
  const chips=get('activeInventoryFilters');
  function render() {
    chips.replaceChildren();
    let count=0;
    for(const [key,label] of Object.entries(fields)) {
      const input=get('filter_'+key),value=input.value.trim();
      if(!value)continue;
      count++;
      const button=doc.createElement('button');
      button.type='button';button.textContent=label+'：'+value+' ×';
      button.setAttribute('aria-label','移除'+label+'筛选：'+value);
      button.onclick=()=>{input.value='';render();search();};
      chips.append(button);
    }
    get('inventoryFilterSummary').textContent='库存筛选'+(count?'（'+count+' 项）':'');
    chips.hidden=!count;
  }
  for(const key of Object.keys(fields))get('filter_'+key).addEventListener('input',render);
  get('clearInventoryFilters').onclick=()=>{
    for(const key of Object.keys(fields))get('filter_'+key).value='';
    get('searchInput').value='';get('searchScope').value='all';
    render();search();get('searchInput').focus();
  };
  let optionsVersion=0;
  async function refreshOptions() {
    const version=++optionsVersion;
    try {
      const values=await fetchOptions();
      if(version!==optionsVersion)return;
      for(const key of ['source','status','unit']) {
        const list=get('filter_options_'+key);
        list.replaceChildren(...(values[key] || []).map(value=>{
          const option=doc.createElement('option');option.value=value;return option;
        }));
      }
      get('filterOptionsHint').textContent='可选择已有值，也可输入精确条件。';
    } catch(error) {
      if(version===optionsVersion)get('filterOptionsHint').textContent='筛选选项读取失败，可手动输入；点击刷新数据重试。';
    }
  }
  render();
  return {render,refreshOptions};
}
