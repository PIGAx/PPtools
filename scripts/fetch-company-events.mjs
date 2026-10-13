#!/usr/bin/env node
/* ════════════════════════════════════════════════════════════════════════
   PPtools — 觀察標的公司事件抓取（在 GitHub Actions 伺服器端執行）
   ------------------------------------------------------------------------
   觀察標的清單在 data/company-events.json 的 tickers。每天抓：
     1. 公開資訊觀測站「法人說明會一覽表」（ajax_t100sb02_1）→ 法說會日期、時間、地點、簡報
     2. 公開資訊觀測站「重大訊息」（ajax_t05st01）→ 依關鍵字挑出董事會、股東會、股利、法說等公告
     3. 櫃買中心 OpenAPI「上櫃股票除權除息預告表」→ 除權息日
   產出：
     data/company-events-auto.json  行事曆網頁讀取
     data/company-events.ics        可在 Google 日曆「從網址新增」訂閱，之後自動更新
   設計原則同 fetch-quotes.mjs：單一來源失敗不影響其他來源；某檔這次抓不到就沿用上次的資料。
   ════════════════════════════════════════════════════════════════════════ */

import { readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..');
const CFG_PATH = resolve(ROOT, 'data/company-events.json');
const OUT_PATH = resolve(ROOT, 'data/company-events-auto.json');
const ICS_PATH = resolve(ROOT, 'data/company-events.ics');

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';
const MOPS = 'https://mopsov.twse.com.tw';
const MOPS_PAGE = 'https://mops.twse.com.tw/mops/';
const DEBUG = !!process.env.DEBUG_EVENTS;

// 重大訊息主旨符合這些關鍵字才放進行事曆
const NEWS_KEYWORDS = /法人說明會|法說|發表會|說明會|董事會|股東會|股東常會|股東臨時會|股利|配息|除息|除權|現金增資|私募|合併|收購|處分|取得|營收|財務報告|自結/;

const pad = (n) => String(n).padStart(2, '0');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function fetchText(url, { method = 'GET', body, timeout = 30000, headers = {} } = {}) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeout);
  try {
    const res = await fetch(url, {
      method,
      body,
      signal: ctrl.signal,
      headers: { 'User-Agent': UA, ...headers },
    });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    return await res.text();
  } finally {
    clearTimeout(timer);
  }
}

const postForm = (url, params) =>
  fetchText(url, {
    method: 'POST',
    body: new URLSearchParams(params).toString(),
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
  });

