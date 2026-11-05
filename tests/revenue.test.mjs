// 執行：node --test tests/*.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
const R = createRequire(import.meta.url)('../pp-revenue.js');
const seed = () => JSON.parse(readFileSync(new URL('../data/revenue.json', import.meta.url), 'utf8')).companies['7828'];
const near = (a, b, tol = 0.05) => assert.ok(Math.abs(a - b) <= tol, `${a} ≠ ${b}`);
const TODAY = '2026-11-05';

test('民國年月轉換', () => {
    assert.equal(R.normYm('11509'), '2026-09');
    assert.equal(R.normYm('115/10'), '2026-10');
    assert.equal(R.normYm('202601'), '2026-01');
    assert.equal(R.normYm('11513'), null);
});

test('季合計與達成率與追蹤表一致', () => {
    const a = R.analyze(seed(), TODAY);
    near(a.quarters['2026Q1'].rev, 152.3);
    near(a.quarters['2026Q2'].rev, 359.2);
    near(a.quarters['2026Q3'].rev, 442.8);
    near(a.quarters['2026Q3'].revAch.CTBC, 79.5);
    near(a.quarters['2026Q3'].revAch.JPM, 99.1);
    near(a.quarters['2026Q2'].revAch.CTBC, 105.6);
    assert.equal(a.quarters['2026Q3'].epsRough, 4.1);
    near(a.years['2026'].rev, 954.3);
    near(a.years['2026'].yoy, 196.9, 0.5);
});

test('全年 EPS：CTBC 下修壓力、JPM 相對安全', () => {
    const y = R.analyze(seed(), TODAY).years['2026'];
    const ctbc = y.brokers.find(b => b.broker === 'CTBC'), jpm = y.brokers.find(b => b.broker === 'JPM');
    near(y.epsActual, 4.43, 0.001);
    near(ctbc.need, 8.01, 0.001);
    assert.equal(ctbc.status, '下修壓力');
    near(jpm.need, 6.58, 0.001);
    assert.equal(jpm.status, '相對安全');
});

test('待更新事項：10 月營收 11/10、3Q26 財報 11/14、全年預估', () => {
    const p = R.analyze(seed(), TODAY).pending;
    assert.deepEqual(p.map(x => [x.title, x.due]), [['10 月營收', '2026-11-10'], ['3Q26 財報', '2026-11-14'], ['2026 全年預估', null]]);
});

test('觀測站新月營收：新增月列、MoM／YoY、未創新高', () => {
    const c = seed();
    const rec = R.parseRevenueRow({
        '出表日期': '1151111', '資料年月': '11510', '公司代號': '7828', '公司名稱': '創新服務',
        '營業收入-當月營收': '170,500', '營業收入-上月營收': '156200', '營業收入-去年當月營收': '61000',
        '營業收入-上月比較增減(%)': '9.15', '營業收入-去年同月增減(%)': '179.5', '備註': '-'
    });
    assert.equal(rec.ym, '2026-10');
    near(rec.rev, 170.5, 0.001);
    const ch = R.upsertMonth(c, rec, 'mops');
    assert.equal(ch.type, 'new');
    assert.equal(R.upsertMonth(c, rec, 'mops'), null, '同一筆再合併不應有變動');
    const a = R.analyze(c, '2026-11-11');
    const oct = a.latest;
    assert.equal(oct.ym, '2026-10');
    const sep = c.monthly.find(m => m.ym === '2026-09').rev;
    near(oct.mom, (170.5 / sep - 1) * 100, 0.01);
    near(oct.yoy, (170.5 / 61 - 1) * 100, 0.01);
    assert.equal(oct.isRecord, false);
    assert.equal(a.curQ.label, '4Q26');
    assert.deepEqual(a.pending.slice(0, 2).map(p => p.title), ['3Q26 財報', '11 月營收']);
    assert.match(R.formatRevenueNotice('7828', c, '2026-10'), /未創新高（高點 2025\/12 183.3）/);
});

test('超過 183.3 → 創單月新高', () => {
    const c = seed();
    R.upsertMonth(c, { ym: '2026-10', rev: 200 }, 'mops');
    assert.equal(R.analyze(c, TODAY).latest.isRecord, true);
});

test('官方值覆蓋手填值並記為修正', () => {
    const c = seed();
    const ch = R.upsertMonth(c, { ym: '2026-09', rev: 158.0, prevYear: 77.3 }, 'mops');
    assert.equal(ch.type, 'revised');
    const row = c.monthly.find(m => m.ym === '2026-09');
    assert.equal(row.yoy, undefined);
    near(R.analyze(c, TODAY).latest.yoy, (158 / 77.3 - 1) * 100, 0.01);
});

test('季 EPS 彙總為累計值時，自動扣前兩季得單季', () => {
    const c = seed();
    // 1–9 月累計營收約 954.3 百萬、累計 EPS 8.6 → 3Q 單季 = 8.6 − 1.02 − 3.41 = 4.17
    const p = R.parseEpsRow({ '年度': '115', '季別': '3', '公司代號': '7828', '基本每股盈餘(元)': '8.60', '營業收入': '954300', '稅後淨利': '340000' });
    assert.equal(p.q, '2026Q3');
    const s = R.singleQuarterEps(c, p);
    assert.equal(s.basis, 'ytd');
    near(s.eps, 4.17, 0.001);
    // 若是單季口徑（營收≈單季合計）就直接用
    const p2 = R.parseEpsRow({ '年度': '115', '季別': '3', '公司代號': '7828', '基本每股盈餘(元)': '4.17', '營業收入': '442800' });
    assert.deepEqual(R.singleQuarterEps(c, p2), { eps: 4.17, basis: 'q' });
});

test('手動補登只填空，不蓋官方值', () => {
    const sepOfficial = seed().monthly.find(m => m.ym === '2026-09').rev;
    const c = R.withManual(seed(), { monthly: { '2026-09': 999, '2026-10': 150 }, eps: { '2026Q2': 9, '2026Q3': 4.2 } });
    assert.equal(c.monthly.find(m => m.ym === '2026-09').rev, sepOfficial);
    assert.equal(c.monthly.find(m => m.ym === '2026-10').src, 'manual');
    assert.equal(c.quarters['2026Q2'].eps, 3.41);
    assert.equal(c.quarters['2026Q3'].eps, 4.2);
});

test('櫃買 EPS 彙總表真實欄位（2026-11-05 Actions 實測）可解析，且為累計口徑', () => {
    const row = { Date: '1151105', Year: '115', '季別': '3', SecuritiesCompanyCode: '7828', CompanyName: '創新服務股份有限公司', '產業別': '電機機械',
        '基本每股盈餘': '8.60', '普通股每股面額': '新台幣                 10.0000元', '營業收入': '954167.00', '營業利益': '400000.00', '營業外收入及支出': '1000.00', '稅後淨利': '340000.00' };
    const p = R.parseEpsRow(row);
    assert.equal(p.code, '7828');
    assert.equal(p.q, '2026Q3');
    assert.equal(p.eps, 8.6);
    const s = R.singleQuarterEps(seed(), p);
    assert.equal(s.basis, 'ytd');
    near(s.eps, 4.17, 0.001);
});
