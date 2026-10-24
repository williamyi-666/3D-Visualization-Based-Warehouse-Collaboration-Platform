import {createWorkDialog,drawQuickBuildPreview} from './warehouse-work-ui.mjs';
import {workApi} from './work-request.mjs';
import {scanFieldCode} from './scan-code-ui.mjs';
import {parseWarehouseCode} from './warehouse-code.mjs';

const el=(tag,text)=>{const node=document.createElement(tag);if(text!=null)node.textContent=text;return node;};
const button=(text,action)=>{const node=el('button',text);node.type='button';node.onclick=action;return node;};
let lastScan='';
window.addEventListener('spatial-auth-required',()=>{lastScan='';});
export async function openRoutePreview({room,locations,onShow,locate}){
  const options=await workApi('/api/work/route-options?room='+encodeURIComponent(room));
  const panel=createWorkDialog('取货路线'),{body,root,run}=panel;
  const form=el('div');form.className='work-grid';body.append(form);
  const label=el('label','从哪里出发'),start=el('select');start.setAttribute('aria-label','路线起点');label.append(start);form.append(label);
  const recent=options.locations.some(v=>v.loc_code===lastScan)?[{value:'loc:'+lastScan,label:'最近扫码 · '+lastScan}]:[];
  for(const row of [{value:'',label:'请选择起点'},...recent,...options.entrances.map(v=>({value:'entry:'+v.index,label:v.label})),...options.locations.map(v=>({value:'loc:'+v.loc_code,label:'格位附近 · '+v.loc_code}))]){const opt=el('option',row.label);opt.value=row.value;start.append(opt);}
  if(options.entrances.length)start.value='entry:'+options.entrances[0].index;
  const widthLabel=el('label','每侧通行余量（米）'),width=el('input');width.type='number';width.min='.1';width.max='1.5';width.step='.05';width.value='.25';width.setAttribute('aria-label','每侧通行余量（米）');widthLabel.append(width);form.append(widthLabel);
  const content=el('section'),controls=el('div');controls.className='work-actions';
  const calculate=button('规划路线',()=>run(plan));calculate.className='primary';controls.append(calculate);body.append(controls,content);
  controls.append(button('扫描当前位置格位',()=>run(async()=>{
    const raw=await scanFieldCode('扫描当前位置格位');if(!raw)return;
    const target=options.locations.some(v=>v.loc_code===raw)?raw:parseWarehouseCode(raw,location.origin).loc;
    if(!target)throw Error('请扫描格位码，货品码不能确定当前位置');
    const snapshot=await workApi('/api/work/opening?loc_code='+encodeURIComponent(target));
    if(!options.locations.some(v=>v.loc_code===snapshot.loc_code))throw Error('扫码格位不属于当前库区');
    lastScan=snapshot.loc_code;start.value='loc:'+lastScan;await plan();
  })));
  const hint=el('p','起点使用入口或你指定的格位附近；最近扫码可选，不代表人员实时位置。');hint.className='work-hint';body.insertBefore(hint,controls);
  let generation=0;
  const invalidate=()=>{generation++;content.replaceChildren(el('p','起点或通行余量已调整，请重新规划路线。'));};start.onchange=width.oninput=invalidate;
  async function plan(){
    if(!start.value)throw Error('请选择入口或当前所在格位附近作为起点');
    const current=++generation,origin=start.value.split(':'),query=new URLSearchParams({room,locations:[...new Set(locations)].join(','),revision:options.layout.revision,clearance:width.value,...(origin[0]==='entry'?{entry:origin[1]}:{start_loc:origin.slice(1).join(':')})});
    calculate.disabled=true;content.replaceChildren(el('p','正在按当前布局规划…'));
    try{
      const route=await workApi('/api/work/route?'+query);if(current!==generation||!root.isConnected)return;
      content.replaceChildren(el('h3',`可到达 ${route.stops.length} 处 · 约 ${route.distance.toFixed(1)} 米`),el('p',route.origin.label));
      const svg=document.createElementNS('http://www.w3.org/2000/svg','svg');svg.classList.add('work-preview');svg.setAttribute('aria-label','取货通道路线预览');content.append(svg);
      drawQuickBuildPreview(svg,{...options.layout,existing:options.layout.furniture,furniture:[],problems:[]});
      const ns=svg.namespaceURI,line=document.createElementNS(ns,'polyline');line.setAttribute('points',route.points.map(p=>`${p.x},${p.z}`).join(' '));line.setAttribute('fill','none');line.setAttribute('stroke','#45c6ff');line.setAttribute('stroke-width','.09');svg.append(line);
      for(const stop of route.stops){const marker=document.createElementNS(ns,'text');marker.setAttribute('x',String(stop.point.x));marker.setAttribute('y',String(stop.point.z-.12));marker.setAttribute('fill','#fff');marker.setAttribute('font-size','.38');marker.setAttribute('text-anchor','middle');marker.textContent=String(stop.index);svg.append(marker);}
      if(route.unreachable.length){const warning=el('p','以下格位未找到通路，请核对摆放或通行余量：'+route.unreachable.join('、'));warning.className='work-message';content.append(warning);}
      for(const note of route.warnings){const p=el('p',note);p.className='work-hint';content.append(p);}
      for(const stop of route.stops){const row=el('div');row.className='work-row';row.append(el('strong',`${stop.index}. ${stop.loc_code}`),el('small',`从上一处约 ${stop.distance.toFixed(1)} 米`));if(locate)row.append(button('查看此格位',()=>run(async()=>{await locate(stop.loc_code);root.close();})));content.append(row);}
      if(route.stops.length&&onShow){const show=button('在3D中显示路线',()=>run(async()=>{await onShow(route);root.close();}));show.className='primary';content.prepend(show);}
    }finally{calculate.disabled=false;}
  }
  if(start.value)await run(plan);return panel;
}
