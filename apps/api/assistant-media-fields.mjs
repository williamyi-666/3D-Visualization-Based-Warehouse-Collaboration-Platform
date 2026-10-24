import {parseAssistantNumber} from './assistant-grounding.mjs';

// 识别只给填写建议。没有明确数量/单位时留空，规格号不能充当数量。
export function extractMediaFields(raw){
  const text=String(raw||'').normalize('NFKC').replace(/([\u3400-\u9fff])[ \t]+(?=[\u3400-\u9fff])/g,'$1').replace(/[ \t]+/g,' ').trim();
  const value=labels=>text.match(new RegExp('(?:^|[\n,，;；])\\s*(?:'+labels+')\\s*[:：]\\s*([^\n,，;；]+)','i'))?.[1].trim()||'';
  const fields={name:value('名称|品名|货品名称|商品名称|NAME'),spec:value('规格(?:型号)?|型号|SPEC|MODEL'),sku:value('SKU|物料(?:编码|编号)|货品编码|商品编码|CODE').replace(/\s/g,''),unit:value('单位|UNIT'),qty:null,operation:'',from_hint:value('源格位|来源格位|FROM'),to_hint:value('目标格位|TO')};
  const operations=[['in',/入库|收货/],['out',/出库|领出/],['move',/移库|移到|搬到/],['count',/盘点|实盘/]];
  const found=operations.filter(([,pattern])=>pattern.test(text));if(found.length===1)fields.operation=found[0][0];
  const labelled=value('数量|实盘数量|QTY|QUANTITY');
  const quantityText=labelled||text.split('\n').filter(line=>!/^\s*(?:规格(?:型号)?|型号|SKU|CODE|SPEC|MODEL|名称|品名|货品名称|商品名称|NAME)\s*[:：]/i.test(line)).join('\n');
  const amounts=[...quantityText.matchAll(/([+-]?\d+(?:\.\d+)?|负?[零〇一二两三四五六七八九十百]+)\s*(套|件|个|盒|箱|包|袋|瓶|桶|卷|根|只|台|吨|千克|公斤|kg|米|m)(?![A-Za-z])/gi)].filter(match=>/\d|十|百/.test(match[1])||match[1].replace('负','').length===1);
  if(labelled&&/^(?:[+-]?\d+(?:\.\d+)?|[零〇一二两三四五六七八九十百])$/.test(labelled)&&fields.unit)fields.qty=parseAssistantNumber(labelled);
  else if(amounts.length===1){fields.qty=parseAssistantNumber(amounts[0][1]);fields.unit=amounts[0][2];}
  if(!fields.name&&fields.operation&&amounts.length===1){
    const before=text.slice(0,text.lastIndexOf(amounts[0][0])).replace(/(?:数量|总共|共)\s*[:：]?\s*$/,'').trim();
    const name=before.replace(/^(?:请|帮我|把|将|办理|需要|我要|我想|现在|这批)*\s*/,'').replace(/^(?:入库|出库|收货|盘点|实盘)\s*/,'').replace(/\s*(?:入库|出库|收货|盘点|实盘)$/,'').trim();
    if(name&&!/[\n:：]|格位|货架|移库|移到|从|到/.test(name))fields.name=name;
  }
  return {text,fields};
}
