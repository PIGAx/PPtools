# 📓 Quant Strategy Lab 量化策略實驗室

個人交易策略平台:策略發想紀錄 → 瀏覽器快速回測 → Python / Pine Script 精算 → 每日自動掃描 + Telegram 訊號通知。涵蓋台股(TWSE / TAIFEX / FinMind)與美股(yfinance)。

```
quant-lab/
├─ index.html                  ← 網站本體(GitHub Pages)
├─ data/
│  ├─ strategies.json          ← 策略庫(網站 ⬆⬇ 同步用,自動建立)
│  └─ signal_state.json        ← 掃描器狀態(自動建立)
├─ config/watchlist.json       ← 每日掃描的「標的 × 策略 × 參數」清單
├─ signals/scanner.py          ← 訊號掃描器(yfinance)
├─ .github/workflows/daily_scan.yml ← 排程:台美股收盤後各掃一次
├─ webhook/worker.js           ← TradingView webhook → Telegram(選用)
└─ pine/                       ← Pine Script 範例
```

## 一、部署網站(5 分鐘)

1. GitHub 建立 repo(建議 **Private**;Private repo 用 Pages 需 Pro,免費帳號可改 Public 或本機開 index.html)
2. 上傳本專案所有檔案到 repo 根目錄
3. Settings → Pages → Source 選 `main` branch `/ (root)` → 存檔
4. 網址 `https://<你的帳號>.github.io/<repo名>/` 就是你的平台,手機電腦都能開

## 二、跨裝置同步

1. GitHub → Settings → Developer settings → **Fine-grained tokens** → 新增
   - Repository access:只勾這個 repo
   - Permissions → Contents:**Read and write**
2. 網站「⚙️ 同步與通知」填入 `owner/repo`、分支、token → 儲存設定
3. 之後任何裝置:改完策略按「⬆ 推送」,換裝置先「⬇ 拉取」
   - Token 只存在各裝置瀏覽器本機,不會寫進 repo
   - 每次推送都是一個 commit,誤刪可從 repo 歷史找回

## 三、Telegram 通知

1. Telegram 搜 **@BotFather** → `/newbot` → 取得 Bot Token
2. 對你的新 bot 說一句話,然後開:
   `https://api.telegram.org/bot<TOKEN>/getUpdates` → 找到 `"chat":{"id":123456789}`
3. Repo → Settings → Secrets and variables → Actions → 新增兩個 secret:
   - `TELEGRAM_BOT_TOKEN`
   - `TELEGRAM_CHAT_ID`
4. Actions 頁籤 → Daily Signal Scan → **Run workflow** 手動跑一次驗證
5. 之後每個交易日台股收盤(約 13:50)與美股收盤後自動掃描,
   **訊號翻轉才通知**(🔴 買進 / 🟢 出場,台股慣例紅買綠賣),不會洗版

### 加標的到掃描清單

編輯 `config/watchlist.json`(GitHub 網頁直接改即可):

```json
{ "label": "台積電 20/60 均線", "ticker": "2330.TW",
  "strategy": "ma_cross", "params": { "fast": 20, "slow": 60 } }
```

支援策略:`ma_cross`、`momentum`、`breakout`、`seasonal`、`rsi_pullback`
(邏輯與網站回測室、Pine 產生器一致,三邊可互相對照)

## 四、TradingView 即時警報(選用,需 TV 付費方案)

1. 網站「🌲 Pine Script」產生策略碼 → 貼進 Pine Editor → Add to chart
2. Cloudflare Workers 部署 `webhook/worker.js`,設定 `TG_TOKEN`、`TG_CHAT`、`SECRET`
3. TV 建立警報 → Condition 選策略 → alert() function calls only
   → Webhook URL:`https://<worker>.workers.dev/?key=<SECRET>`
4. 免費版 TV 沒有 webhook → 直接用路線 A 的 GitHub Actions 即可

## 五、本機使用

直接雙擊 `index.html` 也能用(資料存瀏覽器 localStorage),
Python 腳本本機執行:

```bash
pip install yfinance pandas numpy requests
TELEGRAM_BOT_TOKEN=xxx TELEGRAM_CHAT_ID=yyy python signals/scanner.py
```

## 注意事項

- 回測請用**還原股價**(yfinance `auto_adjust=True`),否則除權息會失真
- 台股來回成本約 0.585%(手續費 0.1425%×2 + 證交稅 0.3%),回測務必計入
- yfinance 台股資料偶有缺漏,重要結論請用 TWSE / FinMind 交叉驗證
- 訊號皆為「收盤確認、隔日執行」邏輯,避免前視偏誤
- 本專案為個人研究工具,非投資建議
