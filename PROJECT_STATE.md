# PROJECT_STATE

Last updated: 2026-06-12 18:05 Asia/Taipei

## Current Deployed Version

- Commit: `3647c81` (`Adjust group reply copy behavior`)
- Environment: Railway production
- Health check: `200 OK`
- Service health: `{"ok":true,"service":"reply-assistant","db":"connected"}`

## Latest Completed Scope

群組回覆話術調整已完成並通過 Codex 複驗：

- 同群組自我介紹去重：首次長版，之後短版。
- `group_flags.metadata_json.intro_shown` 持久化 intro 狀態。
- `metadata_json` 寫入 `intro_shown` 時保留未知 key。
- `metadata_json = null` 或異常格式時安全降級，不中斷 webhook。
- `intro_shown` 不再新增 event log。
- 閒聊回覆支援 LLM opening + 固定語法池。
- 缺 `OPENAI_API_KEY`、LLM 失敗、非法 index 時，fallback 完全等於固定語法池其中一組。
- 閒聊最多回覆兩輪，第三輪起安靜。
- handoff 改為固定文案，不經 LLM。
- 知識卡命中仍逐字輸出 `standard_answer`，再接固定結尾語。

## Verification

- `npm run build` passed.
- `npm test -- --runInBand` passed.
- Test result: 30 passed, 1 skipped; 522 passed, 19 skipped.

## LINE Test Focus

建議本輪 LINE 實測重點：

1. 同一群組第一次輸入 `小助手自我介紹一下`，應出現長版介紹。
2. 同一群組再次輸入 `小助手自我介紹一下`、`小助手使用說明`、`你是誰`、`可以幹嘛`，應只出現短版，且不得出現 `30 天`。
3. 不同群組第一次介紹仍應出現長版。
4. 店家輸入 `我好無聊`，小助手最多回兩輪閒聊，第三輪起不回。
5. 店家中途改問操作問題，應跳出閒聊流程進正常挑卡/收斂/handoff。
6. 知識卡命中時，正文應維持卡片 `standard_answer` 逐字內容，後方接固定結尾語。
7. 無法回答或需教練確認時，handoff 文案不得出現 `請稍等`、`馬上`、`等等回覆`。

## Known Notes

- `backups/` remains local untracked data and is intentionally not committed.
- Full test may require unsandboxed execution locally because supertest opens a test server port.