/* ── HTML 表格解析（觀測站的表格很規律，不需要完整的 HTML parser） ── */
const decode = (s) =>
  s.replace(/&#(\d+);/g, (_, n) => String.fromCharCode(+n)).replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&#39;/g, "'");
const cellText = (html) => decode(html.replace(/<br\s*\/?>/gi, ' ').replace(/<[^>]+>/g, '')).replace(/[\s\u3000\u00a0]+/g, ' ').trim();

export function parseRows(html) {
  const rows = [];
  for (const tr of html.match(/<tr[\s\S]*?<\/tr>/gi) || []) {
    const cells = [...tr.matchAll(/<td[^>]*>([\s\S]*?)<\/td>/gi)].map((m) => m[1]);
    if (cells.length) rows.push({ html: tr, cells: cells.map(cellText), raw: cells });
  }
  return rows;
}

// 民國日期「115/06/05」或「115年6月5日」→ 2026-06-05
export function rocToIso(s) {
  const c = String(s || '').trim().match(/^(\d{3})(\d{2})(\d{2})$/); // 櫃買 OpenAPI 的「1151005」
  if (c) return `${+c[1] + 1911}-${c[2]}-${c[3]}`;
  const m = String(s || '').match(/(\d{2,3})\s*[\/年.-]\s*(\d{1,2})\s*[\/月.-]\s*(\d{1,2})/);
  if (!m) return null;
  const y = +m[1] + 1911;
  return `${y}-${pad(+m[2])}-${pad(+m[3])}`;
}

/* ── 1. 法人說明會一覽表 ── */
export function parseConferences(html, code) {
  const out = [];
  for (const r of parseRows(html)) {
    if (r.cells[0] !== code) continue;
    const [, , dateCell, time, place, summary] = r.cells;
    const date = rocToIso(dateCell);
    if (!date) continue;
    // 主辦券商：「受邀參加富邦證券舉辦之法人說明會」→ 富邦證券
    const host = (summary.match(/參加(.{2,24}?)(?:舉辦|主辦)/) || [])[1];
    const links = [...r.html.matchAll(/href\s*=\s*['"](https?:[^'"]+)['"]/gi)].map((m) => m[1]);
    const pdf = r.cells.find((c) => /^\w+M\d+\.pdf$/i.test(c));
    out.push({
      ticker: code, date, kind: 'conference', source: 'MOPS 法人說明會',
      title: '法說會' + (host ? `（${host.replace(/[“”"]/g, '')}）` : ''),
      note: [time && '時間 ' + time, place && '地點 ' + place, summary, pdf && '簡報檔 ' + pdf + '（觀測站法說會一覽可下載）']
        .filter(Boolean).join('｜').slice(0, 500),
      url: links.find((u) => /youtube|youtu\.be/.test(u)) || links[0] || '',
      links,
    });
  }
  return out;
}

async function fetchConferences(t, rocYear) {
  const html = await postForm(MOPS + '/mops/web/ajax_t100sb02_1', {
    encodeURIComponent: 1, step: 1, firstin: 1, off: 1,
    TYPEK: t.market === 'TWO' ? 'otc' : 'sii', year: rocYear, month: 'all', co_id: t.code,
  });
  if (DEBUG) {
    const rows = parseRows(html).filter((r) => r.cells[0] === t.code);
    console.log(`[debug] t100sb02_1 ${t.code} ${rocYear}: ${rows.length} rows`);
    rows.slice(0, 3).forEach((r) => console.log('  cells:', JSON.stringify(r.cells).slice(0, 600), '\n  raw:', r.html.slice(0, 1200)));
  }
  return parseConferences(html, t.code);
}

/* ── 2. 重大訊息 ── */
// 「詳細資料」按鈕 onclick 裡設定的表單欄位，用來查單則公告的內文
function detailParams(rowHtml) {
  const p = {};
  for (const m of rowHtml.matchAll(/t05st01_fm\.(\w+)\.value\s*=\s*['"]([^'"]*)['"]/g)) p[m[1]] = m[2];
  return p;
}

export function parseNews(html, code) {
  const out = [];
  for (const r of parseRows(html)) {
    if (r.cells[0] !== code) continue;
    const [, , spokeDate, spokeTime, subject] = r.cells;
    const date = rocToIso(spokeDate);
    if (!date || !subject || !NEWS_KEYWORDS.test(subject)) continue;
    const detail = /召開日期/.test(subject) ? detailParams(r.html) : null;
    const title = subject.replace(/^公告本公司/, '').replace(/^本公司/, '').trim();
    out.push({
      ticker: code, date, kind: 'news', source: 'MOPS 重大訊息',
      title: '公告：' + title.slice(0, 60),
      note: `${spokeDate} ${spokeTime || ''} 發布｜${subject}`.slice(0, 400),
      url: '',
      ...(detail && Object.keys(detail).length ? { _detail: detail } : {}),
    });
    // 主旨裡寫了未來的召開日期（例如「訂於115年11月6日召開董事會」），另外在那天放一個事件
    const m = subject.match(/(?:訂於|預計於|將於|於)\s*(\d{2,3}\s*年\s*\d{1,2}\s*月\s*\d{1,2}\s*日|\d{2,3}\/\d{1,2}\/\d{1,2})/);
    const when = m && rocToIso(m[1]);
    if (when && when > date) {
      const what = /股東/.test(subject) ? '股東會' : /法人說明會|法說|發表會|說明會/.test(subject) ? '法說會' : /董事會/.test(subject) ? '董事會' : '預定事項';
      out.push({
        ticker: code, date: when, kind: what === '法說會' ? 'conference' : 'meeting', source: 'MOPS 重大訊息',
        title: what + '（' + title.slice(0, 40) + '）',
        note: `${spokeDate} 公告｜${subject}`.slice(0, 400),
        url: '',
      });
    }
  }
  return out;
}

async function fetchNews(t, rocYear) {
  const html = await postForm(MOPS + '/mops/web/ajax_t05st01', {
    encodeURIComponent: 1, step: 1, firstin: 1, off: 1, queryName: 'co_id', inpuType: 'co_id',
    TYPEK: 'all', co_id: t.code, year: rocYear,
  });
  if (DEBUG) {
    const rows = parseRows(html).filter((r) => r.cells[0] === t.code);
    console.log(`[debug] t05st01 ${t.code} ${rocYear}: ${rows.length} rows`);
    rows.slice(0, 40).forEach((r) => console.log('  ', r.cells.slice(2, 5).join(' | ').slice(0, 200)));
  }
  const events = parseNews(html, t.code);
  // 「○○財務報告董事會召開日期」的實際日期只寫在內文，逐則查詳細資料
  for (const e of events.filter((x) => x._detail)) {
    try {
      await sleep(1500);
      const body = await postForm(MOPS + '/mops/web/ajax_t05st01', {
        encodeURIComponent: 1, firstin: true, off: 1, TYPEK: 'all', co_id: t.code, year: rocYear, month: 'all', step: 2,
        ...e._detail,
      });
      const text = cellText(body);
      if (DEBUG) console.log(`[debug] detail ${e.date} ${e.title}:`, text.slice(0, 700));
      const when = extractMeetingDate(text, e.date);
      if (when) {
        events.push({
          ticker: t.code, date: when, kind: 'meeting', source: 'MOPS 重大訊息',
          title: '董事會（' + e.title.replace(/^公告：/, '').replace(/召開日期$/, '') + '）',
          note: `${e.date} 公告｜${e.title.replace(/^公告：/, '')}`, url: '',
        });
      }
    } catch (err) {
      console.warn(`${t.code} 公告內文抓取失敗：${err.message}`);
    }
    delete e._detail;
  }
  return events;
}

// 從公告內文找「董事會預定日期／召開日期」之類的日期，取公告日之後的第一個
export function extractMeetingDate(text, announced) {
  const near = text.match(/(?:預定|召開|開會)[^。\d]{0,12}日期[^\d]{0,6}(\d{2,3}\s*[\/年]\s*\d{1,2}\s*[\/月]\s*\d{1,2})/);
  const cand = near ? [near[1]] : [...text.matchAll(/\d{2,3}\s*[\/年]\s*\d{1,2}\s*[\/月]\s*\d{1,2}/g)].map((m) => m[0]);
  return cand.map(rocToIso).find((d) => d && d > announced) || null;
}

/* ── 3. 除權除息預告（櫃買／證交所 OpenAPI） ── */
function pickKey(obj, re) {
  const k = Object.keys(obj).find((key) => re.test(key));
  return k ? obj[k] : undefined;
}

async function fetchExRights(tickers) {
  const out = [];
  const sources = [
    { url: 'https://www.tpex.org.tw/openapi/v1/tpex_exright_prepost', market: 'TWO' },
    { url: 'https://openapi.twse.com.tw/v1/exchangeReport/TWT48U_ALL', market: 'TW' },
  ];
  for (const s of sources) {
    const codes = new Set(tickers.filter((t) => (t.market === 'TWO') === (s.market === 'TWO')).map((t) => t.code));
    if (!codes.size) continue;
    try {
      const list = JSON.parse(await fetchText(s.url, { headers: { Accept: 'application/json' } }));
      if (DEBUG) console.log(`[debug] ${s.url}: ${list.length} rows, sample keys:`, JSON.stringify(list[0] || {}).slice(0, 400));
      for (const row of list) {
        const code = String(pickKey(row, /代號|Code/i) || '').trim();
        if (!codes.has(code)) continue;
        const date = rocToIso(pickKey(row, /除權息日|除息日|除權日|Date/i));
        if (!date) continue;
        const kind = String(pickKey(row, /權值|類型|權\/息|Exdividend|Type/i) || '除權息');
        const cash = pickKey(row, /現金股利|息值|CashDividend/i);
        out.push({
          ticker: code, date, kind: 'dividend', source: s.market === 'TWO' ? '櫃買中心 除權除息預告' : '證交所 除權除息預告',
          title: '除權息' + (/息/.test(kind) && !/權/.test(kind) ? '（除息）' : /權/.test(kind) && !/息/.test(kind) ? '（除權）' : ''),
          note: cash ? '現金股利 ' + cash : '', url: '',
        });
      }
    } catch (e) {
      console.warn('除權息預告抓取失敗', s.url, e.message);
    }
  }
  return out;
}

/* ── .ics（一年內：手動事件 + 自動事件 + 營收／財報公告期限） ── */
const icsEscape = (s) => String(s || '').replace(/\\/g, '\\\\').replace(/;/g, '\\;').replace(/,/g, '\\,').replace(/\n/g, '\\n');
function nextDayCompact(iso) {
  const [y, m, d] = iso.split('-').map(Number);
  const n = new Date(Date.UTC(y, m - 1, d + 1));
  return `${n.getUTCFullYear()}${pad(n.getUTCMonth() + 1)}${pad(n.getUTCDate())}`;
}
// 75 octets 換行（RFC 5545），以字元近似即可
const fold = (line) => {
  const out = [];
  let s = line;
  while (Buffer.byteLength(s) > 73) {
    let cut = 0, bytes = 0;
    for (const ch of s) { const b = Buffer.byteLength(ch); if (bytes + b > 73) break; bytes += b; cut += ch.length; }
    out.push(s.slice(0, cut));
    s = ' ' + s.slice(cut);
  }
  out.push(s);
  return out.join('\r\n');
};

function deadlineEvents(tickers, fromIso, toIso) {
  const out = [];
  const y0 = +fromIso.slice(0, 4);
  for (const t of tickers) {
    for (const y of [y0, y0 + 1]) {
      for (let m = 1; m <= 12; m++) {
        out.push({ ticker: t.code, date: `${y}-${pad(m)}-10`, kind: 'deadline', title: `${m === 1 ? 12 : m - 1}月營收公告`, note: '每月 10 日前公告上月營收' });
      }
      for (const [md, label] of [['03-31', '年報'], ['05-15', 'Q1 財報'], ['08-14', 'Q2 財報'], ['11-14', 'Q3 財報']]) {
        out.push({ ticker: t.code, date: `${y}-${md}`, kind: 'deadline', title: `${label}公告期限`, note: '法定最晚公告日，實際日期以董事會公告為準' });
      }
    }
  }
  return out.filter((e) => e.date >= fromIso && e.date <= toIso);
}

export function buildIcs(tickers, events, today) {
  const names = Object.fromEntries(tickers.map((t) => [t.code, t.name || '']));
  const from = new Date(today);
  from.setUTCMonth(from.getUTCMonth() - 3);
  const to = new Date(today);
  to.setUTCFullYear(to.getUTCFullYear() + 1);
  const fromIso = from.toISOString().slice(0, 10);
  const toIso = to.toISOString().slice(0, 10);
  const all = [...events.filter((e) => e.date >= fromIso && e.date <= toIso), ...deadlineEvents(tickers, fromIso, toIso)]
    .sort((a, b) => a.date.localeCompare(b.date));
  const stamp = new Date(today).toISOString().replace(/[-:]/g, '').replace(/\.\d+/, '');
  const lines = ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//PPtools//Company Events//ZH', 'CALSCALE:GREGORIAN',
    'METHOD:PUBLISH', 'X-WR-CALNAME:PPtools 觀察標的事件', 'X-WR-TIMEZONE:Asia/Taipei', 'REFRESH-INTERVAL;VALUE=DURATION:PT12H'];
  const seen = new Set();
  for (const e of all) {
    const uid = `${e.ticker}-${e.date}-${e.kind}-${(e.title || '').replace(/[^\p{L}\p{N}]+/gu, '').slice(0, 24)}@pptools`;
    if (seen.has(uid)) continue;
    seen.add(uid);
    const desc = [e.note, e.url && '連結：' + e.url, e.source && '來源：' + e.source, '公開資訊觀測站：' + MOPS_PAGE].filter(Boolean).join('\n');
    lines.push('BEGIN:VEVENT', 'UID:' + uid, 'DTSTAMP:' + stamp,
      'DTSTART;VALUE=DATE:' + e.date.replace(/-/g, ''), 'DTEND;VALUE=DATE:' + nextDayCompact(e.date),
      fold('SUMMARY:' + icsEscape(`${e.ticker} ${names[e.ticker] || ''} ${e.title}`.replace(/\s+/g, ' '))),
      fold('DESCRIPTION:' + icsEscape(desc)), 'TRANSP:TRANSPARENT', 'END:VEVENT');
  }
  lines.push('END:VCALENDAR');
  return lines.join('\r\n') + '\r\n';
}

