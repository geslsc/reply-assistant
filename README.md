# 客立樂教學小助手｜Reply Assistant

LINE 群組教學小助手後端。第一版 MVP 核心邏輯 + PostgreSQL 持久化 + LINE Messaging API 串接。

## 功能摘要

- LINE 群組 webhook（signature 驗證、reply / push）
- 固定 5 種狀態機 + event_log
- 知識庫 JSON 查詢（不接 Notion 即時 API）
- PostgreSQL 持久化（group / thread / event / consultant / knowledge override）
- Railway 部署就緒

## 本機啟動

```bash
cp .env.example .env
# 編輯 .env，至少設定 DATABASE_URL（開發可設 USE_MEMORY_REPOS=true）

npm install
npm run db:migrate   # 使用 PostgreSQL 時
npm run dev          # 開發模式
```

Production：

```bash
npm run build
npm start
```

## 環境變數

| 變數 | 說明 |
|------|------|
| `NODE_ENV` | `development` / `test` / `production` |
| `PORT` | 服務 port，預設 3000 |
| `DATABASE_URL` | PostgreSQL 連線字串（production 必填；`npm run db:migrate` 只讀此變數） |
| `TEST_DATABASE_URL` | 真 PostgreSQL integration tests 專用（見下方驗證流程） |
| `USE_MEMORY_REPOS` | `true` 時使用記憶體 repository（測試/本機 demo） |
| `LINE_CHANNEL_SECRET` | LINE Channel Secret（webhook 簽章驗證） |
| `LINE_CHANNEL_ACCESS_TOKEN` | LINE Channel Access Token |
| `LINE_BOT_BASIC_ID` | Bot Basic ID（文件/設定参考） |
| `ADMIN_LINE_USER_IDS` | 逗號分隔 admin LINE userId，啟動時 upsert |
| `CONSULTANT_INVITE_CODE` | 顧問加入邀請碼 |
| `OFFICIAL_CS_*` | 官方客服導流資訊（覆蓋 JSON placeholder） |
| `LOG_LEVEL` | `debug` / `info` / `warn` / `error` |
| `OPENAI_API_KEY` | **選填**。OpenAI API Key，僅用於顧問私訊 AI 草稿／摘要輔助；未設定時系統仍可啟動，AI 草稿整理不可用 |

## PostgreSQL 初始化

```bash
createdb reply_assistant
export DATABASE_URL=postgresql://user:password@localhost:5432/reply_assistant
npm run db:migrate
```

Schema 定義：`src/db/schema.sql`

### issue_threads 欄位說明

`issue_threads` 中的 `risk_level`、`knowledge_card_id`、`is_waiting`、`is_stale`、`last_message_at`、`resolved_at`、`metadata_json` 屬於 **issueThread 內部狀態追蹤欄位**，供被動結算與 thread 生命週期使用。  
其中 `is_waiting`、`is_stale` 等為內部 thread 追蹤旗標，不代表新增狀態機 state enum。  
**event_log 欄位才是固定不得擴充**；請勿將 issue_threads 欄位與 event_log 混為一談。

`issue_threads` 主鍵為 `(group_id, issue_thread_id)`，狀態歸屬符合 groupId + issueThreadId 設計。

### 本機 PostgreSQL 驗證流程

1. 建立測試 DB：`createdb reply_assistant_test`
2. 設定 integration test 環境變數：`export TEST_DATABASE_URL=postgresql://user:password@localhost:5432/reply_assistant_test`
3. 若需對測試 DB 執行 migration，請使用（`npm run db:migrate` 只讀 `DATABASE_URL`）：

```bash
DATABASE_URL=$TEST_DATABASE_URL npm run db:migrate
```

4. 執行測試：`npm test`（有 `TEST_DATABASE_URL` 時會跑真 PostgreSQL integration tests）
5. 檢查 health：`curl http://localhost:3000/health`

**環境變數分工：**

- `DATABASE_URL` — production / 本機主 DB；`npm run db:migrate` 與 `npm start`（production）使用
- `TEST_DATABASE_URL` — 僅供 `tests/postgresIntegration.test.ts` 真 PostgreSQL integration tests

若未設定 `TEST_DATABASE_URL`，integration tests 會自動 skip，不影響一般本機測試。

## Build 與 runtime assets

`npm run build` 會執行 `tsc` 並複製以下 runtime assets 到 `dist/`：

- `dist/data/knowledge_items.json`
- `dist/db/schema.sql`

Production 請使用：

```bash
npm run build
npm start
```

## LINE Developer Console 設定

1. 建立 Messaging API Channel
2. 取得 Channel Secret、Channel Access Token
3. 設定 Webhook URL：`https://<your-domain>/webhook/line`
4. 啟用 Webhook
5. 將 Bot 加入目標群組

## 取得 admin LINE userId

1. 先啟動服務（可不設定 `ADMIN_LINE_USER_IDS`）
2. 用 LINE 私訊 Bot 任意文字
3. 查看 server log 或 Bot 回覆中的 `LINE userId`
4. 將 userId 填入 `.env`：

```env
ADMIN_LINE_USER_IDS=Uxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
```

5. 重啟服務後 admin 會被 upsert 為 active

## 顧問加入流程

私訊 Bot：

```
加入顧問 YOUR_INVITE_CODE
```

Admin 私訊核准：

```
核准顧問 Uxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
```

## Railway 部署

1. 建立 Railway 專案
2. 新增 PostgreSQL plugin（自動提供 `DATABASE_URL`）
3. 設定環境變數（LINE_*、ADMIN_LINE_USER_IDS 等）
4. Build command：`npm run build`
5. Start command：`npm start`
6. 首次部署後在 Railway shell 執行 migration：

```bash
npm run db:migrate
```

`npm run db:migrate` 會套用 `pending_handoffs` 等 schema 更新；部署後務必執行。

7. 確認 `GET /health` 回 `{ "ok": true, "db": "connected" }`
8. 再設定 LINE Developer Console Webhook URL

### OPENAI_API_KEY（選填）

- 未設定時 production 仍可正常啟動
- 未設定時，顧問私訊要求知識卡草稿整理會回覆「AI 草稿整理尚未啟用」
- 僅注入顧問私訊草稿流程，**不會**進入群組公開回答或 REPLY_TO_GROUP 代回流程

## 測試

```bash
npm test
```

- 預設使用 memory repository（`USE_MEMORY_REPOS=true`），無需 PostgreSQL
- 設定 `TEST_DATABASE_URL` 後會額外執行真 PostgreSQL integration tests

## 第一版不做清單

- 不依賴 LINE 引用訊息作主流程
- 不做保守補位、語音處理、貼圖完成訊號
- 不做店家 emoji 結案
- 不做 AI 自由生成操作答案
- 不做完整知識庫後台 / Notion 即時 API
- 不做多 issueThread 完整並行
- 不做排程器主動逾時推播
- 不做多種靜音時長
- 不做 consultant_correction 自動偵測
- 不做 LLM 挑卡升級
- 不做前端後台

## API Endpoints

- `GET /health` — 服務與 DB 狀態
- `POST /webhook/line` — LINE webhook（需 valid signature）
