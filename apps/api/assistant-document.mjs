const fail=message=>{throw Object.assign(Error(message),{status:400});};
const aliases={
  sku:['sku','物料编码','物料编号','货品编码','货品编号','商品编码','商品编号','产品编码','存货编码','条码'],
  name:['name','名称','品名','物料名称','货品名称','商品名称','产品名称','存货名称'],
  specification:['specification','规格','型号','规格型号','物料规格'],qty:['qty','quantity','数量','申请数量','领用数量','入库数量','出库数量','实发数量','需求数量'],
  unit:['unit','单位','计量单位','库存单位'],operation:['operation','业务','业务类型','操作','操作类型'],
  from_hint:['from_loc','来源','来源格位','来源库位','源格位','源库位','出库库位'],to_hint:['to_loc','目标','目标格位','目标库位','入库库位'],
};
const businessAliases={document_no:['单号','业务单号','领料单号','出库单号','入库单号'],department:['部门','领用部门','申请部门'],recipient:['领用人','领取人','申请人'],purpose:['用途','领用用途']};
const normal=value=>String(value??'').trim();
const header=value=>normal(value).toLowerCase().replace(/[\s*：:（）()]/g,'');
const operation=value=>({入库:'in',收货:'in',出库:'out',领料:'out',移库:'move',移位:'move',in:'in',out:'out',move:'move'})[normal(value).toLowerCase()];
const units='千克|公斤|毫升|套|件|个|只|盒|箱|包|袋|瓶|桶|卷|根|张|台|米|升|克|kg|pcs|pc|m|g|l';
const amountPattern=new RegExp('(?:^|[\\s，,；;：:])([0-9]+(?:\\.[0-9]+)?)\\s*('+units+')(?=$|[\\s，,；;。])','i');

// CSV/TSV仅作为数据读取；保留引号内换行，不计算公式，也不执行原文中的指令。
export function documentTable(text){
  const lines=text.split(/\r?\n/).filter(line=>line.trim());
  const first=lines.find(line=>/(?:数量|申请数量|领用数量|需求数量)/.test(line)&&/[\t,;]/.test(line))||lines[0]||'';
  const delimiter=['\t',',',';'].sort((a,b)=>first.split(b).length-first.split(a).length)[0];
  if(!first.includes(delimiter))return null;
  const rows=[];let row=[],cell='',quoted=false;
  for(let i=0;i<text.length;i++){
    const c=text[i];
    if(c==='"'){if(quoted&&text[i+1]==='"'){cell+='"';i++;}else if(quoted||!cell)quoted=!quoted;else cell+=c;}
    else if(c===delimiter&&!quoted){row.push(cell);cell='';}
    else if((c==='\n'||c==='\r')&&!quoted){if(c==='\r'&&text[i+1]==='\n')i++;row.push(cell);rows.push(row);row=[];cell='';}
    else cell+=c;
  }
  if(quoted)fail('表格引号没有闭合，请检查原文或重新导出CSV');
  if(cell||row.length){row.push(cell);rows.push(row);}return rows;
}

