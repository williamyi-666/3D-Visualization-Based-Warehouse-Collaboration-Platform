// 米制平面矩形；旋转与 Three.js 绕 Y 轴的方向一致。
export function footprint(f) {
  const c = Math.cos(f.rot || 0), s = Math.sin(f.rot || 0);
  return [[-1,-1],[1,-1],[1,1],[-1,1]].map(([u,v]) => {
    const x=u*f.w/2,z=v*f.d/2;
    return [f.x+x*c+z*s,f.z-x*s+z*c];
  });
}
export function halfExtents(f) {
  const c=Math.abs(Math.cos(f.rot || 0)),s=Math.abs(Math.sin(f.rot || 0));
  return {x:(f.w*c+f.d*s)/2,z:(f.w*s+f.d*c)/2};
}
export function overlaps(a,b) {
  const p=footprint(a),q=footprint(b);
  for(const polygon of [p,q]) for(let i=0;i<2;i++) {
    const next=polygon[i+1],prev=polygon[i],axis=[-(next[1]-prev[1]),next[0]-prev[0]];
    const project=points=>points.map(v=>v[0]*axis[0]+v[1]*axis[1]);
    const x=project(p),y=project(q);
    if(Math.max(...x)<=Math.min(...y)+1e-7 || Math.max(...y)<=Math.min(...x)+1e-7)return false;
  }
  return true;
}
export function placementError(f, room, others=[]) {
  if(footprint(f).some(([x,z])=>Math.abs(x)>room.width/2+1e-6 || Math.abs(z)>room.depth/2+1e-6))return '货架超出库区边界';
  // 地面区是划线区域，可与货架投影叠加，不作为实体碰撞物。
  if(f.type!=='floor' && others.some(o=>o.code!==f.code && o.type!=='floor' && overlaps(f,o)))return '货架与其他货架重叠';
  return '';
}
