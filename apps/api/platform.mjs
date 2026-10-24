// Open supOS 适配：只向配置的服务端身份接口验证 Cookie，不接受代理头中的角色。
export const platformEnabled = process.env.SPATIAL_AUTH_PROVIDER === 'supos';
// demo 是旧版独立库存配置名，兼容读取，统一对外报告 standalone。
const configuredMode = process.env.SPATIAL_MODE || 'standalone';
if (!['standalone','integration','demo'].includes(configuredMode)) throw new Error('SPATIAL_MODE 只支持 standalone 或 integration');
export const inventoryMode = configuredMode === 'integration' ? 'integration' : 'standalone';
export const integrationMode = inventoryMode === 'integration';
export const basePath = (process.env.SPATIAL_BASE_PATH || '').replace(/\/$/, '');
export const publicOrigin = process.env.SPATIAL_PUBLIC_ORIGIN || '';

export async function verifySuposUser(cookie, { url = process.env.SUPOS_USERINFO_URL, fetcher = fetch } = {}) {
  const token = String(cookie || '').split(';').map(x => x.trim()).find(x => x.startsWith('supos_community_token='));
  if (!token || !token.slice(token.indexOf('=') + 1)) return null;
  if (!url) throw new Error('SUPOS_USERINFO_URL 未配置');
  const res = await fetcher(url, { headers: { Cookie: token }, redirect: 'error', signal: AbortSignal.timeout(5000) });
  if (!res.ok) return null;
  const { data } = await res.json();
  const id = data?.id || data?.userId || data?.sub;
  if (data?.enabled === false || !id || !data?.preferredUsername && !data?.username && !data?.userName) return null;
  const username = data.preferredUsername || data.username || data.userName;
  // 可选：逗号分隔的平台用户ID，只授予空间维护权限，不授予同步凭证管理权限。
  const spaceAdmins=(process.env.SPATIAL_SPACE_ADMIN_IDS || '').split(',').map(v=>v.trim()).filter(Boolean);
  return { id: 'supos:' + id, username, name: data.firstName || data.name || username,
    role: data.superAdmin === true ? 'admin' : spaceAdmins.includes(String(id)) ? 'spaceAdmin' : 'viewer', provider: 'supos' };
}

export function sameOriginWrite(req) {
  // Cookie 鉴权写操作必须由同源页面发起；机器请求使用单独凭证。
  const origin = req.get('origin');
  return !!publicOrigin && origin === publicOrigin && req.get('x-spatial-request') === '1';
}
