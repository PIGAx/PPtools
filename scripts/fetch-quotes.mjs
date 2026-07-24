#!/usr/bin/env node
/* ════════════════════════════════════════════════════════════════════════
   PPtools — 每日報價快照抓取（在 GitHub Actions 伺服器端執行）
   ------------------------------------------------------------------------
   為什麼要有這支程式：
     網站各模組原本都在「瀏覽器端」即時去抓 TWSE / TPEX / Yahoo，
     常因 CORS、代理伺服器、對方限流而變慢或抓不到，使用者每次都要等。
     本程式改由 GitHub Actions（美國伺服器、無 CORS、可直連）每天定時
     抓好指數與股價，寫成 data/quotes.json commit 回 repo，網站直接讀
     這個靜態檔即可秒開，抓取失敗時模組再走原本的即時抓取當備援。

   產出：data/quotes.json（見檔尾結構）。
   設計原則：
     - 「合併更新」：讀取現有 quotes.json，只覆蓋這次抓成功的區塊，
       某來源暫時掛掉時保留上一次的好資料（標記 stale），不會把好資料清空。
     - 對欄位名稱寬容（官方 API 有時中文鍵、有時英文鍵），用 pick() 容錯。
     - 單一來源失敗不讓整個流程失敗；只有「完全沒抓到任何東西」才 exit 1。
   ════════════════════════════════════════════════════════════════════════ */

import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..');
const OUT_PATH = resolve(ROOT, 'data/quotes.json');
const US_SYMBOLS_PATH = resolve(ROOT, 'data/us-symbols.json');

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';

/* ── 小工具 ── */
const nowIso = () => new Date().toISOString();

function num(v) {
  if (v == null) return null;
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  const s = String(v).replace(/,/g, '').replace(/\s/g, '').replace(/[+]/g, '').trim();
  if (s === '' || s === '--' || s === '-' || s === 'N/A' || s.toLowerCase() === 'null') return null;
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}

/* 依候選鍵（字串或 RegExp）取值，容忍中英文欄位名差異 */
function pick(obj, keys) {
  if (!obj) return undefined;
  const entries = Object.keys(obj);
  for (const k of keys) {
    if (typeof k === 'string') {
      if (k in obj) return obj[k];
    } else {
      const hit = entries.find((ek) => k.test(ek));
      if (hit) return obj[hit];
    }
  }
  return undefined;
}

async function fetchJson(url, { timeout = 25000, headers = {} } = {}) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeout);
  try {
    const res = await fetch(url, {
      signal: ctrl.signal,
      headers: { 'User-Agent': UA, Accept: 'application/json, text/plain, */*', ...headers },
    });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    return await res.json();
  } finally {
    clearTimeout(timer);
  }
}

/* Yahoo v8 chart：回傳 { price, prevClose, change, changePct } */
async function fetchYahooQuote(symbol) {
  const url =
    'https://query1.finance.yahoo.com/v8/finance/chart/' +
    encodeURIComponent(symbol) +
    '?range=1d&interval=1d&includePrePost=false';
  const data = await fetchJson(url);
  const result = data?.chart?.result?.[0];
  if (!result) throw new Error('no data for ' + symbol);
  const meta = result.meta || {};
  const closes = result.indicators?.quote?.[0]?.close || [];
  const validCloses = closes.filter((v) => v != null);
  const lastClose = validCloses.length ? validCloses[validCloses.length - 1] : null;
  const price = meta.regularMarketPrice ?? lastClose ?? null;
  const prev = meta.chartPreviousClose ?? meta.previousClose ?? null;
  return {
    price: num(price),
    prevClose: num(prev),
    change: price != null && prev != null ? +(price - prev).toFixed(4) : null,
    changePct: price != null && prev ? +(((price - prev) / prev) * 100).toFixed(4) : null,
    currency: meta.currency || null,
    asOf: meta.regularMarketTime ? new Date(meta.regularMarketTime * 1000).toISOString() : nowIso(),
    source: 'Yahoo',
  };
}

