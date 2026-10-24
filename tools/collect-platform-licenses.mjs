// 只读收集固定平台镜像的许可证据；缺失原文及源码对应关系不能自动判定合规。
import {execFileSync} from 'node:child_process';
import {readFileSync, writeFileSync, mkdirSync} from 'node:fs';
import {resolve, join} from 'node:path';
import {createHash} from 'node:crypto';

const lockPath = resolve(process.argv[2] || '../open-supos/images.lock.json');
const output = resolve(process.argv[3] || 'tools/out/platform-licenses');
const prefix = process.argv[4] || 'opensupos-lab-';
const digest = data => createHash('sha256').update(data).digest('hex');
const docker = (...args) => execFileSync('docker', args, {encoding:'utf8', stdio:['ignore','pipe','pipe']});
const lockBytes = readFileSync(lockPath);
const lock = JSON.parse(lockBytes);
mkdirSync(output, {recursive:true});
const paths = {
  grafana:['/usr/share/grafana/LICENSE'],
  nodered:['/usr/src/node-red/node_modules/node-red/LICENSE'],
  eventflow:['/usr/src/node-red/node_modules/node-red/LICENSE'],
  keycloak:['/opt/keycloak/LICENSE.txt'],
  konga:['/app/LICENSE'],
  kong:['/usr/local/share/lua/5.1/kong/LICENSE'],
};
const report = {
  collectedAt:new Date().toISOString(), lockSha256:digest(lockBytes),
  scope:'平台顶层组件证据；不覆盖全部操作系统包、插件、传递依赖或分发义务履行',
  complianceStatus:'待核查', services:[], upstreamEvidence:[],
};
for (const [service, reference] of Object.entries(lock)) {
  if (!/^[a-z0-9_-]+$/i.test(service) || !/@sha256:[a-f0-9]{64}$/.test(reference)) {
    throw new Error('锁文件必须包含合法服务名与固定镜像摘要');
  }
  const [image] = JSON.parse(docker('image','inspect',reference));
  const [container] = JSON.parse(docker('inspect',prefix+service));
  if (container.Image !== image.Id) throw new Error(service+'运行镜像与锁文件不一致');
  // 不记录环境变量、容器挂载、用户数据或任意标签内容。
  const labels = image.Config.Labels || {};
  const record = {service, reference, imageId:image.Id, tags:image.RepoTags || [],
    declaredLicense:labels['org.opencontainers.image.licenses'] || labels['org.label-schema.license'] || null,
    files:[], missing:[], status:'待核查'};
  const dir = join(output,service);
  mkdirSync(dir,{recursive:true});
  for (const [i, path] of (paths[service] || []).entries()) {
    const file = `${service}/license-${i}.txt`;
    try {
      docker('cp',`${container.Id}:${path}`,join(output,file));
      record.files.push({containerPath:path, file, sha256:digest(readFileSync(join(output,file)))});
    } catch { record.missing.push(path); }
  }
  report.services.push(record);
}
// 上游文件与镜像内原文分开记录；版本标签本身不是镜像构建来源证明。
const sources = {
  // 官方仓库候选源码，固定本次核查提交；尚未证明与T19/T16部署镜像一致。
  'supos-backend-0289d2d':'https://raw.githubusercontent.com/supOS-Project/supOS-backend/0289d2d129e220965271c7203a3d4a1bf2dba758/LICENSE',
  'supos-frontend-ccc2f81':'https://raw.githubusercontent.com/supOS-Project/supOS-frontend/ccc2f815dac3c7b694ba7a804a4c31b2fc490325/LICENSE',
  'grafana-11.4.0':'https://raw.githubusercontent.com/grafana/grafana/v11.4.0/LICENSE',
  'emqx-5.8.6':'https://raw.githubusercontent.com/emqx/emqx/v5.8.6/LICENSE',
  'emqx-5.8.6-apache':'https://raw.githubusercontent.com/emqx/emqx/v5.8.6/APL.txt',
  'timescaledb-2.20.0':'https://raw.githubusercontent.com/timescale/timescaledb/2.20.0/LICENSE',
  'timescaledb-2.20.0-tsl':'https://raw.githubusercontent.com/timescale/timescaledb/2.20.0/tsl/LICENSE-TIMESCALE',
};
mkdirSync(join(output,'upstream'),{recursive:true});
for (const [name,url] of Object.entries(sources)) {
  try {
    const response = await fetch(url,{signal:AbortSignal.timeout(20000)});
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const bytes = Buffer.from(await response.arrayBuffer());
    if (!bytes.length || /<html/i.test(bytes.toString('utf8'))) throw new Error('未取得许可原文');
    const file = `upstream/${name}.txt`;
    writeFileSync(join(output,file),bytes);
    report.upstreamEvidence.push({url,file,sha256:digest(bytes),status:'已取得原文'});
  } catch (error) { report.upstreamEvidence.push({url,status:'未取得',reason:error.message}); }
}
writeFileSync(join(output,'manifest.json'),JSON.stringify(report,null,2)+'\n');
console.log(JSON.stringify({services:report.services.length, embeddedFiles:report.services.reduce((n,s)=>n+s.files.length,0),
  upstreamFiles:report.upstreamEvidence.filter(e=>e.file).length, complianceStatus:report.complianceStatus,output}));
