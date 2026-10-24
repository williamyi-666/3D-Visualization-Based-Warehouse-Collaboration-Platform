import {matchesInventoryQuery} from './inventory-query.mjs';
import {assistantActionsSchema,createAssistantActions} from './assistant-actions.mjs';
import {guideTopics,setupProgress,platformGuide} from './assistant-guidance.mjs';
import {workAttention} from './work-attention.mjs';

export const assistantToolSchema=[
  {type:'function',function:{name:'prepare_batch',description:'把用户明确提出的多项入库、出库、移库需求整理成待核对清单，不执行数量变更；缺少的数量或位置留空。',parameters:{type:'object',properties:{operations:{type:'array',minItems:1,maxItems:20,items:{type:'object',properties:{operation:{type:'string',enum:['in','out','move']},query:{type:'string'},qty:{type:'number'},unit:{type:'string'},from_hint:{type:'string'},to_hint:{type:'string'}},required:['operation','query'],additionalProperties:false}}},required:['operations'],additionalProperties:false}}},
  {type:'function',function:{name:'update_job',description:'修改当前清单中选中的一项，仅返回用户明确修改的字段，不执行库存变更。第几项由程序从原话核对。',parameters:{type:'object',properties:{operation:{type:'string',enum:['in','out','move']},query:{type:'string'},qty:{type:'number'},unit:{type:'string'},from_hint:{type:'string'},to_hint:{type:'string'}},additionalProperties:false}}},
  {type:'function',function:{name:'setup_progress',description:'查看当前库区从空间配置到建账的真实进度，告诉用户下一步。',parameters:{type:'object',properties:{},additionalProperties:false}}},
  {type:'function',function:{name:'platform_guide',description:'用户问平台功能在哪里或怎么操作时，提供具体按钮和表单指引。',parameters:{type:'object',properties:{topic:{type:'string',enum:guideTopics}},required:['topic'],additionalProperties:false}}},
  {type:'function',function:{name:'find_stock',description:'查询真实库存。query填写用户说出的SKU、规格号或有辨识度的货品名称，保留材质、用途等限定词。例如不锈钢螺母保留为不锈钢螺母，不缩成螺母；6204轴承可用6204。不包括在哪里等问句。',parameters:{type:'object',properties:{query:{type:'string'}},required:['query'],additionalProperties:false}}},
  {type:'function',function:{name:'list_tasks',description:'查看待办。问盘点时kind=count，问未完成单据时kind=draft，问低库存时kind=low；其余为all。',parameters:{type:'object',properties:{kind:{type:'string',enum:['all','count','draft','low']}},additionalProperties:false}}},
  {type:'function',function:{name:'prepare_operation',description:'按用户明确给出的数量和位置生成入库、出库或移库草稿，不执行库存变更。没有数量或位置时不猜测，保留空值。',parameters:{type:'object',properties:{operation:{type:'string',enum:['in','out','move']},query:{type:'string',description:'货品SKU或短关键词'},qty:{type:'number',description:'用户明确说的数量'},unit:{type:'string',description:'用户明确说的单位'},from_hint:{type:'string',description:'源格位完整编码或货架简称，例如A架'},to_hint:{type:'string',description:'目标格位完整编码或货架简称，例如B架'}},required:['operation','query'],additionalProperties:false}}},
];
assistantToolSchema.push(...assistantActionsSchema);

export function assistantPrompt(roomName,canOperate,state={}) {
  return `你是仓储平台的业务助手。用工具查真实数据，不猜库存、位置和数量。当前库区名称为${JSON.stringify(roomName)}，货架简称默认指当前库区，完整格位码可跨库区。
用户问货品在哪里、还有多少时调用find_stock；问盘点或待办时调用list_tasks；请求入库、出库、搬移时调用prepare_operation。查货保留用户明确给出的货品限定词或规格号，不能把具体货名泛化成同类名称；例如“不锈钢螺母”查询“不锈钢螺母”，不能只查询“螺母”。用户仅说“轴承”时才查询“轴承”。中文数字转换为数字，但绝不补充用户未指定的数量、单位或位置。用户明确说了单位必须填写unit，例如“3套”填写qty=3、unit="套”，“3箱”填写qty=3、unit="箱"。
用户提出多项入库、出库、移库时调用prepare_batch，operations每项只放用户明确提出的需求。修改已打开清单的某一项用update_job，只填写修改字段，不重复创建清单。不确定数量、货品或位置时留空，让使用者核对。
建仓和布置货架用preview_warehouse；首次建立底账用prepare_opening；推荐放哪里用recommend_location；实盘实际总数量用prepare_stocktake；追溯数量变化、查流水用movement_history。“修改数量”“每排2架”等补充上一次请求用update_request，只填写修改项。模板默认尺寸仅是建议，用户明确给的参数须保留。不要把盘点实际总数转换为入库或出库增量。
多个匹配由使用者选择，不替使用者做选择。工具只是查询和生成草稿，所有数量变化必须由使用者在原作业台核对确认。当前账号${canOperate?'可以办理库存作业':'不能办理本地库存数量变更'}。
程序核对后的当前场景和待确认请求：${JSON.stringify(state)}。只使用这里的货品与位置ID；“这里”“这批”留空，由程序引用已选上下文。缺信息时调用工具返回待补充项，不猜测。`;
}

