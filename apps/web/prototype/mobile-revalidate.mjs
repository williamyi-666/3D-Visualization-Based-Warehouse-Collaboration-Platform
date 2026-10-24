// 断网草稿只保留意图；提交前使用新读取的服务端数据核对。
export function validateMobileStock({mode,amount,item,source,originalNode,unit,target,targetNode}){
  if(source.node_id!==originalNode)throw Error('此格位已重建，请重新打开作业核对位置');
  if(item){
    if(item.unit!==unit)throw Error('货品库存单位已变化，请重新选择货品并核对数量');
    if(mode!=='in'){
      const held=source.items.find(row=>row.item_id===item.item_id);
      if(!held||amount>(held.available_qty??held.qty))throw Error('最新可用库存不足；任务预占数量请到团队任务中办理');
    }
  }
  if(target&&targetNode&&target.node_id!==targetNode)throw Error('目标格位已重建，请重新选择');
}
