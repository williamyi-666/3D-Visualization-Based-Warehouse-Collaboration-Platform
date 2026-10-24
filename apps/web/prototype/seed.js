// apps/web/prototype/seed.js
// 离线版内联样例数据（实时版从 /api 拉取）。仓库场景：货架 A/B/C，货位按 层×位。
// LOC Code 规则：仓库-库区-货架-层-格，如 WH-1-A-L01-B01
export const SEED = {
  tenant: 'WH',
  room: '1',
  roomSize: { width: 12, depth: 8, height: 4, door: 'back', window: ['left', 'right'] },
  furniture: [
    {
      type: 'rack',
      code: 'WH-1-A',
      label: 'A货架',
      position: [-2.0, 0, 0],
      width: 1.2,
      height: 2.0,
      depth: 0.5,
      rows: 5, // 含开放顶层（无顶板，可往上堆货），对应 L05
      cols: 6,
      capacityPerCell: 50,
      items: {
        'L01-B01': [{ name: '包装纸箱', qty: 24, note: '60×40' }, { name: '封箱胶带', qty: 50 }],
        'L02-B03': [{ name: '螺丝配件包', qty: 500, note: 'M6×20' }],
        'L03-B02': [{ name: '防护手套', qty: 30 }],
      },
    },
    {
      type: 'rack',
      code: 'WH-1-B',
      label: 'B货架',
      position: [0, 0, 0],
      width: 1.2,
      height: 2.0,
      depth: 0.5,
      rows: 5, // 含开放顶层（无顶板，可往上堆货），对应 L05
      cols: 6,
      capacityPerCell: 50,
      items: {
        'L01-B01': [{ name: '原料桶', qty: 8, note: '化工原料' }, { name: '标签纸卷', qty: 200 }],
        'L02-B04': [{ name: '塑料周转箱', qty: 15 }],
      },
    },
    {
      type: 'rack',
      code: 'WH-1-C',
      label: 'C货架',
      position: [2.0, 0, 0],
      width: 1.2,
      height: 2.0,
      depth: 0.5,
      rows: 5, // 含开放顶层（无顶板，可往上堆货），对应 L05
      cols: 6,
      capacityPerCell: 50,
      items: {
        'L01-B01': [{ name: '成品工件', qty: 12 }],
        'L02-B02': [{ name: '备品轴承', qty: 40 }],
      },
    },
  ],
};
