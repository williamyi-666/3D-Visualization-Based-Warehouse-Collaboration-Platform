// 平台界面适配；通用请求适配在 request-bridge.js 中。
(() => {
  const runtime = window.SPATIAL_RUNTIME || {};
  const standalone=runtime.provider==='supos' && runtime.mode==='standalone';
  if (runtime.mode === 'integration' || standalone) {
    document.documentElement.classList.add('integration-view');
    document.documentElement.classList.toggle('standalone-view',standalone);
    const style = document.createElement('style');
    style.textContent = '.integration-view #ioBtn,.integration-view #impBtn2,.integration-view #expBtn2,.integration-view #legend,.integration-view #addBtn,.integration-view #adminBtn,.integration-view:not(.space-editor) #drag3dBtn,.integration-view:not(.space-editor) #mergeBtn,.integration-view:not(.space-editor) #assetBtn,.integration-view:not(.space-editor) #addSiteBtn,.integration-view:not(.space-editor) #addRoomBtn,.integration-view .item-card .acts{display:none!important}';
    style.textContent += '.integration-view #topbar{left:10px;right:10px;transform:none;width:auto;flex-wrap:wrap;overflow:visible;justify-content:flex-start}.integration-view #topbar .title,.integration-view .standalone-group,.integration-view #ltBody #mergeBtn{display:none}.integration-view #leftToolbar.lt-open{flex-basis:156px;width:156px}.integration-view #viewBar{top:140px}';
    style.textContent += '.warehouse-scoped #addSiteBtn{display:none!important}';
    style.textContent += '.integration-view:not(.space-editor) #layout_import_btn,.integration-view:not(.space-editor) #layout_asset_btn,.integration-view #layout_photo_btn,.integration-view:not(.space-editor) #roomEditBtn{display:none!important}';
    if(standalone)style.textContent+=`
      .standalone-view.stock-operator #ioBtn,.standalone-view.stock-operator #addBtn{display:flex!important}
      .standalone-view.stock-operator .standalone-group{display:block}
      .standalone-view.stock-operator #impBtn2,.standalone-view #expBtn2{display:block!important}
      .standalone-view.stock-operator .item-card .acts{display:inline-flex!important}
      .standalone-view:not(.stock-operator) .item-card .acts{display:none!important}
      .standalone-view .integration-help{display:none}.standalone-view .local-help{display:block}
    `;
    if(new URLSearchParams(location.search).get('compact')==='1') {
      document.documentElement.classList.add('compact-view');
      style.textContent+='.compact-view #leftToolbar,.compact-view #userChip,.compact-view #layoutBtn,.compact-view #roomEditBtn{display:none!important}.compact-view #sidebar{max-width:280px}';
    }
    document.head.append(style);
    style.textContent += `
      .integration-view #app{height:calc(100vh - var(--sync-bar-height,48px))}
      .integration-view body{padding-bottom:var(--sync-bar-height,48px);box-sizing:border-box}
      #syncStatusBar{position:fixed;bottom:0;left:0;right:0;z-index:16;padding:8px 14px;background:#111c30;color:#dbe7f8;border-top:1px solid #334155;font:13px/1.5 system-ui,sans-serif}
      #syncStatusBar .sync-status-row{display:flex;align-items:center;gap:12px;flex-wrap:wrap}
      #syncStatusBar .sync-status-text{flex:1;min-width:140px}
      #syncStatusBar button,#syncStatusBar a{font:inherit;color:#dbeafe;background:#1e3558;border:1px solid #476083;border-radius:7px;padding:6px 10px;text-decoration:none;cursor:pointer}
      #syncStatusBar button:disabled{opacity:.6;cursor:wait}
      #syncStatusBar button:focus-visible,#syncStatusBar a:focus-visible{outline:2px solid #60a5fa;outline-offset:2px}
      #syncStatusBar ul{margin:8px 0 0;padding:8px 8px 8px 24px;max-height:120px;overflow:auto;border-top:1px solid #334155}
      #syncStatusBar li{padding:3px 0;overflow-wrap:anywhere}
      #syncStatusBar [hidden]{display:none!important}
    `;
    window.addEventListener('DOMContentLoaded', async () => {
      const bar=document.createElement('footer');bar.id='syncStatusBar';bar.setAttribute('aria-label','库存同步状态');
      const row=document.createElement('div');row.className='sync-status-row';
      const text=document.createElement('span');text.className='sync-status-text';text.setAttribute('role','status');
      const details=document.createElement('button');details.textContent='来源详情';details.setAttribute('aria-expanded','false');details.setAttribute('aria-controls','syncSourceList');
      const list=document.createElement('ul');list.id='syncSourceList';list.hidden=true;
      if(standalone)details.hidden=true;
      details.onclick=()=>{list.hidden=!list.hidden;details.setAttribute('aria-expanded',String(!list.hidden));};
      const button=document.createElement('button');button.textContent='刷新数据';
      const navLink=document.getElementById('integrationAdminLink');
      const link=navLink || document.createElement('a');link.href='./sync.html';if(!navLink)link.textContent='系统管理';link.hidden=true;
      row.append(text,details,button);if(!navLink)row.append(link);bar.append(row,list);document.body.append(bar);
      new ResizeObserver(()=>{
        document.documentElement.style.setProperty('--sync-bar-height',bar.offsetHeight+'px');
        window.dispatchEvent(new Event('resize'));
      }).observe(bar);
      function publishSources(sources) {
        window.SPATIAL_SOURCE_STATUS=sources;
        window.dispatchEvent(new Event('spatial-source-status'));
      }
      async function readStatus() {
        try {
        if(standalone){
          const response=await window.fetch('/api/access/status');
          if(!response.ok)throw Error('权限读取失败，请刷新重试');
          const access=await response.json();
          document.documentElement.classList.toggle('space-editor',access.canManage);
          document.documentElement.classList.toggle('stock-operator',access.canOperate);
          document.documentElement.classList.toggle('warehouse-scoped',Array.isArray(access.warehouseSites));
          window.SPATIAL_ACCESS=access;
          for(const id of ['layoutBtn','spaceManageBtn','quickBuildBtn']){const b=document.getElementById(id);if(b)b.disabled=!access.canManage;}
          const opening=document.getElementById('openingStockBtn');if(opening)opening.disabled=!access.canOperate;
          const team=document.getElementById('teamTasksBtn');if(team)team.disabled=!access.canOperate;
          link.hidden=!access.canAdmin || location.pathname.endsWith('/sync.html');
          const heading=document.getElementById('systemNavHeading');if(heading)heading.hidden=!access.canAdmin;
          text.textContent='独立库存 · '+(access.canOperate?'可出入库':'库存只读')+' · '+(access.canManage?'可维护空间':'空间只读');
          const warehouseSync=access.warehouseSync;
          const syncLabel={starting:'平台同步启动中',ready:'平台同步正常',warehouse_missing:'平台同步异常：配置仓库不存在',error:'平台同步失败，请联系管理员检查'}[warehouseSync?.state];
          if(syncLabel)text.textContent+=' · '+syncLabel;
          text.title=warehouseSync?.lastVerifiedAt?'最近平台读回确认：'+new Date(warehouseSync.lastVerifiedAt).toLocaleString():'';
          window.dispatchEvent(new Event('spatial-access-change'));
          return;
        }
        const r=await window.fetch('/api/integration/status');
        if(!r.ok)throw Error('同步状态读取失败，请重试');
        const d=await r.json();
        publishSources(d.sources);
        document.documentElement.classList.toggle('space-editor',!!d.canManage);
        const layoutButton=document.getElementById('layoutBtn');
        const quickBuildButton=document.getElementById('quickBuildBtn');if(quickBuildButton)quickBuildButton.disabled=!d.canManage;
        for(const id of ['openingStockBtn','workTasksBtn','teamTasksBtn']){const b=document.getElementById(id);if(b)b.hidden=true;}
        if(layoutButton){layoutButton.disabled=!d.canManage;layoutButton.title=d.canManage?'编辑库区布局与货架规格':'当前空间只读，请联系管理员授予空间维护权限';}
        document.documentElement.classList.toggle('warehouse-scoped',Array.isArray(d.warehouseSites));
        const count=state=>d.sources.filter(s=>s.state===state).length;
        const summary=[['failed','失败'],['stale','超时'],['unconfigured','待配置'],['waiting','待同步'],['ok','正常']].filter(([state])=>count(state)).map(([state,label])=>label+' '+count(state)).join(' · ');
        text.textContent=(d.canManage?'空间可编辑 · ':'空间只读 · ')+'外部库存只读 · 来源状态：'+(d.sources.length?summary:'尚未同步');
        if(Array.isArray(d.warehouseSites))text.textContent+=' · 授权仓库：'+(d.warehouseSites.join('、')||'无，请联系管理员');
        list.replaceChildren();
        for(const source of d.sources){
          const li=document.createElement('li');
          li.textContent=source.source+' · '+({ok:'正常',stale:'更新超时',failed:'最近同步失败',waiting:'等待首次同步',unconfigured:'尚未配置更新周期'})[source.state]+(source.stale?' · 当前显示旧库存':'')+' · 最近成功更新 '+(source.received_at?new Date(source.received_at).toLocaleString():'无');
          if(source.state!=='ok') {
            const action={unconfigured:'设置更新周期',waiting:'检查数据接入',stale:'检查来源更新',failed:'查看失败记录'}[source.state] || '查看状态';
            if(d.canAdmin){const a=document.createElement('a');a.href='./sync.html#'+(source.state==='waiting'?'connection':'running');a.textContent=action;li.append(' · ',a);}
            else li.append(' · 请联系管理员'+action);
          }
          list.append(li);
        }
        if(!d.sources.length){const li=document.createElement('li');li.textContent=d.canAdmin?'暂无来源，请先在同步管理中配置并接收库存。':'暂无来源，请联系管理员配置库存同步。';list.append(li);}
        link.hidden=!d.canAdmin || location.pathname.endsWith('/sync.html');
        const heading=document.getElementById('systemNavHeading');if(heading)heading.hidden=!d.canAdmin;
        } catch(e) {
          if(standalone){document.documentElement.classList.remove('stock-operator','space-editor');window.SPATIAL_ACCESS=null;window.dispatchEvent(new Event('spatial-access-change'));}
          publishSources(null); throw e;
        }
      }
      button.onclick=async()=>{
        button.disabled=true;button.textContent='刷新中…';
        try {
          if(typeof window.SPATIAL_REFRESH_VIEW!=='function')throw Error('页面尚未准备好，请稍后重试');
          await window.SPATIAL_REFRESH_VIEW();
          await readStatus();
        }catch(e){text.textContent=e.message || '刷新失败，请重试';}
        finally{button.disabled=false;button.textContent='刷新数据';}
      };
      text.textContent='正在读取同步状态…';
      try{await readStatus();}catch(e){text.textContent=e.message;}
      // 三维库存通过实时订阅更新；来源状态变化也立即核对，避免只显示旧的“正常”。
      window.addEventListener('spatial-inventory-refreshed',()=>{if(!document.hidden)readStatus().catch(e=>{text.textContent=e.message+'；旧库存仍保留';});});
      setInterval(()=>{if(!document.hidden)readStatus().catch(e=>{text.textContent=e.message+'；旧库存仍保留';});},60000);
    });
  }
})();
