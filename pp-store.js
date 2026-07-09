/* ════════════════════════════════════════════════════════════
   PPStore — PPtools 跨模組資料同步引擎
   功能：把所有模組的 localStorage 資料打包成單一 JSON，
        備份到 GitHub 私人 repo（Contents API），支援還原與版本歷史。
   使用：index.html 與 datahub.html 皆載入本檔。
        自動備份計時器只在最上層視窗（portal shell）運作。
   ════════════════════════════════════════════════════════════ */
(function () {
  'use strict';

  const DATA_FILE = 'pptools-data.json';
  const CFG_KEY   = 'pptools-sync-config';
  const META_KEY  = 'pptools-sync-meta';
  const AUTO_INTERVAL_MS = 5 * 60 * 1000; // 每 5 分鐘檢查一次是否需要自動備份

  /* ── 資料註冊表：新模組的 localStorage key 加在這裡 ── */
  const REGISTRY = [
    { key: 'finance_tool_v2',         name: '預算管理',       desc: '記帳、信用卡、資產、投資資料' },
    { key: 'quantPortfolioDataV2',    name: '部位控管',       desc: '股票庫存與部位資料' },
    { key: 'quantPortfolioData',      name: '部位控管（舊版）', desc: 'V1 舊版資料，保留備援' },
    { key: 'pptools-calendar-custom', name: '投資行事曆',     desc: '自訂經濟事件與日程' },
    { key: 'pptools-forecast',        name: '財務預測',       desc: '關注標的財務預測' },
    { key: 'pptools-watchlist',       name: '觀察清單',       desc: '台美股觀察標的與報價資料' },
    { key: 'pptools-sector-notes',    name: '產業族群筆記',   desc: '依產業分類的看盤清單與研究筆記' },
    { key: 'pptools-dashboard',       name: '儀表板版面',     desc: '總覽儀表板的面板配置' }
  ];

  /* ── 設定與同步紀錄 ── */
  function getCfg() {
    try { return JSON.parse(localStorage.getItem(CFG_KEY)) || {}; }
    catch (e) { return {}; }
  }
  function setCfg(c) { localStorage.setItem(CFG_KEY, JSON.stringify(c)); }

  function getMeta() {
    try { return JSON.parse(localStorage.getItem(META_KEY)) || {}; }
    catch (e) { return {}; }
  }
  function setMeta(m) { localStorage.setItem(META_KEY, JSON.stringify(m)); }

  /* ── UTF-8 安全的 Base64（分段處理，避免大字串爆堆疊） ── */
  function b64encode(str) {
    const bytes = new TextEncoder().encode(str);
    let bin = '';
    const CHUNK = 0x8000;
    for (let i = 0; i < bytes.length; i += CHUNK) {
      bin += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK));
    }
    return btoa(bin);
  }
  function b64decode(b64) {
    const bin = atob(b64.replace(/\s/g, ''));
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return new TextDecoder().decode(bytes);
  }

  /* ── GitHub API helpers ── */
  function apiFileUrl(cfg) {
    return 'https://api.github.com/repos/' + cfg.owner + '/' + cfg.repo + '/contents/' + DATA_FILE;
  }
  function headers(cfg, extra) {
    return Object.assign({
      'Authorization': 'Bearer ' + cfg.token,
      'Accept': 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28'
    }, extra || {});
  }
  function cfgReady(cfg) {
    return !!(cfg.token && cfg.owner && cfg.repo);
  }

  /* ── 測試連線：確認 repo 存在、PAT 有效、是否為私人 ── */
  async function testConnection() {
    const cfg = getCfg();
    if (!cfgReady(cfg)) throw new Error('請先填寫帳號、Repo 與 PAT');
    const r = await fetch('https://api.github.com/repos/' + cfg.owner + '/' + cfg.repo, { headers: headers(cfg) });
    if (r.status === 401) throw new Error('PAT 無效或已過期');
    if (r.status === 404) throw new Error('找不到 Repo — 確認名稱拼字，以及 PAT 是否有授權此 Repo');
    if (!r.ok) throw new Error('連線失敗：HTTP ' + r.status);
    const j = await r.json();
    return { fullName: j.full_name, isPrivate: j.private };
  }

  /* ── 打包本機資料 ── */
  function buildSnapshot() {
    const data = {};
    REGISTRY.forEach(function (it) {
      const v = localStorage.getItem(it.key);
      if (v !== null) data[it.key] = v;
    });
    return {
      version: 1,
      exportedAt: new Date().toISOString(),
      device: navigator.platform || 'unknown',
      data: data
    };
  }

  async function hashSnapshot(snap) {
    const s = JSON.stringify(snap.data);
    const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s));
    return Array.from(new Uint8Array(buf)).map(function (b) { return b.toString(16).padStart(2, '0'); }).join('');
  }

  /* ── 讀取遠端目前版本：回傳 { sha, snapshot }，不存在回傳 null ── */
  async function getRemote() {
    const cfg = getCfg();
    if (!cfgReady(cfg)) throw new Error('尚未完成連線設定');
    const branch = cfg.branch || 'main';
    const metaRes = await fetch(apiFileUrl(cfg) + '?ref=' + branch, { headers: headers(cfg) });
    if (metaRes.status === 404) return null;
    if (!metaRes.ok) throw new Error('讀取遠端失敗：HTTP ' + metaRes.status);
    const meta = await metaRes.json();
    let text;
    if (meta.content) {
      text = b64decode(meta.content);
    } else {
      // 檔案超過 1MB 時 content 為空，改用 raw 取回
      const raw = await fetch(apiFileUrl(cfg) + '?ref=' + branch, {
        headers: headers(cfg, { 'Accept': 'application/vnd.github.raw+json' })
      });
      if (!raw.ok) throw new Error('讀取遠端內容失敗：HTTP ' + raw.status);
      text = await raw.text();
    }
    return { sha: meta.sha, snapshot: JSON.parse(text) };
  }

  /* ── 備份（push）：本機 → GitHub ── */
  async function push(message) {
    const cfg = getCfg();
    if (!cfgReady(cfg)) throw new Error('尚未完成連線設定');
    const snap = buildSnapshot();
    const body = {
      message: message || ('backup ' + snap.exportedAt),
      branch: cfg.branch || 'main',
      content: b64encode(JSON.stringify(snap, null, 2))
    };
    const remote = await getRemote().catch(function () { return null; });
    if (remote) body.sha = remote.sha;
    const r = await fetch(apiFileUrl(cfg), {
      method: 'PUT',
      headers: headers(cfg),
      body: JSON.stringify(body)
    });
    if (!r.ok) {
      const t = await r.text().catch(function () { return ''; });
      throw new Error('備份失敗：HTTP ' + r.status + ' ' + t.slice(0, 120));
    }
    const meta = getMeta();
    meta.lastPushAt = snap.exportedAt;
    meta.lastHash = await hashSnapshot(snap);
    setMeta(meta);
    return snap;
  }

  /* ── 套用快照到本機（還原用，呼叫端先向使用者確認） ── */
  function applySnapshot(snap, keys) {
    const applied = [];
    Object.keys(snap.data || {}).forEach(function (k) {
      if (keys && keys.indexOf(k) === -1) return;
      localStorage.setItem(k, snap.data[k]);
      applied.push(k);
    });
    const meta = getMeta();
    meta.lastPullAt = new Date().toISOString();
    setMeta(meta);
    return applied;
  }

  /* ── 版本歷史：列出備份檔的 commit 紀錄 ── */
  async function listHistory(limit) {
    const cfg = getCfg();
    if (!cfgReady(cfg)) throw new Error('尚未完成連線設定');
    const url = 'https://api.github.com/repos/' + cfg.owner + '/' + cfg.repo +
      '/commits?path=' + DATA_FILE + '&per_page=' + (limit || 10) + '&sha=' + (cfg.branch || 'main');
    const r = await fetch(url, { headers: headers(cfg) });
    if (!r.ok) throw new Error('讀取歷史失敗：HTTP ' + r.status);
    const arr = await r.json();
    return arr.map(function (c) {
      return { sha: c.sha, date: c.commit.committer.date, message: c.commit.message };
    });
  }

  /* ── 取回特定歷史版本的快照 ── */
  async function getVersion(sha) {
    const cfg = getCfg();
    const raw = await fetch(apiFileUrl(cfg) + '?ref=' + sha, {
      headers: headers(cfg, { 'Accept': 'application/vnd.github.raw+json' })
    });
    if (!raw.ok) throw new Error('讀取版本失敗：HTTP ' + raw.status);
    return JSON.parse(await raw.text());
  }

  /* ── 自動備份：資料有變動才 push，避免無意義 commit ── */
  let _autoTimer = null;
  async function autoTick() {
    const cfg = getCfg();
    if (!cfg.auto || !cfgReady(cfg)) return;
    try {
      const snap = buildSnapshot();
      const h = await hashSnapshot(snap);
      const meta = getMeta();
      if (h !== meta.lastHash) {
        await push('auto backup ' + new Date().toISOString());
        console.log('[PPStore] 自動備份完成');
      }
    } catch (e) {
      console.warn('[PPStore] 自動備份失敗：' + e.message);
    }
  }
  function startAuto() {
    if (window !== window.top) return; // 只在 portal shell 執行，避免 iframe 重複計時
    if (_autoTimer) clearInterval(_autoTimer);
    _autoTimer = setInterval(autoTick, AUTO_INTERVAL_MS);
    setTimeout(autoTick, 15 * 1000); // 開站 15 秒後先檢查一次
  }

  /* ── 對外介面 ── */
  window.PPStore = {
    DATA_FILE: DATA_FILE,
    REGISTRY: REGISTRY,
    getCfg: getCfg,
    setCfg: setCfg,
    getMeta: getMeta,
    setMeta: setMeta,
    cfgReady: function () { return cfgReady(getCfg()); },
    testConnection: testConnection,
    buildSnapshot: buildSnapshot,
    hashSnapshot: hashSnapshot,
    getRemote: getRemote,
    push: push,
    applySnapshot: applySnapshot,
    listHistory: listHistory,
    getVersion: getVersion,
    startAuto: startAuto
  };
})();
