// 二维码只解析业务标识，不打开二维码内的任意网址。
export function parseWarehouseCode(raw,origin) {
 const text=String(raw || '').trim();if(!text || text.length>2000)throw new Error('请输入有效的仓储码');
 if(/^https?:\/\//i.test(text)) {
  const url=new URL(text);if(url.origin!==origin)throw new Error('二维码不是当前仓储平台的链接');
  const loc=url.searchParams.get('loc'),sku=url.searchParams.get('sku'),source=url.searchParams.get('source');
  if(loc)return {loc};if(sku)return {sku,...(source?{source}:{})};throw new Error('链接中没有库位或SKU');
 }
 if(/^loc:/i.test(text)){const loc=text.slice(4).trim();if(!loc)throw new Error('库位编码为空');return {loc};}
 if(/^sku:/i.test(text)){const sku=text.slice(4).trim();if(!sku)throw new Error('SKU为空');return {sku};}
 if(/^[a-z][a-z0-9+.-]*:/i.test(text))throw new Error('不支持的仓储码格式');
 if(/^WH-[^\s]+$/.test(text))return {loc:text};
 return {sku:text};
}
