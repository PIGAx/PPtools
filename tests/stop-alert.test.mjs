// 執行：node --test tests/*.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const A = createRequire(import.meta.url)('../pp-stop-alert.js');

// 截圖中的四筆 7828 新金鑽（2.5 倍、虧損上限 50%），borrow = 成本 × (1 − 1/2.5)
const lot = (shares, price) => ({ ticker: '7828', market: 'TW', dir: 'long', source: '康和', shares, price,
    borrow: shares * price * 0.6, lots: [{ shares, price, lev: 2.5 }], currentPrice: 1840 });
const pf = { riskCfg: { lossPct: 50, alertPct: 10 }, positions: [lot(24, 1840), lot(36, 1725), lot(20, 1740), lot(20, 1735),
    { ticker: '2330', market: 'TW', shares: 1000, price: 1000, borrow: 0, currentPrice: 900 }] };

test('停損價與表格一致', () => {
    assert.deepEqual(pf.positions.slice(0, 4).map(p => Math.round(A.stopPrice(p, pf.riskCfg))), [1472, 1380, 1392, 1388]);
});

test('現價 1,840 時沒有預警', () => {
    assert.equal(A.scan(pf).length, 0);
});

test('大跌收 1,605：只有 @1,840 那筆緩衝 8.3% < 10%', () => {
    const r = A.scan(pf, { priceOf: () => 1605 });
    assert.equal(r.length, 1);
    assert.equal(r[0].price, 1840);
    assert.equal(r[0].level, 'warn');
    assert.equal(r[0].bufferPct.toFixed(1), '8.3');
    const msg = A.formatMessage(r, { alertPct: 10 });
    assert.match(msg, /即將敲停損/);
    assert.match(msg, /再跌 8\.3% 就會敲停損/);
});

test('門檻調到 15%：四筆全部預警，依緩衝排序', () => {
    const r = A.scan(pf, { priceOf: () => 1605, alertPct: 15 });
    assert.deepEqual(r.map(x => x.price), [1840, 1740, 1735, 1725]);
});

test('跌破停損價標為 hit', () => {
    const r = A.scan(pf, { priceOf: () => 1450 });
    assert.equal(r[0].level, 'hit');
    assert.match(A.formatMessage(r), /已觸及停損/);
});

test('做空：上漲接近停損', () => {
    const s = { ticker: 'TSLA', market: 'US', dir: 'short', shares: 10, price: 100, borrow: 500, lots: [{ shares: 10, price: 100, lev: 2 }], currentPrice: 120 };
    const r = A.scan({ positions: [s], riskCfg: { lossPct: 50 } });   // 停損 125，緩衝 4.2%
    assert.equal(Math.round(r[0].stop), 125);
    assert.match(A.formatMessage(r), /再漲 4\.2%/);
});

test('rebuyCash：以停損價買回原股數要準備的現金', () => {
    // 24 股 @1840、2.5x、虧損上限 50% → 停損價 1472
    const a = { ticker: '7828', market: 'TW', dir: 'long', shares: 24, price: 1840, lev: 2.5, lossPct: 50, stop: 1472, cur: 1605, bufferPct: 8.3, level: 'warn' };
    const r = A.rebuyCash(a);
    assert.equal(Math.round(r.back), 8832);      // 自備 17,664 剩一半
    assert.equal(Math.round(r.cash), 35328);     // 1472 × 24
    assert.equal(Math.round(r.cashNet), 26496);
    assert.equal(Math.round(r.lev), 14131);      // 1472 × 24 ÷ 2.5
    assert.equal(Math.round(r.levNet), 5299);
    assert.match(A.formatMessage([a]), /現股需 35,328（淨補 26,496）、槓桿 2\.5x 需 14,131（淨補 5,299）/);
    // 看空不能用現股回補
    assert.equal(A.rebuyCash(Object.assign({}, a, { dir: 'short', stop: 2208 })).cash, null);
});
