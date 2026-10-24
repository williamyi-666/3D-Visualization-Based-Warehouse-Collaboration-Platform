// ERP适配侧补传入口。默认只检查；--send才入队，--watch等待断网恢复后补传完成。
// node tools/erp-sync-worker.mjs --file payload.json --id ERP单据行号 --queue /data/erp-delivery.db --url http://仓储后台 --send --watch
import {DatabaseSync} from 'node:sqlite';
import {readFileSync} from 'node:fs';
import {inspectInventoryPayload} from '../packages/integration/inventory-client.mjs';
import {createInventoryDelivery} from '../packages/integration/inventory-delivery.mjs';
const args=process.argv.slice(2),options={};let sql;
try{
  for(let i=0;i<args.length;i++){
    if(['--send','--watch','--retry-blocked'].includes(args[i]))options[args[i].slice(2)]=true;
    else if(['--file','--id','--queue','--url'].includes(args[i])&&args[i+1])options[args[i].slice(2)]=args[++i];
    else throw Error('支持 --file、--id、--queue、--url、--send、--watch、--retry-blocked');
  }
  if(!options.file)throw Error('请指定 --file 库存消息文件');
  const payload=JSON.parse(readFileSync(options.file,'utf8').replace(/^\uFEFF/,'')),summary=inspectInventoryPayload(payload);
  if(!options.send)console.log(JSON.stringify({...summary,sent:false,note:'仅检查，尚未入队或提交。'}));
  else{
    if(!options.id||!options.queue||!options.url)throw Error('发送需要稳定的 --id、独立的 --queue 文件和 --url');
    const token=process.env.SPATIAL_SYNC_TOKEN;if(!token)throw Error('请设置来源专用 SPATIAL_SYNC_TOKEN');
    sql=new DatabaseSync(options.queue);const queue=createInventoryDelivery(sql,{baseUrl:options.url,token,source:payload.source});const id=queue.enqueue(options.id,payload);if(options['retry-blocked'])queue.retry(id);
    let interrupted=false;process.once('SIGINT',()=>{interrupted=true;});process.once('SIGTERM',()=>{interrupted=true;});
    do{
      const rows=await queue.flush(),remaining=rows.filter(r=>r.state!=='sent');
      console.log(JSON.stringify({sent:rows.length-remaining.length,pending:remaining.length,blocked:remaining.some(r=>r.state==='blocked'),next:remaining[0]||null}));
      if(!remaining.length)break;
      if(!options.watch||remaining.some(r=>r.state==='blocked')){process.exitCode=1;break;}
      await new Promise(resolve=>setTimeout(resolve,Math.max(100,Math.min(1000,remaining[0].next_attempt_at-Date.now()))));
    }while(!interrupted);
    if(interrupted)process.exitCode=1;
  }
}catch(error){console.error(String(error.message).replaceAll(process.env.SPATIAL_SYNC_TOKEN||'\u0000','[已隐藏]'));process.exitCode=1;}
finally{sql?.close();}