/* Yahoo v8 chart 走勢序列：回傳 { intra:{labels,closes,prevClose}, month:{labels,closes}, price, change, changePct }
   給網站的走勢圖用。瀏覽器端直抓 ^TWOII / WTX&（台指期）常被 CORS／代理擋掉，
   改由伺服器端（美國 IP、可直連 Yahoo）抓好存進快照，網站讀同源靜態檔即可畫圖。 */
async function fetchYahooSeries(symbol) {
  async function one(range, interval) {
    const url =
      'https://query1.finance.yahoo.com/v8/finance/chart/' +
      encodeURIComponent(symbol) +
      `?range=${range}&interval=${interval}&includePrePost=false`;
    const data = await fetchJson(url);
    const result = data?.chart?.result?.[0];
    if (!result) throw new Error('no data for ' + symbol);
    const meta = result.meta || {};
    const closes = (result.indicators?.quote?.[0]?.close || []).map((v) => (v == null ? null : num(v)));
    const timestamps = result.timestamp || [];
    const intraday = /m$/.test(interval);
    const labels = timestamps.map((t) => {
      const d = new Date(t * 1000 + 8 * 3600 * 1000); // 以台北時間標記時間軸
      return intraday
        ? `${d.getUTCHours()}:${String(d.getUTCMinutes()).padStart(2, '0')}`
        : `${d.getUTCMonth() + 1}/${d.getUTCDate()}`;
    });
    const valid = closes.filter((v) => v != null);
    const lastClose = valid.length ? valid[valid.length - 1] : null;
    const price = num(meta.regularMarketPrice) ?? lastClose ?? null;
    const prev = num(meta.chartPreviousClose ?? meta.previousClose) ?? null;
    return { labels, closes, price, prev };
  }
  const [ir, mr] = await Promise.allSettled([one('1d', '5m'), one('1mo', '1d')]);
  if (ir.status !== 'fulfilled' && mr.status !== 'fulfilled') {
    throw ir.reason || mr.reason || new Error('series empty for ' + symbol);
  }
  const out = { intra: null, month: null, price: null, change: null, changePct: null };
  if (ir.status === 'fulfilled') {
    out.intra = { labels: ir.value.labels, closes: ir.value.closes, prevClose: ir.value.prev };
    out.price = ir.value.price;
    if (ir.value.price != null && ir.value.prev != null) {
      out.change = +(ir.value.price - ir.value.prev).toFixed(4);
      out.changePct = ir.value.prev ? +(((ir.value.price - ir.value.prev) / ir.value.prev) * 100).toFixed(4) : null;
    }
  }
  if (mr.status === 'fulfilled') {
    out.month = { labels: mr.value.labels, closes: mr.value.closes };
    if (out.price == null) {
      out.price = mr.value.price;
      if (mr.value.price != null && mr.value.prev != null) {
        out.change = +(mr.value.price - mr.value.prev).toFixed(4);
        out.changePct = mr.value.prev ? +(((mr.value.price - mr.value.prev) / mr.value.prev) * 100).toFixed(4) : null;
      }
    }
  }
  return out;
}

/* ── 台股加權指數（TWSE FMTQIK，官方、取最後一筆） ── */
async function fetchTaiex() {
  const rows = await fetchJson('https://openapi.twse.com.tw/v1/exchangeReport/FMTQIK');
  if (!Array.isArray(rows) || !rows.length) throw new Error('FMTQIK empty');
  const last = rows[rows.length - 1];
  const price = num(pick(last, [/加權股價指數/, /TAIEX/i, 'Index', '收盤指數']));
  const change = num(pick(last, [/漲跌點數/, /Change/i]));
  const date = pick(last, [/日期/, /Date/i]);
  if (price == null) throw new Error('FMTQIK no index value; keys=' + Object.keys(last).join(','));
  const prev = change != null ? +(price - change).toFixed(2) : null;
  return {
    name: '加權指數',
    price,
    change,
    changePct: prev ? +((change / prev) * 100).toFixed(2) : null,
    prevClose: prev,
    date: rocOrIsoDate(date),
    asOf: nowIso(),
    source: 'TWSE FMTQIK',
  };
}

