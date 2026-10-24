// bundle-labels.mjs
// 生成离线二维码打印页：内联真实格位(window.__CELLS__) + 本地 qrcode-generator，零网络依赖。
import { readFileSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const LABELS = join(__dirname, '..', 'labels'); // apps/web/labels
const ROOT = join(__dirname, '..', '..'); // spatial-inventory/
const PORT = process.env.PORT || 3000;
const TOKEN = process.env.SPATIAL_BUNDLE_TOKEN || '';
const H = TOKEN ? { Authorization: `Bearer ${TOKEN}` } : {};

const b64 = (s) => Buffer.from(s, 'utf-8').toString('base64');

async function main() {
  // 1) 真实格位（来自运行中的后端；若未运行则用空数组，页内回退 FALLBACK）
  let cells = [];
  try {
    const res = await fetch(`http://localhost:${PORT}/api/cells`, { headers: H });
    if (res.ok) cells = await res.json();
  } catch (e) {
    console.warn('[bundle-labels] 未取到 /api/cells（后端未运行？），将使用 FALLBACK 样例:', e.message);
  }
  // 1b) 真实货品（货品标签模式用；离线也可打印货品二维码）
  let items = [];
  try {
    const res = await fetch(`http://localhost:${PORT}/api/v1/items`, { headers: H });
    if (res.ok) items = await res.json();
  } catch (e) {
    console.warn('[bundle-labels] 未取到 /api/v1/items（后端未运行？）:', e.message);
  }

  // 2) 内联 qrcode-generator 库
  const qrLib = readFileSync(join(LABELS, 'vendor/qrcode-generator.js'), 'utf-8');

  // 3) 读取 labels 页，并把 fetch 段替换为读取内联数据
  let html = readFileSync(join(LABELS, 'index.html'), 'utf-8');
  // 把本地 qrcode-generator.js 转为 base64 data URI 内联，避免 <script> 内联时
  // 库里的 $' / </script> 等字符串被 HTML 解析器误解析导致页面错乱。
  html = html.replace(/<script src="\.\/vendor\/qrcode-generator\.js"><\/script>/,
    () => `<script src="data:text/javascript;base64,${b64(qrLib)}"></script>`);

  // 4) 在 <body> 开头注入内联数据（用 replacer 函数避免 $ 特殊序列）
  html = html.replace('<body>',
    () => `<body>\n  <script>window.__CELLS__ = ${JSON.stringify(cells)};\n  window.__ITEMS__ = ${JSON.stringify(items)};</script>`);

  writeFileSync(join(__dirname, 'standalone-labels.html'), html, 'utf-8');
  console.log(`[bundle-labels] 已生成 standalone-labels.html（格位 ${cells.length} 个，货品 ${items.length} 个，${((Buffer.byteLength(html)) / 1024).toFixed(0)} KB）`);
}

main().catch((e) => { console.error(e); process.exit(1); });
