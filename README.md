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
| `OPENAI_API_KEY` | **選填**。OpenAI API Key，用於群組語意挑卡／清晰度判斷、顧問私訊 AI 草稿／摘要；未設定時系統仍可啟動，群組語意判斷降級為關鍵字比對 |
| `KNOWLEDGE_EXPORT_REMINDER_DAYS` | admin 私訊被動備份提醒天數，預設 `7` |
| `DM_SESSION_TIMEOUT_HOURS` | 私訊草稿 session 被動過期小時數，預設 `24`（無 cron，每次私訊檢查） |
| `DEBOUNCE_SECONDS` | 群組店家訊息收斂 debounce 秒數，預設 `60`（允許 `setTimeout` 短時 debounce；buffer 存 DB，重啟後由下一個群組事件補結算） |
| `OFFICIAL_LINE_URL` | **選填**。官方客服 LINE 好友連結；用於顧問停用兜底話術與服務期結束話術。缺少時話術仍會發出，但不附連結 |

## 顧問申請與管理（批次一）

### consultant_applications 表

僅保存顧問申請紀錄（`pending` / `approved` / `rejected`），與 `consultants` 表分離。`consultants.status` 僅允許 `active` / `disabled`，不含 `pending`。

### 申請流程

- 一般使用者私訊「申請顧問」→ 建立 `consultant_applications`（pending）→ 通知 active admin
- 已是 active consultant / admin 者不重複建申請

### 核准 / 拒絕

- Admin 私訊「核准 C-xxxx」→ application approved → `consultants` 建立 active 顧問（含 `consultant_code`）
- Admin 私訊「拒絕 C-xxxx」→ application rejected → 通知申請者（不揭露內部原因）

### 顧問管理指令（僅 active admin）

- `顧問名單` / `查詢待審顧問`
- `停用 C-xx` 或 `停用 [userId]` → 即時停用 + 自動分類清理
- `啟用 C-xx` 或 `啟用 [userId]`
- 不可停用最後一位 active admin

### 停用時自動分類

1. `dm_sessions` active 草稿 → 標記 `cancelled`
2. `pending_knowledge_reviews` 已送審 → 保留，admin 可繼續審核
3. 顧問相關群組（批次一過渡：以 `pending_handoffs` 關聯群組為資料來源）：
   - 小助手已離群（`group_flags.bot_left_at`）→ 不處理
   - 仍在 + 服務期內 → 發兜底話術 + 暫停群組
   - 仍在 + 服務期已結束 → 不發兜底話術

### Bot leave event

LINE `leave` event → 寫入 `group_flags.bot_left_at` → 私訊通知 admin

### 服務期結束話術

下一則群組訊息進來時，若 `serviceEndAt` 已過且尚未通知（`service_period_end_notified`），發送固定結束話術（非 LLM 生成）。

### 顧問自查

Active consultant 私訊「我的服務群組」→ 列出自己作為主負責或副手的群組（資料來源：`group_consultant_assignments`）。

## 群組負責顧問綁定與 handoff 路由（批次二）

### group_consultant_assignments 表

保存群組與負責顧問綁定：`group_id`（唯一）、`group_code`（G-01 / G-02…）、`primary_consultant_user_id`、`secondary_consultant_user_id`、`status`（active / left）、`last_consultant_action_at`、`last_customer_message_at`。

### 新群組偵測

- LINE join event 或首次收到群組訊息時自動建立記錄
- 自動分配 `group_code`（G-01、G-02…）
- `group_name` 嘗試從 LINE Group Summary API 取得；失敗時顯示 `尚未取得群組名稱（groupId: xxx）`

### 自動綁定主負責

- active consultant / active admin 在群組使用「小助手」開頭的有效顧問語法，且該群尚無主負責 → 自動設為 primary
- 同群已有主負責、另一位顧問使用「小助手」語法 → 不覆蓋，通知 admin
- 一般發話不觸發綁定

### admin 也可作為主負責 / 副手

active admin 綁定規則與 consultant 相同；handoff 若 admin 是主負責，走 primary 路徑。

### admin 指派指令（僅 active admin）

- `設定群組 G-01 主負責 C-01`
- `設定群組 G-01 主負責 C-01 副手 C-02`
- `解除群組 G-01 負責人`
- `群組清單` / `群組 G-01 狀態` / `XX美甲店 狀態`（名稱重複時回候選清單）

### 我的服務群組

active admin / active consultant 私訊「我的服務群組」→ 列出自己作為 primary 或 secondary 的群組。

### handoff 路由

`resolveHandoffTarget(groupId)` 單一入口，順序：主負責 → 副手 → fallback admin。`pending_handoffs` 只為實際被通知的人建立。

