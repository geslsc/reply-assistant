# 客立樂教學小助手｜Reply Assistant

LINE 群組教學小助手後端。第一版 MVP 核心邏輯 + PostgreSQL 持久化 + LINE Messaging API 串接。

## 功能摘要

- LINE 群組 webhook（signature 驗證、reply / push）
- 固定 5 種狀態機 + event_log
- 知識庫 DB 查詢（`knowledge_cards` 表；`knowledge_items.json` 保留作歷史備份）
- PostgreSQL 持久化（group / thread / event / consultant / knowledge_cards / pending_knowledge_reviews / dm_sessions / knowledge override）
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
| `OPENAI_API_KEY` | **選填**。OpenAI API Key，僅用於顧問私訊 AI 草稿／摘要與私訊截圖理解；未設定時系統仍可啟動，AI 功能不可用 |
| `OPENAI_VISION_MODEL` | 私訊截圖 vision 模型，預設 `gpt-4o` |
| `KNOWLEDGE_EXPORT_REMINDER_DAYS` | admin 私訊被動備份提醒天數，預設 `7` |
| `DM_SESSION_TIMEOUT_HOURS` | 私訊草稿 session 被動過期小時數，預設 `24`（無 cron，每次私訊檢查） |

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

## 知識庫 DB（knowledge_cards）

正式知識庫來源為 PostgreSQL `knowledge_cards` 表。含 9 個內容欄位 + 6 個追蹤欄位；追蹤欄位由系統自動填入。`src/data/knowledge_items.json` 保留作歷史備份，不再作 runtime 正式來源。

### Migration

```bash
npm run db:migrate                     # 1. 先建立 schema
npm run db:migrate:knowledge:dry-run   # 2. dry-run 試跑（不寫 DB）
npm run db:migrate:knowledge           # 3. 正式灌入 knowledge_cards
```

### Admin 私訊指令

| 指令 | 說明 |
|------|------|
| `匯出所有知識卡` | 匯出完整 JSON（含追蹤欄位），並記錄上次匯出時間 |
| `匯出 low risk 的卡` | 篩選 low risk |
| `匯出 active 的卡` | 篩選 active |
| `批量匯入` + JSON | 先列預覽，回「確認批量匯入」才寫入 |
| `列出所有知識卡` | 人類可讀清單（追蹤欄位請用匯出） |
| `列出 active 的卡` | 篩選 active |
| `查詢知識卡 [關鍵字]` / `搜尋 [關鍵字]` / `找跟 [關鍵字] 有關的卡` | 自然語法搜尋知識卡 |
| `找跟登入有關的卡` | 搜尋登入相關（相容舊語法） |

Consultant 另可：`查看待處理問題`、`稍後處理`、代回後 `整理成知識卡`。

Consultant / Admin 私訊多步驟草稿：`幫我整理知識卡`（預設新增）或 `修改知識卡 [card_id]`（修改既有）→ 提供內容 → 補充 / 修改 / 設為可公開回答 / 設為導入教練參考 / 轉成 JSON → consultant「確認送出」或 admin「確認更新」。新增模式由系統分配唯一 card_id，不覆蓋舊卡。

私訊 `使用說明` / `help` 可取得 Admin 或 Consultant 版指令說明（依身份分流）。

### dm_sessions（私訊草稿暫存表）

僅用於 admin / consultant 私訊多步驟知識卡草稿暫存，**不是**正式知識庫、不是待審區、不是 CMS。

| 欄位 | 說明 |
|------|------|
| `session_id` | 主鍵，系統產生 |
| `user_id` | admin / consultant 的 LINE userId |
| `session_type` | 目前僅 `knowledge_draft` |
| `status` | `active` / `submitted` / `completed` / `cancelled` / `expired` |
| `draft_data` | JSONB 草稿（人類可讀 + 結構化 card） |
| `created_at` / `updated_at` | 建立與最後互動時間 |
| `expired_at` | 被動過期時填入 |

同一 `user_id` 同時只允許一筆 `status = active` 的 session（DB partial unique index）。  
被動過期：每次 admin / consultant 私訊時檢查 `updated_at`，超過 `DM_SESSION_TIMEOUT_HOURS`（預設 24）則標記 `expired`，不新增 cron。

**部署前請執行** `npm run db:migrate` 以建立此表（含於 `src/db/schema.sql`）。  
`OPENAI_API_KEY` 仍為選填，缺 key 不影響啟動。

### 私訊截圖理解（2-C-1）

active admin / consultant 可在私訊直接貼截圖整理知識卡草稿：

1. 有 active `dm_sessions` 草稿 session 時，傳圖會先經 OpenAI vision 理解，再接入既有 2-B 多步驟流程。
2. 無 active session 時，請先輸入「幫我整理知識卡」再傳圖。
3. 圖片僅在 memory 下載與分析，**不寫磁碟、不寫 DB、不存 URL**；`draft_data` 只保留 vision 文字摘要。
4. vision 失敗時回覆「截圖理解失敗，請改用文字描述」，session 維持 active。
5. 缺 `OPENAI_API_KEY` 時回覆「AI 功能尚未啟用」，文字流程仍正常。

**注意：** 2-C-1 本身不新增獨立圖片資料表，但 2026-06-09 UX 修正已在
`group_flags` 增加 `group_name` 欄位，用於快取 LINE 群組名稱。部署這版前仍需執行
`npm run db:migrate`。

Vision model 由 `OPENAI_VISION_MODEL` 設定（預設 `gpt-4o`）。

### pending_knowledge_reviews（顧問送審待審表）

僅用於「顧問送審 → admin 審核」流程，不得作其他用途。

| 欄位 | 說明 |
|------|------|
| `review_id` | 主鍵，人類可讀短碼，格式 `K-YYYYMMDD-XX` |
| `card_data` | JSONB 草稿，符合 knowledge_cards schema |
| `submitted_by` | 送出顧問 userId |
| `submitted_at` | 送出時間 |
| `status` | `pending` / `approved` / `rejected` / `expired` |
| `bot_message_id` | 推送給 admin 的 LINE messageId（quotedMessageId 輔助定位） |
| `admin_response` | admin 修改意見或退回原因 |
| `resolved_at` / `resolved_by` | admin 處理時間與操作者 |

**部署前請執行** `npm run db:migrate` 以建立此表（含於 `src/db/schema.sql`）。

## Build 與 runtime assets

`npm run build` 會執行 `tsc` 並複製以下 runtime assets 到 `dist/`：

- `dist/data/knowledge_items.json`（歷史備份）
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
npm run db:migrate:knowledge:dry-run   # 先 dry run
npm run db:migrate:knowledge             # 正式灌入 knowledge_cards
```

`npm run db:migrate` 會套用 `knowledge_cards`、`pending_handoffs` 等 schema 更新；部署後務必執行知識卡 migration 並確認 DB 卡數 = JSON 卡數。

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
