import {placementError} from './layout-geometry.mjs';

export const rackTemplates = [
  {id:'shelf',name:'轻型货架',type:'shelf',w:1.2,h:1.8,d:0.5,rows:4,cols:3},
  {id:'rack',name:'横梁货架',type:'rack',w:2.4,h:3,d:1,rows:3,cols:2},
  {id:'floor',name:'地面存放区',type:'floor',w:2,h:0.05,d:2,rows:2,cols:2},
];

// 只生成摆放计划，不保存；预览和提交使用同一算法。
export function planQuickBuild(layout,input={}) {
  const template=rackTemplates.find(t=>t.id===input.template);
  if(!template)throw Error('请选择货架模板');
  const spec={...template};
  for(const key of ['w','h','d','rows','cols'])spec[key]=Number(input[key]??template[key]);
  for(const key of ['w','h','d'])if(!Number.isFinite(spec[key])||spec[key]<=0)throw Error('尺寸须大于零');
  for(const key of ['rows','cols'])if(!Number.isInteger(spec[key])||spec[key]<1||spec[key]>20)throw Error('层数、列数须为1至20');
  if(spec.type==='floor')spec.h=0.05;
  const count=Number(input.count),perRow=Number(input.perRow),aisle=Number(input.aisle),gap=Number(input.gap??0.3);
  if(!Number.isInteger(count)||count<1||count>30||count*spec.rows*spec.cols>5000)throw Error('单批1至30个，最多生成5000个格位');
  if(!Number.isInteger(perRow)||perRow<1||perRow>count)throw Error('每排数量须为1至总数量');
  if(!Number.isFinite(aisle)||aisle<0.6||!Number.isFinite(gap)||gap<0)throw Error('排间通道至少0.6米，相邻间距不能为负');
  if(spec.h>layout.room.height)throw Error('货架高于库区');
  const across=Math.min(count,perRow),lines=Math.ceil(count/perRow);
  const width=across*spec.w+(across-1)*gap,depth=lines*spec.d+(lines-1)*aisle;
  const startX=input.startX==null?-width/2+spec.w/2:Number(input.startX);
  const startZ=input.startZ==null?-depth/2+spec.d/2:Number(input.startZ);
  if(!Number.isFinite(startX)||!Number.isFinite(startZ))throw Error('起始坐标须为数字');
  const furniture=[],problems=[];
  for(let index=0;index<count;index++) {
    const f={...spec,code:'preview-'+index,x:startX+(index%perRow)*(spec.w+gap),z:startZ+Math.floor(index/perRow)*(spec.d+aisle),rot:0};
    const problem=placementError(f,layout.room,[...layout.furniture,...furniture]);
    if(problem)problems.push(`第${index+1}个：${problem}`);
    furniture.push(f);
  }
  return {roomCode:layout.roomCode,revision:layout.revision,room:layout.room,existing:layout.furniture,furniture,spec,count,cellCount:count*spec.rows*spec.cols,problems};
}
