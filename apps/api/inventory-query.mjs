const searchFields=['name','sku','loc_code','external_loc_code','batch_no','status','unit','source'];

export function matchesInventoryQuery(row,query,fields=searchFields) {
 const q=String(query||'').normalize('NFKC').trim().toLowerCase();
 if(!q)return true;
 // 型号与货名可交换顺序；中文限定词保留，所有关键词必须同时命中。
 const words=q.match(/[a-z0-9]+(?:[_.-][a-z0-9]+)*|\p{Script=Han}+|[\p{L}]+/gu)||[q];
 return words.every(word=>fields.some(key=>String(row[key]||'').normalize('NFKC').toLowerCase().includes(word)));
}

export function searchInventory(rows,query={}) {
 const q=String(query.q || '').trim().toLowerCase();
 const fields=['source','status','unit','batch_no'];
 return rows.filter(row=>(!query.room || String(row.loc_code || '').startsWith(String(query.room)+'-')) && (!query.warehouse || row.warehouse_code===String(query.warehouse)) && (query.assignment!=='unassigned' || (row.assignment==='unassigned' && row.qty>0)) && fields.every(key=>!query[key] || row[key]===String(query[key])) && matchesInventoryQuery(row,q));
}

export function inventoryFacets(rows) {
 return Object.fromEntries(['source','status','unit'].map(key=>[key,[...new Set(rows.map(row=>String(row[key] || '')).filter(Boolean))].sort((a,b)=>a.localeCompare(b,'zh-CN'))]));
}
