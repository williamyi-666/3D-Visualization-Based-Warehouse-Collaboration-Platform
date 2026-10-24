// 模型负责选择业务；尺寸、层列和局部修改必须对应使用者的原话。
const num='([+-]?\\d+(?:\\.\\d+)?|负?[零〇一二两三四五六七八九十百]+)';
const glue='\\s*(?:改成|改为|调整为|预留|布置|摆放|放置|放|是|为)?\\s*';
export {numeric as parseAssistantNumber};
function numeric(value){
  if(/^[+-]?\d/.test(value))return Number(value);
  const digits={零:0,〇:0,一:1,二:2,两:2,三:3,四:4,五:5,六:6,七:7,八:8,九:9};let sum=0,n=0;
  for(const char of value.replace('负','')){if(char==='十'||char==='百'){sum+=(n||1)*(char==='十'?10:100);n=0;}else n=digits[char];}
  return (sum+n)*(value.startsWith('负')?-1:1);
}
export function groundWarehouseCall(name,args,message,pending){
  if((name==='prepare_stocktake'||name==='update_request'&&pending?.name==='prepare_stocktake')&&typeof args.reason==='string'&&!message.normalize('NFKC').replace(/\s/g,'').includes(args.reason.normalize('NFKC').replace(/\s/g,'')))args={...args,reason:undefined};
  if(name==='prepare_opening'){
    const unit=typeof args.unit==='string'?args.unit.replace(/[.*+?^${}()|[\]\\]/g,'\\$&'):'';
    const literal=unit?message.match(new RegExp('(?:这里有|这个格位有|此格位有|这格有|货品(?:名称)?(?:是|为|叫))\\s*(.+?)(?=共?'+num+'\\s*'+unit+')')):null;
    if(literal)return {name,args:{...args,name:literal[1].replace(/(?:[,，]\s*)?(?:数量|实盘数量|总计)\s*$/,'').replace(/[,，：:]\s*$/,'').trim(),qty:numeric(literal[2])}};
    if(args.name&&!message.normalize('NFKC').replace(/\s/g,'').includes(args.name.normalize('NFKC').replace(/\s/g,'')))args={...args,name:undefined};
    return {name,args};
  }
  if(name!=='preview_warehouse'&&!(name==='update_request'&&pending?.name==='preview_warehouse'))return {name,args};
  const definitions={
    count:['(?:新建|新增|布置|摆放|放置|需要|要|共|总共|总数量)'+glue+num+'\\s*(?:个)?(?:架|货架|(?:地面)?存放区|储位区)','(?:货架数量|总架数|总数量)'+glue+num],
    perRow:['每排'+glue+num+'\\s*(?:个|架)?'],
    rows:[num+'\\s*层','层数'+glue+num],cols:[num+'\\s*列','(?:列数|每层格位数)'+glue+num],
    w:['(?:宽度|宽)'+glue+num],h:['(?:高度|高)'+glue+num],d:['(?:深度|深)'+glue+num],
    aisle:['(?:通道宽度|排间通道|通道)'+glue+num],gap:['(?:相邻间距|间距)'+glue+num],
    startX:['(?:起始X|起始x)'+glue+num],startZ:['(?:起始Z|起始z)'+glue+num],
  };
  const grounded={...args};
  for(const [key,patterns] of Object.entries(definitions)){
    const found=patterns.map(pattern=>message.match(new RegExp(pattern))).find(Boolean);
    if(found)grounded[key]=numeric(found[1]);else delete grounded[key];
  }
  if(!/(轻型|横梁|地面|shelf|rack|floor)/i.test(message))delete grounded.template;
  if(!/(名称|名叫|命名|前缀)/.test(message))delete grounded.name;
  if(pending?.name==='preview_warehouse'&&!/(新建|新增|重新|再建|布置|摆放)/.test(message)&&Object.keys(grounded).length)name='update_request';
  return {name,args:grounded};
}
