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
