// packages/integration/photoLayout.mjs
// 拍照/图片 → 3D 布局模板。
// 调用「OpenAI 兼容协议」的视觉大模型（GPT-4V / Claude / 通义 qwen-vl / 智谱 glm-4v …）识别仓库布局，
// 把模型输出归一化为与 DXF/IFC 同源的「规范布局模板」（room + furniture[]），
// 后续直接复用外部布局导入层（importLayout / saveLayout / spaceGenerator）生成 3D 场景。
//
// 配置（环境变量）：
//   PHOTO_VISION_BASE_URL  OpenAI 兼容的 base（默认 https://api.openai.com/v1），需能被拼接 /chat/completions
//   PHOTO_VISION_API_KEY   鉴权 Bearer token（必填，除非开 MOCK）
//   PHOTO_VISION_MODEL     模型名（默认 gpt-4o）
//   PHOTO_VISION_MOCK=1    不调真实 API，返回固定布局，便于无密钥联调/前端走通
//
// 精度策略（核心）：
//   单张照片没有真实尺度，AI 擅长「数数与相对位置」、不擅长「推算米数」。
//   因此：数量与相对位置交给 AI，绝对尺寸优先采用用户提供的先验值（hints），
//   并让模型对每个货架给出置信度与备注，生成后再做自动自检（越界/重叠/异常），
//   最后由用户在「照片 vs 俯视图」并排界面上确认微调。

import { normalizeTemplate, validateTemplate, DEFAULTS } from './importers/schema.mjs';

const BASE_URL = (process.env.PHOTO_VISION_BASE_URL || 'https://api.openai.com/v1').replace(/\/$/, '');
const API_KEY = process.env.PHOTO_VISION_API_KEY || '';
const MODEL = process.env.PHOTO_VISION_MODEL || 'gpt-4o';
const MOCK = process.env.PHOTO_VISION_MOCK === '1';

// 参照物预设（前端下拉的 value → 提示词里的描述与真实尺寸）
export const REFERENCE_PRESETS = {
  pallet: { label: '标准托盘', w: 1.2, d: 1.0 },
  tape: { label: '卷尺/可见刻度', w: null, d: null },
  a4: { label: 'A4 纸', w: 0.21, d: 0.297 },
};

const SYSTEM_PROMPT = `你是一名仓库/库房空间布局估算助手。用户会发送一张或多张仓库/房间的照片。
请综合判断其内部空间布局，并【只】输出一个严格 JSON 对象，不要任何解释文字、不要 Markdown 代码块。

坐标系约定：
- 房间中心为原点 (0,0)。
- X 轴：向右为正、向左为负，单位米。
- Z 轴：向门口/拍摄者方向为正、向后墙为负，单位米。
- 旋转 rot：货架绕竖直轴的角度（度，正=逆时针），默认 0。

输出 JSON 结构：
{
  "room": { "width": 数字(米), "depth": 数字(米), "height": 数字(米, 层高) },
  "furniture": [
    {
      "label": "货架A",
      "type": "rack" | "cabinet" | "floor",
      "rows": 层数(整数),
      "cols": 每层位数(整数),
      "x": 数字(米, 相对中心),
      "z": 数字(米, 相对中心),
      "rot": 数字(度),
      "rough_w": 宽估算(米, 可选),
      "rough_d": 深估算(米, 可选),
      "confidence": "high" | "medium" | "low",
      "note": "不确定原因或被遮挡说明（可选，没有就省略）"
    }
  ]
}

说明：
- 普通库房 room.width/depth 多在 8~15 米，层高 2.6~4 米；看不清就用合理估值。
- type：rack=开放式/横梁货架；cabinet=封闭柜；floor=贴地网格堆放区。
- confidence 规则：清晰可辨且数量确定=high；大致能看出但细节存疑=medium；被严重遮挡/透视畸变/无法判断=low，并在 note 说明原因。
- 若用户提供了「已知尺寸」，请直接采用这些数值，不要另行估算；如照片中某件家具明显与已知尺寸不符，仍采用已知尺寸，但把 confidence 设为 low 并在 note 说明差异。`;

