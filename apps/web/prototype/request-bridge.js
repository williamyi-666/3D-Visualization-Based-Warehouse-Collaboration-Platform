// 平台请求适配与界面独立，出入库台也能使用同一子路径和Cookie写入校验。
(() => {
  const prefix = window.SPATIAL_RUNTIME?.basePath || '';
  const localPath = value => typeof value === 'string' && /^\/(api|uploads|apps)\//.test(value) ? prefix + value : value;
  const originalFetch = window.fetch.bind(window);
  window.fetch = async (input, init = {}) => {
    const headers = new Headers(init.headers || (input instanceof Request ? input.headers : undefined));
    headers.set('X-Spatial-Request', '1');
    const response = await originalFetch(localPath(input), { ...init, headers });
    // 网关可能以302跳到登录页并最终返回200；不能把它当成成功的库存响应。
    if (window.SPATIAL_RUNTIME?.provider === 'supos' && response.redirected) {
      const requestUrl = new URL(input instanceof Request ? input.url : input, window.location.href);
      const target = new URL(response.url);
      const apiPath = requestUrl.pathname === prefix + '/api' || requestUrl.pathname.startsWith(prefix + '/api/') || requestUrl.pathname.startsWith('/api/');
      if (requestUrl.origin === window.location.origin && apiPath && /\/(supos-login|keycloak)(\/|$)/.test(target.pathname)) {
        return new Response(JSON.stringify({error:'会话已过期，请重新登录'}), {
          status:401, headers:{'Content-Type':'application/json'}
        });
      }
    }
    return response;
  };
  const open = window.open.bind(window);
  window.open = (url, ...args) => open(localPath(url), ...args);
})();
