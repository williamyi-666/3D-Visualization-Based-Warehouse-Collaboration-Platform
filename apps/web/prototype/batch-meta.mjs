// 保持不发送字段；清空使用后端已有的空值语义，不把容量0当作未设置。
export function buildBatchMeta(fields, status='') {
  const meta={};
  if(status)meta.status=status;
  for(const [key,{mode,value}] of Object.entries(fields)) {
    if(mode==='keep')continue;
    if(mode==='clear'){meta[key]=key==='tags'?[]:key==='note'?'':null;continue;}
    const text=String(value).trim();
    if(!text)throw Error('选择设置后请填写内容，删除原值请选择清空');
    if(key==='capacity'||key==='max_load'){
      const number=Number(text);
      if(!Number.isFinite(number)||number<0||(key==='capacity'&&!Number.isInteger(number)))throw Error(key==='capacity'?'容量须为非负整数':'承重须为非负数字');
      meta[key]=number;
    }else if(key==='tags'){
      meta.tags=text.split(/[,，]/).map(v=>v.trim()).filter(Boolean);
      if(!meta.tags.length)throw Error('请填写有效标签');
    }else meta[key]=text;
  }
  return meta;
}