function num(v) {
  if (v == null || v === '') return 0;
  const n = typeof v === 'number' ? v : parseFloat(String(v).replace(',', '.'));
  return Number.isFinite(n) ? n : 0;
}

// ---------- 图片 data URL 解析 ----------
function dataUrlToParts(dataUrl) {
  const m = /^data:([^;]+);base64,(.+)$/.exec(dataUrl || '');
  if (!m) throw new Error('图片应为 data URL（形如 data:image/jpeg;base64,…）');
  return { mime: m[1], b64: m[2] };
}

// 拼 user 文本：基础指令 + 先验尺寸 + 参照物 + 多图提示
function buildUserText({ hints = {}, reference = '', imageCount = 1 } = {}) {
  const lines = [];
  if (imageCount > 1) lines.push(`这里共有 ${imageCount} 张同一空间的照片（不同角度），请综合判断，避免把同一排货架重复计算。`);

  const H = hints || {};
  const known = [];
  if (num(H.rackW) > 0) known.push(`标准货架宽 ${num(H.rackW)} m`);
  if (num(H.rackD) > 0) known.push(`标准货架深 ${num(H.rackD)} m`);
  if (num(H.rackRows) > 0) known.push(`标准货架层数 ${Math.round(num(H.rackRows))}`);
  if (num(H.rackCols) > 0) known.push(`每层位数 ${Math.round(num(H.rackCols))}`);
  if (num(H.roomW) > 0) known.push(`房间宽 ${num(H.roomW)} m`);
  if (num(H.roomD) > 0) known.push(`房间深 ${num(H.roomD)} m`);
  if (num(H.roomH) > 0) known.push(`层高 ${num(H.roomH)} m`);
  if (known.length) {
    lines.push(`已知尺寸（这是用户提供的真实值，请直接采用，不要再估算）：${known.join('、')}。`);
    lines.push('你只需判断：一共有几排家具、每排的类型、以及它们相对房间中心的大致位置（x/z）。');
  }

  const ref = REFERENCE_PRESETS[reference];
  if (ref) {
    const size = ref.w && ref.d ? `（真实尺寸 ${ref.w} m × ${ref.d} m）` : '';
    lines.push(`照片中有已知尺寸的参照物：${ref.label}${size}，请据此推算真实尺度。`);
  }

  lines.push('请分析照片，按系统指令输出严格 JSON。');
  return lines.join('\n');
}

// ---------- 调用视觉 API（OpenAI 兼容 chat/completions，多模态） ----------
async function callVision(imageList, opts = {}) {
  const content = [{ type: 'text', text: buildUserText({ ...opts, imageCount: imageList.length }) }];
  for (const img of imageList) {
    const { mime, b64 } = dataUrlToParts(img);
    content.push({ type: 'image_url', image_url: { url: `data:${mime};base64,${b64}` } });
  }
  const resp = await fetch(`${BASE_URL}/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${API_KEY}` },
    body: JSON.stringify({
      model: MODEL,
      temperature: 0.2,
      messages: [
        { role: 'system', content: SYSTEM_PROMPT },
        { role: 'user', content },
      ],
    }),
  });
  if (!resp.ok) {
    const t = await resp.text().catch(() => '');
    throw new Error(`视觉API错误 ${resp.status}: ${t.slice(0, 300)}`);
  }
  const j = await resp.json();
  const content2 = j?.choices?.[0]?.message?.content || '';
  return parseModelJson(content2);
}

function parseModelJson(content) {
  let s = (content || '').trim();
  const fence = /^```(?:json)?\s*([\s\S]*?)\s*```$/i.exec(s);
  if (fence) s = fence[1].trim();
  const tryParse = (str) => { try { return JSON.parse(str); } catch { return null; } };
  const direct = tryParse(s);
  if (direct) return direct;
  const a = s.indexOf('{'), b = s.lastIndexOf('}');
  if (a >= 0 && b > a) {
    const cut = tryParse(s.slice(a, b + 1));
    if (cut) return cut;
  }
  throw new Error('视觉模型未返回可解析的 JSON');
}

