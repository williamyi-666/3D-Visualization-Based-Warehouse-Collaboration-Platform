import {capacityProduct,capacityProducts,productKey,skuCapacity,cellDimensions,updateCapacityRules} from '../../../packages/three-kit/sku-capacity.mjs';
const key = (row, col) => `${row}-B${String(col).padStart(2, '0')}`;

export function cellGroups(rows, cols, merges = {}) {
  const groups = [];
  for (let r = rows; r >= 1; r--) {
    const row = 'L' + String(r).padStart(2, '0');
    for (let a = 1; a <= cols;) {
      const b = (merges[row] || []).find(span => span[0] === a)?.[1] ?? a;
      groups.push({row, a, b, suffix:key(row, a), id:`${row}:${a}-${b}`});
      a = b + 1;
    }
  }
  return groups;
}

// 已合并的主格位容量只计一次；拆分后不能推断容量分配。
export function mergeCapacityPlan(source, rows, cols, merges, targets={}) {
  const originals = cellGroups(source.rows || rows, source.cols || cols, source.merges);
  const choices=new Map();
  for(const item of [...capacityProducts(Object.values(source.items || {}).flat()),...(source.catalog || []),...Object.values(source.cellMeta || {}).flatMap(m=>(m.capacity_rules || []).map(r=>r.product))]) {
    const product=capacityProduct(item);if(product&&(!choices.has(productKey(product)) || !choices.get(productKey(product)).storage_profile && product.storage_profile))choices.set(productKey(product),product);
  }
  return cellGroups(rows, cols, merges).map(group => {
    const parts = originals.filter(p => p.row === group.row && p.a <= group.b && p.b >= group.a);
    const split = parts.some(p => p.a < group.a || p.b > group.b);
    const unchanged = parts.length === 1 && parts[0].id === group.id;
    const items=parts.flatMap(p=>source.items?.[p.suffix] || []),products=capacityProducts(items);
    const product=Object.hasOwn(targets,group.id)?targets[group.id]:products.length===1?products[0]:null;
    const dimensions=cellDimensions({...source,rows,cols},group.suffix,group.b-group.a+1);
    const meta=source.cellMeta?.[group.suffix] || {};
    const state=skuCapacity({items,meta,dimensions,target:product});
    const complete = parts.reduce((n,p) => n + p.b-p.a+1, 0) === group.b-group.a+1;
    let capacity = null, hint;
    if(!product)hint=products.length>1?'当前混放，请选择需要核定容量的目标 SKU':'请选择容量对应的目标 SKU';
    else if(state.basis==='manual'){capacity=state.capacity;hint='此 SKU 在当前格位尺寸下已核定容量';}
    else if(state.basis==='estimated')hint=`按当前空间估算 ${state.capacity} ${product.unit}；${state.note}，可填写现场核定值`;
    else if(split)hint='原格位已拆分，请重新确认此 SKU 容量';
    else if(!unchanged && complete) {
      const values=parts.map(p=>skuCapacity({items:source.items?.[p.suffix],meta:source.cellMeta?.[p.suffix],dimensions:cellDimensions(source,p.suffix,p.b-p.a+1),target:product}));
      if(values.every(v=>v.basis==='manual')){capacity=values.reduce((n,v)=>n+v.capacity,0);hint='同 SKU 核定容量参考合计：'+values.map(v=>v.capacity).join(' + ')+' = '+capacity+'，保存前请核对';}
    }
    hint ||= '缺少包装尺寸或此 SKU 的容量标准，可填写核定值；留空按已有资料估算';
    if(product && products.length>1)hint+='；当前混放，总体满载率不计算';
    return {...group, changed:!unchanged, capacity, hint, product,choices:[...choices.values()],dimensions,unit:product?.unit || '',state};
  });
}

// 草稿预览只归并显示数据，不修改真实库存。
export function mergeCapacityPreview(original = {}, draft) {
  const groups = cellGroups(draft.rows, draft.cols, draft.merges);
  const items = {};
  for (const [suffix, rows] of Object.entries(original.items || {})) {
    const group = groups.find(g => suffix.startsWith(g.row+'-') && Number(suffix.split('-B')[1]) >= g.a && Number(suffix.split('-B')[1]) <= g.b);
    if (group) (items[group.suffix] ||= []).push(...rows);
  }
  const cellMeta = {...original.cellMeta};
  for (const [suffix, value] of Object.entries(draft.mergeCapacities || {})) {
    const meta=cellMeta[suffix] || {};
    cellMeta[suffix]=value && typeof value==='object'?{...meta,capacity:value.capacity,capacity_rules:updateCapacityRules(meta,value.product,value.capacity,cellDimensions(draft,suffix))}:{...meta,capacity:value};
  }
  return {items:original.items === undefined ? undefined : items, cellMeta:original.cellMeta === undefined && !draft.mergeCapacities ? undefined : cellMeta};
}
