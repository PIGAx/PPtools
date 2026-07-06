/* ════════════════════════════════════════════════════════════
   PPTheme — PPtools 全站主題引擎（日夜模式）
   修復重點：主題設定（system / light / dark）以前只作用在外殼
   index.html，iframe 內的模組只跟隨作業系統，造成外殼與內容
   日夜模式不同步。本檔由「每一個頁面」在 <head> 同步載入：
     1. 載入當下立即套用 data-theme，避免閃白（FOUC）
     2. 監聽 storage 事件 → 外殼切換主題時，iframe 內即時跟進
     3. 監聽系統深淺色變化（「系統」模式時生效）
     4. 更新 <meta name="theme-color">，手機狀態列顏色一致
     5. 對外提供 PPTheme API，圖表可透過 onChange 重繪配色
   ════════════════════════════════════════════════════════════ */
(function () {
  'use strict';

  var KEY = 'pptools-theme'; // 'system' | 'light' | 'dark'
  var mql = window.matchMedia ? window.matchMedia('(prefers-color-scheme: dark)') : null;
  var listeners = [];

  function stored() {
    try {
      var t = localStorage.getItem(KEY);
      return (t === 'light' || t === 'dark') ? t : 'system';
    } catch (e) { return 'system'; }
  }

  function isDark() {
    var t = stored();
    if (t === 'dark') return true;
    if (t === 'light') return false;
    return !!(mql && mql.matches);
  }

  function updateMetaColor() {
    var meta = document.querySelector('meta[name="theme-color"]');
    if (!meta) {
      meta = document.createElement('meta');
      meta.name = 'theme-color';
      (document.head || document.documentElement).appendChild(meta);
    }
    meta.content = isDark() ? '#0a0c15' : '#eef1f9';
  }

  function apply() {
    var t = stored();
    var root = document.documentElement;
    if (t === 'system') root.removeAttribute('data-theme');
    else root.setAttribute('data-theme', t);
    updateMetaColor();
  }

  function notify() {
    var dark = isDark();
    for (var i = 0; i < listeners.length; i++) {
      try { listeners[i](dark, stored()); } catch (e) {}
    }
    try {
      window.dispatchEvent(new CustomEvent('pp-theme-change', { detail: { dark: dark, theme: stored() } }));
    } catch (e) {}
  }

  function set(t) {
    try { localStorage.setItem(KEY, t); } catch (e) {}
    apply();
    notify();
  }

  function cycle() {
    var order = ['system', 'light', 'dark'];
    var next = order[(order.indexOf(stored()) + 1) % 3];
    set(next);
    return next;
  }

  /* 外殼寫入 localStorage 時，同分頁的 iframe 會收到 storage 事件 */
  window.addEventListener('storage', function (e) {
    if (e.key === KEY || e.key === null) { apply(); notify(); }
  });

  /* 「系統」模式下，跟隨作業系統即時切換 */
  if (mql) {
    var onSys = function () {
      if (stored() === 'system') { apply(); notify(); }
    };
    if (mql.addEventListener) mql.addEventListener('change', onSys);
    else if (mql.addListener) mql.addListener(onSys);
  }

  /* 圖表配色輔助：依當前主題回傳 Chart.js 常用顏色 */
  function chartColors() {
    var dark = isDark();
    return {
      grid: dark ? 'rgba(255,255,255,.07)' : 'rgba(20,25,50,.07)',
      tick: dark ? '#8e94b4' : '#5f6684',
      text: dark ? '#e6e8f2' : '#1b1e2e',
      border: dark ? 'rgba(255,255,255,.12)' : 'rgba(20,25,50,.12)'
    };
  }

  window.PPTheme = {
    KEY: KEY,
    get: stored,
    set: set,
    cycle: cycle,
    isDark: isDark,
    chartColors: chartColors,
    onChange: function (cb) { listeners.push(cb); }
  };

  apply(); // 同步載入時立即套用，避免閃爍
})();
