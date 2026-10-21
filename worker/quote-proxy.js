/* Cloudflare Worker：PPtools 報價代理
   用途：取代瀏覽器端不穩的公開 CORS 代理，由 Cloudflare 伺服器端去抓 Yahoo / FinMind / 證交所 / 櫃買 / 期交所 / 券商分點並加上 CORS 標頭。
   用法：GET  https://<你的worker>.workers.dev/?url=<編碼後的目標網址>
         POST 同上，body 原封轉送（僅限 POST_HOSTS，例如期交所 MIS 即時報價）
   只允許白名單網域，避免被當成開放代理濫用。 */
// 網域 → 邊緣快取秒數：盤中即時報價短、官方每日資料長一點（減少被來源限流，又不會卡住當日更新太久）
const ALLOW_HOSTS = {
  'query1.finance.yahoo.com': 30,
  'query2.finance.yahoo.com': 30,
  'api.finmindtrade.com': 30,
  'histock.tw': 30,
  'bsr.twse.com.tw': 120,              // 券商分點（產業族群筆記）
  'fubon-ebrokerdj.fbs.com.tw': 120,   // 券商分點備援（產業族群筆記）
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

/* Yahoo 對雲端機房 IP 常回 401／429，要求先取得 cookie 與 crumb。
   失敗時依序：換 query2 主機 → 帶 cookie＋crumb 重抓；crumb 存在 isolate 記憶體內重複使用。 */
let yahooAuth = null; // { cookie, crumb }
async function getYahooAuth(force) {
  if (yahooAuth && !force) return yahooAuth;
  const r = await fetch('https://fc.yahoo.com/', { headers: { 'User-Agent': UA }, redirect: 'manual' });
  const cookie = (r.headers.get('set-cookie') || '').split(/,(?=\s*\w+=)/).map(c => c.split(';')[0].trim()).filter(Boolean).join('; ');
  if (!cookie) throw new Error('yahoo cookie unavailable');
  const c = await fetch('https://query2.finance.yahoo.com/v1/test/getcrumb', { headers: { 'User-Agent': UA, Cookie: cookie } });
  const crumb = (await c.text()).trim();
  if (!c.ok || !crumb || crumb.length > 64) throw new Error('yahoo crumb unavailable');
  yahooAuth = { cookie, crumb };
  return yahooAuth;
}
async function fetchYahoo(target, cf) {
  const isBlocked = r => r.status === 401 || r.status === 403 || r.status === 429;
  let res = await fetch(target.toString(), { headers: { 'User-Agent': UA }, cf });
  if (!isBlocked(res)) return res;
  const alt = new URL(target);
  alt.hostname = target.hostname === 'query1.finance.yahoo.com' ? 'query2.finance.yahoo.com' : 'query1.finance.yahoo.com';
  res = await fetch(alt.toString(), { headers: { 'User-Agent': UA }, cf });
  if (!isBlocked(res)) return res;
  for (const force of [false, true]) {
    const auth = await getYahooAuth(force);
    const u = new URL(alt);
    u.searchParams.set('crumb', auth.crumb);
    res = await fetch(u.toString(), { headers: { 'User-Agent': UA, Cookie: auth.cookie } });
    if (!isBlocked(res)) return res;
  }
  return res;
}

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
    try {
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
        const cf = { cacheTtlByStatus: { '200-299': ttl, '300-599': 0 }, cacheEverything: true }; // 只快取成功回應，錯誤不卡在邊緣
        res = target.hostname.endsWith('.finance.yahoo.com')
          ? await fetchYahoo(target, cf)
          : await fetch(target.toString(), { headers: { 'User-Agent': UA }, cf });
      }
    } catch (e) {
      // 來源連線失敗也要帶 CORS 標頭回應，瀏覽器端才看得到原因，而不是只顯示「網路不通」
      return new Response('upstream error: ' + (e && e.message || e), { status: 502, headers: { ...cors, 'Cache-Control': 'no-store' } });
    }
    const h = new Headers(cors);
    h.set('Content-Type', res.headers.get('Content-Type') || 'application/json');
    h.set('Cache-Control', isPost || !res.ok ? 'no-store' : 'public, max-age=' + ALLOW_HOSTS[target.hostname]);
    return new Response(res.body, { status: res.status, headers: h });
  },
};
