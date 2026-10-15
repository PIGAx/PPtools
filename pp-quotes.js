/* ══ 報價抓取：部位控管與庫存戰情室共用 ══
   1. 同一檔（代碼＋市場）只抓一次，結果套用到所有同標的部位 → 不會有的更新、有的沒更新
   2. 先讀 data/quotes.json（GitHub Actions 每日收盤快照），用它判斷上市（.TW）或上櫃（.TWO），少打一半的請求
   3. 即時價走 Yahoo Finance，經公開 CORS 代理；成功過的代理下次優先用，並限制同時請求數避免被擋
   4. 即時價抓不到就退回收盤快照，並標示「收盤價」；兩邊都沒有才算失敗 */
(function (root) {
    'use strict';

    // 部署 worker/quote-proxy.js 後，把網址填這裡（或在頁面先設 window.PP_QUOTE_WORKER），會優先使用；留空則只用公開代理
    const WORKER_URL = (root.PP_QUOTE_WORKER || 'https://wispy-river-32edpp-quote-proxy.kelvin891001.workers.dev').replace(/\/$/, '');
    const PROXIES = [
        ...(WORKER_URL ? [{ id: 'worker', wrap: u => WORKER_URL + '/?url=' + encodeURIComponent(u) }] : []),
        { id: 'corsproxy',  wrap: u => 'https://corsproxy.io/?url=' + encodeURIComponent(u) },
        { id: 'allorigins', wrap: u => 'https://api.allorigins.win/raw?url=' + encodeURIComponent(u) },
        { id: 'codetabs',   wrap: u => 'https://api.codetabs.com/v1/proxy?quest=' + encodeURIComponent(u) }
    ];
    const PROXY_KEY = 'pp-quote-proxy';
    const TIMEOUT_MS = 8000;
    const CONCURRENCY = 3;

    function orderedProxies() {
        let best = null;
        try { best = localStorage.getItem(PROXY_KEY); } catch (e) { /* 無痕模式等 */ }
        return PROXIES.slice().sort((a, b) => (b.id === best) - (a.id === best));
    }

    async function fetchJsonViaProxy(url) {
        let lastErr = new Error('沒有可用的代理');
        for (const p of orderedProxies()) {
            const ctrl = new AbortController();
            const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
            try {
                const res = await fetch(p.wrap(url), { signal: ctrl.signal, cache: 'no-store' });
                if (!res.ok) throw new Error('HTTP ' + res.status);
                const j = await res.json();
                try { localStorage.setItem(PROXY_KEY, p.id); } catch (e) { /* 忽略 */ }
                return j;
            } catch (e) { lastErr = e; }
            finally { clearTimeout(timer); }
        }
        throw lastErr;
    }

    async function yahooQuote(symbol) {
        const url = 'https://query1.finance.yahoo.com/v8/finance/chart/' + encodeURIComponent(symbol) + '?interval=1d&range=5d';
        const d = await fetchJsonViaProxy(url);
        const r = d && d.chart && d.chart.result && d.chart.result[0];
        const meta = r && r.meta;
        if (!meta) throw new Error('no meta');
        let price = meta.regularMarketPrice != null ? meta.regularMarketPrice : meta.previousClose;
        if (price == null && r.indicators) {
            const closes = (((r.indicators.quote || [])[0] || {}).close || []).filter(v => v != null);
            if (closes.length) price = closes[closes.length - 1];
        }
        if (price == null || isNaN(price)) throw new Error('no price');
        const prev = meta.chartPreviousClose != null ? meta.chartPreviousClose : meta.previousClose;
        return { price: Number(price), prevClose: prev != null ? Number(prev) : null };
    }

    let snapPromise = null;
    function loadSnapshot() {
        if (!snapPromise) {
            snapPromise = fetch('data/quotes.json', { cache: 'no-store' })
                .then(r => (r.ok ? r.json() : null))
                .catch(() => null);
        }
        return snapPromise;
    }

    function keyOf(ticker, market) { return (market === 'US' ? 'US' : 'TW') + ':' + String(ticker).toUpperCase(); }

    function snapQuote(snap, ticker, market) {
        if (!snap) return null;
        if (market === 'US') {
            const s = snap.us && snap.us[ticker];
            if (!s || s.price == null) return null;
            return { price: s.price, prevClose: s.prevClose != null ? s.prevClose : null, date: String(s.asOf || '').slice(0, 10) };
        }
        const s = snap.tw && snap.tw.stocks && snap.tw.stocks[ticker];
        if (!s || s.close == null) return null;
        return {
            price: s.close,
            prevClose: s.change != null ? Math.round((s.close - s.change) * 10000) / 10000 : null,
            date: snap.tw.date, name: s.name, exchange: s.market
        };
    }

    // 上櫃（TPEX）用 .TWO；快照查不到就兩個都試
    function yahooSymbols(ticker, market, sq) {
        if (market === 'US') return [ticker];
        if (sq && sq.exchange === 'TPEX') return [ticker + '.TWO'];
        if (sq && sq.exchange) return [ticker + '.TW'];
        return [ticker + '.TW', ticker + '.TWO'];
    }

    async function liveQuote(ticker, market, sq) {
        let err = null;
        for (const sym of yahooSymbols(ticker, market, sq)) {
            try { return await yahooQuote(sym); } catch (e) { err = e; }
        }
        throw err || new Error('no quote');
    }

    async function pool(items, n, fn) {
        let i = 0;
        const workers = Array.from({ length: Math.min(n, items.length) }, async () => {
            while (i < items.length) { const it = items[i++]; await fn(it); }
        });
        await Promise.all(workers);
    }

    /* 抓一組標的的報價。positions 只需要 {ticker, market}，會自動去重。
       回傳 { quotes: Map(key → {price, prevClose, source:'live'|'close', date, name}), failed: [ticker], snapDate, fx } */
    async function fetchQuotes(positions, opts) {
        opts = opts || {};
        const snap = await loadSnapshot();
        const uniq = new Map();
        for (const p of positions || []) {
            if (!p || !p.ticker) continue;
            const k = keyOf(p.ticker, p.market);
            if (!uniq.has(k)) uniq.set(k, { ticker: String(p.ticker).toUpperCase(), market: p.market === 'US' ? 'US' : 'TW' });
        }
        const quotes = new Map(), failed = [];
        await pool([...uniq.entries()], CONCURRENCY, async ([k, it]) => {
            const sq = snapQuote(snap, it.ticker, it.market);
            if (opts.live !== false) {
                try {
                    const q = await liveQuote(it.ticker, it.market, sq);
                    quotes.set(k, Object.assign({ source: 'live', name: sq && sq.name }, q));
                    return;
                } catch (e) { /* 退回收盤快照 */ }
            }
            if (sq) quotes.set(k, Object.assign({ source: 'close' }, sq));
            else failed.push(it.ticker);
        });
        let fx = null;
        if (opts.fx) {
            try { fx = (await yahooQuote('TWD=X')).price; }
            catch (e) { fx = snap && snap.fx && snap.fx.USDTWD && snap.fx.USDTWD.price || null; }
        }
        return { quotes, failed, snapDate: snap && snap.tw && snap.tw.date, fx };
    }

    /* 日線歷史收盤：回傳 { dates: ['YYYY-MM-DD'], closes: [Number], source }，range 例 '3mo'、'6mo'、'1y'
       來源依序：FinMind（瀏覽器可直接呼叫，不經代理）→ Yahoo（經代理）→ FinMind（經代理） */
    const RANGE_DAYS = { '1mo': 31, '3mo': 92, '6mo': 183, '1y': 366, '2y': 731 };

    function finmindUrl(t, m, range) {
        const start = new Date(Date.now() - (RANGE_DAYS[range] || 183) * 86400000).toISOString().slice(0, 10);
        const ds = m === 'US' ? 'USStockPrice' : 'TaiwanStockPrice';
        return 'https://api.finmindtrade.com/api/v4/data?dataset=' + ds + '&data_id=' + encodeURIComponent(t) + '&start_date=' + start;
    }
    function parseFinmind(j) {
        const rows = (j && j.data) || [];
        const dates = [], closes = [];
        rows.forEach(r => {
            const c = r.close != null ? r.close : r.Close;   // 台股欄位 close、美股欄位 Close
            if (c == null || !r.date) return;
            dates.push(String(r.date).slice(0, 10));
            closes.push(Math.round(Number(c) * 100) / 100);
        });
        if (!dates.length) throw new Error((j && j.msg) || 'no series');
        return { dates, closes, source: 'FinMind' };
    }
    async function finmindDirect(t, m, range) {
        const ctrl = new AbortController();
        const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
        try {
            const r = await fetch(finmindUrl(t, m, range), { signal: ctrl.signal });
            if (!r.ok) throw new Error('HTTP ' + r.status);
            return parseFinmind(await r.json());
        } finally { clearTimeout(timer); }
    }
    async function yahooHistory(t, m, range, sq) {
        let err = null;
        for (const sym of yahooSymbols(t, m, sq)) {
            try {
                const url = 'https://query1.finance.yahoo.com/v8/finance/chart/' + encodeURIComponent(sym) + '?interval=1d&range=' + (range || '6mo');
                const d = await fetchJsonViaProxy(url);
                const r = d && d.chart && d.chart.result && d.chart.result[0];
                const ts = r && r.timestamp, cl = r && r.indicators && r.indicators.quote && r.indicators.quote[0] && r.indicators.quote[0].close;
                if (!ts || !cl) throw new Error('no series');
                const tz = (r.meta && r.meta.gmtoffset) || 0;   // 用交易所當地日期，避免台股跨日
                const dates = [], closes = [];
                ts.forEach((x, i) => {
                    if (cl[i] == null) return;
                    dates.push(new Date((x + tz) * 1000).toISOString().slice(0, 10));
                    closes.push(Math.round(cl[i] * 100) / 100);
                });
                if (!dates.length) throw new Error('no series');
                return { dates, closes, source: 'Yahoo' };
            } catch (e) { err = e; }
        }
        throw err || new Error('no series');
    }
    async function history(ticker, market, range) {
        const snap = await loadSnapshot();
        const t = String(ticker).toUpperCase(), m = market === 'US' ? 'US' : 'TW';
        const sources = [
            () => finmindDirect(t, m, range),
            () => yahooHistory(t, m, range, snapQuote(snap, t, m)),
            async () => parseFinmind(await fetchJsonViaProxy(finmindUrl(t, m, range)))
        ];
        let err = null;
        for (const src of sources) {
            try { return await src(); } catch (e) { err = e; }
        }
        throw err || new Error('no series');
    }

    // TradingView 代碼：台股依快照分上市（TWSE）／上櫃（TPEX），美股直接用代碼
    async function tradingViewSymbol(ticker, market) {
        const t = String(ticker).toUpperCase();
        if (market === 'US') return t;
        const sq = snapQuote(await loadSnapshot(), t, 'TW');
        return (sq && sq.exchange === 'TPEX' ? 'TPEX:' : 'TWSE:') + t;
    }

    function quoteFor(result, pos) { return result.quotes.get(keyOf(pos.ticker, pos.market)) || null; }

    // 狀態列文字：例「報價已更新 (13:05)，7828 用 10/14 收盤價；抓不到：XYZ」
    function statusText(result, positions) {
        const time = new Date().toLocaleTimeString('zh-TW', { hour12: false, hour: '2-digit', minute: '2-digit' });
        const closeOnly = [];
        result.quotes.forEach((q, k) => { if (q.source === 'close') closeOnly.push(k.split(':')[1] + (q.date ? '（' + q.date.slice(5).replace('-', '/') + '）' : '')); });
        let msg = '報價已更新 (' + time + ')';
        if (closeOnly.length) msg += '，即時報價抓不到、改用收盤價：' + closeOnly.join('、');
        if (result.failed.length) msg += '；完全抓不到：' + result.failed.join('、');
        return msg;
    }

    root.PPQuotes = { fetchQuotes, history, tradingViewSymbol, quoteFor, statusText, yahooQuote, fetchJsonViaProxy, keyOf };
})(typeof window !== 'undefined' ? window : globalThis);
