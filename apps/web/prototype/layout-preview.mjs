import {mergeCapacityPreview} from './merge-capacity.mjs';
// 草稿只覆盖空间结构；库存归并和容量变更仅作预览。
export function layoutPreviewSpec(saved, layout) {
  const originals = new Map((saved.furniture || []).map(f => [f.code, f]));
  return {...saved, room:layout.room, assets:{}, furniture:layout.furniture.map(f => ({
    ...originals.get(f.code), ...mergeCapacityPreview(originals.get(f.code), f), code:f.code, label:f.label, type:f.type, open:f.open,
    position:[f.x, 0, f.z], x:f.x, z:f.z, rotationY:f.rot,
    width:f.w, height:f.h, depth:f.d, rows:f.rows, cols:f.cols,
    merges:f.merges || {}, cellNames:f.cellNames || {},mergeCapacities:f.mergeCapacities
  }))};
}

// 移动和旋转无需重建几何体，避免拖动结束时重建整个库区。
export function layoutStructureKey(furniture) {
  return JSON.stringify(furniture.map(f => [f.code,f.label,f.type,f.open,
    f.w,f.h,f.d,f.rows,f.cols,f.merges || {},f.cellNames || {},f.mergeCapacities || {}]));
}
