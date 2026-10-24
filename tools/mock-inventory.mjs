// 仅用于独立 Open supOS 联调卷；不可对原库存库执行。
if (process.env.SPATIAL_MODE !== 'integration' || process.env.SPATIAL_DATA_DIR !== '/data') throw new Error('仅允许独立联调容器');
const { default: sql } = await import('../apps/api/db.mjs');
const { createInventoryView } = await import('../apps/api/inventory-view.mjs');
const view = createInventoryView(sql);
console.log(view.apply({ source: '模拟ERP（联调）', version: 1, rows: [
  { sku: 'BEARING-6204', name: '深沟球轴承 6204', qty: 120, unit: '套', batch_no: 'DEMO-202609-A', loc_code: 'WH-1-A-L01-B01' },
  { sku: 'BOLT-M12', name: '六角螺栓 M12', qty: 500, unit: '件', batch_no: 'DEMO-202609-B', loc_code: 'WH-1-A-L02-B03' },
  { sku: 'BEARING-6204', name: '深沟球轴承 6204', qty: 20, unit: '套', status: '待检', batch_no: 'DEMO-202609-C', loc_code: 'WH-1-B-L01-B02' }
] }));