/* ── 櫃買指數（TPEX openapi「上櫃概況」，官方） ── */
async function fetchOtcIndex() {
  const urls = [
    'https://www.tpex.org.tw/openapi/v1/tpex_mainboard_highlight',
    'https://www.tpex.org.tw/openapi/v1/tpex_mainborad_highlight', // 官方曾用的拼字，保留備援
  ];
  let rows = null;
  let lastErr = null;
  for (const u of urls) {
    try {
      rows = await fetchJson(u);
      if (Array.isArray(rows) && rows.length) break;
    } catch (e) {
      lastErr = e;
    }
  }
  if (!Array.isArray(rows) || !rows.length) throw lastErr || new Error('TPEX highlight empty');
  const r = rows[0];
  const price = num(pick(r, [/收盤指數|指數/, /index/i, 'Close']));
  const change = num(pick(r, [/漲跌|Change/i]));
  const date = pick(r, [/日期|Date/i]);
  if (price == null) throw new Error('TPEX no index value; keys=' + Object.keys(r).join(','));
  const prev = change != null ? +(price - change).toFixed(2) : null;
  return {
    name: '櫃買指數',
    price,
    change,
    changePct: prev ? +((change / prev) * 100).toFixed(2) : null,
    prevClose: prev,
    date: rocOrIsoDate(date),
    asOf: nowIso(),
    source: 'TPEX',
  };
}

/* 民國日期 (1130723 / 113/07/23) → 西元 YYYY-MM-DD；西元則原樣清洗 */
function rocOrIsoDate(v) {
  if (!v) return null;
  const s = String(v).trim();
  const digits = s.replace(/\D/g, '');
  if (digits.length === 8 && digits.startsWith('20')) {
    return `${digits.slice(0, 4)}-${digits.slice(4, 6)}-${digits.slice(6, 8)}`;
  }
  if (digits.length === 7) {
    const y = 1911 + Number(digits.slice(0, 3));
    return `${y}-${digits.slice(3, 5)}-${digits.slice(5, 7)}`;
  }
  const m = s.match(/(\d{2,4})\D(\d{1,2})\D(\d{1,2})/);
  if (m) {
    let y = Number(m[1]);
    if (y < 1911) y += 1911;
    return `${y}-${String(m[2]).padStart(2, '0')}-${String(m[3]).padStart(2, '0')}`;
  }
  return s;
}

/* ── 全上市個股當日收盤（TWSE STOCK_DAY_ALL） ── */
async function fetchTwseStocks() {
  const rows = await fetchJson('https://openapi.twse.com.tw/v1/exchangeReport/STOCK_DAY_ALL', {
    timeout: 40000,
  });
  if (!Array.isArray(rows) || !rows.length) throw new Error('STOCK_DAY_ALL empty');
  const out = {};
  for (const r of rows) {
    const code = String(pick(r, ['Code', /證券代號|代號/]) ?? '').trim();
    if (!code) continue;
    const close = num(pick(r, ['ClosingPrice', /收盤價/]));
    const change = num(pick(r, ['Change', /漲跌/]));
    const prev = close != null && change != null ? +(close - change).toFixed(2) : null;
    out[code] = {
      name: String(pick(r, ['Name', /證券名稱|名稱/]) ?? '').trim(),
      close,
      change,
      changePct: prev ? +((change / prev) * 100).toFixed(2) : null,
      volume: num(pick(r, ['TradeVolume', /成交股數/])),
      market: 'TWSE',
    };
  }
  return out;
}

