// 格位的末尾编码用于层筛选，货架使用场景提供的归属，不按前缀猜测。
export const cellLayer = cell => /-(L\d+)-B\d+(?:-\d+)?$/.exec(cell.locCode)?.[1] || '';
export function filterCells(cells,{rack='',layer='',query=''}={}) {
  const term=query.trim().toLocaleLowerCase();
  return cells.filter(cell=>(!rack || cell.rackCode===rack) && (!layer || cellLayer(cell)===layer) &&
    (!term || [cell.locCode,cell.meta?.name,...(cell.meta?.tags || [])].some(v=>String(v || '').toLocaleLowerCase().includes(term))));
}
