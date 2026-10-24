// 菜单反映现有权限，实际业务授权仍由服务端处理。
export function workspaceCapabilities({user,access,platform=false,integration=false,spaceEditable=false}={}) {
  const role=user?.role;
  return {
    canManage:platform||integration ? !!spaceEditable : ['admin','spaceAdmin'].includes(role),
    canOperate:!integration && (platform ? !!access?.canOperate : ['admin','operator'].includes(role)),
    canAdmin:platform||integration ? (access?.canAdmin ?? role==='admin') : role==='admin'
  };
}
export function workspaceMenu({canManage,canOperate,canAdmin}) {
  return Object.fromEntries([
    ...['openingStockBtn','workTasksBtn','teamTasksBtn','addBtn','ioBtn','transferImport'].map(id=>[id,canOperate]),
    ...['quickBuildBtn','layoutBtn','spaceManageBtn','drag3dBtn','mergeBtn','assetBtn'].map(id=>[id,canManage]),
    ['adminBtn',canAdmin]
  ]);
}
export function mountWorkspaceNavigation({document,window,getAccess,getState}) {
  const space=document.getElementById('lt-space').closest('.lt-group');
  const inventory=document.getElementById('lt-inventory');
  const initial=document.createElement('details');initial.className='lt-initialization';
  const summary=document.createElement('summary');summary.textContent='初始化工具';
  initial.append(summary,document.getElementById('openingStockBtn'));inventory.append(initial);
  let applied='';
  function conceal(element,hidden) {
    if(!element)return;
    element.hidden=hidden;element.toggleAttribute('data-workspace-hidden',hidden);
  }
  function refresh() {
    const access=getAccess(),state=getState();
    for(const [id,shown] of Object.entries(workspaceMenu(access)))conceal(document.getElementById(id),!shown);
    conceal(initial,!access.canOperate);conceal(space,!access.canManage);
    space.querySelector('.lt-group-toggle').firstChild.textContent=access.canAdmin?'仓库配置':'空间维护';
    inventory.closest('.lt-group').querySelector('.lt-group-toggle').firstChild.textContent=access.canOperate?'库存作业':'库存查看';
    document.querySelector('#inventoryExportBtn .lb').textContent=access.canOperate?'导入 / 导出':'导出库存';
    const key=JSON.stringify([state.account,state.room,access]);
    if(key!==applied){
      applied=key;initial.open=false;
      // 空间维护人员直接看到工具，管理员日常优先，配置按需展开。
      const collapsed=access.canAdmin || !access.canManage;
      space.classList.toggle('is-collapsed',collapsed);
      space.querySelector('.lt-group-toggle').setAttribute('aria-expanded',String(!collapsed));
    }
  }
  window.addEventListener('spatial-auth-ready',refresh);
  window.addEventListener('spatial-access-change',refresh);
  return {refresh};
}
