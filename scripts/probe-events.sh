#!/usr/bin/env bash
# 暫時性偵測：在 GitHub Actions 上測試各公告來源能否抓到 7828 的資料
UA='Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36'
probe() { echo; echo "===== $1"; shift; curl -sS -L --max-time 30 -A "$UA" -w '\n[HTTP %{http_code} %{size_download}B %{url_effective}]\n' "$@" | head -c 3000; echo; }

probe "官網首頁" https://www.inno-stars.com/
echo "--- 官網內連結（含 investor/投資/ir/news）"
curl -sS -L --max-time 30 -A "$UA" https://www.inno-stars.com/ | grep -oiE 'href="[^"]+"' | grep -iE 'invest|ir|stock|share|news|投資|股東|法說|財務|營收' | sort -u | head -40

probe "MOPS 舊版 法說會 ajax (mopsov)" -X POST https://mopsov.twse.com.tw/mops/web/ajax_t100sb02_1 \
  --data 'encodeURIComponent=1&step=1&firstin=1&off=1&TYPEK=otc&year=115&month=all&co_id=7828'
probe "MOPS 舊版 重大訊息 ajax (mopsov)" -X POST https://mopsov.twse.com.tw/mops/web/ajax_t05st01 \
  --data 'encodeURIComponent=1&step=1&firstin=1&off=1&queryName=co_id&inpuType=co_id&TYPEK=all&co_id=7828&year=115'
probe "MOPS 新版 api t100sb02_1" -X POST https://mops.twse.com.tw/mops/api/t100sb02_1 -H 'Content-Type: application/json' \
  --data '{"marketKind":"otc","year":"115","month":"all","companyId":"7828"}'
probe "MOPS 新版 api t05st01" -X POST https://mops.twse.com.tw/mops/api/t05st01 -H 'Content-Type: application/json' \
  --data '{"companyId":"7828","year":"115","month":"all"}'

echo; echo "===== TPEx OpenAPI swagger 相關路徑"
curl -sS -L --max-time 30 -A "$UA" https://www.tpex.org.tw/openapi/swagger.json -o /tmp/tpex.json; ls -la /tmp/tpex.json
node -e 'const j=require("/tmp/tpex.json");for(const [p,v] of Object.entries(j.paths||{})){const s=JSON.stringify(v);if(/法說|法人說明|股東會|除權|除息|重大訊息|營收|說明會|行事曆/.test(s))console.log(p, (v.get||v.post||{}).summary||"")}' || true
echo; echo "===== TWSE OpenAPI swagger 相關路徑"
curl -sS -L --max-time 30 -A "$UA" https://openapi.twse.com.tw/v1/swagger.json -o /tmp/twse.json; ls -la /tmp/twse.json
node -e 'const j=require("/tmp/twse.json");for(const [p,v] of Object.entries(j.paths||{})){const s=JSON.stringify(v);if(/法說|法人說明|股東會|除權|除息|重大訊息|說明會/.test(s))console.log(p, (v.get||v.post||{}).summary||"")}' || true
exit 0
