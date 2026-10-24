// bundle.mjs —— 把原型打包成离线自包含 standalone.html
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const b64 = (p) => Buffer.from(readFileSync(p, 'utf-8'), 'utf-8').toString('base64');

// 打包需要读取 /api/rooms、/api/scene、/api/sites —— 这些接口需登录。
// 启动时带上会话令牌（环境变量 SPATIAL_BUNDLE_TOKEN），否则只能拿到占位数据。
const TOKEN = process.env.SPATIAL_BUNDLE_TOKEN || '';
const H = TOKEN ? { Authorization: `Bearer ${TOKEN}` } : {};

const threeSrc = b64(join(__dirname, 'vendor', 'three.module.js'));
const orbitSrc = b64(join(__dirname, 'vendor', 'jsm', 'controls', 'OrbitControls.js'));
const generatorPath = join(__dirname, '..', '..', '..', 'packages', 'three-kit', 'spaceGenerator.js');
const genB64 = b64(generatorPath);
const jsqrB64 = b64(join(__dirname, 'vendor', 'jsQR.js'));
const appB64  = b64(join(__dirname, 'standalone-app.js'));
const qrGenB64 = b64(join(__dirname, '..', 'labels', 'vendor', 'qrcode-generator.js'));

// 抓取所有库区场景（多库区），失败则回退到单一 /api/scene
let roomsPayload = [];
try {
  const rres = await fetch('http://localhost:3000/api/rooms', { headers: H });
  if (rres.ok) {
    const rooms = await rres.json();
    for (const r of rooms) {
      try {
        const sres = await fetch('http://localhost:3000/api/scene?room=' + encodeURIComponent(r.loc_code), { headers: H });
        if (sres.ok) { const sc = await sres.json(); roomsPayload.push({ roomCode: sc.roomCode, roomName: sc.roomName, room: sc.room, furniture: sc.furniture }); }
      } catch (e) { /* skip */ }
    }
  }
} catch (e) { console.warn('[bundle] 多库区抓取失败:', e.message); }
if (!roomsPayload.length) {
  try {
    const res = await fetch('http://localhost:3000/api/scene', { headers: H });
    if (res.ok) { const sc = await res.json(); roomsPayload = [{ roomCode: sc.roomCode, roomName: sc.roomName, room: sc.room, furniture: sc.furniture }]; }
  } catch (e) { console.warn('[bundle] 抓取失败，使用占位数据:', e.message); }
}
// 抓取仓库（场地）列表，供离线版仓库下拉使用
let sitesPayload = [];
try {
  const sres = await fetch('http://localhost:3000/api/sites', { headers: H });
  if (sres.ok) sitesPayload = await sres.json();
} catch (e) { console.warn('[bundle] 仓库列表抓取失败:', e.message); }
console.log('[bundle] 已抓取仓库数 =', sitesPayload.length);

// 抓取每个格位的流转记录，供离线版「物品时间线」使用（无令牌时为空）
const historyMap = {};
for (const room of roomsPayload) {
  for (const f of (room.furniture || [])) {
    const cm = f.cellMeta || {};
    for (const suffix of Object.keys(cm)) {
      const locCode = f.code + '-' + suffix;
      try {
        const hres = await fetch('http://localhost:3000/api/cell/' + encodeURIComponent(locCode) + '/history', { headers: H });
        if (hres.ok) { const rows = await hres.json(); if (Array.isArray(rows) && rows.length) historyMap[locCode] = rows; }
      } catch (e) { /* skip */ }
    }
  }
}
console.log('[bundle] 已嵌入流转记录格位数 =', Object.keys(historyMap).length);

const scene = roomsPayload[0]
  ? { roomCode: roomsPayload[0].roomCode, roomName: roomsPayload[0].roomName, room: roomsPayload[0].room, furniture: roomsPayload[0].furniture }
  : { room: { width: 4, depth: 3, height: 2.6 }, furniture: [] };
console.log('[bundle] 已抓取库区数 =', roomsPayload.length, '，首库区货架数 =', (scene.furniture || []).length);

// 读取 index.html 的 CSS 与 body
let html = readFileSync(join(__dirname, 'index.html'), 'utf-8');
const styleBlock = html.match(/<style>[\s\S]*?<\/style>/)[0];
const bodyInner = html.match(/<body>([\s\S]*)<\/body>/)[1];

// 去掉原 importmap / vendor / module 引用
let body = bodyInner
  .replace(/<script type="importmap">[\s\S]*?<\/script>/, '')
  .replace(/<script src="\.\/vendor\/jsQR\.js"><\/script>/, '')
  .replace(/<script src="\.\/vendor\/xlsx\.full\.min\.js"><\/script>/, '')
  .replace(/<script src="\.\.\/labels\/vendor\/qrcode-generator\.js"><\/script>/, '')
  .replace(/<script type="module" src="\.\/app\.js"><\/script>/, '');

const bootstrap = `
<script>
window.__SCENE__ = ${JSON.stringify(scene)};
window.__ROOMS__ = ${JSON.stringify(roomsPayload)};
window.__SITES__ = ${JSON.stringify(sitesPayload)};
window.__HISTORY__ = ${JSON.stringify(historyMap)};
(function () {
  const B64 = {
    three: "${threeSrc}",
    orbit: "${orbitSrc}",
    gen: "${genB64}",
    jsqr: "${jsqrB64}",
    qrcode: "${qrGenB64}",
    app: "${appB64}"
  };
  function b64ToText(b) {
    const bin = atob(b);
    const a = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) a[i] = bin.charCodeAt(i);
    return new TextDecoder('utf-8').decode(a);
  }
  const mk = (src) => URL.createObjectURL(new Blob([b64ToText(src)], { type: 'text/javascript' }));
  const threeUrl = mk(B64.three);
  const orbitUrl = mk(B64.orbit);
  const genUrl = mk(B64.gen);
  const appUrl = mk(B64.app);
  // jsQR 作为经典脚本注入（UMD 挂到 window）
  const jsqrUrl = mk(B64.jsqr);
  const s0 = document.createElement('script'); s0.src = jsqrUrl; document.head.appendChild(s0);
  // qrcode-generator 作为经典脚本注入（UMD 挂到 window.qrcode），供离线版「打印格位码」使用
  const qrUrl = mk(B64.qrcode);
  const sQ = document.createElement('script'); sQ.src = qrUrl; document.head.appendChild(sQ);
  // importmap 必须在模块脚本前注入
  const im = document.createElement('script');
  im.type = 'importmap';
  im.textContent = JSON.stringify({ imports: { 'three': threeUrl, 'three/addons/controls/OrbitControls.js': orbitUrl, 'generator': genUrl } });
  document.head.appendChild(im);
  const s1 = document.createElement('script'); s1.type = 'module'; s1.src = appUrl; document.head.appendChild(s1);
})();
</script>
`;

const out = `<!doctype html>
<!-- built: ${new Date().toISOString()} | rooms=${roomsPayload.length} | furniture=${(scene.furniture||[]).length} -->
<html lang="zh-CN">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1, maximum-scale=1, user-scalable=no" />
  <title>空间物品收纳 · 3D 离线版</title>
  ${styleBlock}
</head>
<body>
  ${body}
  ${bootstrap}
</body>
</html>
`;

const outPath = join(__dirname, 'standalone.html');
writeFileSync(outPath, out, 'utf-8');
console.log('[bundle] 已生成 ->', outPath, '(', (out.length / 1024 / 1024).toFixed(2), 'MB )');