/* ── 全上櫃個股當日收盤（TPEX openapi） ── */
async function fetchTpexStocks() {
  const urls = [
    'https://www.tpex.org.tw/openapi/v1/tpex_mainboard_quotes',
    'https://www.tpex.org.tw/openapi/v1/tpex_mainborad_quotes',
  ];
  let rows = null;
  let lastErr = null;
  for (const u of urls) {
    try {
      rows = await fetchJson(u, { timeout: 40000 });
      if (Array.isArray(rows) && rows.length) break;
    } catch (e) {
      lastErr = e;
    }
  }
  if (!Array.isArray(rows) || !rows.length) throw lastErr || new Error('TPEX quotes empty');
  const out = {};
  for (const r of rows) {
    const code = String(pick(r, ['SecuritiesCompanyCode', 'Code', /代號|股票代號/]) ?? '').trim();
    if (!code) continue;
    const close = num(pick(r, ['Close', /收盤/]));
    const change = num(pick(r, ['Change', /漲跌/]));
    const prev = close != null && change != null ? +(close - change).toFixed(2) : null;
    out[code] = {
      name: String(pick(r, ['CompanyName', 'Name', /名稱/]) ?? '').trim(),
      close,
      change,
      changePct: prev ? +((change / prev) * 100).toFixed(2) : null,
      volume: num(pick(r, ['TradeVolume', /成交股數|成交量/])),
      market: 'TPEX',
    };
  }
  return out;
}

/* ── 三大法人買賣超（外資／投信／自營商／合計），依日期回退找最近有資料的交易日 ──
   台股 T86 / TPEX 欄位順序偶有變動，一律用回傳的 fields 名稱定位欄位，較保險。 */
function twDateStr(offsetDays = 0) {
  // 以台北時間（UTC+8）為準推算日期字串 YYYYMMDD
  const d = new Date(Date.now() + 8 * 3600 * 1000 - offsetDays * 86400000);
  return (
    d.getUTCFullYear().toString() +
    String(d.getUTCMonth() + 1).padStart(2, '0') +
    String(d.getUTCDate()).padStart(2, '0')
  );
}

/* 在 fields 陣列中找第一個「全部 matcher 皆命中」的欄位索引 */
function fieldIdx(fields, matchers) {
  return fields.findIndex((f) => {
    const name = String(f);
    return matchers.every((m) => (m instanceof RegExp ? m.test(name) : name.includes(m)));
  });
}

/* 上市三大法人（TWSE T86，selectType=ALL）。回傳 { date, map } 或 null */
async function fetchTwseInst(dateStr) {
  const data = await fetchJson(
    `https://www.twse.com.tw/rwd/zh/fund/T86?date=${dateStr}&selectType=ALL&response=json`
  );
  if (data.stat !== 'OK' || !Array.isArray(data.data) || !data.data.length) return null;
  const fields = data.fields || [];
  const iForeignExcl = fieldIdx(fields, [/外/, /買賣超/, /不含外資自營商/]);
  // 「外資自營商買賣超」欄位；務必排除「不含外資自營商」那欄（否則外資會被重複相加）
  const iForeignDealer = fields.findIndex(
    (f) => /外資自營商/.test(String(f)) && /買賣超/.test(String(f)) && !/不含/.test(String(f))
  );
  const iTrust = fieldIdx(fields, [/投信/, /買賣超/]);
  const iDealerTotal = fields.findIndex((f) => /^自營商買賣超股數\s*$/.test(String(f)));
  const iDealerSelf = fieldIdx(fields, [/自營商/, /買賣超/, /自行/]);
  const iDealerHedge = fieldIdx(fields, [/自營商/, /買賣超/, /避險/]);
  const iTotal = fieldIdx(fields, [/三大法人/, /買賣超/]);
  const lots = (v) => (num(v) == null ? 0 : Math.round(num(v) / 1000)); // 股 → 張
  const map = {};
  for (const row of data.data) {
    const code = String(row[0]).trim();
    if (!/^\d{4,5}$/.test(code)) continue; // 只留個股與 ETF，排除權證/ETN（6 碼以上）
    const foreign =
      lots(row[iForeignExcl]) + (iForeignDealer >= 0 ? lots(row[iForeignDealer]) : 0);
    const trust = iTrust >= 0 ? lots(row[iTrust]) : 0;
    const dealer =
      iDealerTotal >= 0
        ? lots(row[iDealerTotal])
        : lots(row[iDealerSelf]) + lots(row[iDealerHedge]);
    const total = iTotal >= 0 ? lots(row[iTotal]) : foreign + trust + dealer;
    map[code] = { f: foreign, t: trust, d: dealer, s: total };
  }
  return { date: rocOrIsoDate(data.date) || null, map, fields, idx: { iForeignExcl, iForeignDealer, iTrust, iDealerTotal, iTotal } };
}

