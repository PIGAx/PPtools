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
    tw: prev.tw || null,
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
    }｜美股 ${Object.keys(out.us).length}｜錯誤 ${out.errors.length}`
  );
}

main().catch((e) => {
  console.error('未預期錯誤：', e);
  process.exit(1);
});
