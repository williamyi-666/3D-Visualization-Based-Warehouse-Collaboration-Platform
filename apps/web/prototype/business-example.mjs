// 模拟宿主详情读取当前同步视图，不把postMessage载荷当成权威库存。
export async function resolveBusinessInventory(payload, { fetcher = fetch, basePath = '' } = {}) {
  if (!payload || ['source','sku','loc'].some(k => typeof payload[k] !== 'string' || !payload[k].trim()))
    throw new Error('缺少业务来源、SKU或库位');
  const params = new URLSearchParams({ q: payload.sku, source: payload.source });
  const response = await fetcher(basePath + '/api/search?' + params);
  if (!response.ok) throw new Error(response.status === 401 ? '平台会话已过期，请重新登录' : '无法读取当前库存详情');
  const rows = await response.json();
  const matches = rows.filter(row => row.source === payload.source && row.sku === payload.sku &&
    row.loc_code === payload.loc && (row.batch_no || '') === (payload.batch_no || '') &&
    (row.status || '') === (payload.status || ''));
  if (matches.length !== 1) throw new Error(matches.length ? '业务标识匹配到多条库存，请核对来源数据' : '该库存记录已变化或移除，请返回三维页刷新');
  return matches[0];
}
