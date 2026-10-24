// 明确的新业务切换时只开放对应工具；同一张预览的补参保留原请求。
import {guideRequest} from './assistant-guidance.mjs';
import {isBatchRequest} from './assistant-job-intent.mjs';
export function assistantIntent(message,pending){
  const guide=guideRequest(message);if(guide)return guide.name;
  if(isBatchRequest(message))return 'prepare_batch';
  if(/流水|变动记录|出入记录|为什么.*(?:少|多)|数量变化/.test(message))return 'movement_history';
  if(/待办|哪些.*盘点|今天.*盘哪些/.test(message))return 'list_tasks';
  if(/盘点|实盘|实际(?:只有|有|数量|库存)/.test(message))return 'prepare_stocktake';
  if(/期初|建账|底账|初始库存/.test(message))return 'prepare_opening';
  if(/推荐.*(?:格位|上架|存放)|应该放|放(?:到)?哪里|哪个格位/.test(message))return 'recommend_location';
  if(/入库|出库|移庫|移库|移到|搬到|挪到|领出|收货/.test(message))return 'prepare_operation';
  if(/建仓|布置.*(?:货架|存放区)|新增.*(?:货架|存放区)|轻型货架|横梁货架|地面存放区/.test(message))return 'preview_warehouse';
  if(/在哪里|在哪|还有多少|查货|查找货品/.test(message))return 'find_stock';
  if(pending)return pending.name;
  return '';
}
