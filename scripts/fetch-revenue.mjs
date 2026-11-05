#!/usr/bin/env node
/* ════════════════════════════════════════════════════════════════════════
   PPtools — 營收追蹤：自動抓公開資訊觀測站月營收與季 EPS（GitHub Actions 執行）
   ------------------------------------------------------------------------
   追蹤哪些公司：data/revenue.json 的 companies（新增公司就在那裡加一筆）。
   資料來源（證交所／櫃買中心 OpenAPI，內容即公開資訊觀測站彙總表）：
     月營收  上市 t187ap05_L｜上櫃 mopsfin_t187ap05_O｜興櫃 mopsfin_t187ap05_R（千元）
     季 EPS  上市 t187ap14_L｜上櫃 mopsfin_t187ap14_O
   規則：
     - 月營收：新月份直接新增；既有月份以官方值覆蓋手填值（並記錄差異）。
     - 季 EPS：只填「尚未有值」的季，不覆蓋人工填的口徑（例如 Statementdog 3.41）。
       彙總表 EPS 可能是累計值，用報表營收對照月營收自動判斷，判斷不出來就不寫。
     - 券商預估、判斷、備註都是人工欄位，本程式不動。
     - 沒有任何變動就不寫檔（避免每天產生空 commit）。
   有新資料且設定了 TELEGRAM_BOT_TOKEN／TELEGRAM_CHAT_ID 時，順便發 Telegram 通知。
   ════════════════════════════════════════════════════════════════════════ */
import { readFile, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const R = require('../pp-revenue.js');
const { sendTelegram } = require('../pp-stop-alert.js');

const DATA_PATH = new URL('../data/revenue.json', import.meta.url);
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';

const REVENUE_SOURCES = {
  TWSE: ['https://openapi.twse.com.tw/v1/opendata/t187ap05_L'],
  TPEX: ['https://www.tpex.org.tw/openapi/v1/mopsfin_t187ap05_O'],
  ESB:  ['https://www.tpex.org.tw/openapi/v1/mopsfin_t187ap05_R'],
};
const EPS_SOURCES = {
  TWSE: ['https://openapi.twse.com.tw/v1/opendata/t187ap14_L'],
  TPEX: ['https://www.tpex.org.tw/openapi/v1/mopsfin_t187ap14_O'],
};

async function fetchJson(url) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 40000);
  try {
    const res = await fetch(url, { signal: ctrl.signal, headers: { 'User-Agent': UA, Accept: 'application/json' } });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const j = await res.json();
    if (!Array.isArray(j)) throw new Error('回應不是陣列');
    return j;
  } finally {
    clearTimeout(timer);
  }
}

/* 同一個資料集只抓一次，多家公司共用 */
const cache = new Map();
async function rowsOf(url) {
  if (!cache.has(url)) cache.set(url, fetchJson(url).catch((e) => { console.error('  ✗ ' + url + '：' + e.message); return []; }));
  return cache.get(url);
}

/* 先查公司所屬市場，找不到再掃其他市場（公司轉上市／上櫃時也能接得上） */
async function findRows(sources, market, code, parse) {
  const order = [market, ...Object.keys(sources).filter((m) => m !== market)].filter((m) => sources[m]);
  for (const m of order) {
    for (const url of sources[m]) {
      const hits = (await rowsOf(url)).map(parse).filter((r) => r && r.code === code);
      if (hits.length) return { market: m, hits };
    }
  }
  return { market: null, hits: [] };
}

const today = new Date(Date.now() + 8 * 3600e3).toISOString().slice(0, 10); // 台北日期
const data = JSON.parse(await readFile(DATA_PATH, 'utf8'));
const notices = [];
let changed = false;

