// 執行：node --test tests/*.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const T = createRequire(import.meta.url)('../pp-target-sim.js');

// 驗收條件：P0 = 1,840、N = 106、L = 2.5、庫存費率 4%、處理費 0.12%、180 天
const t = T.optionTerms({ price: 1840, shares: 106, lev: 2.5, carryPct: 4, handlePct: 0.12, days: 180 });
const near = (a, b, tol = 0.01) => assert.ok(Math.abs(a - b) <= tol, `${a} ≠ ${b}`);

test('權利金、履約價、下限價', () => {
    near(t.premiumPerShare, 736);
    near(t.premium, 78016);
    near(t.strike, 1104);
    near(t.floor, 1472);
    near(t.notional, 195040);
});

test('庫存費以名目全額計、雙邊處理費', () => {
    near(t.carryFee, 195040 * 0.04 * 180 / 365);   // ≈ 3,847.36
    near(t.carryFee, 3847, 1);
    near(t.buyFee, 234.05);
    near(T.optionEvalAt(t, 1840).sellFee, 234.05);
});

test('價格 ≤ 履約價：淨損益 = −(權利金總額 + 全部費用)', () => {
    for (const px of [1104, 1000, 500]) {
        const r = T.optionEvalAt(t, px);
        near(r.net, -(78016 + t.carryFee + t.buyFee + px * 106 * 0.0012));
        assert.ok(r.wipedOut && r.forced);
    }
});

test('價格 ≤ 下限價標示強制收回，以上則否', () => {
    assert.ok(T.optionEvalAt(t, 1472).forced);
    assert.ok(T.optionEvalAt(t, 1288).forced);
    assert.ok(!T.optionEvalAt(t, 1472.01).forced);
    const labels = T.optionStressPrices(t).map(s => Math.round(s.price * 100) / 100);
    assert.deepEqual(labels, [1472, 1398.4, 1324.8, 1104]);
});

test('加碼部位回本價：淨損益 = 0', () => {
    const be = T.optionBreakeven(t);
    near(T.optionEvalAt(t, be).net, 0, 1e-6);
    assert.ok(be > 1840);
});

test('現股出場扣手續費＋證交稅，回本價解出淨損益 = 0', () => {
    const sc = T.stockScenario({ shares: 100, avg: 1380, borrow: 0, carryPct: 0, days: 180 });
    const r = T.stockEvalAt(sc, 1840, 1, 0.4425);
    near(r.net, 46000 - 184000 * 0.004425);
    near(T.stockEvalAt(sc, T.stockBreakeven(sc, 1, 0.4425), 1, 0.4425).net, 0, 1e-6);
});

test('舊版借款模型維持原公式', () => {
    near(T.legacyCarry(117024, 4, 180), 2308.42);
});

test('損益矩陣：(價格 − 成本) × 股數，與試算表一致', () => {
    const prices = T.steps(1800, 3100, 50, 100), shares = T.steps(128, 200, 3, 100);
    assert.equal(prices.length, 27);
    assert.equal(shares.length, 25);
    const m = T.pnlMatrix({ prices, shares, cost: 1477, dirSign: 1 });
    near(m[0][0], 41344);      // 1800 × 128
    near(m[0][9], 50065);      // 1800 × 155
    near(m[26][24], 324600);   // 3100 × 200
    const f = T.pnlMatrix({ prices: [2000], shares: [100], cost: 1477, dirSign: 1, exitCostPct: 0.4425 });
    near(f[0][0], 52300 - 2000 * 100 * 0.004425);
});

test('矩陣預設範圍：155 股 → 128～200 間距 3；1,840 → 間距 50', () => {
    const d = T.matrixDefaults(1840, 155);
    assert.deepEqual([d.sStart, d.sEnd, d.sStep], [128, 200, 3]);
    assert.deepEqual([d.pStart, d.pStep, d.pEnd], [1650, 50, 2950]);
});

test('強制收回後重新承作：P0 1,846、24 股、持有 30 天', () => {
    const r = T.recallRebuy({ P0: 1846, N: 24, days: 30, days1: 90 });
    near(r.strike0, 1107.6);
    near(r.floor0, 1476.8);
    near(r.payoff, (1476.8 - 1107.6) * 24);
    near(r.cashBack, r.payoff - 1476.8 * 24 * 0.0012 - 1846 * 24 * 0.04 * 30 / 365);
    near(r.realizedPnL, r.cashBack - (738.4 * 24 + 1846 * 24 * 0.0012));
    near(r.topUp, 1476.8 / 2.5 * 24 + 1476.8 * 24 * 0.0012 - r.cashBack);
    near(r.floor1, 1476.8 * 0.8);
    // 回本價代回去：新部位淨損益剛好補回已實現虧損
    const X = r.breakEven, h = 0.0012;
    near((X - r.R) * 24 - X * 24 * h - r.R * 24 * h - r.carry1, -r.realizedPnL, 1e-6);
    assert.ok(!r.fullLoss);
});

test('結算價 ≤ 履約價：payoff = 0、標示權利金全賠', () => {
    const rows = T.recallSensitivity({ P0: 1846, N: 24, days: 30 });
    assert.deepEqual(rows.map(x => Math.round(x.S * 100) / 100), [1476.8, 1402.96, 1329.12, 1107.6]);
    const last = rows[3];
    assert.equal(last.payoff, 0);
    assert.ok(last.fullLoss);
    assert.ok(rows.every((x, i) => i === 0 || x.topUp > rows[i - 1].topUp));   // 跌越深、補越多
});

test('同標的合併風險：現股 ＋ 兩筆新金鑽各自計算下限價', () => {
    const r = T.tickerRisk({
        price: 1840,
        lots: [
            { shares: 120, price: 1477, lev: 1 },
            { shares: 24, price: 1846, lev: 2.5, days: 30 },
            { shares: 10, price: 1600, lev: 2, days: 10 }
        ]
    });
    assert.equal(r.shares, 154);
    assert.equal(r.cashShares, 120);
    assert.equal(r.levShares, 34);
    near(r.firstFloor, 1476.8);                                   // 1846 那筆最先觸發
    assert.deepEqual(r.rows.map(x => x.price), [1476.8, 1200, 1080]); // 1600×2 倍 → 下限價 1,200
    assert.deepEqual(r.rows.map(x => x.recalled), [1, 2, 2]);
    // 1,200 時：現股 (1200−1477)×120，1846 那筆最多賠權利金 738.4×24，1600 那筆剛好賠一半權利金
    near(r.rows[1].pnl, (1200 - 1477) * 120 + Math.max((1200 - 1846) * 24, -738.4 * 24) + (1200 - 1600) * 10);
    const one = T.recallRebuy({ P0: 1846, N: 24, L: 2.5, days: 30, S: 1476.8, R: 1476.8 });
    near(r.rows[0].topUp, one.topUp);
    near(r.reserve, Math.max(...r.rows.map(x => x.topUp)));
});
