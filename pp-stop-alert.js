/* ══ 槓桿部位停損預警：純計算＋Telegram 發送 ══
   不碰 DOM／Vue，return_equity.html、scripts/check-stops.mjs（GitHub Actions）與 node 測試共用。
   停損價算法與 return_equity.html 的 posLots／lotStopPrice／posCallPrice 一致：
   做多 = 成交價 − 成交價 ÷ 倍數 × 虧損上限；做空 = 成交價 ＋ 成交價 ÷ 倍數 × 虧損上限，
   同一部位有多筆時取最先觸發（做多最高、做空最低）的那一筆。 */
(function (root) {
    'use strict';

    const DEFAULT_ALERT_PCT = 10;   // 緩衝低於此 % 就發預警
    const DEFAULT_LOSS_PCT = 50;

    function num(v) { const n = Number(v); return isNaN(n) ? 0 : n; }
    function isShort(pos) { return !!pos && pos.dir === 'short'; }

    function lotBorrow(shares, price, lev) {
        const l = Number(lev);
        if (!l || l <= 1 || isNaN(l)) return 0;
        return (shares || 0) * (price || 0) * (1 - 1 / l);
    }

    function posBorrow(pos) {
        const cost = num(pos.shares) * num(pos.price);
        if (pos.borrow != null && !isNaN(Number(pos.borrow))) return Math.max(0, Math.min(Number(pos.borrow), cost));
        const lev = Number(pos.lev);
        if (!lev || lev <= 1 || isNaN(lev)) return 0;
        return cost * (1 - 1 / lev);
    }

    // 每一筆 {股數, 成交價, 倍數}；與庫存合計對不上就退回單筆
    function posLots(pos) {
        const shares = num(pos.shares), avg = num(pos.price), borrow = posBorrow(pos);
        const single = () => {
            const cost = shares * avg, own = cost - borrow;
            return [{ shares, price: avg, lev: (borrow > 0 && own > 0) ? cost / own : 1 }];
        };
        const lots = Array.isArray(pos.lots) ? pos.lots : [];
        if (!lots.length) return single();
        let s = 0, c = 0, b = 0;
        for (const l of lots) { s += l.shares; c += l.shares * l.price; b += lotBorrow(l.shares, l.price, l.lev); }
        const ok = Math.abs(s - shares) <= 1e-6 * Math.max(1, shares)
            && Math.abs(c - shares * avg) <= shares * 1e-4 + 1
            && Math.abs(b - borrow) <= Math.max(1, borrow * 1e-4);
        return ok ? lots : single();
    }

    function lossPct(pos, riskCfg) {
        const l = Number(pos.lossPct);
        const v = (!l || l <= 0 || isNaN(l)) ? (Number(riskCfg && riskCfg.lossPct) || DEFAULT_LOSS_PCT) : l;
        return Math.min(v, 100);
    }

    function stopPrice(pos, riskCfg) {
        const loss = lossPct(pos, riskCfg) / 100;
        const lots = posLots(pos).filter(l => l.lev > 1 && l.shares > 0 && l.price > 0);
        if (!lots.length) return 0;
        const stops = lots.map(l => {
            const d = l.price / l.lev * loss;
            return isShort(pos) ? l.price + d : l.price - d;
        });
        return isShort(pos) ? Math.min(...stops) : Math.max(...stops);
    }

    function bufferPct(cur, stop, short) {
        if (!cur || stop <= 0) return 100;
        const dist = short ? (stop - cur) : (cur - stop);
        return Math.max(-100, dist / cur * 100);
    }

    function posLev(pos) {
        const cost = num(pos.shares) * num(pos.price), own = cost - posBorrow(pos);
        return own > 0 ? cost / own : 1;
    }

    /* 掃描所有槓桿部位，回傳緩衝低於門檻者（依緩衝由小到大）。
       portfolio：quantPortfolioDataV2 解析後的物件；
       opts.alertPct：預警門檻（%），預設取 riskCfg.alertPct，再預設 10；
       opts.priceOf(pos)：回傳現價，預設用 pos.currentPrice。 */
    function scan(portfolio, opts) {
        opts = opts || {};
        const riskCfg = (portfolio && portfolio.riskCfg) || {};
        const alertPct = Number(opts.alertPct != null ? opts.alertPct : riskCfg.alertPct) || DEFAULT_ALERT_PCT;
        const priceOf = opts.priceOf || (p => num(p.currentPrice) || num(p.price));
        const out = [];
        for (const pos of (portfolio && portfolio.positions) || []) {
            if (posBorrow(pos) <= 0) continue;
            const stop = stopPrice(pos, riskCfg);
            if (stop <= 0) continue;
            const cur = num(priceOf(pos)) || num(pos.currentPrice) || num(pos.price);
            const short = isShort(pos);
            const buf = bufferPct(cur, stop, short);
            if (buf >= alertPct) continue;
            out.push({
                ticker: pos.ticker, market: pos.market, dir: short ? 'short' : 'long', source: pos.source || '',
                shares: num(pos.shares), price: num(pos.price), lev: posLev(pos), lossPct: lossPct(pos, riskCfg),
                cur, stop, bufferPct: buf, level: buf <= 0 ? 'hit' : 'warn'
            });
        }
        return out.sort((a, b) => a.bufferPct - b.bufferPct);
    }

    // 同一筆部位的識別碼（當日去重用）
    function alertKey(a) {
        return [a.dir, a.ticker, a.market, a.source, a.shares, a.price].join('|');
    }

    function fmt(n) {
        return Number(n).toLocaleString('en-US', { maximumFractionDigits: 2 });
    }

    function describe(a) {
        const side = a.dir === 'short' ? '空' : '多';
        const move = a.dir === 'short' ? '漲' : '跌';
        const head = `${a.ticker} ${a.market || ''} ${side}${a.source ? '・' + a.source : ''}・${fmt(a.shares)} 股 @${fmt(a.price)}（${(Math.round(a.lev * 100) / 100)}x）`;
        const body = a.level === 'hit'
            ? `現價 ${fmt(a.cur)} 已${a.dir === 'short' ? '突破' : '跌破'}停損價 ${fmt(Math.round(a.stop * 100) / 100)}，應已觸發停損！`
            : `現價 ${fmt(a.cur)}，停損價 ${fmt(Math.round(a.stop * 100) / 100)}，再${move} ${a.bufferPct.toFixed(1)}% 就會敲停損`;
        return { head, body };
    }

    function formatMessage(alerts, opts) {
        opts = opts || {};
        const hit = alerts.some(a => a.level === 'hit');
        const lines = [hit ? '🚨 槓桿部位已觸及停損' : '⚠️ 槓桿部位即將敲停損'];
        if (opts.note) lines.push(opts.note);
        lines.push('');
        for (const a of alerts) {
            const d = describe(a);
            lines.push((a.level === 'hit' ? '🔴 ' : '🟠 ') + d.head);
            lines.push('   ' + d.body);
        }
        lines.push('');
        lines.push(`預警門檻：緩衝 < ${opts.alertPct || DEFAULT_ALERT_PCT}%`);
        return lines.join('\n');
    }

    // 用 form-urlencoded 送出（瀏覽器端屬簡單請求，不會觸發 CORS 預檢）
    async function sendTelegram(token, chatId, text, fetchImpl) {
        const f = fetchImpl || (typeof fetch !== 'undefined' ? fetch : null);
        if (!f) throw new Error('fetch 不可用');
        if (!token || !chatId) throw new Error('缺少 Telegram Bot Token 或 Chat ID');
        const body = new URLSearchParams({ chat_id: String(chatId), text, disable_web_page_preview: 'true' });
        const r = await f('https://api.telegram.org/bot' + token + '/sendMessage', { method: 'POST', body });
        let j = null;
        try { j = await r.json(); } catch (e) { /* 非 JSON 回應 */ }
        if (!r.ok || !j || !j.ok) throw new Error('Telegram 發送失敗：' + ((j && j.description) || ('HTTP ' + r.status)));
        return j;
    }

    const api = {
        DEFAULT_ALERT_PCT, posLots, stopPrice, bufferPct, scan, alertKey, describe, formatMessage, sendTelegram
    };
    if (typeof module !== 'undefined' && module.exports) module.exports = api;
    else root.PPStopAlert = api;
})(typeof window !== 'undefined' ? window : globalThis);