for (const [code, company] of Object.entries(data.companies || {})) {
  console.error(`· ${code} ${company.name}`);

  /* 月營收 */
  const rev = await findRows(REVENUE_SOURCES, company.market, code, R.parseRevenueRow);
  for (const rec of rev.hits) {
    const ch = R.upsertMonth(company, rec, 'mops');
    if (!ch) { console.error(`  ${rec.ym} 無變化`); continue; }
    changed = true;
    const msg = ch.type === 'new' ? `新增 ${rec.ym} 營收 ${R.r1(ch.rev)}`
      : ch.type === 'revised' ? `${rec.ym} 營收由 ${R.r1(ch.before)} 修正為 ${R.r1(ch.rev)}（以觀測站為準）`
      : `${rec.ym} 營收與觀測站核對一致，補上去年同月營收`;
    console.error('  ✓ ' + msg);
    log(company, msg);
    if (ch.type !== 'verified') notices.push(R.formatRevenueNotice(code, company, rec.ym));
  }
  if (!rev.hits.length) console.error('  月營收：資料集裡沒有這家公司（可能尚未公布或來源暫時失敗）');

  /* 季 EPS（只補空值） */
  const eps = await findRows(EPS_SOURCES, company.market, code, R.parseEpsRow);
  if (!eps.hits.length) await diagnose(EPS_SOURCES, code, 'EPS');
  for (const p of eps.hits) {
    company.quarters = company.quarters || {};
    const Q = company.quarters[p.q] = company.quarters[p.q] || {};
    if (Q.eps != null) { console.error(`  ${p.q} EPS 已有值 ${Q.eps}，不覆蓋（觀測站彙總 ${p.eps}）`); continue; }
    const s = R.singleQuarterEps(company, p);
    if (s.eps == null) {
      console.error(`  ${p.q} EPS 彙總值 ${p.eps} 無法判斷為單季或累計，略過`);
      continue;
    }
    Q.eps = s.eps;
    Q.epsSrc = 'mops';
    if (s.basis === 'ytd') Q.epsYtd = s.epsYtd;
    if (p.rev && p.netIncome != null && s.basis === 'q') Q.netMargin = R.r1(p.netIncome / p.rev * 100);
    delete Q.epsRough;
    delete Q.epsRoughNote;
    changed = true;
    const msg = `${p.q} EPS ${s.eps}（觀測站${s.basis === 'ytd' ? '累計 ' + s.epsYtd + ' 扣前幾季' : '單季'}）`;
    console.error('  ✓ ' + msg);
    log(company, msg);
    notices.push(R.formatEpsNotice(code, company, p.q));
  }
}

/* 對不到公司時印出資料集的實際欄位，方便修正欄位名稱（官方 API 偶爾改名） */
async function diagnose(sources, code, label) {
  console.error(`  ${label}：解析後沒有 ${code} 的資料，以下為各資料集實際內容供除錯`);
  for (const urls of Object.values(sources)) {
    for (const url of urls) {
      const rows = await rowsOf(url);
      console.error(`    ${url}：${rows.length} 筆`);
      if (!rows.length) continue;
      console.error('    欄位：' + JSON.stringify(Object.keys(rows[0])));
      const hit = rows.find((r) => Object.values(r).some((v) => String(v).trim() === code));
      console.error('    ' + (hit ? `含 ${code} 的列：` + JSON.stringify(hit) : `找不到任何欄位值為 ${code} 的列；第一列：` + JSON.stringify(rows[0])));
    }
  }
}

function log(company, msg) {
  company.log = company.log || [];
  company.log.unshift({ date: today, msg });
  company.log = company.log.slice(0, 30);
}

if (!changed) {
  console.error('沒有新資料，不更新 data/revenue.json。');
  process.exit(0);
}
data.updatedAt = today;
await writeFile(DATA_PATH, JSON.stringify(data, null, 2) + '\n', 'utf8');
console.error('✓ 已更新 data/revenue.json');

const { TELEGRAM_BOT_TOKEN: token, TELEGRAM_CHAT_ID: chat } = process.env;
const text = notices.filter(Boolean).join('\n\n');
if (text && token && chat) {
  try {
    await sendTelegram(token, chat, text);
    console.error('✓ 已發送 Telegram 通知');
  } catch (e) {
    console.error('Telegram 通知失敗（不影響資料更新）：' + e.message);
  }
}
