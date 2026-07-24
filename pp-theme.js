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
  var SCALE_KEY = 'pptools-fontscale'; // 'sm' | 'md' | 'lg' | 'xl'
  var SCALES = { sm: 0.9, md: 1, lg: 1.15, xl: 1.3 };
  var SCALE_ORDER = ['sm', 'md', 'lg', 'xl'];
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
    meta.content = isDark() ? '#000000' : '#ffffff';
  }

  /* ── 字級（全站字體大小）──
     shell（index.html）以 window.__PP_SHELL__ 標記；shell 只設 --pp-scale
     供外殼 chrome 的 CSS 使用，不套 zoom（避免固定高度版面被放大溢出）。
     模組頁（iframe 內或獨立開啟）則對 documentElement 套 zoom，整頁放大字級。 */
  function storedScale() {
    try {
      var s = localStorage.getItem(SCALE_KEY);
      return SCALES[s] ? s : 'md';
    } catch (e) { return 'md'; }
  }
  function scaleValue() { return SCALES[storedScale()] || 1; }
  function applyScale() {
    var root = document.documentElement;
    var v = scaleValue();
    root.style.setProperty('--pp-scale', String(v));
    if (!window.__PP_SHELL__) {
      // 模組頁：整頁縮放（zoom 會連同 px 字級一起放大）
      root.style.zoom = v === 1 ? '' : String(v);
    }
  }

  function apply() {
    var t = stored();
    var root = document.documentElement;
    if (t === 'system') root.removeAttribute('data-theme');
    else root.setAttribute('data-theme', t);
    updateMetaColor();
    applyScale();
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

  function setScale(s) {
    if (!SCALES[s]) s = 'md';
    try { localStorage.setItem(SCALE_KEY, s); } catch (e) {}
    applyScale();
    notify();
  }
  function cycleScale() {
    var next = SCALE_ORDER[(SCALE_ORDER.indexOf(storedScale()) + 1) % SCALE_ORDER.length];
    setScale(next);
    return next;
  }

  /* 外殼寫入 localStorage 時，同分頁的 iframe 會收到 storage 事件。
     主題（KEY）與字級（SCALE_KEY）都要同步：早期只聽 KEY，導致外殼切字級時
     iframe 內模組不會即時 zoom（要重新整理才生效），內容看起來還是很擠很小。 */
  window.addEventListener('storage', function (e) {
    if (e.key === KEY || e.key === SCALE_KEY || e.key === null) { apply(); notify(); }
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
      grid: dark ? 'rgba(255,255,255,.07)' : 'rgba(20,20,15,.07)',
      tick: dark ? '#8f8f98' : '#6e6e66',
      text: dark ? '#e8e6e1' : '#17170f',
      border: dark ? 'rgba(255,255,255,.12)' : 'rgba(20,20,15,.12)'
    };
  }

  window.PPTheme = {
    KEY: KEY,
    SCALE_KEY: SCALE_KEY,
    SCALES: SCALES,
    get: stored,
    set: set,
    cycle: cycle,
    getScale: storedScale,
    setScale: setScale,
    cycleScale: cycleScale,
    isDark: isDark,
    chartColors: chartColors,
    onChange: function (cb) { listeners.push(cb); }
  };

  apply(); // 同步載入時立即套用，避免閃爍
})();
