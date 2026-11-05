/* ══ 營收追蹤：計算邏輯（頁面 revenue.html 與排程 scripts/fetch-revenue.mjs 共用） ══
   資料來源：data/revenue.json（人工填的券商預估、判斷、備註＋排程自動寫入的公開資訊觀測站月營收／季 EPS）
   本檔只做「純計算」：解析觀測站欄位、合併新資料、算 MoM／YoY／季合計／達成率／全年缺口與待辦事項。
   單位：營收一律存「百萬元」（觀測站原始單位是千元，解析時 ÷1000）。 */
(function (root) {
    'use strict';

    /* ── 小工具 ── */
    const pad2 = n => String(n).padStart(2, '0');
    const r1 = v => v == null ? null : Math.round(v * 10) / 10;
    const r2 = v => v == null ? null : Math.round(v * 100) / 100;

    function num(v) {
        if (v == null) return null;
        if (typeof v === 'number') return Number.isFinite(v) ? v : null;
        const s = String(v).replace(/[,\s+]/g, '');
        if (s === '' || s === '-' || s === '--' || /^n\/?a$/i.test(s)) return null;
        const n = Number(s);
        return Number.isFinite(n) ? n : null;
    }

    /* 依候選鍵（字串或 RegExp）取值，官方欄位名稱偶有中英文差異 */
    function pick(obj, keys) {
        if (!obj) return undefined;
        const names = Object.keys(obj);
        for (const k of keys) {
            if (typeof k === 'string') { if (k in obj) return obj[k]; }
            else { const hit = names.find(n => k.test(n)); if (hit) return obj[hit]; }
        }
        return undefined;
    }

    /* 「11509」「115/09」「2026-09」「202609」→「2026-09」 */
    function normYm(s) {
        const t = String(s == null ? '' : s).trim().replace(/[年月/.\-\s]/g, '');
        if (!/^\d{5,6}$/.test(t)) return null;
        let y = Number(t.slice(0, t.length - 2));
        const m = Number(t.slice(-2));
        if (y < 1911) y += 1911;
        if (m < 1 || m > 12) return null;
        return y + '-' + pad2(m);
    }

    function addMonths(ym, k) {
        const [y, m] = ym.split('-').map(Number);
        const idx = y * 12 + (m - 1) + k;
        return Math.floor(idx / 12) + '-' + pad2(idx % 12 + 1);
    }
    const quarterOf = ym => { const [y, m] = ym.split('-').map(Number); return y + 'Q' + Math.ceil(m / 3); };
    const quarterMonths = q => { const y = q.slice(0, 4), n = Number(q.slice(5)); return [1, 2, 3].map(i => y + '-' + pad2((n - 1) * 3 + i)); };
    const quarterLabel = q => q.slice(5) + 'Q' + q.slice(2, 4);          // 2026Q3 → 3Q26
    const ymLabel = ym => ym.replace('-', '/').replace('/0', '/');         // 2026-09 → 2026/9

    /* 營收公布期限：次月 10 日；財報期限：Q1 5/15、Q2 8/14、Q3 11/14、Q4 隔年 3/31 */
    function revenueDeadline(ym) { return addMonths(ym, 1) + '-10'; }
    function reportDeadline(q) {
        const y = Number(q.slice(0, 4)), n = Number(q.slice(5));
        return n === 4 ? (y + 1) + '-03-31' : y + ['', '-05-15', '-08-14', '-11-14'][n];
    }
    function quarterEnded(q, today) { return quarterMonths(q)[2] + '-31' < today; }

    /* ── 解析觀測站月營收彙總表的一列（上市 t187ap05_L／上櫃 t187ap05_O／興櫃 t187ap05_R） ──
       欄位：資料年月、公司代號、公司名稱、營業收入-當月營收、營業收入-去年當月營收、備註…（千元） */
    function parseRevenueRow(row) {
        const code = String(pick(row, ['公司代號', 'SecuritiesCompanyCode', 'CompanyCode', /代號/]) ?? '').trim();
        const ym = normYm(pick(row, ['資料年月', 'YearMonth', /年月/]));
        const keys = Object.keys(row || {});
        const cur = keys.find(k => /當月營收/.test(k) && !/去年|上月|累計/.test(k));
        const ly = keys.find(k => /去年當月營收/.test(k));
        const rev = cur ? num(row[cur]) : null;
        if (!code || !ym || rev == null) return null;
        const prev = ly ? num(row[ly]) : null;
        const note = String(pick(row, ['備註', /備註|Note/i]) ?? '').trim();
        return {
            code, ym,
            name: String(pick(row, ['公司名稱', 'CompanyName', /名稱/]) ?? '').trim(),
            rev: rev / 1000,
            prevYear: prev != null ? prev / 1000 : null,
            note: note && note !== '-' ? note : ''
        };
    }

    /* ── 解析財報 EPS 彙總表的一列（t187ap14_L／t187ap14_O） ──
       欄位：年度（民國）、季別、公司代號、基本每股盈餘(元)、營業收入、稅後淨利（千元） */
    function parseEpsRow(row) {
        const code = String(pick(row, ['公司代號', 'SecuritiesCompanyCode', /代號/]) ?? '').trim();
        let y = num(pick(row, ['年度', 'Year', /年度/]));
        const n = num(pick(row, ['季別', 'Season', 'Quarter', /季/]));
        const eps = num(pick(row, [/基本每股盈餘/, 'EPS', /每股盈餘/]));
        if (!code || y == null || !(n >= 1 && n <= 4) || eps == null) return null;
        if (y < 1911) y += 1911;
        const revK = num(pick(row, ['營業收入', /^營業收入/]));
        const niK = num(pick(row, [/稅後淨利|本期淨利/]));
        return { code, q: y + 'Q' + n, eps, rev: revK != null ? revK / 1000 : null, netIncome: niK != null ? niK / 1000 : null };
    }

    /* 彙總表的 EPS 可能是「年初至今累計」也可能是「單季」，用報表營收對照月營收自動判斷：
       報表營收較接近「今年累計月營收」→ 累計，單季 EPS = 累計 − 今年前幾季 EPS */
    function singleQuarterEps(company, parsed) {
        const q = parsed.q, y = q.slice(0, 4), n = Number(q.slice(5));
        if (n === 1) return { eps: parsed.eps, basis: 'q' };
        const byYm = {};
        (company.monthly || []).forEach(m => { byYm[m.ym] = m.rev; });
        const sum = list => list.every(ym => byYm[ym] != null) ? list.reduce((a, ym) => a + byYm[ym], 0) : null;
        const qRev = sum(quarterMonths(q));
        const ytdList = [];
        for (let i = 1; i <= n; i++) ytdList.push(...quarterMonths(y + 'Q' + i));
        const ytdRev = sum(ytdList);
        let basis = null;
        if (parsed.rev != null && qRev != null && ytdRev != null) {
            basis = Math.abs(parsed.rev - ytdRev) < Math.abs(parsed.rev - qRev) ? 'ytd' : 'q';
        }
        if (basis === 'q') return { eps: parsed.eps, basis };
        if (basis === 'ytd') {
            const prior = [];
            for (let i = 1; i < n; i++) prior.push(((company.quarters || {})[y + 'Q' + i] || {}).eps);
            if (prior.some(v => v == null)) return { eps: null, epsYtd: parsed.eps, basis };
            return { eps: r2(parsed.eps - prior.reduce((a, v) => a + v, 0)), epsYtd: parsed.eps, basis };
        }
        return { eps: null, epsYtd: parsed.eps, basis: null };   // 判斷不出來就不寫，避免填錯
    }

    /* ── 合併一筆月營收進 company.monthly；回傳變動描述（沒變回 null） ── */
    function upsertMonth(company, rec, src) {
        company.monthly = company.monthly || [];
        const list = company.monthly;
        const row = list.find(m => m.ym === rec.ym);
        const rev = Math.round(rec.rev * 1000) / 1000;
        const prevYear = rec.prevYear != null ? Math.round(rec.prevYear * 1000) / 1000 : undefined;
        if (!row) {
            const nr = { ym: rec.ym, rev, src: src || 'mops' };
            if (prevYear != null) nr.prevYear = prevYear;
            if (rec.note) nr.mopsNote = rec.note;
            list.push(nr);
            list.sort((a, b) => a.ym < b.ym ? -1 : 1);
            return { type: 'new', ym: rec.ym, rev };
        }
        const changed = Math.abs((row.rev ?? 0) - rev) > 0.0005 || (prevYear != null && row.prevYear !== prevYear) || row.src !== (src || 'mops');
        if (!changed) return null;
        const before = row.rev;
        row.rev = rev;
        if (prevYear != null) row.prevYear = prevYear;
        if (rec.note) row.mopsNote = rec.note;
        row.src = src || 'mops';
        // 原本手填的 YoY 以官方去年同月營收為準後就不需要了
        if (prevYear != null) { delete row.yoy; delete row.yoyNote; }
        return { type: Math.abs(before - rev) > 0.05 ? 'revised' : 'verified', ym: rec.ym, rev, before };
    }

    /* ── 合併使用者在頁面手動補登的資料（localStorage），手動值只填空，不蓋官方值 ── */
    function withManual(company, manual) {
        const c = JSON.parse(JSON.stringify(company));
        if (!manual) return c;
        Object.entries(manual.monthly || {}).forEach(([ym, rev]) => {
            if (!(c.monthly || []).some(m => m.ym === ym)) upsertMonth(c, { ym, rev: Number(rev) }, 'manual');
        });
        c.quarters = c.quarters || {};
        Object.entries(manual.eps || {}).forEach(([q, eps]) => {
            const Q = c.quarters[q] = c.quarters[q] || {};
            if (Q.eps == null) { Q.eps = Number(eps); Q.epsSrc = 'manual'; }
        });
        return c;
    }

    /* ── 主計算：給頁面用的完整檢視模型 ── */
    function analyze(company, today) {
        today = today || new Date().toISOString().slice(0, 10);
        const months = (company.monthly || []).slice().sort((a, b) => a.ym < b.ym ? -1 : 1);
        const byYm = {};
        months.forEach(m => { byYm[m.ym] = m; });

        /* 去年同月：官方值 > 由手填 YoY 回推 > 「基期近零」視為 0 */
        const prevYearOf = m => m.prevYear != null ? m.prevYear
            : m.yoy != null ? m.rev / (1 + m.yoy / 100)
            : m.yoyNote ? 0 : null;

        let high = company.recordBefore ? { ym: company.recordBefore.ym, rev: company.recordBefore.rev } : null;
        const rows = months.map(m => {
            const prev = byYm[addMonths(m.ym, -1)];
            const py = prevYearOf(m);
            const yoy = m.prevYear != null ? (m.prevYear > 0 ? (m.rev / m.prevYear - 1) * 100 : null)
                : m.yoy != null ? m.yoy : null;
            const yoyNote = m.prevYear != null ? (m.prevYear > 0 ? '' : '基期為零') : (m.yoyNote || '');
            const isRecord = !high || m.rev > high.rev;
            const highBefore = high;
            if (isRecord) high = { ym: m.ym, rev: m.rev };
            return {
                ym: m.ym, label: ymLabel(m.ym), q: quarterOf(m.ym), rev: m.rev, src: m.src || 'seed',
                mom: prev && prev.rev > 0 ? (m.rev / prev.rev - 1) * 100 : null,
                yoy, yoyNote, prevYear: py, isRecord, highBefore,
                eps: (company.monthlyEps || {})[m.ym] ?? null,
                note: m.note || m.mopsNote || ''
            };
        });

        /* 季：月營收加總＋券商預估＋EPS */
        const qKeys = new Set(Object.keys(company.quarters || {}));
        rows.forEach(r => qKeys.add(r.q));
        const quarters = {};
        [...qKeys].sort().forEach(q => {
            const Q = (company.quarters || {})[q] || {};
            const ms = quarterMonths(q).map(ym => rows.find(r => r.ym === ym)).filter(Boolean);
            const rev = ms.length ? ms.reduce((a, r) => a + r.rev, 0) : null;
            const complete = ms.length === 3;
            const revAch = {};
            Object.entries(Q.revEst || {}).forEach(([b, est]) => { if (rev != null && est) revAch[b] = rev / est * 100; });
            quarters[q] = {
                q, label: quarterLabel(q), months: ms, rev, complete, ended: quarterEnded(q, today),
                revEst: Q.revEst || {}, revEstNote: Q.revEstNote || '', revAch,
                eps: Q.eps ?? null, epsSrc: Q.epsSrc || (Q.eps != null ? 'seed' : null), epsAlt: Q.epsAlt || '',
                epsEst: Q.epsEst || {}, epsEstNote: Q.epsEstNote || '',
                epsRough: null, epsRoughNote: '', epsAch: {},
                netMargin: Q.netMargin ?? null,
                verdict: Q.verdict || '', reportDeadline: reportDeadline(q)
            };
        });

        /* EPS 粗估：沒公布、但季已結束且營收齊全 → 手填粗估，否則用上一季 EPS × 營收比（假設淨利率、股本不變） */
        Object.values(quarters).forEach(Q => {
            const raw = (company.quarters || {})[Q.q] || {};
            if (Q.eps == null && Q.complete) {
                if (raw.epsRough != null) { Q.epsRough = raw.epsRough; Q.epsRoughNote = raw.epsRoughNote || '手填粗估'; }
                else {
                    const prev = Object.values(quarters).filter(p => p.q < Q.q && p.eps != null && p.complete && p.rev > 0).pop();
                    if (prev) { Q.epsRough = r2(prev.eps * Q.rev / prev.rev); Q.epsRoughNote = '以 ' + prev.label + ' EPS × 營收比例推算（假設淨利率不變）'; }
                }
            }
            const base = Q.eps ?? Q.epsRough;
            Object.entries(Q.epsEst).forEach(([b, est]) => { if (base != null && est) Q.epsAch[b] = base / est * 100; });
            if (!Q.verdict) Q.verdict = autoVerdict(Q);
        });

        /* 全年：累計營收 YoY＋EPS 缺口（全年預估 − 已公布 − 粗估，對照券商自己對剩餘季度的預估） */
        const years = {};
        const yearSet = new Set(rows.map(r => r.ym.slice(0, 4)));
        Object.keys(company.annual || {}).forEach(y => { if (yearSet.has(y)) years[y] = null; });
        yearSet.forEach(y => { years[y] = null; });
        Object.keys(years).sort().forEach(y => {
            const ms = rows.filter(r => r.ym.startsWith(y));
            const rev = ms.reduce((a, r) => a + r.rev, 0);
            const pyKnown = ms.every(r => r.prevYear != null);
            const pyRev = pyKnown ? ms.reduce((a, r) => a + r.prevYear, 0) : null;
            const qs = [1, 2, 3, 4].map(n => quarters[y + 'Q' + n] || { q: y + 'Q' + n, label: quarterLabel(y + 'Q' + n), eps: null, epsRough: null, epsEst: {} });
            const actual = qs.filter(Q => Q.eps != null);
            const rough = qs.filter(Q => Q.eps == null && Q.epsRough != null);
            const rest = qs.filter(Q => Q.eps == null && Q.epsRough == null);
            const epsActual = actual.reduce((a, Q) => a + Q.eps, 0);
            const epsRough = rough.reduce((a, Q) => a + Q.epsRough, 0);
            const brokers = Object.entries(((company.annual || {})[y] || {}).epsEst || {}).map(([b, est]) => {
                const need = est - epsActual - epsRough;
                const ownList = rest.map(Q => (Q.epsEst || {})[b]);
                const own = rest.length && ownList.every(v => v != null) ? ownList.reduce((a, v) => a + v, 0) : null;
                const gap = own ? (need / own - 1) * 100 : null;
                const status = !rest.length ? (need > 0.005 ? '未達標' : '已達標')
                    : gap == null ? '—' : gap > 5 ? '下修壓力' : gap < -5 ? '有上修空間' : '相對安全';
                return { broker: b, est, need, own, gap, status };
            });
            years[y] = {
                year: y, months: ms.length, rev, pyRev,
                yoy: pyRev > 0 ? (rev / pyRev - 1) * 100 : null,
                priorYearTotal: (company.priorYearTotal || {})[String(Number(y) - 1)] ?? null,
                epsActual, epsRough, actualQs: actual.map(Q => Q.label), roughQs: rough.map(Q => Q.label), restQs: rest.map(Q => Q.label),
                brokers
            };
        });

        const latest = rows[rows.length - 1] || null;
        const curQ = latest ? quarters[latest.q] : null;
        return {
            rows, quarters, years, latest, curQ, high,
            pending: pendingItems(company, rows, quarters, today),
            today
        };
    }

    function autoVerdict(Q) {
        const parts = [];
        const ach = Object.entries(Q.revAch);
        if (Q.complete && ach.length) {
            parts.push('營收 ' + ach.map(([b, a]) => (a >= 100 ? '超越 ' : a >= 95 ? '大致符合 ' : '低於 ') + b).join('、'));
        } else if (!Q.complete && Q.months.length) {
            parts.push('季累計 ' + Q.months.length + '/3 個月');
        }
        const ea = Object.entries(Q.epsAch);
        if (Q.eps != null && ea.length) parts.push('EPS ' + ea.map(([b, a]) => (a >= 100 ? '達標 ' : a >= 95 ? '接近 ' : '未達 ') + b).join('、'));
        return parts.join('；');
    }

    /* ── 待更新事項：下一筆月營收、未公布財報、全年預估檢視 ── */
    function pendingItems(company, rows, quarters, today) {
        const out = [];
        const latest = rows[rows.length - 1];
        if (latest) {
            const next = addMonths(latest.ym, 1);
            const due = revenueDeadline(next);
            out.push({
                kind: 'revenue', due, overdue: due < today,
                title: ymLabel(next).slice(5) + ' 月營收',
                detail: '新增月列，計算 MoM／YoY，檢查是否創單月新高' + (rows.length ? '（目前高點 ' + highLabel(rows, company) + '）' : '')
            });
        }
        Object.values(quarters).forEach(Q => {
            if (Q.eps == null && Q.ended) {
                const ests = Object.entries(Q.epsEst).map(([b, v]) => b + ' ' + v).join('／');
                out.push({
                    kind: 'report', due: Q.reportDeadline, overdue: Q.reportDeadline < today,
                    title: Q.label + ' 財報',
                    detail: (Q.epsRough != null ? '以實際 EPS 取代粗估 ' + Q.epsRough : '填入實際 EPS') + (ests ? '，計算對 ' + ests + ' 的達成率' : '')
                });
                const y = Q.q.slice(0, 4);
                if (Q.q.endsWith('Q3') && (company.annual || {})[y]) {
                    const ests2 = Object.entries(company.annual[y].epsEst || {}).map(([b, v]) => b + ' ' + v).join('／');
                    out.push({ kind: 'annual', due: null, after: Q.label + ' 財報後', title: y + ' 全年預估', detail: '檢視 ' + ests2 + ' 是否下修' });
                }
            }
        });
        return out.sort((a, b) => (a.due || '9999') < (b.due || '9999') ? -1 : 1);
    }

    function highLabel(rows, company) {
        let h = company.recordBefore ? { ym: company.recordBefore.ym, rev: company.recordBefore.rev } : null;
        rows.forEach(r => { if (!h || r.rev > h.rev) h = { ym: r.ym, rev: r.rev }; });
        return h ? ymLabel(h.ym) + ' 的 ' + r1(h.rev) : '';
    }

    /* ── 通知文字（Telegram）── */
    const pct = v => v == null ? '—' : (v >= 0 ? '+' : '') + v.toFixed(1) + '%';
    function formatRevenueNotice(code, company, ym) {
        const a = analyze(company);
        const r = a.rows.find(x => x.ym === ym);
        if (!r) return '';
        const Q = a.quarters[r.q];
        const lines = [
            '📈 ' + company.name + '（' + code + '）' + r.label + ' 營收 ' + r1(r.rev) + ' 百萬',
            'MoM ' + pct(r.mom) + '｜YoY ' + (r.yoy != null ? pct(r.yoy) : (r.yoyNote || '—')),
            r.isRecord ? '🏆 創單月新高' : '未創新高（高點 ' + ymLabel(r.highBefore.ym) + ' ' + r1(r.highBefore.rev) + '）',
            Q.label + ' 季累計 ' + r1(Q.rev) + '（' + Q.months.length + '/3 個月）' +
                (Object.keys(Q.revEst).length ? '｜預估 ' + Object.entries(Q.revEst).map(([b, v]) => b + ' ' + v + ' 達成 ' + Q.revAch[b].toFixed(0) + '%').join('、') : '')
        ];
        return lines.join('\n');
    }
    function formatEpsNotice(code, company, q) {
        const a = analyze(company);
        const Q = a.quarters[q];
        if (!Q || Q.eps == null) return '';
        const ach = Object.entries(Q.epsAch).map(([b, v]) => b + ' ' + Q.epsEst[b] + ' 達成 ' + v.toFixed(0) + '%').join('、');
        return '📊 ' + company.name + '（' + code + '）' + Q.label + ' EPS ' + Q.eps + ' 元' + (ach ? '\n' + ach : '');
    }

    const api = {
        num, pick, normYm, addMonths, quarterOf, quarterMonths, quarterLabel, ymLabel,
        revenueDeadline, reportDeadline, parseRevenueRow, parseEpsRow, singleQuarterEps,
        upsertMonth, withManual, analyze, formatRevenueNotice, formatEpsNotice, r1, r2
    };
    if (typeof module !== 'undefined' && module.exports) module.exports = api;
    else root.PPRevenue = api;
})(typeof window !== 'undefined' ? window : globalThis);
