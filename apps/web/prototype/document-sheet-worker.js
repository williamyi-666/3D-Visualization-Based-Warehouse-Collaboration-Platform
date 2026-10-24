importScripts('./vendor/xlsx.full.min.js');
let workbook;
onmessage=event=>{
  const {action,data,sheet}=event.data;
  try{
    if(action==='open'){
      workbook=XLSX.read(data,{type:'array',sheetRows:152,cellFormula:true,cellHTML:false});
      postMessage({sheets:workbook.SheetNames});return;
    }
    const page=workbook?.Sheets[sheet];if(!page)throw Error('请选择需要导入的工作表');
    const range=XLSX.utils.decode_range(page['!fullref']||page['!ref']||'A1');
    if(range.e.r>=150||range.e.c>=40)throw Error('单据最多150行、40列，请复制需要办理的区域到新工作表');
    for(const [address,cell] of Object.entries(page))if(!address.startsWith('!')&&cell.f)throw Error('所选工作表含公式，请先粘贴为数值再导入');
    postMessage({rows:XLSX.utils.sheet_to_json(page,{header:1,defval:'',blankrows:true,raw:false})});
  }catch(error){postMessage({error:error.message||'表格无法读取，请另存为CSV后重试'});}
};
