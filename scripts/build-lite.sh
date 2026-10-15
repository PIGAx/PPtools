#!/usr/bin/env bash
# 產生「精簡版」：只含部位控管＋庫存戰情室，資料存在使用者自己的瀏覽器，可放 GitHub Pages 分享給親友。
# 用法：scripts/build-lite.sh <輸出目錄>   （例如 lite repo 的 clone 位置）
# 會覆蓋輸出目錄中的頁面與腳本，但保留 data/quotes.json（lite repo 自己的排程會持續更新它）。
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
OUT="${1:?用法：scripts/build-lite.sh <輸出目錄>}"
mkdir -p "$OUT/scripts" "$OUT/data" "$OUT/.github/workflows"

# 頁面與共用資源
cp "$ROOT/lite/index.html" "$ROOT/lite/README.md" "$OUT/"
for f in inventory.html pp-theme.js pp-ui.css pp-target-sim.js pp-stop-alert.js pp-quotes.js vue.global.prod.js chart.umd.min.js; do
  cp "$ROOT/$f" "$OUT/$f"
done
# 部位控管：拿掉只有完整版才有的說明（雲端備份＋Actions secrets 的 Telegram 通知）
grep -v '<!-- full-only -->' "$ROOT/return_equity.html" > "$OUT/return_equity.html"
touch "$OUT/.nojekyll"

# 每日報價排程（不含停損通知那段：精簡版沒有雲端備份可讀）
cp "$ROOT/scripts/fetch-quotes.mjs" "$OUT/scripts/"
cp "$ROOT/data/us-symbols.json" "$OUT/data/"
[ -f "$OUT/data/quotes.json" ] || cp "$ROOT/data/quotes.json" "$OUT/data/"
awk '/# 停損預警/ { exit } { print }' "$ROOT/.github/workflows/fetch-quotes.yml" \
  | grep -v -e "scripts/check-stops.mjs" -e "pp-stop-alert.js" \
  | sed -e :a -e '/^\n*$/{$d;N;ba' -e '}' > "$OUT/.github/workflows/fetch-quotes.yml"

echo "精簡版已輸出到 $OUT"