/* 上櫃三大法人（TPEX）。新版 dailyTrade 有 fields；舊版 aaData 無，退回只給合計 */
async function fetchTpexInst(dateStr) {
  const y = parseInt(dateStr.substring(0, 4), 10) - 1911;
  const rocDate = `${y}/${dateStr.substring(4, 6)}/${dateStr.substring(6, 8)}`;
  const lots = (v) => (num(v) == null ? 0 : Math.round(num(v) / 1000));
  // 新版 API（含 fields）
  try {
    const data = await fetchJson(
      `https://www.tpex.org.tw/www/zh-tw/insti/dailyTrade?type=Daily&sect=EW&date=${rocDate}&id=&response=json`
    );
    const tbl = data?.tables?.[0];
    const rows = tbl?.data;
    const fields = tbl?.fields || tbl?.title || [];
    if (Array.isArray(rows) && rows.length && Array.isArray(fields) && fields.length) {
      // TPEX EW（含外資自營商與自營商避險）欄位名稱皆為通用「買/賣/買賣超股數」，
      // 無法用名稱定位，改用固定版面（0代號 1名稱 + 7 組買賣超 + 合計 = 24 欄）：
      //   組別淨額索引 → 4 外陸資(不含自營)｜7 外資自營商｜10 外資合計｜13 投信
      //                  16 自營(自行)｜19 自營(避險)｜22 自營合計｜23 三大法人合計
      const n = fields.length;
      const lastIsTotal = /三大法人/.test(String(fields[n - 1]));
      const positional = n === 24 && lastIsTotal;
      const map = {};
      for (const row of rows) {
        const code = String(row[0]).trim();
        if (!/^\d{4,5}$/.test(code)) continue;
        if (positional) {
          const foreign = lots(row[10]); // 外資及陸資合計 淨（含外資自營商）
          const trust = lots(row[13]);   // 投信 淨
          const dealer = lots(row[22]);  // 自營商合計 淨
          const total = lots(row[23]);   // 三大法人合計 淨
          map[code] = { f: foreign, t: trust, d: dealer, s: total };
        } else {
          const total = lastIsTotal ? lots(row[n - 1]) : null;
          map[code] = { f: null, t: null, d: null, s: total };
        }
      }
      if (!positional) console.error('  TPEX 版面非預期(欄位數 ' + n + ')，僅存合計；fields=' + JSON.stringify(fields));
      return { date: rocOrIsoDate(rocDate), map, partial: !positional };
    }
  } catch (e) { /* 退回舊版 */ }
  // 舊版 API（aaData，欄位固定，只可靠取到外資與合計）
  try {
    const data2 = await fetchJson(
      `https://www.tpex.org.tw/web/stock/3insti/daily_trade/3itrade_hedge_result.php?l=zh-tw&se=EW&t=D&d=${rocDate}&o=json`
    );
    const rows = data2?.aaData;
    if (Array.isArray(rows) && rows.length) {
      const map = {};
      for (const row of rows) {
        const code = String(row[0]).trim();
        if (!/^\d{4,5}$/.test(code)) continue;
        const foreign = lots(row[3]);
        const total = lots(row[row.length - 1]);
        map[code] = { f: foreign, t: null, d: null, s: total };
      }
      return { date: rocOrIsoDate(rocDate), map, partial: true };
    }
  } catch (e) { /* 無資料 */ }
  return null;
}

