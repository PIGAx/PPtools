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

    const api = { legacyCarry, legacyScenario, legacyEvalAt, legacyBreakeven };
    if (typeof module !== 'undefined' && module.exports) module.exports = api;
    else root.PPTargetSim = api;
})(typeof window !== 'undefined' ? window : globalThis);
