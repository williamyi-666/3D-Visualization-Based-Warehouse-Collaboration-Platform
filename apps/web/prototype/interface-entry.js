// 只识别设备，不用窗口宽度判断；电脑侧栏再窄也保持电脑版。
(() => {
  const here=new URL(window.location.href),directory=new URL('./',here).pathname;
  const key='spatial-interface:'+directory;
  const valid=value=>value==='desktop'||value==='mobile';
  function url(mode,context={},explicit=true){
    const target=new URL(mode==='mobile'?'mobile.html':'index.html',here);
    target.search=here.search;
    target.hash=here.hash;
    for(const name of ['room','loc'])if(name in context){
      if(context[name])target.searchParams.set(name,context[name]);else target.searchParams.delete(name);
    }
    if(explicit)target.searchParams.set('ui',mode);else target.searchParams.delete('ui');
    return target.href;
  }
  window.SpatialInterface={url};
  let saved;
  try{saved=window.localStorage.getItem(key);}catch{}
  const explicit=here.searchParams.get('ui');
  if(valid(explicit))try{window.localStorage.setItem(key,explicit);}catch{}
  const nav=window.navigator;
  const handheld=nav.userAgentData?.mobile===true||/Android|iPhone|iPad|iPod|Mobile/i.test(nav.userAgent)||(/Macintosh/i.test(nav.userAgent)&&nav.maxTouchPoints>1);
  const current=here.pathname.endsWith('/mobile.html')?'mobile':'desktop';
  // 专门打开作业页也可以在电脑上使用；手动选择的界面优先。
  const mode=valid(explicit)?explicit:valid(saved)?saved:current==='mobile'||handheld?'mobile':'desktop';
  if(mode!==current)window.location.replace(url(mode,{},false));
})();
