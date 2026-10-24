// 只保存业务草稿，不保存SVG节点等运行时对象。拖动结束后才提交一次记录。
export function createDraftHistory(limit=100) {
  let entries=[],index=-1,baseline='';
  const encode=value=>JSON.stringify(value,(key,item)=>key==='_el'?undefined:item);
  return {
    reset(value){baseline=encode(value);entries=[baseline];index=0;},
    push(value){const next=encode(value);if(next===entries[index])return;entries.splice(index+1);entries.push(next);if(entries.length>limit+1)entries.shift();index=entries.length-1;},
    undo(){if(index>0)return JSON.parse(entries[--index]);},
    redo(){if(index<entries.length-1)return JSON.parse(entries[++index]);},
    get canUndo(){return index>0;},get canRedo(){return index<entries.length-1;},
    get dirty(){return index>=0 && entries[index]!==baseline;}
  };
}
