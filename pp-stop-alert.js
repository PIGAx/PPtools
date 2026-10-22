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

    /* 以 exit 價整筆出場的結算，對齊券商對帳單：
       own 自有本金（保證金）、pnl 履約損益、fee 出場費用（作業處理費＋累計庫存費）、back 可拿回（淨收支 ＝ own ＋ pnl − fee）。
       fees：{ handlePct 作業處理費 %（新金鑽，按出場價金）、carryPct 庫存費 %／年（部位沒填 carryFee 時用）、now }
       做多槓桿（新金鑽）庫存費以名目全額 × 年費率 × 持有天數 ÷ 365；做空以借款 × 年息；持有天數取 openedAt，沒填就不算。 */
    function settle(pos, exit, fees) {
        fees = fees || {};
        const shares = num(pos.shares), price = num(pos.price), borrow = posBorrow(pos), short = isShort(pos);
        const own = shares * price - borrow;
        const pnl = (short ? -1 : 1) * (num(exit) - price) * shares;
        let fee = 0;
        if (borrow > 0) {
            const opened = pos.openedAt ? new Date(pos.openedAt).getTime() : NaN;
            const days = isNaN(opened) ? 0 : Math.max(0, Math.round(((fees.now || Date.now()) - opened) / 86400000));
            const rate = (Number(pos.carryFee) || (short ? 0 : num(fees.carryPct))) / 100;
            fee += (short ? borrow : shares * price) * rate * days / 365;
            if (!short) fee += num(exit) * shares * num(fees.handlePct) / 100;
        }
        return { own, pnl, fee, back: Math.max(0, own + pnl - fee) };
    }

    // 預估出場價：觸及停損時券商以觸發後的結算價強制回收，已跳空穿過停損價就以現價估（取較差者），否則以停損價估
    function exitPrice(cur, stop, short) {
        const s = Math.round(num(stop) * 100) / 100;
        if (!isHit(cur, stop, short)) return s;
        return short ? Math.max(cur, s) : Math.min(cur, s);
    }

    // 觸及停損：現價要「超過」停損價才算（做多跌破、做空突破；停損價取到小數兩位），剛好等於停損價還沒觸發
    function isHit(cur, stop, short) {
        const s = Math.round(num(stop) * 100) / 100;
        if (!cur || s <= 0) return false;
        return short ? cur > s : cur < s;
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
            const recall = pos.recall && pos.recall.date ? pos.recall : null;
            if (buf >= alertPct && !recall) continue;
            // 已確定回收：以現價估（下一交易日的結算價）；其餘同 exitPrice
            const exit = recall ? cur : exitPrice(cur, stop, short);
            const st = settle(pos, exit, opts.fees || (portfolio && portfolio.optCfg));
            out.push({
                ticker: pos.ticker, market: pos.market, dir: short ? 'short' : 'long', source: pos.source || '',
                shares: num(pos.shares), price: num(pos.price), lev: posLev(pos), lossPct: lossPct(pos, riskCfg),
                cur, stop, bufferPct: buf, level: recall ? 'recall' : (isHit(cur, stop, short) ? 'hit' : 'warn'),
                recallDate: recall ? recall.date : null, recallPrice: recall ? num(recall.price) : null,
                exit, own: st.own, pnl: st.pnl, fee: st.fee, back: st.back
            });
        }
        return out.sort((a, b) => (b.level === 'recall') - (a.level === 'recall') || a.bufferPct - b.bufferPct);
    }

    /* ══ 強制回收兩段式：收盤跌破 → 待回收；下一交易日收盤後 → 以當天價格結算 ══
       新金鑽回收價承作後不能調整、觸發後不能取消，觸發看收盤價，下一交易日以結算價回收（以收盤價估）。 */
    const MARKET_TZ = { TW: ['Asia/Taipei', 13 * 60 + 35], US: ['America/New_York', 16 * 60 + 5] };

    function marketNow(market, now) {
        const [tz] = MARKET_TZ[market === 'US' ? 'US' : 'TW'];
        const parts = {};
        new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' })
            .formatToParts(new Date(now || Date.now())).forEach(x => { parts[x.type] = x.value; });
        return { date: `${parts.year}-${parts.month}-${parts.day}`, minutes: Number(parts.hour) * 60 + Number(parts.minute) };
    }

    // 報價是否為該報價日的收盤價：報價日早於市場當地今天，或今天已過收盤結算時間
    function quoteFinal(market, date, now) {
        if (!date) return false;
        const m = marketNow(market, now);
        if (date < m.date) return true;
        return date === m.date && m.minutes >= MARKET_TZ[market === 'US' ? 'US' : 'TW'][1];
    }

    /* 回傳下一步：{ action: 'mark' | 'cancel' | 'settle' | 'none', date, price }
       q = { price, date（市場當地報價日 YYYY-MM-DD）, final（是否為收盤價） } */
    function recallStep(pos, q, riskCfg) {
        const stop = stopPrice(pos, riskCfg || {});
        if (stop <= 0 || !q || !(num(q.price) > 0) || !q.date) return { action: 'none' };
        const r = pos.recall;
        const hit = isHit(num(q.price), stop, isShort(pos));
        if (r && r.date) {
            if (q.final && q.date > r.date) return { action: 'settle', date: q.date, price: num(q.price) };
            if (q.final && q.date === r.date && !hit) return { action: 'cancel' };   // 收盤價更正後沒有跌破
            return { action: 'none' };
        }
        if (q.final && hit) return { action: 'mark', date: q.date, price: num(q.price) };
        return { action: 'none' };
    }

    /* ══ 回收價分散建議 ══
       stops：同一檔既有槓桿單的回收價；cur：現價；lossPct：虧損上限 %。
       回傳 clusters（彼此差距 < gapPct 的回收價群）與 options（各進場價 × 倍數的新回收價、距現價、與既有回收價最近差距、是否建議）。 */
    function spreadPlan(o) {
        const cur = num(o.cur), loss = (num(o.lossPct) || DEFAULT_LOSS_PCT) / 100;
        const gap = (num(o.gapPct) || 3) / 100, minDist = (num(o.minDistPct) || 25) / 100;
        const stops = (o.stops || []).map(num).filter(x => x > 0).sort((a, b) => b - a);
        const clusters = [];
        for (const st of stops) {
            const c = clusters[clusters.length - 1];
            if (c && (c.high - st) / cur < gap) { c.low = st; c.count++; } else clusters.push({ high: st, low: st, count: 1 });
        }
        const levs = o.levs || [1.5, 2, 2.5];
        const prices = o.prices || [cur, Math.round(cur * 0.95), Math.round(cur * 0.9)];
        const options = [];
        for (const p of prices) {
            for (const lev of levs) {
                const stop = p * (1 - loss / lev);
                const dist = 1 - stop / cur;
                const near = stops.length ? Math.min(...stops.map(x => Math.abs(x - stop))) / cur : null;
                const ok = dist >= minDist && (near === null || near >= gap);
                options.push({ price: Math.round(p * 100) / 100, lev, stop: Math.round(stop * 100) / 100, distPct: dist * 100,
                               nearPct: near === null ? null : near * 100, ok });
            }
        }
        return { clusters, options };
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
        const stopTxt = fmt(Math.round(a.stop * 100) / 100);
        const body = a.level === 'recall'
            ? `${a.recallDate.slice(5).replace('-', '/')} 收盤 ${fmt(a.recallPrice)} 已${a.dir === 'short' ? '突破' : '跌破'}回收價 ${stopTxt}，確定強制回收（不能取消），下一交易日收盤後以結算價結算；現價 ${fmt(a.cur)}`
            : a.level === 'hit'
            ? `現價 ${fmt(a.cur)} 已${a.dir === 'short' ? '突破' : '跌破'}停損價 ${stopTxt}，收盤仍${a.dir === 'short' ? '高' : '低'}於此價就會被強制回收（不能取消）`
            : `現價 ${fmt(a.cur)}，停損價 ${stopTxt}，再${move} ${a.bufferPct.toFixed(1)}% 就會敲停損`;
        // 以停損價結算的損益與可拿回本金（美股為 USD）
        const ccy = a.market === 'US' ? 'USD ' : '';
        const feeText = a.fee >= 1 ? `、費用 ${ccy}${fmt(Math.round(a.fee))}` : '';
        const settleText = a.pnl == null ? '' : `${a.level === 'warn' ? '敲停損' : '以 ' + fmt(a.exit) + ' 結算'}損益 ${a.pnl >= 0 ? '+' : '−'}${ccy}${fmt(Math.round(Math.abs(a.pnl)))}${feeText}，可拿回本金約 ${ccy}${fmt(Math.round(a.back))}（投入 ${fmt(Math.round(a.own))}）`;
        return { head, body, settle: settleText };
    }

    function formatMessage(alerts, opts) {
        opts = opts || {};
        const hit = alerts.some(a => a.level !== 'warn');
        const lines = [hit ? '🚨 槓桿部位已觸及停損' : '⚠️ 槓桿部位即將敲停損'];
        if (opts.note) lines.push(opts.note);
        lines.push('');
        for (const a of alerts) {
            const d = describe(a);
            lines.push(({ recall: '⏳ ', hit: '🔴 ' }[a.level] || '🟠 ') + d.head);
            lines.push('   ' + d.body);
            if (d.settle) lines.push('   ' + d.settle);
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
        DEFAULT_ALERT_PCT, posLots, stopPrice, bufferPct, isHit, exitPrice, settle, scan, marketNow, quoteFinal, recallStep, spreadPlan, alertKey, describe, formatMessage, sendTelegram
    };
    if (typeof module !== 'undefined' && module.exports) module.exports = api;
    else root.PPStopAlert = api;
})(typeof window !== 'undefined' ? window : globalThis);