// ---------- 模型 JSON → 规范模板 ----------
function defaultDims(type, H = {}) {
  if (type === 'floor') return { w: num(H.floorW) || 2.0, d: num(H.floorD) || 2.0 };
  if (type === 'cabinet') return { w: 0.8, d: 0.5 };
  return { w: num(H.rackW) || 1.0, d: num(H.rackD) || 0.6 }; // rack
}

function normConf(v) {
  const s = String(v || '').toLowerCase();
  if (/high|^高/.test(s)) return 'high';
  if (/low|^低/.test(s)) return 'low';
  return 'medium';
}

export function photoLayoutToTemplate(model, opts = {}) {
  const H = (opts && opts.hints) || {};
  const src = model || {};
  const room = src.room || {};
  const rw = num(room.width);
  const rd = num(room.depth);
  // 先验房间尺寸优先，其次模型值，最后合理默认
  const roomOut = {
    width: num(H.roomW) > 0 ? num(H.roomW) : (rw > 0 ? rw : 10),
    depth: num(H.roomD) > 0 ? num(H.roomD) : (rd > 0 ? rd : 8),
    height: num(H.roomH) > 0 ? num(H.roomH) : (num(room.height) || DEFAULTS.roomHeight),
  };

  const list = Array.isArray(src.furniture) ? src.furniture : [];
  const furniture = list.map((f, i) => {
    const ts = String(f.type || '').toLowerCase();
    const type = /floor|地面/.test(ts) ? 'floor' : /cab|柜/.test(ts) ? 'cabinet' : 'rack';
    const dims = defaultDims(type, H);
    const code = String.fromCharCode(65 + (i % 26)); // A,B,…Z
    // 先验值优先级最高（用户提供的是真值），其次模型估算，最后内置默认
    const hintW = type === 'rack' ? num(H.rackW) : (type === 'floor' ? num(H.floorW) : 0);
    const hintD = type === 'rack' ? num(H.rackD) : (type === 'floor' ? num(H.floorD) : 0);
    const hintRows = type === 'rack' ? num(H.rackRows) : 0;
    const hintCols = type === 'rack' ? num(H.rackCols) : 0;
    return {
      code,
      label: String(f.label || '').trim() || `货架${code}`,
      type,
      x: num(f.x),
      z: num(f.z),
      rot: (num(f.rot)) * Math.PI / 180, // 模型给角度 → 弧度（与 layoutState.rot 一致）
      w: hintW > 0 ? hintW : (num(f.rough_w) || dims.w),
      d: hintD > 0 ? hintD : (num(f.rough_d) || dims.d),
      rows: hintRows > 0 ? Math.round(hintRows)
        : (num(f.rows) > 0 ? Math.round(num(f.rows)) : (type === 'floor' ? DEFAULTS.floorRows : DEFAULTS.rackRows)),
      cols: hintCols > 0 ? Math.round(hintCols)
        : (num(f.cols) > 0 ? Math.round(num(f.cols)) : (type === 'floor' ? DEFAULTS.floorCols : DEFAULTS.rackCols)),
      open: type === 'cabinet' ? 0 : 1,
    };
  });

  return normalizeTemplate({ room: roomOut, furniture }, opts);
}

