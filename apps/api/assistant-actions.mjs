import {rackTemplates,planQuickBuild} from '../../packages/three-kit/quick-build.mjs';
import {readAssistantHistory} from './assistant-history.mjs';

const string={type:'string'},number={type:'number'};
const subject={query:{...string,description:'货品名称或SKU；“这批货”留空，由程序使用当前选中货品'},item_id:string,loc_hint:{...string,description:'完整格位码或货架简称；“这里”留空，由程序使用当前选中格位'}};
const spec=(name,description,properties)=>({type:'function',function:{name,description,parameters:{type:'object',properties,additionalProperties:false}}});
export const assistantActionsSchema=[
  spec('preview_warehouse','为当前库区生成新增货架摆放预览。仅预览，不建立货架。缺失尺寸或通道时留空，交由用户核对模板建议。',{template:{type:'string',enum:['shelf','rack','floor']},count:{...number,description:'本次新增货架总个数；布置2架=count2'},perRow:{...number,description:'平面上每排货架个数；每排1架=perRow1，不改变总个数count'},rows:{...number,description:'每架竖直层数；2层=rows2'},cols:{...number,description:'每层横向格位列数；3列=cols3'},w:{...number,description:'货架横向宽度，米'},h:{...number,description:'货架竖直高度，米'},d:{...number,description:'货架前后深度，米'},aisle:number,gap:number,startX:number,startZ:number,name:{...string,description:'仅当用户明确指定货架名称前缀时填写'}}),
  spec('prepare_opening','为尚未建账的空格位预填期初库存。新货品name填写用户原话的完整名称，不能只保留规格号或删除前缀。实盘数量是绝对数，仅预览；已在库货品数量变化应使用盘点。',{...subject,name:{...string,description:'新货品完整名称，保留用户明确说出的全部限定词'},qty:number,unit:string,sku:string}),
  spec('recommend_location','按已登记的包装尺寸、存放标签、同SKU、容量、承重和通道距离推荐格位。必须有本次存放数量，不编造尺寸或重量。',{...subject,qty:number,unit:string,unit_weight:number,start_loc:{...string,description:'用户明确给出的搬运起点格位，未指定时留空使用入口，不把选中格位当人员位置'},entry:number}),
  spec('prepare_stocktake','用户说实盘、实际有多少、盘点时生成实盘预览。actual_qty是实际总数，可为0，不是入库增量。',{...subject,actual_qty:number,unit:string,reason:string}),
  spec('movement_history','查询真实出入库、移库和盘点记录，解释数量变化。period默认today；查询全部历史时all。',{...subject,period:{type:'string',enum:['today','week','month','all']}}),
  spec('update_request','补充或修改上一条待确认请求，例如“改成5套”“每排2架”“目标改为B架”。只填写本次用户明确修改的字段，保留其他字段。',{query:string,qty:number,actual_qty:number,unit:string,unit_weight:number,from_hint:string,to_hint:string,loc_hint:string,start_loc:string,entry:number,count:number,perRow:number,rows:number,cols:number,w:number,h:number,d:number,aisle:number,gap:number,startX:number,startZ:number,template:{type:'string',enum:['shelf','rack','floor']},name:string,reason:string}),
];

