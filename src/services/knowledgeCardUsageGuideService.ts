export const USAGE_GUIDE_TRIGGER_PHRASES = [
  '使用說明',
  'help',
  '顧問手冊',
  '小助手說明',
  '你會做什麼',
] as const;

export const ADMIN_USAGE_GUIDE = `【小助手使用說明｜Admin】

我是教學小助手，目前私訊可以協助您：

1. 查詢身份與權限
   輸入：我的層級

2. 整理知識卡草稿
   輸入：幫我整理知識卡
   也可以直接貼截圖，我會先理解截圖內容再整理成草稿。
   接著請提供：
   - 店家常問的問題
   - 您建議的回答方式
   - 適用情境
   - 不適用情境
   - 需要轉顧問的情況

3. 補充或修改草稿
   輸入：補充：……
   輸入：修改：……

4. 轉成 JSON
   輸入：轉成 JSON

5. 確認更新知識庫（僅 Admin）
   輸入：確認更新 K-xxxxxxxx-xx
   多筆待審時請指定編號，單筆時可省略。
   也可以直接回覆草稿訊息 + 輸入「確認更新」。

6. 退回或要求修改草稿
   輸入：退回 K-xxxxxxxx-xx
   輸入：需要修改 K-xxxxxxxx-xx：……

7. 暫停知識卡
   輸入：暫停知識卡 [card_id 或編號]

8. 恢復知識卡（僅 Admin）
   輸入：恢復知識卡 [card_id 或編號]

9. 查看知識庫
   輸入：列出所有知識卡
   輸入：列出 active 的卡
   輸入：找跟登入有關的卡

10. 匯出知識庫備份
    輸入：匯出所有知識卡
    輸入：匯出 low risk 的卡

11. 批量匯入知識卡（僅 Admin）
    輸入：批量匯入
    接著貼上 JSON，我會先列出清單讓您確認再寫入。

12. 代回群組
    當我私訊您待處理問題時，可以回：
    幫我回這題：「……」
    多題時請指定問題編號：
    幫我回 Q-xxxxxxxx-xx：「……」

13. 取消或完成目前流程
    輸入：完成
    輸入：取消
    輸入：停止整理
    輸入：先不用

提醒：
- 知識卡草稿不會自動生效，需要您確認更新才會正式上線。
- 顧問送出的草稿會推送到您這裡，由您最終確認。
- 建議定期輸入「匯出所有知識卡」保存備份。`;

export const CONSULTANT_USAGE_GUIDE = `【小助手使用說明｜顧問】

我是教學小助手，目前私訊可以協助您：

1. 查詢身份與權限
   輸入：我的層級

2. 整理知識卡草稿
   輸入：幫我整理知識卡
   也可以直接貼截圖，我會先理解截圖內容再整理成草稿。
   接著請提供：
   - 店家常問的問題
   - 您建議的回答方式
   - 適用情境
   - 不適用情境
   - 需要轉顧問的情況

3. 補充或修改草稿
   輸入：補充：……
   輸入：修改：……

4. 轉成 JSON
   輸入：轉成 JSON

5. 確認送出草稿給 Admin 審核
   輸入：確認送出
   草稿會送到 Admin，由 Admin 確認後才會正式上線。

6. 代回群組
    當我私訊您待處理問題時，可以回：
    幫我回這題：「……」
    多題時請指定問題編號：
    幫我回 Q-xxxxxxxx-xx：「……」

7. 查看知識庫（僅查看，不可修改）
   輸入：列出所有知識卡
   輸入：找跟登入有關的卡

8. 建議暫停知識卡
   輸入：建議暫停 [card_id 或編號]
   暫停需由 Admin 執行，您的建議會通知 Admin。

9. 取消或完成目前流程
   輸入：完成
   輸入：取消
   輸入：停止整理
   輸入：先不用

提醒：
- 您整理的草稿不會自動上線，需要確認送出給 Admin，由 Admin 確認更新後才生效。
- 代回群組的內容會逐字轉貼，小助手不會改寫您的回覆。`;

export const GROUP_USAGE_GUIDE = `【小助手使用說明｜群組】

群組內僅提供簡要說明。完整指令請私訊小助手。

- 查身份：私訊「我的層級」
- 整理知識卡：私訊「幫我整理知識卡」
- 查看知識庫：私訊「列出所有知識卡」等
- 代回群組：私訊「幫我回這題：…」
- 完整說明：私訊「使用說明」

群組內請勿期待 AI 自動公開回覆；代回群組內容會逐字轉貼。`;

export function isUsageGuideTrigger(text: string): boolean {
  const trimmed = text.trim();
  return USAGE_GUIDE_TRIGGER_PHRASES.includes(
    trimmed as (typeof USAGE_GUIDE_TRIGGER_PHRASES)[number]
  );
}

export function isUsageGuideTriggerCaseInsensitive(text: string): boolean {
  const trimmed = text.trim().toLowerCase();
  return USAGE_GUIDE_TRIGGER_PHRASES.some((phrase) => phrase.toLowerCase() === trimmed);
}

export function matchUsageGuideTrigger(text: string): boolean {
  return isUsageGuideTrigger(text) || isUsageGuideTriggerCaseInsensitive(text);
}
