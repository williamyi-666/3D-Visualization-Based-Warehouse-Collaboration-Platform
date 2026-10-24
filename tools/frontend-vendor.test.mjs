import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync,existsSync} from 'node:fs';
import {createHash} from 'node:crypto';
import vm from 'node:vm';

test('前端组件清单校验；SheetJS中文库存表导出再导入',()=>{
 const manifest=JSON.parse(readFileSync('third-party/frontend.json','utf8'));
 for(const component of manifest){
  assert.ok(component.license_files.length>0);
  for(const file of component.license_files)assert.ok(existsSync(file));
  for(const {path,sha256} of component.files)assert.equal(createHash('sha256').update(readFileSync(path)).digest('hex'),sha256);
 }
 const context=vm.createContext({});
 vm.runInContext(readFileSync('apps/web/prototype/vendor/xlsx.full.min.js','utf8'),context);
 const x=context.XLSX;assert.equal(x.version,'0.20.3');
 const rows=[{物料:'轴承',SKU:'BEARING-6204',数量:120,单位:'套',批次:'202609-A'},{物料:'螺栓',SKU:'BOLT-M12',数量:0,单位:'件',批次:''}];
 const workbook=x.utils.book_new();x.utils.book_append_sheet(workbook,x.utils.json_to_sheet(rows),'库存');
 const bytes=x.write(workbook,{bookType:'xlsx',type:'array'});
 const result=x.read(bytes,{type:'array'});
 assert.deepEqual(JSON.parse(JSON.stringify(x.utils.sheet_to_json(result.Sheets['库存']))),rows);
 assert.ok(x.utils.sheet_to_csv(result.Sheets['库存']).includes('BEARING-6204,120'));
});
