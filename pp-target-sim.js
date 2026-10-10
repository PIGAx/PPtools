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

    const api = {
        legacyCarry, legacyScenario, legacyEvalAt, legacyBreakeven,
        stockScenario, stockEvalAt, stockBreakeven,
        optionTerms, optionEvalAt, optionBreakeven, optionStressPrices
    };
    if (typeof module !== 'undefined' && module.exports) module.exports = api;
    else root.PPTargetSim = api;
})(typeof window !== 'undefined' ? window : globalThis);
