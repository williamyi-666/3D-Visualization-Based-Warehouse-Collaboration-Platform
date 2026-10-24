// 通用ERP联调入口：默认只检查文件；--send 才提交，凭证从环境变量读取。
// node tools/send-inventory.mjs --file snapshot.json --url http://localhost:28088/warehouse --send
import {readFileSync} from 'node:fs';
import {pathToFileURL} from 'node:url';
import {inspectInventoryPayload,sendInventory} from '../packages/integration/inventory-client.mjs';
export {inspectInventoryPayload,sendInventory};

async function main(){
  const args=process.argv.slice(2),options={};
  for(let i=0;i<args.length;i++){
    if(args[i]==='--send')options.send=true;
    else if(['--file','--url'].includes(args[i])&&args[i+1])options[args[i].slice(2)]=args[++i];
    else throw Error('用法：node tools/send-inventory.mjs --file payload.json [--url 应用根地址 --send]');
  }
  if(!options.file)throw Error('请通过 --file 指定同步JSON文件');
  const payload=JSON.parse(readFileSync(options.file,'utf8').replace(/^\uFEFF/,''));
  const summary=inspectInventoryPayload(payload);
  if(!options.send){console.log(JSON.stringify({...summary,sent:false,note:'仅检查基本格式；字段、映射及版本冲突须服务端验证。全量快照会替换该来源全部库存，空rows会清空该来源。'}));return;}
  if(!options.url)throw Error('提交必须指定 --url 应用根地址');
  console.log(JSON.stringify(await sendInventory({baseUrl:options.url,token:process.env.SPATIAL_SYNC_TOKEN,payload})));
}
if(process.argv[1] && import.meta.url===pathToFileURL(process.argv[1]).href){
  main().catch(error=>{console.error(error.message.replaceAll(process.env.SPATIAL_SYNC_TOKEN||'\u0000','[已隐藏]'));process.exitCode=1;});
}