const text=value=>typeof value==='string'?value.trim():'';
const numberValue=value=>typeof value==='number'&&Number.isFinite(value)?value:null;
const unique=rows=>[...new Map(rows.map(row=>[row.item_id,row])).values()];
export function createAssistantActions({db,work,matchingItems,locations,integrationMode}){
  const canManage=req=>{if(!['admin','spaceAdmin'].includes(req.user.role))throw Object.assign(Error('此操作需要空间管理员权限'),{status:403});};
  const canOperate=ctx=>{if(!ctx.canOperate)throw Object.assign(Error(integrationMode?'当前库存由ERP维护，请通过对应业务流程办理。':'当前账号没有库存作业权限'),{status:403});};
  const catalogue=(ctx,req)=>unique([...work.catalogue(ctx.room.loc_code,req.canAccessLocation,req.user),...ctx.inventory]);
  function choose(ctx,args,rows){
    const input={...args};
    if(!text(input.query)&&!text(input.item_id)&&ctx.selectedItem)input.item_id=ctx.selectedItem.item_id;
    const matches=matchingItems(rows,text(input.query),text(input.item_id));
    const items=unique(matches),item=items.length===1?items[0]:null;
    return {input,items,item};
  }
  function chooseLocation(ctx,args){
    const input={...args};
    if(!text(input.loc_code)&&!text(input.loc_hint)&&ctx.selectedLoc)input.loc_code=ctx.selectedLoc;
    const candidates=locations(ctx,input.loc_hint,input.loc_code),loc=candidates.length===1?candidates[0].loc_code:'';
    return {input,candidates,loc};
  }
  function previewWarehouse(ctx,args,req){
    canManage(req);
    const input={...args},template=rackTemplates.find(t=>t.id===input.template),missing=[];
    if(!template)missing.push('选择轻型货架、横梁货架或地面存放区');
    if(numberValue(input.count)===null)missing.push('本次新增数量');
    // 模板尺寸是明示建议，进入原建仓台后须预览和确认，不能当作用户已指定尺寸。
    const proposed={template:template?.id||'shelf',count:input.count??4,perRow:input.perRow??Math.min(input.count??4,2),aisle:input.aisle??1.2,gap:input.gap??0.3,...input};
    for(const key of ['w','h','d','rows','cols'])if(proposed[key]==null)proposed[key]=(template||rackTemplates[0])[key];
    const suggested=['w','h','d','rows','cols','perRow','aisle','gap'].filter(key=>input[key]==null);
    let plan=null,message=missing.length?'请补充：'+missing.join('、'):'';
    if(!missing.length){try{plan=planQuickBuild(db.getLayout(ctx.room.loc_code),proposed);message=plan.problems.length?plan.problems.join('；'):`预览新增 ${plan.count} 个存放位置、${plan.cellCount} 个格位。请核对尺寸与通道后进入建仓台。`;}catch(error){message=error.message;}}
    return {kind:'setup',input,proposed:{...proposed,roomCode:ctx.room.loc_code},suggested,templates:rackTemplates,plan,ready:!!plan&&!plan.problems.length,message};
  }
  function prepareOpening(ctx,args,req){
    canOperate(ctx);
    const chosen=chooseLocation(ctx,args),selection=choose(ctx,chosen.input,catalogue(ctx,req)),input={...selection.input,loc_code:chosen.loc||chosen.input.loc_code||''},qty=numberValue(input.qty),unit=text(input.unit)||selection.item?.unit||'',reasons=[];
    if(!chosen.loc)reasons.push('请选择一个空格位');
    let snapshot=null;if(chosen.loc){snapshot=work.opening(chosen.loc,req.canAccessLocation);if(snapshot.completed||snapshot.items.length)reasons.push('此格位已有底账或库存，请使用盘点核对实际数量');}
    if(qty===null||qty<=0)reasons.push('请填写大于零的实盘数量');
    if(!text(input.name)&&!text(input.query)&&!selection.item)reasons.push('请填写货品名称');
    if(selection.items.length>1)reasons.push('有多个货品匹配，请选择具体SKU');
    if(!unit)reasons.push('请填写库存单位');
    if(selection.item&&text(input.unit)&&input.unit!==selection.item.unit)reasons.push('请使用已有货品单位 '+selection.item.unit);
    const row={item_id:selection.item?.item_id,name:selection.item?.name||text(input.name)||text(input.query),sku:selection.item?.sku||text(input.sku),qty,unit};
    return {kind:'opening',input:{...input,qty,unit},choices:selection.items,locations:chosen.candidates.map(c=>({loc_code:c.loc_code})),loc_code:chosen.loc,row,baseline:snapshot?.baseline,ready:!reasons.length,message:reasons.join('；')||'建账预览已准备。确认时复用已有SKU，新货品无编号时生成临时SKU。'};
  }
  function recommendLocation(ctx,args,req){
    canOperate(ctx);
    const selection=choose(ctx,args,catalogue(ctx,req)),input=selection.input,qty=numberValue(input.qty),unit=text(input.unit)||selection.item?.unit||'',reasons=[];
    if(!selection.item)reasons.push(selection.items.length?'请选择具体货品':'请提供已有货品名称或SKU');
    if(qty===null||qty<=0)reasons.push('请提供本次存放数量');
    if(selection.item&&unit!==selection.item.unit)reasons.push('请使用库存单位 '+selection.item.unit);
    const result=reasons.length?{candidates:[]}:work.recommend({room:ctx.room.loc_code,item_id:selection.item.item_id,qty,unit,unit_weight:input.unit_weight,from_loc:input.from_loc,start_loc:input.start_loc,entry:input.entry},req.canAccessLocation);
    return {kind:'recommendations',room:ctx.room.loc_code,input:{...input,qty,unit},choices:selection.items,item:selection.item,...result,ready:!reasons.length,message:reasons.join('；')||(result.candidates.length?'请选择存放位置，核对推荐理由和未校验项目。':'当前没有符合已知条件的格位，请检查货品资料、格位条件或通道。')};
  }
  function prepareStocktake(ctx,args){
    if(!ctx.canCount)throw Object.assign(Error('当前账号没有盘点权限'),{status:403});
    const chosen=chooseLocation(ctx,args),rows=ctx.inventory.filter(row=>row.loc_code===chosen.loc),selection=choose(ctx,chosen.input,rows),input={...selection.input,loc_code:chosen.loc||chosen.input.loc_code||''},qty=numberValue(input.actual_qty),reasons=[];
    if(!chosen.loc)reasons.push('请选择一个具体盘点格位');
    if(!selection.item)reasons.push(selection.items.length?'此格位有多个货品，请指定SKU':'请提供该格位的在库货品');
    if(qty===null||qty<0)reasons.push('请提供实际总数量，缺货填0');
    if(selection.item&&text(input.unit)&&input.unit!==selection.item.unit)reasons.push('请核对库存单位 '+selection.item.unit);
    const row=selection.item?{...selection.item,book_qty:selection.item.qty,actual_qty:qty,difference:qty===null?null:Number((qty-selection.item.qty).toFixed(8))}:null;
    return {kind:'stocktake',input:{...input,actual_qty:qty},choices:selection.items,locations:chosen.candidates.map(c=>({loc_code:c.loc_code})),loc_code:chosen.loc,row,external:integrationMode,ready:!reasons.length,message:reasons.join('；')||(integrationMode?'进入ERP盘点差异单核对，并按审核和回传流程处理。':'进入盘点单核对差异，其他货品仍需逐项实盘。')};
  }
  function history(ctx,args,req){
    if(integrationMode)return {kind:'notice',message:'外部库存的数量变动请查看ERP业务流水，当前助手没有完整外部流水，不能推断变化原因。'};
    const query=text(args.query),loc=text(args.loc_hint)||ctx.selectedLoc;
    const candidates=loc?locations(ctx,loc):[],code=candidates.length===1?candidates[0].loc_code:'';
    if(loc&&!code)return {kind:'notice',message:'请指定完整格位码以追溯数量变化。'};
    return readAssistantHistory(db.default,{allowedLocations:ctx.cells.map(c=>c.loc_code),query,loc:code,period:args.period||'today'});
  }
  return {preview_warehouse:previewWarehouse,prepare_opening:prepareOpening,recommend_location:recommendLocation,prepare_stocktake:prepareStocktake,movement_history:history};
}
