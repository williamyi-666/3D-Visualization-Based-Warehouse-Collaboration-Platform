// 在 Linux 容器中运行；仅加载已安装模型，不下载、不读取库存。
const url=process.env.SPATIAL_ASSISTANT_URL;
const model=process.env.SPATIAL_ASSISTANT_MODEL||'qwen3:4b-instruct-2507-q4_K_M';
if(!url)throw Error('请设置 SPATIAL_ASSISTANT_URL');
const response=await fetch(new URL('/api/generate',url),{
  method:'POST',headers:{'Content-Type':'application/json'},
  signal:AbortSignal.timeout(180000),
  body:JSON.stringify({model,prompt:'',stream:false,keep_alive:'30m',options:{num_ctx:4096,num_thread:4}}),
});
const result=await response.json();
if(!response.ok)throw Error(result.error||'模型加载失败');
console.log('仓储智能助手模型已加载，可以开始验收。');
