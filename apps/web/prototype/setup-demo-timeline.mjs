// 演示时钟是唯一状态来源，暂停、重播和跳转均可完整还原；不连接业务接口。
export const SETUP_DEMO_DURATION=50;
export const SETUP_SAMPLE=Object.freeze({room:'样板库区',width:12,depth:8,height:4,rack:'A货架',rackWidth:1.2,rackHeight:2,rackDepth:0.5,rows:3,cols:4,loc:'DEMO-A-L02-B02',item:'深沟球轴承6204',sku:'DEMO-6204',qty:24});
export const SETUP_CHAPTERS=[
  {title:'设置空间',help:'按现场测量填写，单位为米。宽 × 深得到库区面积，确定可用空间。',start:0,preview:8.5,caption:'① 先按现场尺寸建立库区，形成仓库的空间范围。',fields:[['roomName','库区名称','样板库区',1,3],['roomWidth','宽（米）','12',3.5,4.5],['roomDepth','深（米）','8',5,6],['roomHeight','高（米）','4',6.5,7.5]],action:'应用尺寸'},
  {title:'生成货架',help:'尺寸按实物填写；层数 × 每层列数生成格位。格位码对应货架、层和列。',start:10,preview:21.5,caption:'② 填写货架尺寸和层列，自动划分存放格位。',fields:[['rackName','货架名称','A货架',10.5,12],['rackWidth','宽（米）','1.2',12.2,13.2],['rackDepth','深（米）','0.5',13.5,14.5],['rackHeight','高（米）','2',15,16],['rackRows','层数','3',16.5,17.5],['rackCols','每层列数','4',18,19]],action:'生成货架'},
  {title:'摆放货架',help:'拖动到实际位置，留出人行和搬运通道；保存布局后才正式生效。',start:23,preview:30.8,caption:'③ 拖动货架到实际位置，留好通道，核对后保存布局。',fields:[['positionX','位置 X（米）','',0,0],['positionZ','位置 Z（米）','',0,0]],action:'保存布局'},
  {title:'关联货品',help:'先选格位，再登记货品和数量。L02-B02表示第2层第2格；SKU是货品编号，可后补。',start:32,preview:40.5,caption:'④ 将货品、SKU和数量登记到格位，让实物与空间对应。',fields:[['stockLoc','存放格位','DEMO-A-L02-B02',32.5,34],['stockName','货品名称','深沟球轴承6204',34,35.5],['stockSku','SKU','DEMO-6204',35.5,37],['stockQty','数量（套）','24',37.5,39]],action:'登记示例库存'},
  {title:'查询定位',help:'按名称或SKU查找，点击结果定位，再核对高亮格位的货品、数量和位置。',start:42,preview:48.5,caption:'⑤ 搜索货品，镜头定位到格位，同时查看名称、数量和位置。',fields:[['query','名称 / SKU','6204',42.3,43.5]],action:'搜索定位'}
];
const clamp=value=>Math.max(0,Math.min(1,value));
export const smoothDemo=(time,start,end)=>{const t=clamp((time-start)/(end-start));return t*t*(3-2*t);};
export function setupDemoState(time) {
  const seconds=Math.max(0,Math.min(SETUP_DEMO_DURATION,Number(time)||0));
  const chapter=SETUP_CHAPTERS.findLastIndex(chapter=>seconds>=chapter.start),current=SETUP_CHAPTERS[chapter];
  const values=Object.fromEntries(current.fields.map(([id,,value,start,end])=>[id,end<=start?value:seconds<start?'':value.slice(0,Math.ceil(value.length*clamp((seconds-start)/(end-start))))]));
  const move=smoothDemo(seconds,24,29),x=-2.4*move,z=-1.2*move;
  if(chapter===2){values.positionX=x.toFixed(2);values.positionZ=z.toFixed(2);}
  const active=current.fields.find(([, , ,start,end])=>seconds>=start&&seconds<end)?.[0];
  return {seconds,chapter,values,active,x,z,roomVisible:seconds>=8,rackVisible:seconds>=21,layoutSaved:seconds>=30.5,stocked:seconds>=40,
    results:seconds>=44,selected:seconds>=45.5,done:seconds>=SETUP_DEMO_DURATION,
    actionActive:[8,20,30,39.5,43.7].some(start=>seconds>=start&&seconds<start+0.8),
    dragging:seconds>=24&&seconds<29};
}
