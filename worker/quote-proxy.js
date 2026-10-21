/* Cloudflare Worker：PPtools 報價代理
   用途：取代瀏覽器端不穩的公開 CORS 代理，由 Cloudflare 伺服器端去抓 Yahoo / FinMind / 證交所 / 櫃買 / 期交所並加上 CORS 標頭。
   用法：GET  https://<你的worker>.workers.dev/?url=<編碼後的目標網址>
         POST 同上，body 原封轉送（僅限 POST_HOSTS，例如期交所 MIS 即時報價）
   只允許白名單網域，避免被當成開放代理濫用。 */
// 網域 → 邊緣快取秒數：盤中即時報價短、官方每日資料長一點（減少被來源限流，又不會卡住當日更新太久）
const ALLOW_HOSTS = {
  'query1.finance.yahoo.com': 30,
  'query2.finance.yahoo.com': 30,
  'api.finmindtrade.com': 30,
  'histock.tw': 30,
  'openapi.twse.com.tw': 120,
  'www.twse.com.tw': 120,
  'openapi.tpex.org.tw': 120,
  'www.tpex.org.tw': 120,
  'openapi.taifex.com.tw': 120,
};
// 允許 POST 的網域（即時報價，不快取）
const POST_HOSTS = ['mis.taifex.com.tw'];
// 只允許這些網站的網頁呼叫；沒有 Origin 的請求（直接在網址列打開測試）也放行
const ALLOW_ORIGINS = ['https://pigax.github.io'];
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/124.0 Safari/537.36';

export default {
  async fetch(request) {
    const origin = request.headers.get('Origin') || '';
    const okOrigin = !origin || !ALLOW_ORIGINS.length || ALLOW_ORIGINS.includes(origin);
    const cors = {
      'Access-Control-Allow-Origin': okOrigin ? (origin || '*') : 'null',
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
      Vary: 'Origin',
    };
    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });
    if (!okOrigin) return new Response('forbidden', { status: 403, headers: cors });

    let target;
    try { target = new URL(new URL(request.url).searchParams.get('url')); }
    catch { return new Response('bad url', { status: 400, headers: cors }); }
    const isPost = request.method === 'POST';
    const allowed = isPost ? POST_HOSTS.includes(target.hostname) : target.hostname in ALLOW_HOSTS;
    if (target.protocol !== 'https:' || !allowed) {
      return new Response('host not allowed', { status: 403, headers: cors });
    }

    let res;
    if (isPost) {
      res = await fetch(target.toString(), {
        method: 'POST',
        headers: {
          'User-Agent': UA,
          'Content-Type': request.headers.get('Content-Type') || 'application/json',
          Referer: target.origin + '/',
        },
        body: await request.text(),
      });
    } else {
      const ttl = ALLOW_HOSTS[target.hostname];
      res = await fetch(target.toString(), {
        headers: { 'User-Agent': UA },
        cf: { cacheTtlByStatus: { '200-299': ttl, '300-599': 0 }, cacheEverything: true }, // 只快取成功回應，錯誤不卡在邊緣
      });
    }
    const h = new Headers(cors);
    h.set('Content-Type', res.headers.get('Content-Type') || 'application/json');
    h.set('Cache-Control', isPost || !res.ok ? 'no-store' : 'public, max-age=' + ALLOW_HOSTS[target.hostname]);
    return new Response(res.body, { status: res.status, headers: h });
  },
};