### 停用顧問 handoff 轉移

停用主負責時，該群 open `pending_handoffs` 轉給 active 副手；無副手則轉給 fallback admin。

## 群組訊息收斂與語意分流

店家在群組連續發話時，小助手會先收斂成同一個問題，再進行語意判斷：

1. **收斂 buffer（DB）**：同一 `group_id + customer_user_id` 的連續訊息 append 到 `group_message_buffers`，不拆成多筆問題。
2. **Debounce**：預設 `DEBOUNCE_SECONDS=60`；60 秒內再發話會重設計時器。高風險關鍵字（帳務 / 金流 / 權限 / 資料異常等）則立即收斂。
3. **重啟補結算**：Railway 重啟導致 `setTimeout` 消失時，下一個群組事件會檢查 `status=collecting` 且已逾 debounce 窗的 buffer 並補做收斂。
4. **顧問一般發話**：active 顧問 / admin 在群組一般回覆時，小助手視為人工接手並保持沉默，不 flush 店家 buffer。
5. **LLM 語意分流**（僅挑卡 + 清晰度，不生成公開答案）：
   - 意圖清楚 + 低風險可公開卡 → 逐字 `standard_answer` + 固定收尾句
   - 中高風險 / 不可公開 / 無對應卡 → 固定緩衝話術 + 通知 fallback admin（僅 active admin，不通知所有 active consultants）
   - 意圖模糊 → 既有 `AI_CLARIFYING` 客製釐清（兩輪後仍不清楚則 handoff）
6. **OPENAI_API_KEY 選填**：未設定時語意判斷降級為關鍵字比對 + 原有 heuristics，系統正常啟動。

固定緩衝話術（非 LLM 生成）：「您的問題我已經記下並請顧問協助確認，請稍等一下喔。」

部署前若 schema 有更新，請執行：

```bash
npm run db:migrate
```

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

### 低用量待辦查詢型 schema 部署（2026-06-11）

**請勿直接操作正式資料庫。** 以下流程適用 staging / 本機 / 維護窗口內的 production 部署。

#### 1. 執行前備份

```bash
pg_dump "$DATABASE_URL" > backup-$(date +%Y%m%d-%H%M%S).sql
```

#### 2. 執行 migration

```bash
export DATABASE_URL=postgresql://user:password@localhost:5432/reply_assistant
npm run db:migrate
```

`npm run db:migrate` 會套用 `src/db/schema.sql` 中以下變更（可重複執行）：

- `pending_handoffs`：新增 `status_updated_by`、`status_updated_at`、`reason`；舊 status `open→pending`、`closed→resolved`、`invalid→ignored`；`invalid_reason` 保留但標註 deprecated，新流程使用 `reason`
- `pending_knowledge_reviews`：新增 `last_edited_by`、`last_edited_at`、`edit_reason`、`draft_data`
- `push_usage_logs`：新建預留表（本批次不啟用推播）

#### 3. 執行後檢查欄位

```sql
-- pending_handoffs 新欄位
SELECT column_name FROM information_schema.columns
WHERE table_name = 'pending_handoffs'
  AND column_name IN ('status_updated_by', 'status_updated_at', 'reason');

-- pending_knowledge_reviews 新欄位
SELECT column_name FROM information_schema.columns
WHERE table_name = 'pending_knowledge_reviews'
  AND column_name IN ('last_edited_by', 'last_edited_at', 'edit_reason', 'draft_data');

-- push_usage_logs 表
SELECT table_name FROM information_schema.tables
WHERE table_schema = 'public' AND table_name = 'push_usage_logs';
```

#### 4. 執行後檢查舊 status 轉換

```sql
-- 不應存在舊 status 值
SELECT status, COUNT(*) FROM pending_handoffs
GROUP BY status;

-- ignored 且舊 invalid_reason 有值時，reason 應已帶入
SELECT COUNT(*) FROM pending_handoffs
WHERE status = 'ignored' AND reason IS NULL AND invalid_reason IS NOT NULL;
-- 預期結果：0
```

#### 5. 執行後跑測試

```bash
npm test
# 若有 TEST_DATABASE_URL，integration tests 會驗證 PostgreSQL migration 可重複套用
DATABASE_URL=$TEST_DATABASE_URL npm run db:migrate
npm test -- tests/postgresIntegration.test.ts
```

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

Consultant 另可：`查看待處理問題`、`稍後處理`、處理後 `整理成知識卡`。

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
- 僅注入顧問私訊草稿流程，**不會**進入群組公開回答；待辦回覆請透過「查看待處理問題」→ 私訊 replyMessage 草稿

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
