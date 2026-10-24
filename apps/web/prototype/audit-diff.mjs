const labels = {capacity_rules:'SKU容量标准',capacity:'参考容量',max_load:'承重（kg）',status:'格位状态',tags:'标签',note:'备注',name:'名称',loc_code:'库位编码',parent_id:'所属节点',node_type:'节点类型',w:'宽度（米）',h:'高度（米）',d:'深度（米）',x:'X 坐标（米）',y:'Y 坐标（米）',z:'Z 坐标（米）',rot:'旋转角度',rows:'层数 / 地面行数',cols:'列数',type:'类型',open:'开放状态'};
function fields(node) {
  const result={};
  for (const [key,value] of Object.entries(node || {})) {
    if (key==='id') continue;
    if (key==='geom' || key==='template') {
      let parsed=value;
      try { if(typeof value==='string') parsed=JSON.parse(value); } catch { /* 旧记录保留原文 */ }
      if(parsed && typeof parsed==='object' && !Array.isArray(parsed)) {
        for(const [field,item] of Object.entries(parsed)) result[key+'.'+field]=item;
        continue;
      }
    }
    result[key]=value;
  }
  return result;
}
const display=value=>value===undefined?'未设置':value===null?'空值':typeof value==='object'?JSON.stringify(value):String(value);
export function auditChanges(before=[],after=[]) {
  const oldNodes=new Map(before.map(n=>[n.id,n]));
  const newNodes=new Map(after.map(n=>[n.id,n]));
  const rows=[];
  for(const id of new Set([...oldNodes.keys(),...newNodes.keys()])) {
    const oldNode=oldNodes.get(id),newNode=newNodes.get(id),a=fields(oldNode),b=fields(newNode);
    const node=(newNode || oldNode).loc_code || (newNode || oldNode).name || id;
    for(const key of new Set([...Object.keys(a),...Object.keys(b)])) {
      if(JSON.stringify(a[key])===JSON.stringify(b[key])) continue;
      const [group,field]=key.split('.');
      rows.push({node,action:!oldNode?'新增':!newNode?'删除':'修改',field:(field?(group==='geom'?'空间 · ':'格位 · '):'')+(labels[field || key] || field || key),before:display(a[key]),after:display(b[key])});
    }
  }
  return rows;
}