/* ── 主流程 ── */
async function main() {
  const cfg = JSON.parse(await readFile(CFG_PATH, 'utf8'));
  const tickers = (cfg.tickers || []).filter((t) => /^\d{4,6}[A-Z]?$/.test(t.code));
  let prev = { events: [] };
  try { prev = JSON.parse(await readFile(OUT_PATH, 'utf8')); } catch {}

  const now = new Date();
  const rocYear = now.getUTCFullYear() - 1911;
  const years = now.getUTCMonth() >= 10 ? [rocYear, rocYear + 1] : [rocYear];
  const status = {};
  const events = [];

  for (const t of tickers) {
    const got = [];
    let ok = 0;
    for (const y of years) {
      for (const [name, fn] of [['法說會', fetchConferences], ['重大訊息', fetchNews]]) {
        try {
          got.push(...(await fn(t, y)));
          ok++;
        } catch (e) {
          console.warn(`${t.code} ${name} ${y} 抓取失敗：${e.message}`);
        }
        await sleep(1500); // 觀測站對連續查詢很敏感，放慢一點
      }
    }
    if (ok === 0) {
      // 這檔這次全失敗：沿用上次的資料
      const old = (prev.events || []).filter((e) => e.ticker === t.code && e.kind !== 'dividend');
      events.push(...old);
      status[t.code] = 'stale';
    } else {
      events.push(...got);
      status[t.code] = 'ok';
    }
  }
  const ex = await fetchExRights(tickers);
  events.push(...(ex.length ? ex : (prev.events || []).filter((e) => e.kind === 'dividend')));

  // 去重（同一天同標題只留一筆）並排序
  const uniq = new Map();
  const confDays = new Set(events.filter((e) => e.source === 'MOPS 法人說明會').map((e) => e.ticker + '|' + e.date));
  for (const e of events) {
    // 重大訊息推出來的法說會日期，法說會一覽表已經有就不重複
    if (e.kind === 'conference' && e.source !== 'MOPS 法人說明會' && confDays.has(e.ticker + '|' + e.date)) continue;
    delete e._detail;
    uniq.set(`${e.ticker}|${e.date}|${e.title}`, e);
  }
  const sorted = [...uniq.values()].sort((a, b) => a.date.localeCompare(b.date) || a.ticker.localeCompare(b.ticker));

  const okCount = Object.values(status).filter((s) => s === 'ok').length;
  if (tickers.length && okCount === 0 && !ex.length) {
    console.error('所有來源都抓取失敗，保留原檔。');
    process.exit(1);
  }

  const out = { updatedAt: now.toISOString(), status, events: sorted };
  await writeFile(OUT_PATH, JSON.stringify(out, null, 2) + '\n');
  // 手動維護的事件也一起放進 .ics
  const manual = (cfg.events || []).map((e) => ({ ...e, source: e.source || '手動', kind: e.kind || 'manual' }));
  await writeFile(ICS_PATH, buildIcs(tickers, [...manual, ...sorted], now));
  console.log(`完成：${sorted.length} 筆事件（${JSON.stringify(status)}，除權息 ${ex.length} 筆）`);
  if (DEBUG) sorted.forEach((e) => console.log('  ', e.date, e.ticker, e.kind, e.title));
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
