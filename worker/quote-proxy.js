/* Cloudflare Worker：PPtools 報價代理
   用途：取代瀏覽器端不穩的公開 CORS 代理，由 Cloudflare 伺服器端去抓 Yahoo / FinMind 並加上 CORS 標頭。
   用法：GET https://<你的worker>.workers.dev/?url=<編碼後的目標網址>
   只允許白名單網域，避免被當成開放代理濫用。 */
const ALLOW_HOSTS = ['query1.finance.yahoo.com', 'query2.finance.yahoo.com', 'api.finmindtrade.com'];
// 只允許這些網站的網頁呼叫；沒有 Origin 的請求（直接在網址列打開測試）也放行
const ALLOW_ORIGINS = ['https://pigax.github.io'];

export default {
  async fetch(request) {
    const origin = request.headers.get('Origin') || '';
    const okOrigin = !origin || !ALLOW_ORIGINS.length || ALLOW_ORIGINS.includes(origin);
    const cors = {
      'Access-Control-Allow-Origin': okOrigin ? (origin || '*') : 'null',
      'Access-Control-Allow-Methods': 'GET, OPTIONS',
      Vary: 'Origin',
    };
    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });
    if (!okOrigin) return new Response('forbidden', { status: 403, headers: cors });

    let target;
    try { target = new URL(new URL(request.url).searchParams.get('url')); }
    catch { return new Response('bad url', { status: 400, headers: cors }); }
    if (target.protocol !== 'https:' || !ALLOW_HOSTS.includes(target.hostname)) {
      return new Response('host not allowed', { status: 403, headers: cors });
    }

    const res = await fetch(target.toString(), {
      headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/124.0 Safari/537.36' },
      cf: { cacheTtl: 30, cacheEverything: true }, // 邊緣快取 30 秒，減少被 Yahoo 限流
    });
    const h = new Headers(cors);
    h.set('Content-Type', res.headers.get('Content-Type') || 'application/json');
    h.set('Cache-Control', 'public, max-age=30');
    return new Response(res.body, { status: res.status, headers: h });
  },
};
