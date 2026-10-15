// 收盤後檢查槓桿部位停損距離，緩衝低於門檻就發 Telegram。
// 部位資料來自 PPStore 的雲端備份（私人 repo 的 pptools-data.json），現價來自 data/quotes.json。
// 需要的環境變數（未設定就略過，不算失敗）：
//   TELEGRAM_BOT_TOKEN、TELEGRAM_CHAT_ID
//   PP_BACKUP_REPO（owner/repo）、PP_BACKUP_TOKEN（可讀該 repo 的 PAT）、PP_BACKUP_BRANCH（預設 main）
//   STOP_ALERT_MARKETS（TW、US 或 TW,US；預設依執行時間判斷）
//   STOP_ALERT_STATE（去重紀錄檔路徑，預設 .stop-alert-state.json）
import { readFile, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
const A = createRequire(import.meta.url)('../pp-stop-alert.js');

const env = process.env;
const need = ['TELEGRAM_BOT_TOKEN', 'TELEGRAM_CHAT_ID', 'PP_BACKUP_REPO', 'PP_BACKUP_TOKEN'];
const missing = need.filter(k => !env[k]);
if (missing.length) {
  console.log('未設定 ' + missing.join('、') + '，略過停損通知。');
  process.exit(0);
}

// 台股收盤後（UTC 6–9 點）的那幾次只看台股，美股收盤後只看美股；手動觸發兩邊都看
function marketsNow() {
  if (env.STOP_ALERT_MARKETS) return env.STOP_ALERT_MARKETS.split(',').map(s => s.trim().toUpperCase());
  if (env.GITHUB_EVENT_NAME === 'workflow_dispatch') return ['TW', 'US'];
  const h = new Date().getUTCHours();
  return (h >= 5 && h <= 10) ? ['TW'] : ['US'];
}

async function loadPortfolio() {
  const branch = env.PP_BACKUP_BRANCH || 'main';
  const url = `https://api.github.com/repos/${env.PP_BACKUP_REPO}/contents/pptools-data.json?ref=${encodeURIComponent(branch)}`;
  const r = await fetch(url, {
    headers: { Authorization: 'Bearer ' + env.PP_BACKUP_TOKEN, Accept: 'application/vnd.github.raw', 'User-Agent': 'pptools-stop-alert' }
  });
  if (!r.ok) throw new Error('讀取備份失敗：HTTP ' + r.status);
  const snap = await r.json();
  const raw = snap && snap.data && snap.data.quantPortfolioDataV2;
  if (!raw) throw new Error('備份中沒有部位控管資料（quantPortfolioDataV2）');
  return JSON.parse(raw);
}

function priceLookup(quotes) {
  const tw = (quotes.tw && quotes.tw.stocks) || {};
  const us = quotes.us || {};
  return pos => {
    if (pos.market === 'US') return (us[pos.ticker] || {}).price;
    return (tw[pos.ticker] || {}).close;
  };
}

async function readState(path) {
  try { return JSON.parse(await readFile(path, 'utf8')); } catch (e) { return {}; }
}

const markets = marketsNow();
const quotes = JSON.parse(await readFile(new URL('../data/quotes.json', import.meta.url), 'utf8'));
const portfolio = await loadPortfolio();
portfolio.positions = (portfolio.positions || []).filter(p => markets.includes(p.market === 'US' ? 'US' : 'TW'));

const alerts = A.scan(portfolio, { priceOf: priceLookup(quotes) });
console.log(`檢查市場 ${markets.join('/')}：${alerts.length} 筆低於門檻。`);
if (!alerts.length) process.exit(0);

// 同一筆在同一個報價日只發一次；之後觸及停損會再發
const statePath = env.STOP_ALERT_STATE || '.stop-alert-state.json';
const state = await readState(statePath);
const quoteDay = a => a.market === 'US'
  ? String(((quotes.us || {})[a.ticker] || {}).asOf || quotes.generatedAt || '').slice(0, 10)
  : String((quotes.tw && quotes.tw.date) || '');
const fresh = alerts.filter(a => {
  const prev = state[A.alertKey(a)];
  return !prev || prev.day !== quoteDay(a) || (prev.level !== 'hit' && a.level === 'hit');
});
if (!fresh.length) { console.log('這個報價日已通知過，略過。'); process.exit(0); }

const alertPct = Number(portfolio.riskCfg && portfolio.riskCfg.alertPct) || A.DEFAULT_ALERT_PCT;
const days = [...new Set(fresh.map(quoteDay))].join('、');
await A.sendTelegram(env.TELEGRAM_BOT_TOKEN, env.TELEGRAM_CHAT_ID,
  A.formatMessage(fresh, { alertPct, note: `報價日 ${days}（收盤價）` }));
for (const a of fresh) state[A.alertKey(a)] = { day: quoteDay(a), level: a.level };
await writeFile(statePath, JSON.stringify(state));
console.log(`已發送 ${fresh.length} 筆停損通知。`);
