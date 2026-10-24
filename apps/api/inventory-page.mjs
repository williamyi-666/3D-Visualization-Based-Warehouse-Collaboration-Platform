import {createHash} from 'node:crypto';
import {searchInventory} from './inventory-query.mjs';
export function createInventoryPager(sql,list) {
  return function inventoryPage(query={},canAccessLocation=null) {
    const page=Number(query.page ?? 1),size=Number(query.page_size ?? 50);
    if(!Number.isSafeInteger(page)||page<1||!Number.isInteger(size)||size<1||size>200)throw new Error('分页参数无效，每页须为1至200条');
    const bindingRevision=sql.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='cell_sku_binding'").get() ? sql.prepare('SELECT * FROM cell_sku_binding ORDER BY loc_code').all() : [];
    const revision=createHash('sha256').update(JSON.stringify(sql.prepare('SELECT source,version FROM external_inventory_snapshot ORDER BY source').all())).update(JSON.stringify(bindingRevision)).digest('hex');
    if(query.revision && query.revision!==revision){const error=new Error('库存已更新，请重新查询后再翻页');error.status=409;throw error;}
    const rows=searchInventory(list().filter(row=>!canAccessLocation||canAccessLocation(row.loc_code || row.warehouse_code)),query).sort((a,b)=>a.id<b.id?-1:a.id>b.id?1:0);
    const total=rows.length,pages=Math.max(1,Math.ceil(total/size)),current=Math.min(page,pages);
    return {total,page:current,pages,page_size:size,revision,rows:rows.slice((current-1)*size,current*size)};
  };
}
