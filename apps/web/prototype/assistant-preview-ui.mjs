import {drawQuickBuildPreview} from './warehouse-work-ui.mjs';
import {formatBusinessTime} from './business-time.mjs';
import {openItemStorage,appendStorageReasons} from './item-storage-ui.mjs';

const el=(tag,text,className)=>{const n=document.createElement(tag);if(text!=null)n.textContent=text;if(className)n.className=className;return n;};
const qty=field=>field.value.trim()===''?null:Number(field.value);
export function renderAssistantPreview(card,result,{button,input,select,run,preview,minimize,openQuickBuild,openOpening,openCount,openCounter,locate}){
  const titles={setup:'建仓摆放预览',opening:'首次建账预览',recommendations:'推荐存放位置',stocktake:'实盘数量预览',history:'库存流水追溯'};
  card.replaceChildren(el('strong',titles[result.kind]),el('p',result.message,'work-hint'));
  if(result.kind==='history'){
    card.append(el('small',`${{today:'今天',week:'近7天',month:'近30天',all:'全部历史'}[result.period]} · ${result.loc_code||'可访问格位'} · ${result.query||'全部货品'} · 上海时区`));
    for(const summary of result.summary||[])card.append(el('p',`记录入账 ${summary.incoming} · 出账 ${summary.outgoing} · 净变化 ${summary.net} ${summary.unit}`,'work-receipt'));
    const types={inbound:'入库',outbound:'出库',move:'移库',transfer:'移库',opening:'期初建账',stocktake:'盘点调账',erp_sync:'ERP同步'};
    for(const row of result.rows){const line=el('div',undefined,'work-row');line.append(el('strong',`${types[row.move_type]||row.move_type} · ${row.name||'历史货品'}`),el('p',`${row.qty} ${row.unit||'单位未记录'} · ${row.from_loc||'外部'} → ${row.to_loc||'外部'}`),el('small',`${formatBusinessTime(row.occurred_at,'Asia/Shanghai')} · ${row.actor_name||'操作人未记录'}`));card.append(line);}
    return;
  }
  const form=el('div',undefined,'work-grid'),footer=el('div',undefined,'work-actions');card.append(form);
  const field=(title,value,type='text')=>{const box=el('div');form.append(box);return input(box,title,value,type);};
  const choice=(title,items)=>{const box=el('div');form.append(box);return select(box,title,items);};
  let read,open;const submits=[];
  if(result.kind==='setup'){
    const t=choice('存放模板',result.templates.map(t=>[t.id,t.name]));t.value=result.input.template||'';
    const fields={count:field('新增数量',result.input.count??'','number')};
    for(const [key,title] of [['w','宽（米）'],['h','高（米）'],['d','深（米）'],['rows','层数'],['cols','每层格位数'],['perRow','每排数量'],['aisle','通道（米）'],['gap','相邻间距（米）']])fields[key]=field(title,result.proposed[key],'number');
    const startX=field('起始X（留空自动居中）',result.input.startX??'','number'),startZ=field('起始Z（留空自动居中）',result.input.startZ??'','number');
    t.onchange=()=>{const template=result.templates.find(v=>v.id===t.value);if(template)for(const key of ['w','h','d','rows','cols'])fields[key].value=template[key];};
    if(result.suggested.length)card.append(el('p','未指定的尺寸、排布和通道采用模板建议，请按现场条件核对。','work-hint'));
    if(result.plan){const svg=document.createElementNS('http://www.w3.org/2000/svg','svg');svg.classList.add('work-preview');svg.setAttribute('aria-label','建仓摆放预览');card.append(svg);drawQuickBuildPreview(svg,result.plan);}
    read=()=>({template:t.value,...Object.fromEntries(Object.entries(fields).map(([k,f])=>[k,qty(f)])),...(startX.value!==''?{startX:qty(startX)}:{}),...(startZ.value!==''?{startZ:qty(startZ)}:{})});
    open=button(result.ready?'打开建仓台核对':'打开建仓台调整',()=>run(async()=>{minimize();await openQuickBuild(result.proposed);}),true);open.disabled=!result.plan;
  }else{
    const items=result.choices||[],item=choice('货品',items.map(i=>[i.item_id,[i.name,i.sku||'未编号',i.source,i.batch_no].filter(Boolean).join(' · ')]));if(result.input.item_id)item.value=result.input.item_id;
    const name=field('货品名称 / SKU',result.kind==='opening'?result.row.name:result.input.query||result.row?.name||result.item?.name||''),amount=field(result.kind==='stocktake'?'实际总数量':'数量',result.kind==='stocktake'?result.input.actual_qty:result.input.qty,'number'),unit=field('单位',result.input.unit||result.row?.unit||result.item?.unit||'');
    name.addEventListener('input',()=>{item.value='';});
    item.onchange=()=>{const selected=items.find(i=>i.item_id===item.value);if(selected){name.value=selected.name;unit.value=selected.unit||'';}};
    let location,sku,reason,weight,startLoc;
    if(result.locations){location=choice('格位',result.locations.map(c=>[c.loc_code,c.loc_code]));if(result.loc_code)location.value=result.loc_code;}
    if(result.kind==='opening')sku=field('SKU（无编号可留空）',result.row?.sku||'');
    if(result.kind==='stocktake')reason=field('盘点说明',result.input.reason||'');
    if(result.kind==='recommendations'){weight=field('本次单位重量（kg，留空用资料）',result.input.unit_weight??'','number');startLoc=field('搬运起点格位（留空使用入口）',result.input.start_loc||'');if(result.item)card.append(button('查看 / 修改货品存放资料',()=>run(async()=>{minimize();await openItemStorage({itemId:result.item.item_id,room:result.room,locate,openCounter});})));}
    read=()=>({...result.input,query:name.value.trim(),...(result.kind==='opening'?{name:name.value.trim()}:{}),item_id:item.value||undefined,unit:unit.value.trim(),...(location?{loc_code:location.value}:{}),...(result.kind==='stocktake'?{actual_qty:qty(amount),reason:reason.value.trim()}:{qty:qty(amount)}),...(sku?{sku:sku.value.trim()}:{}),...(weight?{unit_weight:qty(weight),start_loc:startLoc.value.trim()}:{})});
    if(result.kind==='opening'){
      card.append(el('p',result.row.sku?`${result.row.name} · ${result.row.sku}`:'新货品无编号时，确认建账后生成临时SKU。','work-hint'));
      open=button('打开建账台核对',()=>run(async()=>{minimize();await openOpening(result.loc_code,{row:result.row});}),true);open.disabled=!result.ready;
    }else if(result.kind==='stocktake'){
      if(result.row)card.append(el('p',`账面 ${result.row.book_qty} → 实盘 ${result.row.actual_qty??'待填写'} · 差异 ${result.row.difference??'待填写'} ${result.row.unit}`,'work-receipt'));
      open=button('打开盘点单核对',()=>run(async()=>{minimize();await openCount(result.loc_code,{prefill:{counts:[{item_id:result.row.item_id,qty:result.row.actual_qty}],reason:result.input.reason||'',source:result.row.source},external:result.external});}),true);open.disabled=!result.ready;
    }else{
      for(const candidate of result.candidates){const line=el('div',undefined,'work-row');line.append(el('strong',candidate.loc_code));appendStorageReasons(line,candidate);
        const submit=button('在此格位入库',()=>run(async()=>{const fresh=await preview('recommendations',result.input);if(fresh.layout_revision!==result.layout_revision||JSON.stringify(fresh.profile)!==JSON.stringify(result.profile)||!fresh.candidates.some(row=>row.loc_code===candidate.loc_code))throw Error('库存、资料或布局已变化，请更新预览后重新核对');minimize();await openCounter(candidate.loc_code,'in',{itemCode:result.item.sku||result.item.item_id,draft:{item_id:result.item.item_id,name:result.item.name,qty:result.input.qty,unit:result.input.unit,to_loc:candidate.loc_code}});}),true);submits.push(submit);
        line.append(button('3D定位',()=>run(async()=>{minimize();await locate(candidate.loc_code);})),submit);card.append(line);
      }
    }
  }
  footer.append(button('更新预览',()=>run(async()=>renderAssistantPreview(card,await preview(result.kind,read()),{button,input,select,run,preview,minimize,openQuickBuild,openOpening,openCount,openCounter,locate}))));
  if(open){footer.append(open);submits.push(open);}card.append(footer);
  form.addEventListener('input',()=>{for(const b of submits)b.disabled=true;});
}
