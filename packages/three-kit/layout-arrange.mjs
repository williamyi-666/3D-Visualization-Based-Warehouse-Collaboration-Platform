import {halfExtents,placementError} from './layout-geometry.mjs';
// 按当前坐标排序，固定第一架；间距按旋转后的外接边界计算，不改变货架规格。
export function arrangeRacks(furniture,codes,room,axis,gap) {
  if(!['x','z'].includes(axis) || !Number.isFinite(gap) || gap<0)throw Error('请选择排列方向并输入非负间距');
  const selected=new Set(codes),draft=furniture.map(f=>({...f}));
  const racks=draft.filter(f=>selected.has(f.code)).sort((a,b)=>a[axis]-b[axis] || a.code.localeCompare(b.code));
  if(racks.length<2)throw Error('请至少勾选两个货架');
  const cross=axis==='x'?'z':'x';
  for(let i=1;i<racks.length;i++){
    const prev=racks[i-1],next=racks[i];
    next[axis]=prev[axis]+halfExtents(prev)[axis]+gap+halfExtents(next)[axis];
    next[cross]=racks[0][cross];
  }
  for(const rack of racks){const error=placementError(rack,room,draft);if(error)throw Error((rack.label||rack.code)+'：'+error);}
  return racks.map(({code,x,z})=>({code,x,z}));
}
