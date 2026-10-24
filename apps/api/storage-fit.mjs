import {readStorageProfile} from './item-storage.mjs';
import {skuCapacity,capacityProducts} from '../../packages/three-kit/sku-capacity.mjs';

// 这是单库存单位与名义格位尺寸的筛选，不推断整批货品的三维装箱结果。
export function storageFit({cell,rack,profile,inventory,itemId,product,qty,unit,weight}){
  const reasons=[],warnings=[];
  const same=!!itemId&&inventory.some(row=>row.item_id===itemId);
  reasons.push(same?'已有相同SKU，便于集中存放':!inventory.length?'空格位':'已有其他货品，需核对混放要求');
  const tags=JSON.parse(cell.tags||'[]');
  if(profile.required_tags.some(tag=>!tags.includes(tag)))return null;
  if(profile.required_tags.length)reasons.push('存放条件标签匹配：'+profile.required_tags.join('、'));
  else if(!profile.configured)warnings.push('尚未登记货品存放要求');
  const match=cell.loc_code.match(/-L(\d+)-B(\d+)$/),row=Number(match?.[1]),col=Number(match?.[2]),span=(rack?.merges?.['L'+match?.[1]]||[]).find(([a])=>a===col);
  const dimensions=rack?{width:rack.w/rack.cols*(span?span[1]-span[0]+1:1),height:rack.type==='floor'?null:rack.h/rack.rows,depth:rack.type==='floor'?rack.d/rack.rows:rack.d}:null;
  let rotated=false;
  if(profile.width!==null&&dimensions&&dimensions.width>0&&dimensions.depth>0){
    const normal=profile.width<=dimensions.width+1e-7&&profile.depth<=dimensions.depth+1e-7;
    rotated=!normal&&profile.horizontal_rotation&&profile.depth<=dimensions.width+1e-7&&profile.width<=dimensions.depth+1e-7;
    if(!normal&&!rotated||dimensions.height!==null&&profile.height>dimensions.height+1e-7)return null;
    reasons.push('单库存单位包装未超出格位名义尺寸'+(rotated?'（需水平转向）':''));
    warnings.push(dimensions.height===null?'地面区堆高限制、整批堆放和现场净空尚需核对':'整批堆放和货架实际净空尚需核对');
  }else warnings.push('货品或格位尺寸不完整，尺寸未校验');
  const target={...(product || {item_id:itemId}),unit,storage_profile:profile};
  const rows=inventory.map(row=>({...row,storage_profile:readStorageProfile(row.attributes)}));
  const mixed=capacityProducts([...rows,{...target,qty}]).length>1;
  const capacity=skuCapacity({items:rows,target,meta:{capacity_rules:JSON.parse(cell.capacity_rules || '[]')},dimensions});
  if(mixed)warnings.push('多个 SKU 混放，数量不直接累加计算容量');
  else if(capacity.capacity!==null) {
    const used=rows.reduce((n,row)=>n+row.qty,0);
    if(capacity.basis==='manual') {
      if(used+qty>capacity.capacity)return null;
      reasons.push(`此 SKU 核定容量余量 ${capacity.capacity-used} ${unit}`);
    } else warnings.push(`此 SKU 按包装尺寸估算容量 ${capacity.capacity} ${unit}，${capacity.note}；整批存放请现场核对`);
  }else warnings.push('此 SKU 容量未核定，包装尺寸不足时不计算满载率');
  if(cell.max_load!=null){
    const loads=inventory.map(row=>{const w=row.item_id===itemId&&weight!==null?weight:readStorageProfile(row.attributes).weight_kg;return w===null?NaN:w*row.qty;});
    if(weight!==null&&loads.every(Number.isFinite)){const used=loads.reduce((a,b)=>a+b,0);if(used+weight*qty>cell.max_load+1e-7)return null;reasons.push(`承重余量 ${(cell.max_load-used).toFixed(1)} kg`);}
    else warnings.push('货品重量不足，承重未校验');
  }else warnings.push('承重未设置');
  return {loc_code:cell.loc_code,name:cell.name,reasons,warnings,score:same?3:!inventory.length?2:1,dimensions,rotated};
}
