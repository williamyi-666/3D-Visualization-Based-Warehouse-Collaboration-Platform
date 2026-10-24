import {parseAssistantNumber} from './assistant-grounding.mjs';

const number='([+-]?\\d+(?:\\.\\d+)?|负?[零〇一二两三四五六七八九十百]+)';
export const jobOrdinal=message=>{const found=message.match(new RegExp('第'+number+'\\s*(?:项|条|笔)'));return found?parseAssistantNumber(found[1]):null;};
export const listsJobs=message=>/我的作业清单|未完成(?:的)?作业|继续(?:上次|上一次)?清单|查看清单/.test(message);
export const isJobPatch=message=>jobOrdinal(message)!==null||/(?:数量|目标|源格位).*(?:改|调整)|(?:改成|改为|调整为)/.test(message);
export const isBatchRequest=message=>/入库|出库|移库/.test(message)&&(/批量|分别|清单|同时|以下|这些|这几|一起|以及|并且|另外/.test(message)||((message.match(/入库|出库|移库/g)||[]).length>1&&/[；;\n]|然后|再/.test(message)));

// 只接受原话中的数量和单位；第几项不作为办理数量。
export function groundJobInput(input,message,currentUnit=''){
  const result={...input},source=message.replace(new RegExp('第'+number+'\\s*(?:项|条|笔)','g'),'');
  const operations={in:/入库|收货|放入/,out:/出库|领出|取出/,move:/移库|移庫|移到|搬到|挪到/};
  if(result.operation&&!operations[result.operation]?.test(source))delete result.operation;
  const normalized=value=>String(value).normalize('NFKC').replace(/\s/g,'').toUpperCase();
  for(const key of ['from_hint','to_hint'])if(result[key]&&!normalized(source).includes(normalized(result[key])))delete result[key];
  if(result.unit&&!source.includes(result.unit))delete result.unit;
  if(typeof result.qty==='number'){
    const unit=result.unit||currentUnit,escaped=unit.replace(/[.*+?^${}()|[\]\\]/g,'\\$&');
    const patterns=[new RegExp('(?:数量|改成|改为|调整为)\\s*(?:改成|改为|调整为|为)?\\s*'+number,'g')];
    if(unit)patterns.push(new RegExp(number+'\\s*'+escaped,'g'));
    if(!patterns.some(pattern=>[...source.matchAll(pattern)].some(match=>parseAssistantNumber(match[1])===result.qty)))delete result.qty;
  }
  return result;
}
