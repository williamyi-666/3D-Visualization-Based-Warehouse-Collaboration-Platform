import {readdirSync} from 'node:fs';
import {spawn} from 'node:child_process';
import {fileURLToPath} from 'node:url';

const root=fileURLToPath(new URL('../',import.meta.url));
const files=readdirSync(new URL('./',import.meta.url)).filter(name=>name.endsWith('.test.mjs')).sort().map(name=>'tools/'+name);
if(!files.length)throw Error('未找到测试文件，请在完整源码中运行');
// 测试自行创建临时数据库和模拟服务，不继承部署实例的地址、凭证或数据目录。
const env={...process.env};
for(const key of Object.keys(env))if(/^(SPATIAL_|SUPOS_|OUTBOUND_)/.test(key)||key==='PGURL')delete env[key];
env.DB_DRIVER='sqlite';env.SPATIAL_TEST_ERP='1';
const child=spawn(process.execPath,['--test','--test-concurrency=1',...files],{cwd:root,env,stdio:'inherit'});
child.on('error',error=>{console.error(error.message);process.exitCode=1;});
child.on('exit',code=>{process.exitCode=code??1;});
