// packages/ai/recognizer.mjs
// 拍照识别插件（六边形架构的「AI 端口」实现）。核心域不关心具体用哪家模型，
// 只调用 recognize(photo) 拿到 {name, category, qty, note}，由具体 Provider 决定。
//
// 当前两种 Provider：
//   - manual    （默认）不调用任何模型，返回 enabled:false，前端退化为「请手动填写」
//   - visionApi 读取 VISION_API_KEY + VISION_API_URL，调用多模态大模型识别（占位实现，按你的模型档位对接）
//
// 切换：环境变量 AI_PROVIDER=visionApi 并配置上述两个变量即可，业务代码零改动。

const PROVIDER = (process.env.AI_PROVIDER || 'manual').toLowerCase();

export function getProviderName() { return PROVIDER; }

// 统一入口：photoDataUrl 形如 "data:image/jpeg;base64,...."
export async function recognize(photoDataUrl) {
  if (PROVIDER === 'visionApi') return visionApi(photoDataUrl);
  return { enabled: false, provider: 'manual', message: '未启用 AI 识别，请手动填写（设置 AI_PROVIDER=visionApi 并配置密钥可开启）' };
}

// 多模态识别（占位实现）：
// 真实对接时，把 base64 图像发给你的多模态模型（如 GLM-4V / Qwen-VL / GPT-4o 等），
// 解析返回为 { name, category, qty, note }。下方为调用骨架，未配置密钥时安全返回 disabled。
async function visionApi(photoDataUrl) {
  const key = process.env.VISION_API_KEY;
  const url = process.env.VISION_API_URL;
  if (!key || !url) {
    return { enabled: false, provider: 'visionApi', message: '未配置 VISION_API_KEY / VISION_API_URL' };
  }
  try {
    const resp = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
      body: JSON.stringify({ image: photoDataUrl, prompt: '识别图中物品，返回 JSON: {name, category, qty, note}' }),
    });
    if (!resp.ok) throw new Error('vision api http ' + resp.status);
    const data = await resp.json();
    // 各家模型返回结构不同，这里假定顶层即建议字段；按实际响应调整解析
    const s = data.suggestion || data.result || data;
    return {
      enabled: true, provider: 'visionApi',
      suggestion: {
        name: s.name || '', category: s.category || '', qty: Number(s.qty) || 1, note: s.note || '',
      },
    };
  } catch (e) {
    return { enabled: false, provider: 'visionApi', message: '识别失败: ' + e.message };
  }
}
