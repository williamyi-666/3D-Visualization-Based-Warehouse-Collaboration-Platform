// 容量标准属于 SKU、库存单位和格位尺寸；估算采用保持朝上的规整摆放。
export function capacityProduct(item) {
  if (!item) return null;
  const sku=String(item.sku || '').trim(),source=String(item.source || ''),id=String(item.item_id || item.id || '');
  if (!sku && !id) return null;
  return {sku,source,item_id:sku?'':id,unit:String(item.unit || '件'),name:String(item.name || sku || id),storage_profile:item.storage_profile};
}
export const productKey = item => {
  const p=capacityProduct(item);
  return p?JSON.stringify([p.source,p.sku || '@'+p.item_id,p.unit]):'';
};
export function capacityProducts(items=[]) {
  const products=new Map();
  for(const item of items.filter(i=>Number(i.qty)>0)) {
    const key=productKey(item);
    if(key && !products.has(key))products.set(key,capacityProduct(item));
  }
  return [...products.values()];
}
export function cellDimensions(rack,suffix,spanOverride) {
  const col=Number(suffix.split('-B')[1]),row=suffix.slice(0,3);
  const span=spanOverride ?? ((rack.merges?.[row] || []).find(([a])=>a===col)?.[1]-col+1 || 1);
  const floor=rack.type==='floor';
  return {width:Number(rack.width ?? rack.w)/rack.cols*span,height:floor?null:Number(rack.height ?? rack.h)/rack.rows,
    depth:Number(rack.depth ?? rack.d)/(floor?rack.rows:1)};
}
export const dimensionKey = d => JSON.stringify(['width','height','depth'].map(k=>d?.[k]==null?null:Math.round(d[k]*1e6)/1e6));
export function capacityRule(meta,product,dimensions) {
  return (meta.capacity_rules || []).find(r=>productKey(r.product)===productKey(product) && r.space===dimensionKey(dimensions));
}
export function updateCapacityRules(meta,product,capacity,dimensions) {
  const space=dimensionKey(dimensions),key=productKey(product);
  const rules=(meta.capacity_rules || []).filter(r=>r.space!==space || productKey(r.product)!==key);
  if(capacity!==null){const {storage_profile,...identity}=capacityProduct(product);rules.push({product:identity,capacity,space});}
  return rules;
}
export function estimateCapacity(dimensions,profile) {
  if(!dimensions || !profile || !['width','height','depth'].every(k=>Number.isFinite(dimensions[k]) && dimensions[k]>0 && Number.isFinite(profile[k]) && profile[k]>0))return null;
  // 未登记叠放条件时仅作单层估算；不翻倒包装，也不假定可无限叠放。
  const layers=Math.min(Math.floor((dimensions.height+1e-9)/profile.height),profile.max_stack_layers || 1);
  const count=(w,d)=>Math.floor((dimensions.width+1e-9)/w)*Math.floor((dimensions.depth+1e-9)/d)*layers;
  const normal=count(profile.width,profile.depth),turned=profile.horizontal_rotation?count(profile.depth,profile.width):normal;
  return {capacity:Math.max(normal,turned),rotated:turned>normal,layers,singleLayer:!profile.max_stack_layers,
    note:profile.max_stack_layers?'按包装尺寸及最大叠放层数估算':'未登记叠放条件，仅作单层估算'};
}
export function skuCapacity({items=[],meta={},dimensions,target}={}) {
  const stocked=items.filter(i=>Number(i.qty)>0),products=capacityProducts(stocked);
  const quantity=stocked.reduce((n,i)=>n+Number(i.qty),0);
  const unknownProduct=stocked.some(i=>!productKey(i));
  if(!target && (products.length>1 || unknownProduct))return {kind:'mixed',capacity:null,ratio:null,quantity,product:null,over:false,note:unknownProduct?'货品标识不完整，容量待确认':'多个 SKU 或库存单位混放，不计算总体满载率'};
  const product=capacityProduct(target || products[0]);
  if(!product)return {kind:quantity?'unknown':'empty',capacity:null,ratio:null,quantity,product:null,over:false,note:quantity?'容量待确认':'无库存'};
  const matching=stocked.filter(i=>productKey(i)===productKey(product));
  const qty=matching.reduce((n,i)=>n+Number(i.qty),0);
  const profiles=matching.map(i=>i.storage_profile).filter(Boolean);
  const profile=product.storage_profile || profiles[0];
  const profileMatches=!profiles.some(p=>JSON.stringify(p)!==JSON.stringify(profile));
  const standard=capacityRule(meta,product,dimensions),estimate=profileMatches?estimateCapacity(dimensions,profile):null;
  if(estimate && meta.max_load!=null && profile.weight_kg>0) {
    const loadLimit=Math.floor(Number(meta.max_load)/profile.weight_kg);
    if(loadLimit<estimate.capacity){estimate.capacity=loadLimit;estimate.note+='，受承重上限约束';}
  }
  const capacity=standard?.capacity ?? estimate?.capacity ?? null;
  const basis=standard?'manual':estimate?'estimated':'unknown';
  const ratio=capacity===null?null:capacity>0?qty/capacity:qty>0?Infinity:0;
  return {kind:stocked.length?basis:'empty',basis,capacity,ratio,quantity:qty,product,estimate,over:basis==='manual' && qty>capacity,
    note:standard?'现场核定':estimate?estimate.note:!profileMatches?'同 SKU 包装资料不一致，请核对':'未登记包装尺寸或此 SKU 的容量标准'};
}
export function capacitySummary(value) {
  if(value.kind==='mixed')return value.note;
  if(!value.product)return value.note;
  const identity=(value.product.sku || value.product.name)+' · '+value.product.unit;
  if(value.capacity===null)return identity+' · 容量待确认';
  const pct=Number.isFinite(value.ratio)?(value.ratio*100).toFixed(1)+'%':'超出容量';
  return `${identity} · ${value.quantity}/${value.capacity} ${value.product.unit} · ${value.basis==='estimated'?'估算':'核定'}使用率 ${pct}`;
}