export function parseWarehouseDocument(input={}){
  const selected=operation(input.operation);if(!selected)fail('请先选择这张单据办理入库、出库还是移库');
  const text=normal(input.text);if(text.length>30000)fail('单据文字最多30000字，请分单导入');
  const original=normal(input.original_text);if(original.length>30000)fail('单据原文最多30000字，请分单导入');
  const sourceKind=['text','table','photo'].includes(input.source_kind)?input.source_kind:'text';
  let grid=input.rows;
  if(grid!==undefined&&(!Array.isArray(grid)||grid.length>150||grid.some(row=>!Array.isArray(row)||row.length>40||row.some(cell=>!['string','number','boolean'].includes(typeof cell)&&cell!=null))))fail('表格最多150行、40列，请仅选择需要办理的单据区域');
  if(grid){grid=grid.map(row=>row.map(cell=>normal(cell)));if(grid.flat().some(cell=>cell.length>1500)||grid.flat().join('').length>30000)fail('单据内容过多，请分单导入');}
  else grid=documentTable(text)||text.split(/\r?\n/).map(line=>[line]);
  const business={},notes=[],rows=[];
  const mappingOf=row=>Object.fromEntries(Object.entries(aliases).flatMap(([key,names])=>{const index=row.findIndex(cell=>names.includes(header(cell)));return index>=0?[[key,index]]:[];}));
  const detected=grid.findIndex(row=>{const map=mappingOf(row);return (map.name!==undefined||map.sku!==undefined)&&map.qty!==undefined;});
  const manual=input.mapping&&typeof input.mapping==='object'&&!Array.isArray(input.mapping);
  const headerRow=manual?Number(input.header_row??0):detected;
  if(manual&&(!Number.isInteger(headerRow)||headerRow<0||headerRow>=grid.length))fail('请选择有效表头所在行');
  const mapping=manual?Object.fromEntries(Object.keys(aliases).filter(key=>input.mapping[key]!==undefined&&input.mapping[key]!==null&&input.mapping[key]!=='').map(key=>{
    const index=Number(input.mapping[key]);if(!Number.isInteger(index)||index<0||index>=40)fail('表格列选择无效');return [key,index];
  })):detected>=0?mappingOf(grid[detected]):null;
  if(manual&&((mapping.name===undefined&&mapping.sku===undefined)||mapping.qty===undefined))fail('至少选择货品名称或SKU列，以及数量列');
  function metadata(raw){
    let found=false;
    for(const [key,names] of Object.entries(businessAliases))for(const name of names){
      const match=raw.match(new RegExp('(?:^|[\t；;])\\s*'+name+'\\s*[:：]\\s*([^\t；;]+)'));
      if(match){business[key]=match[1].trim();found=true;break;}
    }return found;
  }
  for(const [index,cells] of grid.entries()){
    const raw=cells.join('\t').trim();if(!raw)continue;
    if(index===headerRow)continue;
    if(metadata(raw)&&(!mapping||index<headerRow)){notes.push({line:index+1,raw,reason:'单据信息'});continue;}
    if(mapping&&index<headerRow){notes.push({line:index+1,raw,reason:'表头前的说明'});continue;}
    if(/^(?:合计|总计|小计)(?:\s|[:：]|$)/.test(raw)){notes.push({line:index+1,raw,reason:'合计行，不作为独立货品办理'});continue;}
    let fields={},parsed={operation:selected},issues=[];
    if(mapping){
      fields=Object.fromEntries(Object.entries(mapping).map(([key,column])=>[key,cells[column]||'']));
      const op=fields.operation?operation(fields.operation):selected;
      if(!op)issues.push('业务类型无法识别');else parsed.operation=op;
      if(fields.sku)parsed.sku=fields.sku;
      if(fields.name)parsed.name=fields.name;
      parsed.query=fields.sku||[fields.name,fields.specification].filter(Boolean).join(' ');
      const rawAmount=normal(fields.qty),amount=/^\d{1,3}(?:,\d{3})+(?:\.\d+)?$/.test(rawAmount)?rawAmount.replace(/,/g,''):rawAmount,combined=amount.match(new RegExp('^([0-9]+(?:\\.[0-9]+)?)\\s*('+units+')$','i'));
      if(/^\d+(?:\.\d+)?$/.test(amount))parsed.qty=Number(amount);
      else if(combined){parsed.qty=Number(combined[1]);parsed.unit=combined[2];}
      if(fields.unit){if(parsed.unit&&parsed.unit!==fields.unit)issues.push('数量栏单位与单位栏不一致');parsed.unit=fields.unit;}
      for(const key of ['from_hint','to_hint'])if(fields[key])parsed[key]=fields[key];
    }else{
      const content=raw.replace(/^\s*\d+[.、)）]\s*/,'').replace(/^(入库|出库|移库|领料|收货)\s*[:：]?\s*/,prefix=>{parsed.operation=operation(prefix.replace(/[:：\s]/g,''))||selected;return '';});
      const amount=content.match(amountPattern);
      if(amount){parsed.qty=Number(amount[1]);parsed.unit=amount[2];parsed.query=content.slice(0,amount.index).trim();}
      else parsed.query=content;
      const locations=content.match(/WH-[A-Z0-9]+-[A-Z0-9]+-L\d+-B\d+/gi)||[];
      if(locations.length===1)parsed[parsed.operation==='in'?'to_hint':'from_hint']=locations[0];
      else if(locations.length===2&&parsed.operation==='move'){parsed.from_hint=locations[0];parsed.to_hint=locations[1];}
      else if(locations.length>1)issues.push('出现多个位置，请核对来源与目标');
      parsed.query=normal(parsed.query).replace(/\bWH-[A-Z0-9]+-[A-Z0-9]+-L\d+-B\d+\b/gi,'').replace(/[，,；;：:]\s*$/,'').trim();
    }
    if(!parsed.query)issues.push('缺少货品名称或SKU');
    if(!Number.isFinite(parsed.qty)||parsed.qty<=0){delete parsed.qty;issues.push('缺少明确的正数数量');}
    if(!parsed.unit)issues.push('原单没有明确库存单位');
    if(sourceKind==='photo')issues.push('照片识别结果需要对照原图核对');
    rows.push({input:parsed,source:{line:index+1,raw,fields,issues:[...new Set(issues)],reviewed:false}});
  }
  if(!rows.length)fail('没有找到货品行，请填写单据内容');
  if(rows.length>50)fail('每份单据最多50项，请拆分单据；本次没有保存或办理任何项目');
  return {kind:'document_preview',title:normal(input.title)||business.document_no||'整单作业',business,
    source:{kind:sourceKind,name:normal(input.source_name).slice(0,200)||'粘贴单据',text:original||text,header_row:headerRow,mapping,notes},rows,
    needs_review:rows.filter(row=>row.source.issues.length).length};
}