// ---------- 自动自检：把「明显不对」的地方直接挑出来 ----------
export function selfCheck(tpl) {
  const warnings = [];
  const room = (tpl && tpl.room) || {};
  const rw = num(room.width), rd = num(room.depth);
  const list = (tpl && Array.isArray(tpl.furniture)) ? tpl.furniture : [];

  if (!list.length) {
    warnings.push({ level: 'error', code: '-', text: '未识别到任何货架/柜子，请重拍或改用「导入模板」手动录入。' });
    return warnings;
  }
  if (!(rw > 0) || !(rd > 0)) {
    warnings.push({ level: 'error', code: '-', text: '未得到房间尺寸，请在「已知尺寸」里填写房间宽/深。' });
    return warnings;
  }

  const halfW = rw / 2, halfD = rd / 2;
  // 越界
  for (const f of list) {
    const hw = num(f.w) / 2, hd = num(f.d) / 2;
    const outX = Math.abs(num(f.x)) + hw > halfW + 0.01;
    const outZ = Math.abs(num(f.z)) + hd > halfD + 0.01;
    if (outX || outZ) {
      const dir = [outX ? '左右' : '', outZ ? '前后' : ''].filter(Boolean).join('与');
      warnings.push({ level: 'warn', code: f.code, text: `货架 ${f.code} 超出房间边界（${dir}方向），请核对位置或房间尺寸。` });
    }
  }
  // 重叠（按轴对齐包围盒近似，忽略旋转）
  for (let i = 0; i < list.length; i++) {
    for (let j = i + 1; j < list.length; j++) {
      const a = list[i], b = list[j];
      const ox = Math.abs(num(a.x) - num(b.x)) < (num(a.w) + num(b.w)) / 2 - 0.05;
      const oz = Math.abs(num(a.z) - num(b.z)) < (num(a.d) + num(b.d)) / 2 - 0.05;
      if (ox && oz) {
        warnings.push({ level: 'warn', code: `${a.code}/${b.code}`, text: `货架 ${a.code} 与 ${b.code} 位置重叠，请核对（可能把同一排重复识别了）。` });
      }
    }
  }
  // 合理性
  for (const f of list) {
    if (num(f.rows) > 12) warnings.push({ level: 'warn', code: f.code, text: `货架 ${f.code} 层数 ${f.rows} 偏高，请确认。` });
    if (num(f.cols) > 20) warnings.push({ level: 'warn', code: f.code, text: `货架 ${f.code} 每层位数 ${f.cols} 偏多，请确认。` });
  }
  return warnings;
}

// ---------- Mock（无密钥联调） ----------
const MOCK_LAYOUT = {
  room: { width: 10, depth: 8, height: 3.0 },
  furniture: [
    { label: '货架A', type: 'rack', rows: 4, cols: 6, x: -2.5, z: 0, rot: 0, rough_w: 1.2, rough_d: 0.6, confidence: 'high' },
    { label: '货架B', type: 'rack', rows: 4, cols: 6, x: 2.5, z: 0, rot: 0, rough_w: 1.2, rough_d: 0.6, confidence: 'high' },
    { label: '封闭柜C', type: 'cabinet', rows: 3, cols: 3, x: 0, z: -2.5, rot: 0, rough_w: 0.8, rough_d: 0.5, confidence: 'low', note: '被前方货架遮挡，层数不确定' },
  ],
};

/**
 * 入口：照片 → { kind, template, warnings, lowConfidence }
 * @param {{image?:string, images?:string[], hints?:object, reference?:string}} arg
 */
export async function importLayoutPhoto({ image, images, hints = {}, reference = '' } = {}) {
  const list = (Array.isArray(images) && images.length) ? images : (image ? [image] : []);
  if (!list.length) throw new Error('需提供 image 或 images（图片 data URL）');

  let model;
  if (MOCK) {
    model = MOCK_LAYOUT;
  } else {
    if (!API_KEY) {
      throw new Error('未配置视觉模型：请在环境变量设置 PHOTO_VISION_API_KEY（及可选 PHOTO_VISION_BASE_URL / PHOTO_VISION_MODEL）');
    }
    model = await callVision(list, { hints, reference });
  }

  const template = photoLayoutToTemplate(model, { hints });
  const v = validateTemplate(template);
  if (!v.ok) throw new Error('生成的布局模板不合规：' + v.errors.join('；'));

  // 置信度 / 备注：normalizeTemplate 会丢掉未知字段，这里按索引补回
  const meta = Array.isArray(model.furniture) ? model.furniture : [];
  template.furniture.forEach((f, i) => {
    const src = meta[i] || {};
    f.confidence = normConf(src.confidence);
    if (src.note) f.note = String(src.note);
  });

  const warnings = selfCheck(template);
  const lowConfidence = template.furniture.filter((f) => f.confidence === 'low').length;
  return { kind: 'photo', template, warnings, lowConfidence };
}