const text=value=>typeof value==='string'?value.trim():'';
const normalHint=value=>text(value).toUpperCase().replace(/^(?:货架|架子)\s*/,'').replace(/\s*(?:货架|架子|架)$/,'');

export function createAssistantTools({db,work,readInventory,teamTasks,integrationMode=false}) {
  async function context(req) {
    const room=work.room(req.body.room,req.canAccessLocation);
    const allCells=db.getCells().filter(c=>!req.canAccessLocation||req.canAccessLocation(c.loc_code));
    const valid=new Set(allCells.map(c=>c.loc_code));
    const inventory=(await readInventory(req)).map(row=>integrationMode?{...row,item_id:row.id}:row).filter(row=>!row.loc_code||valid.has(row.loc_code));
    const rooms=db.listRooms().filter(r=>!req.canAccessLocation||req.canAccessLocation(r.loc_code));
    const roomByCode=new Map(rooms.map(r=>[r.loc_code,r]));
    const rackByCode=new Map();
    for(const r of rooms)for(const rack of db.getLayout(r.loc_code).furniture)rackByCode.set(rack.code,{...rack,roomCode:r.loc_code,roomName:r.name});
    const cells=allCells.map(c=>{const rack=rackByCode.get(c.loc_code.split('-').slice(0,-2).join('-'));return {...c,rack,roomCode:rack?.roomCode};});
    const selectedLoc=text(req.body.context?.loc_code),selection=inventory.filter(row=>row.loc_code===selectedLoc),itemId=text(req.body.context?.item_id);
    if(selectedLoc&&!allCells.some(c=>c.loc_code===selectedLoc))throw Object.assign(Error('选中格位已不存在或没有访问权限'),{status:403});
    const selectedItem=itemId?selection.find(row=>row.item_id===itemId):selection.length===1?selection[0]:null;
    const layout=db.getLayout(room.loc_code);
    return {room,roomDimensions:layout.room,roomFurniture:layout.furniture,view:['warehouse','work','records'].includes(req.body.context?.view)?req.body.context.view:'warehouse',cells,inventory,roomByCode,selectedLoc,selectedItem,selection,canManage:['admin','spaceAdmin'].includes(req.user.role),canCount:['admin','operator'].includes(req.user.role),canOperate:!integrationMode&&['admin','operator'].includes(req.user.role)};
  }
  function matchingItems(rows,query,itemId) {
    if(itemId)return rows.filter(row=>row.item_id===itemId);
    if(!query)return [];
    const linked=!integrationMode?db.getItemByCode(query):null;
    return linked?rows.filter(row=>row.item_id===linked.item_id):rows.filter(row=>matchesInventoryQuery(row,query,['name','sku','erp_code','loc_code']));
  }
  function locations(ctx,hint,explicit) {
    const full=text(explicit)||text(hint),canonical=full?db.resolveCellCode(full):'';
    const exact=ctx.cells.filter(c=>c.loc_code.toUpperCase()===canonical.toUpperCase());
    if(exact.length)return exact;
    const candidates=ctx.cells.filter(c=>c.roomCode===ctx.room.loc_code);
    if(!full)return candidates;
    const simple=normalHint(full);
    return candidates.filter(c=>c.rack&&[c.rack.code,c.rack.label,c.rack.code.split('-').at(-1)].some(name=>normalHint(name)===simple));
  }
  function stockResult(ctx,query) {
    if(!query||query.length>100)throw Error('请说明要查询的货品名称或SKU');
    const rows=matchingItems(ctx.inventory,query).map(row=>({item_id:row.item_id,name:row.name,sku:row.sku||'',qty:row.qty,unit:row.unit||'件',loc_code:row.loc_code||'',source:row.source||'',room_name:ctx.roomByCode.get(row.loc_code?.split('-').slice(0,-3).join('-'))?.name||''}));
    return {kind:'stock',query,total:rows.length,rows:rows.slice(0,30),retryable:!rows.length,message:rows.length?'点击格位可在3D中定位。':'没有匹配的库存，请换一个SKU或较短的名称关键词。'};
  }
  function prepare(ctx,args,req) {
    if(!ctx.canOperate)throw Object.assign(Error(integrationMode?'当前库存由ERP维护，可查询位置；数量变更请进入对应业务系统。':'当前账号没有库存操作权限。'),{status:403});
    args={...args};
    if(!text(args.query)&&!text(args.item_id)&&ctx.selectedItem)args.item_id=ctx.selectedItem.item_id;
    if(args.operation!=='in'&&!text(args.from_hint)&&!text(args.from_loc)&&ctx.selectedLoc)args.from_loc=ctx.selectedLoc;
    if(args.operation==='in'&&!text(args.to_hint)&&!text(args.to_loc)&&ctx.selectedLoc)args.to_loc=ctx.selectedLoc;
    const operation=args.operation,query=text(args.query);
    if(!['in','out','move'].includes(operation))throw Error('请选择入库、出库或移库');
    const qty=typeof args.qty==='number'&&Number.isFinite(args.qty)&&args.qty>0?args.qty:null;
    const sources=locations(ctx,args.from_hint,args.from_loc),targets=locations(ctx,args.to_hint,args.to_loc);
    const sourceCodes=new Set(sources.map(c=>c.loc_code));
    const catalogue=operation==='in'?[...new Map([...work.catalogue(ctx.room.loc_code,req.canAccessLocation,req.user),...ctx.inventory].map(row=>[row.item_id,row])).values()]:ctx.inventory;
    let items=matchingItems(catalogue,query,text(args.item_id));
    if(operation!=='in'&&(text(args.from_hint)||text(args.from_loc)))items=items.filter(i=>sourceCodes.has(i.loc_code));
    const choices=items.map(i=>({item_id:i.item_id,name:i.name,sku:i.sku||'',unit:i.unit||'件',qty:i.qty,loc_code:i.loc_code||''}));
    const destination=operation==='out'?[]:targets.map(c=>({loc_code:c.loc_code,name:c.name,room_name:c.rack?.roomName||''}));
    const item=choices.length===1?choices[0]:null,to=destination.length===1?destination[0].loc_code:'';
    let message='请核对草稿，再打开作业台确认。';
    const reasons=[];
    if(!choices.length)reasons.push(operation==='in'?'未找到当前库区已有货品，可通过入库台登记新货品':'没有匹配的在库货品，请补充SKU或源格位');
    else if(!item)reasons.push('有多个匹配，请选择具体货品和源格位');
    if(!qty)reasons.push('请填写本次办理的数量');
    if(operation!=='out'&&!to)reasons.push(destination.length?'请选择具体目标格位':'没有匹配的目标格位，请填写完整格位码');
    if(item&&text(args.unit)&&text(args.unit)!==item.unit)reasons.push(`库存单位为${item.unit}，请核对数量单位`);
    if(item&&qty&&operation!=='in'&&qty>item.qty)reasons.push(`源格位仅有 ${item.qty} ${item.unit}，请调整数量`);
    if(item&&to&&item.loc_code===to&&operation==='move')reasons.push('源格位与目标格位不能相同');
    if(reasons.length)message=reasons.join('；');
    const draft=item?{operation,item_id:item.item_id,itemCode:item.sku||item.item_id,name:item.name,unit:item.unit,qty,from_loc:operation==='in'?'':item.loc_code,to_loc:to,loc:operation==='in'?to:item.loc_code}:null;
    return {kind:'draft',operation,input:{...args,operation,query,qty,unit:text(args.unit)||item?.unit||'',from_hint:text(args.from_hint),to_hint:text(args.to_hint),...(item?{item_id:item.item_id,from_loc:item.loc_code}:{}),...(to?{to_loc:to}:{})},choices,destinations:destination,ready:!reasons.length,draft,message};
  }
  const actions=createAssistantActions({db,work,matchingItems,locations,integrationMode});
  async function run(name,args,req) {
    const ctx=await context(req);
    if(name==='setup_progress')return setupProgress(ctx,integrationMode?null:work.progress(ctx.room.loc_code,req.canAccessLocation),{integrationMode});
    if(name==='platform_guide')return platformGuide(ctx,args.topic);
    if(name==='find_stock')return stockResult(ctx,text(args.query)||ctx.selectedItem?.sku||ctx.selectedItem?.name||'');
    if(name==='list_tasks') {
      if(integrationMode)return {kind:'notice',message:'ERP协同模式的盘点审核和回传任务，请在盘点差异单中查看。'};
      const tasks=work.tasks(ctx.room.loc_code,req.canAccessLocation,req.user),scope=['count','draft','low'].includes(args.kind)?args.kind:'all';
      const team=teamTasks&&ctx.canOperate?teamTasks.list({...req,query:{room:ctx.room.loc_code,filter:req.user.role==='admin'?'pending':'mine'}}):null;
      const rows=workAttention(tasks,team).filter(row=>scope==='all'||(scope==='count'?['count','draft','review'].includes(row.kind):row.kind===scope));
      return {kind:'tasks',rows,total:rows.length,scope};
    }
    if(name==='prepare_operation')return prepare(ctx,args,req);
    if(actions[name])return actions[name](ctx,args,req);
    throw Error('不支持的助手工具');
  }
  return {context,run};
}
