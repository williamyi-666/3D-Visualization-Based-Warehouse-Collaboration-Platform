import {reconcileRows} from './reconcile-view.mjs';
export function parseReconcile(text) {
  let input;
  try{input=JSON.parse(text.replace(/^\uFEFF/,''));}catch{throw Error('JSON格式不正确，请检查引号、逗号和括号');}
  if(!input || Array.isArray(input) || typeof input!=='object')throw Error('对账文件必须包含 source、version、rows');
  if(typeof input.source!=='string' || !input.source.trim())throw Error('缺少数据来源 source');
  if(!Number.isSafeInteger(input.version) || input.version<1)throw Error('version 必须为当前来源的正整数版本号');
  if(!Array.isArray(input.rows))throw Error('rows 必须是库存记录数组');
  input.rows.forEach((row,index)=>{
    const fail=message=>{throw Error('第 '+(index+1)+' 条库存：'+message);};
    if(!row || Array.isArray(row) || typeof row!=='object')fail('必须是对象');
    for(const field of ['sku','name'])if(typeof row[field]!=='string' || !row[field].trim())fail(field+' 必填');
    if(!Number.isFinite(row.qty) || row.qty<0)fail('qty 必须为非负数');
    if(row.placement==='sku'){
      if(row.loc_code!=null || row.external_loc_code!=null)fail('SKU 归位不要同时提供库位');
      if(typeof row.warehouse_code!=='string' || !row.warehouse_code.trim())fail('SKU 归位需要仓库编码 warehouse_code');
    }else{
      if((row.loc_code!=null)===(row.external_loc_code!=null))fail('loc_code 与 external_loc_code 必须且只能提供一个');
      const code=row.loc_code ?? row.external_loc_code;if(typeof code!=='string' || !code.trim())fail('库位编码不能为空');
    }
    if(row.unit_weight_kg!=null && (!Number.isFinite(row.unit_weight_kg)||row.unit_weight_kg<0||!Number.isFinite(row.qty*row.unit_weight_kg)))fail('单位重量或总重量无效');
  });
  return {source:input.source,version:input.version,rows:input.rows};
}
export function reconcileCSV(result,caption) {
  const rows=[['对账范围',caption],['结果范围',result.truncated?'仅导出已返回的前 '+result.differences.length+' 条差异，非完整结果':'完整结果'],
    ['差异记录总数',result.difference_count],['类型','SKU','库位','批次','状态','字段','ERP/WMS期望','当前展示']];
  for(const row of reconcileRows(result))rows.push(['kind','sku','loc','batch','status','field','expected','actual'].map(key=>row[key]));
  const cell=value=>{let text=String(value ?? '');if(/^[\s]*[=+@-]/.test(text))text="'"+text;return '"'+text.replace(/"/g,'""')+'"';};
  return '\uFEFF'+rows.map(row=>row.map(cell).join(',')).join('\r\n');
}
