const names={sku:['SKU','物料编码','物料编号','货品编码','商品编码','存货编码','条码'],name:['NAME','品名','名称','物料名称','货品名称','商品名称'],qty:['QTY','QUANTITY','数量','申请数量','领用数量','需求数量','入库数量','出库数量'],unit:['UNIT','单位','计量单位','库存单位'],specification:['SPEC','规格型号','规格','型号'],from_hint:['FROM','来源格位','来源库位','源格位','源库位'],to_hint:['TO','目标格位','目标库位']};
const captions={sku:'SKU',name:'品名',qty:'数量',unit:'单位',specification:'规格型号',from_hint:'来源格位',to_hint:'目标格位'};
const normal=text=>text.replace(/\s/g,'').toUpperCase();

// Tesseract返回的文字坐标仅用于恢复单据列，所有照片行仍须人工对照核对。
export function photoDocumentTable(lines=[]){
  let headerIndex=-1,columns=[];
  for(const [index,line] of lines.entries()){
    const words=[...(line.words||[])].sort((a,b)=>a.left-b.left),found=[];
    for(let i=0;i<words.length;i++){
      let match;
      for(let length=1;length<=Math.min(5,words.length-i);length++){
        const text=normal(words.slice(i,i+length).map(w=>w.text).join(''));
        const key=Object.keys(names).find(key=>names[key].some(name=>normal(name)===text));
        if(key)match={key,length,left:words[i].left,right:words[i+length-1].left+words[i+length-1].width};
      }
      if(match){found.push(match);i+=match.length-1;}
    }
    if(found.some(c=>c.key==='qty')&&found.some(c=>['name','sku'].includes(c.key))){headerIndex=index;columns=found;break;}
  }
  if(headerIndex<0)return null;
  const rows=lines.slice(0,headerIndex).map(line=>[line.text]);
  rows.push(columns.map(c=>captions[c.key]));
  for(const line of lines.slice(headerIndex+1)){
    const cells=columns.map(()=>[]);
    for(const word of line.words||[]){
      const center=word.left+word.width/2;
      const index=columns.findIndex((c,i)=>i===columns.length-1||center<(c.right+columns[i+1].left)/2);
      cells[index<0?columns.length-1:index].push(word);
    }
    rows.push(cells.map((words,i)=>words.sort((a,b)=>a.left-b.left).map(word=>word.text).join(columns[i].key==='sku'?'':' ')));
  }
  return rows;
}
