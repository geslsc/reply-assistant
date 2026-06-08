# 客立樂教學小助手｜Production 部署 Runbook

本文件對應第一版 MVP **部署驗證**步驟，不新增產品功能。

## 前置：GitHub

```bash
cd reply-assistant
git init
git add .
git commit -m "Initial MVP backend for production deployment"
# 在 GitHub 建立 repo 後：
git remote add origin https://github.com/<your-org>/reply-assistant.git
git branch -M main
git push -u origin main
```

## Railway 設定

### 1. 建立 Project

1. [Railway](https://railway.app) → New Project → Deploy from GitHub repo
2. 選擇 `reply-assistant` repo
3. Railway 會偵測 Node.js，使用 `npm run build` + `npm start`（見 `railway.json`）

### 2. 新增 PostgreSQL

同一 Project → **Add Service** → **Database** → **PostgreSQL**

### 3. Node.js Service 環境變數

在 **Web Service** → **Variables** 設定：

| 變數 | 值 |
|------|-----|
| `NODE_ENV` | `production` |
| `DATABASE_URL` | `${{Postgres.DATABASE_URL}}`（Reference variable） |
| `LINE_CHANNEL_SECRET` | （LINE Console 取得） |
| `LINE_CHANNEL_ACCESS_TOKEN` | （LINE Console 取得） |
| `LINE_BOT_BASIC_ID` | （LINE Console Basic ID，如 `@xxx`） |
| `OFFICIAL_CS_NAME` | （選填） |
| `OFFICIAL_CS_PHONE` | （選填） |
| `OFFICIAL_CS_URL` 或 `OFFICIAL_CS_FORM_URL` | （選填，程式兩者皆支援） |
| `ADMIN_LINE_USER_IDS` | （步驟 13 填入你的 userId） |
| `CONSULTANT_INVITE_CODE` | （選填，顧問加入用） |

**注意：** `npm run db:migrate` 只讀 `DATABASE_URL`，不讀 `TEST_DATABASE_URL`。

### 4. 執行 Migration

Railway Web Service → **Shell**（或 one-off command）：

```bash
npm run db:migrate
```

### 5. 驗證 Health

開啟 Public Domain：

```bash
curl https://<your-railway-domain>/health
# 預期：{"ok":true,"service":"reply-assistant","db":"connected"}
```

### 6. LINE Webhook

1. LINE Developers Console → Messaging API → Webhook URL：
   `https://<your-railway-domain>/webhook/line`
2. 啟用 **Use webhook**
3. 按 **Verify**（需已設定 `LINE_CHANNEL_SECRET`）

### 7. 取得 Admin userId

1. 用手機加 Bot 好友
2. 私訊任意文字
3. Bot 回覆或 server log 會顯示 `LINE userId`
4. 設定 `ADMIN_LINE_USER_IDS=<你的 userId>`
5. **Redeploy / Restart** service

### 8. 群組 Smoke Test（顧問指令）

1. 將 Bot 加入測試群組
2. 顧問（admin）輸入：`小助手自我介紹一下`
3. 店家輸入低風險問題（如：`怎麼登入後台`）→ 應逐字公開標準回答
4. 中高風險問題（如：`畫面一片空白`）→ 不公開，顧問收到 push
5. 顧問輸入 `OK`（在已有公開回答後）→ thread 結案

## Production 啟動驗證（本機）

```bash
# 無 DATABASE_URL 應失敗
NODE_ENV=production node -e "require('./dist/config/env').loadEnv(); require('./dist/repositories').initRepositories().catch(e=>{console.error(e.message);process.exit(1)})"

# 有 DATABASE_URL 應可連線（需本機 PostgreSQL）
DATABASE_URL=postgresql://... NODE_ENV=production npm start
```

## 第一版不做（部署階段亦不得啟用）

- 排程器主動推播
- Notion 即時 API
- LLM 自由生成答案
- 新增狀態 / event_type
- 多 thread 完整並行
