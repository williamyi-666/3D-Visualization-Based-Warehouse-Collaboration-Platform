export const guideTopics=['room','layout','openings','model','cells','labels','opening','operations'];

// 明确的产品指引直接读取真实状态；模型未加载时也能使用。
export function guideRequest(message) {
  if(/(?:开始|首次|第一次)使用|还需要配置|建仓进度|继续搭建|快速落地|货架.*(?:建好|完成).*(?:下一步|接下来)|下一步(?:做什么|怎么做|是什么)?[？?。!！]*$/.test(message))return {name:'setup_progress',args:{}};
  if(!/怎么|如何|哪里|在哪|指引|指导|教我|带我|打开/.test(message))return null;
  const topics=[['openings',/门窗|(?:添加|放置|设置).*(?:门|窗)|(?:门|窗).*(?:添加|放置|设置)/],['model',/模型|blender|glb/i],['room',/(?:新建|设置|切换|选择).*库区|库区.*(?:设置|尺寸|新建|切换)|仓库尺寸/],['layout',/摆放|布局|(?:添加|建立|生成).*货架|货架.*(?:添加|建立|生成)/],['labels',/标签|二维码/],['cells',/格位.*(?:管理|属性|容量|承重)/],['opening',/建账|底账/],['operations',/入库|出库|移库/]];
  const match=topics.find(([,pattern])=>pattern.test(message));
  return match?{name:'platform_guide',args:{topic:match[0]}}:null;
}

export function setupProgress(ctx,progress,{integrationMode=false}={}) {
  const rackCount=ctx.roomFurniture.length,cells=ctx.cells.filter(c=>c.roomCode===ctx.room.loc_code);
  const populated=new Set(ctx.inventory.filter(row=>row.loc_code?.startsWith(ctx.room.loc_code+'-')).map(row=>row.loc_code));
  const dimensions=ctx.roomDimensions,completed=integrationMode?populated.size:progress.completed,total=integrationMode?cells.length:progress.total;
  const steps=[
    {id:'room',title:'确认库区尺寸',done:dimensions.width>0&&dimensions.depth>0,detail:`${dimensions.width} × ${dimensions.depth} 米`,action:'room',allowed:ctx.canManage},
    {id:'layout',title:'布置货架与存放区',done:rackCount>0,detail:`已有 ${rackCount} 个存放位置`,action:'quickBuild',allowed:ctx.canManage},
    {id:'cells',title:'生成并核对格位',done:cells.length>0,detail:`已有 ${cells.length} 个格位`,action:rackCount?'cells':'quickBuild',allowed:ctx.canManage},
    {id:'labels',title:'准备格位标签',optional:true,detail:'按需打印并粘贴到现场；打开页面不代表已经打印。',action:'labels',allowed:cells.length>0},
    {id:'opening',title:integrationMode?'核对库存关联':'建立现场底账',done:total>0&&completed===total,detail:integrationMode?`${completed} 个格位已有外部库存关联`:`已核对 ${completed} / ${total} 个格位（包含确认空位）`,action:integrationMode?'integration':'opening',allowed:integrationMode?ctx.canManage:ctx.canOperate},
  ];
  const required=steps.filter(s=>!s.optional),next=required.find(s=>!s.done);
  return {kind:'setup_progress',room:{code:ctx.room.loc_code,name:ctx.room.name},steps,completed:required.filter(s=>s.done).length,total:required.length,next:next?.id||'',next_loc:progress?.rows.find(r=>!r.completed)?.loc_code||'',message:next?`下一步：${next.title}。已完成的配置会保留。`:'当前库区起步配置已完成，可以开始日常作业。'};
}

export function platformGuide(ctx,topic) {
  if(!guideTopics.includes(topic))throw Error('请选择支持的操作指引');
  const manage=['room','layout','openings','model','cells'].includes(topic),operate=['opening','operations'].includes(topic);
  return {kind:'platform_guide',topic,allowed:manage?ctx.canManage:operate?ctx.canOperate:true,message:manage&&!ctx.canManage?'此项需要空间管理员权限，请联系管理员。':operate&&!ctx.canOperate?'当前账号不能办理本地库存作业。':'打开对应界面，按高亮位置逐步操作；指引不会替你提交修改。'};
}
