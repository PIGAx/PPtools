/* ══ 目標價損益模擬：純計算函式 ══
   不碰 DOM／Vue，return_equity.html 與 node 測試（tests/target-sim.test.mjs）共用。
   金額一律為原幣，換匯由呼叫端處理。 */
(function (root) {
    'use strict';

    /* ── 舊版（融資／借款模型）── */

    // 期間成本：借款餘額 × 年息 × 天數 / 365（單利）
    function legacyCarry(borrow, feePct, days) {
        return (borrow || 0) * (feePct || 0) / 100 * (days || 0) / 365;
    }

    // 一個部位情境：股數、均價、借款、總成本、自有資金（總成本 − 借款）、期間成本
    function legacyScenario(shares, avg, borrow, feePct, days) {
        const cost = shares * avg;
        return {
            shares: shares,
            avg: avg,
            borrow: borrow,
            cost: cost,
            own: Math.max(cost - borrow, 0),
            carry: legacyCarry(borrow, feePct, days)
        };
    }

    // 某價位的損益：毛利 − 期間成本；成本報酬 = 淨損益 ÷ 總成本；自有資金報酬 = 淨損益 ÷（總成本 − 借款）
    function legacyEvalAt(sc, target, dirSign) {
        const gross = dirSign * (target - sc.avg) * sc.shares;
        const net = gross - sc.carry;
        return {
            gross: gross,
            carry: sc.carry,
            net: net,
            roi: sc.cost > 0 ? net / sc.cost * 100 : 0,
            roe: sc.own > 0 ? net / sc.own * 100 : (sc.cost > 0 ? net / sc.cost * 100 : 0)
        };
    }

    // 回本價：均價 ± 每股分攤的期間成本
    function legacyBreakeven(sc, dirSign) {
        return sc.shares > 0 ? sc.avg + dirSign * sc.carry / sc.shares : 0;
    }

    /* ── 現股部位（含手續費、證交稅）──
       exitCostPct：出場時的費用率（%），由呼叫端依市場與多空決定（台股做多 = 手續費 + 證交稅）。
       buyCost：本次加碼買進的手續費（原有部位的買進費用已是沉沒成本，不再計入）。 */
    function stockScenario(o) {
        const shares = o.shares || 0, avg = o.avg || 0, borrow = o.borrow || 0;
        const cost = shares * avg;
        return {
            shares: shares,
            avg: avg,
            borrow: borrow,
            cost: cost,
            own: Math.max(cost - borrow, 0),
            carry: legacyCarry(borrow, o.carryPct, o.days),
            buyCost: o.buyCost || 0
        };
    }

    function stockEvalAt(sc, exit, dirSign, exitCostPct) {
        const gross = dirSign * (exit - sc.avg) * sc.shares;
        const exitCost = exit * sc.shares * (exitCostPct || 0) / 100;
        const net = gross - sc.carry - sc.buyCost - exitCost;
        return { gross: gross, carry: sc.carry, buyCost: sc.buyCost, exitCost: exitCost, net: net };
    }

    // 解 stockEvalAt(...).net = 0
    function stockBreakeven(sc, dirSign, exitCostPct) {
        if (!(sc.shares > 0)) return 0;
        const e = (exitCostPct || 0) / 100, fixed = sc.carry + sc.buyCost;
        return dirSign > 0
            ? (sc.avg * sc.shares + fixed) / (sc.shares * (1 - e))
            : (sc.avg * sc.shares - fixed) / (sc.shares * (1 + e));
    }

    /* ── 加碼部位：自訂槓桿股權選擇權（買權，康和新金鑽）──
       每股權利金 = P0 / L；履約價 = P0 − 每股權利金；
       下限價（強制收回線）= 履約價 + 每股權利金 × 50%：收盤 ≤ 下限價，隔日以當日最低第一委買提前結算；
       庫存費以全額名目金額（P0 × N）計，不是只對「借款」計；作業處理費買進、賣出各收一次；選擇權無證交稅。
       TODO(除息)：除息時履約價與下限價的調整規則尚未確認，目前不做任何調整。 */
    const OPTION_FLOOR_RATIO = 0.5;
    const EPS = 1e-9;   // 浮點誤差：剛好等於下限價也算觸發

    function optionTerms(o) {
        const P0 = o.price || 0, N = o.shares || 0, L = o.lev || 0;
        if (!(P0 > 0 && N > 0 && L > 1)) return null;
        const premiumPerShare = P0 / L;
        const strike = P0 - premiumPerShare;
        const notional = P0 * N;
        return {
            price: P0,
            shares: N,
            lev: L,
            carryPct: o.carryPct || 0,
            handlePct: o.handlePct || 0,
            days: o.days || 0,
            premiumPerShare: premiumPerShare,
            premium: premiumPerShare * N,
            strike: strike,
            floor: strike + premiumPerShare * OPTION_FLOOR_RATIO,
            notional: notional,
            carryFee: notional * (o.carryPct || 0) / 100 * (o.days || 0) / 365,
            buyFee: notional * (o.handlePct || 0) / 100
        };
    }

    // settle：出場價；價格 ≤ 下限價時代表強制收回的結算價（不是收盤價）
    function optionEvalAt(t, settle) {
        const N = t.shares;
        const grossRaw = (settle - t.price) * N;
        const gross = Math.max(grossRaw, -t.premium);      // 最多賠掉權利金
        const sellFee = settle * N * t.handlePct / 100;
        const fees = t.carryFee + t.buyFee + sellFee;
        return {
            settle: settle,
            gross: gross,
            carryFee: t.carryFee,
            buyFee: t.buyFee,
            sellFee: sellFee,
            fees: fees,
            net: gross - fees,                              // 下限：−(權利金總額 + 全部費用)
            forced: settle <= t.floor + EPS,
            wipedOut: settle <= t.strike + EPS
        };
    }

    // 解 optionEvalAt(...).net = 0（含庫存費與雙邊處理費）
    function optionBreakeven(t) {
        const h = t.handlePct / 100;
        return (t.price * t.shares + t.carryFee + t.buyFee) / (t.shares * (1 - h));
    }

    // 強制收回壓力情境：下限價、再跳空 −5%／−10%、權利金全賠（≤ 履約價）
    function optionStressPrices(t) {
        return [
            { price: t.floor, label: '下限價' },
            { price: t.floor * 0.95, label: '下限價跳空 −5%' },
            { price: t.floor * 0.9, label: '下限價跳空 −10%' },
            { price: t.strike, label: '權利金全賠（≤ 履約價）' }
        ];
    }

    /* ── 價格 × 股數 損益矩陣 ── */

    // 取「好讀」的間距：1、2、2.5、5 × 10^k
    function niceStep(raw) {
        if (!(raw > 0)) return 1;
        const p = Math.pow(10, Math.floor(Math.log10(raw)));
        const m = raw / p;
        return (m <= 1 ? 1 : m <= 2 ? 2 : m <= 2.5 ? 2.5 : m <= 5 ? 5 : 10) * p;
    }

    // 預設範圍：價格從現價 −10% 起 27 列，股數以持股為中心偏上 25 欄
    function matrixDefaults(price, shares) {
        const pStep = niceStep((price || 0) * 0.025);
        const pStart = Math.max(pStep, Math.floor((price || 0) * 0.9 / pStep) * pStep);
        const sStep = Math.max(1, Math.round((shares || 0) * 0.02));
        const sStart = Math.max(sStep, (shares || 0) - 9 * sStep);
        return { pStart, pEnd: pStart + 26 * pStep, pStep, sStart, sEnd: sStart + 24 * sStep, sStep };
    }

    function steps(start, end, step, maxCount) {
        const out = [];
        if (!(step > 0) || !(end >= start)) return out;
        for (let i = 0; out.length < maxCount; i++) {
            const v = Math.round((start + i * step) * 10000) / 10000;
            if (v > end + 1e-9) break;
            out.push(v);
        }
        return out;
    }

    // cells[i][j] = 價格 prices[i]、股數 shares[j] 的損益（扣出場費用率 exitCostPct %）
    function pnlMatrix(o) {
        const cost = o.cost || 0, dirSign = o.dirSign || 1, e = (o.exitCostPct || 0) / 100;
        return o.prices.map(p => o.shares.map(n => dirSign * (p - cost) * n - p * n * e));
    }

    /* ── 強制收回後重新承作（新金鑽）──
       費率為小數（0.04 = 4%）。舊合約被收回：拿回 max(S − 履約價, 0) × N，扣賣出處理費與已累積庫存費；
       新合約以重新承作價 R 開倉：權利金 R / L1 ＋ 買進處理費。topUp > 0 為要補的錢，< 0 為退回。
       實際結算價為隔日最低第一委買，重新承作也有買賣價差，結果僅供試算。 */
    function recallRebuy(o) {
        const P0 = o.P0, N = o.N, L = o.L || 2.5;
        const feeCarry = o.feeCarry != null ? o.feeCarry : 0.04;
        const feeProc = o.feeProc != null ? o.feeProc : 0.0012;
        const days = o.days || 0, days1 = o.days1 || 0;
        const prem0 = P0 / L;
        const strike0 = P0 - prem0;
        const floor0 = strike0 + prem0 * OPTION_FLOOR_RATIO;

        const S = o.S != null ? o.S : floor0;
        const R = o.R != null ? o.R : S;
        const N1 = o.N1 != null ? o.N1 : N;
        const L1 = o.L1 || L;

        const payoff = Math.max(S - strike0, 0) * N;
        const sellFee = S * N * feeProc;
        const carry = P0 * N * feeCarry * days / 365;
        const cashBack = payoff - sellFee - carry;
        const realizedPnL = cashBack - (prem0 * N + P0 * N * feeProc);

        const prem1 = R / L1;
        const cost1 = prem1 * N1 + R * N1 * feeProc;
        const topUp = cost1 - cashBack;
        const strike1 = R - prem1;
        const floor1 = strike1 + prem1 * OPTION_FLOOR_RATIO;

        // 新部位回本價：解 (X − R)·N1 − X·N1·feeProc − R·N1·feeProc − carry1 = −realizedPnL
        const carry1 = R * N1 * feeCarry * days1 / 365;
        const breakEven = N1 > 0 ? (R + (-realizedPnL + R * N1 * feeProc + carry1) / N1) / (1 - feeProc) : 0;

        return {
            prem0, strike0, floor0, S, R, N1, L1,
            payoff, sellFee, carry, cashBack, realizedPnL,
            prem1, cost1, topUp, strike1, floor1, carry1, breakEven,
            fullLoss: S <= strike0 + EPS
        };
    }

    // 敏感度：結算價 = 下限價、再跌 5%、再跌 10%、履約價；重新承作價跟著結算價（使用者另填 R 時沿用）
    function recallSensitivity(o) {
        const base = recallRebuy(Object.assign({}, o, { S: null, R: null }));
        return [
            { label: '下限價', S: base.floor0 },
            { label: '下限價再跌 5%', S: base.floor0 * 0.95 },
            { label: '下限價再跌 10%', S: base.floor0 * 0.9 },
            { label: '履約價', S: base.strike0 }
        ].map(r => Object.assign({ label: r.label }, recallRebuy(Object.assign({}, o, { S: r.S, R: o.R != null ? o.R : r.S }))));
    }

    /* ── 同標的合併風險 ──
       lots：同一檔的每一筆 { shares, price, lev, days }，lev ≤ 1 為現股、> 1 為新金鑽（各自的履約價／下限價）。
       壓力價位取每一筆新金鑽的下限價（由高到低）與最低下限價再跌 10%；被收回的單以該價位結算（跳空的保守假設），
       並試算以同價位重新承作同股數、同倍數的合計需補款。損益不含費用，需補款含庫存費與處理費（同 recallRebuy）。 */
    function tickerRisk(o) {
        const lots = (o.lots || []).filter(l => l.shares > 0 && l.price > 0);
        const feeCarry = o.feeCarry != null ? o.feeCarry : 0.04;
        const feeProc = o.feeProc != null ? o.feeProc : 0.0012;
        const levLots = lots.filter(l => l.lev > 1).map(l => {
            const prem = l.price / l.lev, strike = l.price - prem;
            return Object.assign({}, l, { strike, floor: strike + prem * OPTION_FLOOR_RATIO });
        });
        const pnlAt = p => lots.reduce((a, l) => a + (l.lev > 1
            ? Math.max((p - l.price) * l.shares, -l.price / l.lev * l.shares)
            : (p - l.price) * l.shares), 0);
        const floors = [...new Set(levLots.map(l => Math.round(l.floor * 100) / 100))].sort((a, b) => b - a);
        const prices = floors.length ? floors.concat([Math.round(floors[floors.length - 1] * 0.9 * 100) / 100]) : [];
        const rows = prices.map((p, i) => {
            const hit = levLots.filter(l => p <= l.floor + 0.005);
            const topUp = hit.reduce((a, l) => a + recallRebuy({
                P0: l.price, N: l.shares, L: l.lev, feeCarry, feeProc, days: l.days || 0, S: p, R: p
            }).topUp, 0);
            return {
                price: p, label: i < floors.length ? '下限價' : '最低下限價再跌 10%',
                recalled: hit.length, recalledShares: hit.reduce((a, l) => a + l.shares, 0),
                pnl: pnlAt(p), topUp
            };
        });
        const cur = o.price || 0;
        const first = levLots.length ? Math.max(...levLots.map(l => l.floor)) : 0;
        return {
            shares: lots.reduce((a, l) => a + l.shares, 0),
            cashShares: lots.filter(l => !(l.lev > 1)).reduce((a, l) => a + l.shares, 0),
            levShares: levLots.reduce((a, l) => a + l.shares, 0),
            cost: lots.reduce((a, l) => a + l.shares * l.price, 0),
            own: lots.reduce((a, l) => a + l.shares * l.price / (l.lev > 1 ? l.lev : 1), 0),
            pnl: cur > 0 ? pnlAt(cur) : 0,
            levLots, firstFloor: first,
            bufferPct: cur > 0 && first > 0 ? (cur - first) / cur * 100 : null,
            rows,
            reserve: rows.reduce((a, r) => Math.max(a, r.topUp), 0)
        };
    }

    const api = {
        legacyCarry, legacyScenario, legacyEvalAt, legacyBreakeven,
        stockScenario, stockEvalAt, stockBreakeven,
        optionTerms, optionEvalAt, optionBreakeven, optionStressPrices,
        niceStep, matrixDefaults, steps, pnlMatrix,
        recallRebuy, recallSensitivity, tickerRisk
    };
    if (typeof module !== 'undefined' && module.exports) module.exports = api;
    else root.PPTargetSim = api;
})(typeof window !== 'undefined' ? window : globalThis);