async function fetchTwInstitutions() {
  // 由今天往回找最多 6 天，找到第一個有 T86 資料的交易日
  let listed = null;
  let usedDate = null;
  for (let off = 0; off <= 6 && !listed; off++) {
    try {
      const r = await fetchTwseInst(twDateStr(off));
      if (r && Object.keys(r.map).length) {
        listed = r;
        usedDate = twDateStr(off);
      }
    } catch (e) { /* 試下一天 */ }
  }
  if (!listed) return null;
  if (listed.idx) {
    console.error('  T86 欄位索引:', JSON.stringify(listed.idx), '| 樣本 2330:', JSON.stringify(listed.map['2330']));
  }
  const map = { ...listed.map };
  // 上櫃用同一個交易日
  try {
    const otc = await fetchTpexInst(usedDate);
    if (otc && otc.map) {
      Object.assign(map, otc.map);
      if (otc.partial) console.error('  TPEX 法人：舊版 API，僅外資/合計可靠');
    }
  } catch (e) { console.error('  TPEX 法人失敗:', e.message); }
  return { date: listed.date, count: Object.keys(map).length, stocks: map };
}

async function loadExisting() {
  try {
    return JSON.parse(await readFile(OUT_PATH, 'utf8'));
  } catch {
    return {};
  }
}

async function loadUsSymbols() {
  try {
    const cfg = JSON.parse(await readFile(US_SYMBOLS_PATH, 'utf8'));
    const list = Array.isArray(cfg?.symbols) ? cfg.symbols : [];
    return [...new Set(list.map((s) => String(s).trim().toUpperCase()).filter(Boolean))];
  } catch {
    return [];
  }
}

