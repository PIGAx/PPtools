import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseNews, parseConferences, rocToIso, buildIcs } from '../scripts/fetch-company-events.mjs';

const newsHtml = `<table class='hasBorder'>
<tr class='tblHead'><th>公司代號</th><th>公司名稱</th><th>發言日期</th><th>發言時間</th><th>主旨</th><th>&nbsp;</th></tr>
<tr class='even'>
<td style='text-align:left !important;'>&nbsp;7828</td><td style='text-align:left !important;'>&nbsp;創新服務</td><td style='text-align:left !important;'>&nbsp;115/03/10</td><td style='text-align:left !important;'>&nbsp;17:04:53</td><td style='text-align:left !important;'><pre><font size='3'>&nbsp;公告本公司董事會通過114年度第四季合併財務報告</font></pre></td><td align='center'><input type='button' value='詳細資料'></td></tr>
<tr class='odd'><td>&nbsp;7828</td><td>&nbsp;創新服務</td><td>&nbsp;115/10/20</td><td>&nbsp;16:00:00</td><td><pre>&nbsp;公告本公司訂於115年11月6日召開董事會</pre></td><td></td></tr>
<tr class='odd'><td>&nbsp;7828</td><td>&nbsp;創新服務</td><td>&nbsp;115/10/21</td><td>&nbsp;16:00:00</td><td><pre>&nbsp;澄清媒體報導</pre></td><td></td></tr>
</table>`;

test('rocToIso', () => {
  assert.equal(rocToIso('115/06/05'), '2026-06-05');
  assert.equal(rocToIso('115年11月6日'), '2026-11-06');
  assert.equal(rocToIso(''), null);
});

test('parseNews 依關鍵字挑出公告並產生預定召開日', () => {
  const ev = parseNews(newsHtml, '7828');
  assert.deepEqual(ev.map((e) => [e.date, e.kind]), [
    ['2026-03-10', 'news'], ['2026-10-20', 'news'], ['2026-11-06', 'meeting'],
  ]);
  assert.match(ev[2].title, /^董事會/);
});

test('parseConferences 取日期、地點與簡報連結', () => {
  const html = `<table><tr><td>7828</td><td>創新服務</td><td>115/06/05</td><td>14:00</td><td>臺北文創大樓</td><td>說明115年第一季營運</td><td><a href='/nas/STR/782820260605M001.pdf'>中文</a></td></tr>
  <tr><td>1234</td><td>別家</td><td>115/06/06</td><td>10:00</td><td>x</td><td>y</td><td></td></tr></table>`;
  const ev = parseConferences(html, '7828');
  assert.equal(ev.length, 1);
  assert.equal(ev[0].date, '2026-06-05');
  assert.match(ev[0].note, /臺北文創大樓/);
  assert.equal(ev[0].url, 'https://mopsov.twse.com.tw/nas/STR/782820260605M001.pdf');
});

test('buildIcs 含自動事件與公告期限', () => {
  const ics = buildIcs([{ code: '7828', name: '創新服務', market: 'TWO' }],
    [{ ticker: '7828', date: '2026-11-06', kind: 'meeting', title: '董事會', note: 'n' }], new Date('2026-10-13T00:00:00Z'));
  assert.match(ics, /BEGIN:VCALENDAR/);
  assert.match(ics, /DTSTART;VALUE=DATE:20261106/);
  assert.match(ics, /DTSTART;VALUE=DATE:20261114/);
  assert.ok(ics.split('\r\n').every((l) => Buffer.byteLength(l) <= 75));
});