async function main() {
  const prev = await loadExisting();
  const out = {
    generatedAt: nowIso(),
    indices: { ...(prev.indices || {}) },
    fx: { ...(prev.fx || {}) },
    series: { ...(prev.series || {}) }, // 走勢圖序列（TWII / TWOII / USDTWD / TXF）供網站免 CORS 直接畫圖
    tw: prev.tw || null,
    twInst: prev.twInst || null,
    us: { ...(prev.us || {}) },
    errors: [],
  };

  const fail = (label, e) => {
    const msg = `${label}: ${e && e.message ? e.message : e}`;
    console.error('  ✗ ' + msg);
    out.errors.push(msg);
  };
  const markStale = (obj) => {
    if (obj && typeof obj === 'object') obj.stale = true;
  };

  /* 台股指數 — 官方來源，個別容錯 */
  console.error('· 台股指數');
  try {
    out.indices.TWII = await fetchTaiex();
  } catch (e) {
    fail('TWII', e);
    markStale(out.indices.TWII);
  }
  try {
    out.indices.TWOII = await fetchOtcIndex();
  } catch (e) {
    fail('TWOII', e);
    markStale(out.indices.TWOII);
  }

  /* 台指期近月 — 磚面數值 + 走勢序列。
     Yahoo 對台灣期交所 TX 沒有穩定代碼（WTX& 常回空），逐一嘗試多個候選代碼，
     並用「價位須與加權指數同量級」把量級不符的來源（如 SGX 富時台灣期貨）排除，
     取第一個合理的。全部失敗則 TXF 留空，網站前端會退回近一月／即時報價。 */
  console.error('· 台指期近月');
  const twiiRef = out.indices.TWII?.price ?? null;
  const sane = (p) => p != null && (twiiRef == null || (p > twiiRef * 0.7 && p < twiiRef * 1.3));
  const TXF_SYMBOLS = ['WTX&', 'WTX=F', 'TXF=F', '^TWIIF'];
  let txf = null, txfSym = null;
  for (const sym of TXF_SYMBOLS) {
    try {
      const s = await fetchYahooSeries(sym);
      const seriesPrice = s.price ?? (s.intra?.closes || s.month?.closes || []).filter((v) => v != null).slice(-1)[0] ?? null;
      if (sane(seriesPrice)) { txf = s; txfSym = sym; break; }
    } catch (e) { /* 試下一個候選代碼 */ }
  }
  if (txf) {
    out.indices.TXF = {
      name: '台指期近月',
      price: txf.price,
      change: txf.change,
      changePct: txf.changePct,
      date: out.indices.TWII?.date || null,
      asOf: nowIso(),
      source: 'Yahoo ' + txfSym,
    };
    out.series.TXF = { intra: txf.intra, month: txf.month, asOf: nowIso() };
  } else {
    fail('TXF', '所有候選代碼皆無合理報價（' + TXF_SYMBOLS.join('／') + '）');
    markStale(out.indices.TXF);
    markStale(out.series.TXF);
  }

  /* 走勢圖序列：加權指數 / 櫃買指數 / 美元台幣，供網站畫日內＋近一月線圖 */
  console.error('· 走勢圖序列');
  const seriesTargets = [
    ['TWII', '^TWII'],
    ['TWOII', '^TWOII'],
    ['USDTWD', 'TWD=X'],
  ];
  for (const [key, sym] of seriesTargets) {
    try {
      const s = await fetchYahooSeries(sym);
      out.series[key] = { intra: s.intra, month: s.month, asOf: nowIso() };
    } catch (e) {
      fail('series ' + key, e);
      markStale(out.series[key]);
    }
  }

  /* 匯率 + 美股指數 — Yahoo */
  console.error('· 匯率 / 美股指數');
  const yahooIndex = [
    ['USDTWD', 'TWD=X', '美元/台幣', 'fx'],
    ['DJI', '^DJI', '道瓊工業', 'indices'],
    ['GSPC', '^GSPC', 'S&P 500', 'indices'],
    ['IXIC', '^IXIC', '納斯達克', 'indices'],
    ['SOX', '^SOX', '費城半導體', 'indices'],
  ];
  for (const [key, sym, name, bucket] of yahooIndex) {
    try {
      const q = await fetchYahooQuote(sym);
      out[bucket][key] = { name, ...q };
    } catch (e) {
      fail(key, e);
      markStale(out[bucket][key]);
    }
  }

  /* 台股全個股收盤 */
  console.error('· 台股個股收盤');
  const twStocks = {};
  let twOk = false;
  let twDate = null;
  try {
    Object.assign(twStocks, await fetchTwseStocks());
    twOk = true;
  } catch (e) {
    fail('TWSE stocks', e);
  }
  try {
    Object.assign(twStocks, await fetchTpexStocks());
    twOk = true;
  } catch (e) {
    fail('TPEX stocks', e);
  }
  if (twOk) {
    twDate = out.indices.TWII?.date || out.indices.TWOII?.date || null;
    out.tw = { date: twDate, count: Object.keys(twStocks).length, stocks: twStocks };
  } else {
    markStale(out.tw);
  }

  /* 三大法人買賣超（外資／投信／自營商／合計） */
  console.error('· 三大法人買賣超');
  try {
    const inst = await fetchTwInstitutions();
    if (inst && inst.count > 0) out.twInst = inst;
    else { fail('twInst', 'no data'); markStale(out.twInst); }
  } catch (e) {
    fail('twInst', e);
    markStale(out.twInst);
  }

  /* 美股觀察清單 */
  const usSymbols = await loadUsSymbols();
  if (usSymbols.length) {
    console.error(`· 美股觀察清單（${usSymbols.length} 檔）`);
    for (const sym of usSymbols) {
      try {
        const q = await fetchYahooQuote(sym);
        out.us[sym] = { ...q };
      } catch (e) {
        fail('US ' + sym, e);
        markStale(out.us[sym]);
      }
    }
  }

  /* 至少要抓到一點東西，否則不覆蓋（保留舊檔） */
  const gotSomething =
    Object.keys(out.indices).length > 0 ||
    (out.tw && out.tw.count > 0) ||
    Object.keys(out.us).length > 0;
  if (!gotSomething) {
    console.error('全部來源皆失敗，保留現有 quotes.json 不覆蓋。');
    process.exit(1);
  }

  await mkdir(dirname(OUT_PATH), { recursive: true });
  await writeFile(OUT_PATH, JSON.stringify(out, null, 2) + '\n', 'utf8');
  console.error(
    `✓ 已寫入 ${OUT_PATH}｜指數 ${Object.keys(out.indices).length}｜台股 ${
      out.tw?.count || 0
    }｜法人 ${out.twInst?.count || 0}｜美股 ${Object.keys(out.us).length}｜錯誤 ${out.errors.length}`
  );
}

main().catch((e) => {
  console.error('未預期錯誤：', e);
  process.exit(1);
});
