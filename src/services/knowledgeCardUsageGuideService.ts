export const USAGE_GUIDE_TRIGGER_PHRASES = [
  '使用說明',
  'help',
  '顧問手冊',
  '小助手說明',
  '你會做什麼',
  '小助手會做什麼',
  '小助手會幹嘛',
  '你可以幫我什麼',
] as const;

export { GROUP_CUSTOMER_USAGE_GUIDE as GROUP_USAGE_GUIDE } from './groupAssistantCommandService';

export const ADMIN_USAGE_GUIDE = `【小助手使用說明｜Admin】

我是教學小助手，目前私訊可以協助您：

1. 查詢身份與權限
   輸入：我的層級

2. 整理知識卡草稿
   輸入：幫我整理知識卡（預設為「新增知識卡」，系統會分配唯一 card_id）
   若要修改既有卡，請先指定：
   - 修改知識卡 [card_id 或編號]
   - 修改「標題」這張
   - 更新跟 [關鍵字] 有關的知識卡
   也可以直接貼截圖，我會先理解截圖內容再整理成草稿。
   草稿會保留段落與換行，standard_answer 適合 LINE 閱讀。
   AI 會協助建議不適用 / 需導入教練協助情境，您可再補充修改。

3. 補充或修改草稿
   輸入：補充：……
   輸入：修改：……
   若驗證失敗，草稿會保留，請用「修改：…」調整後再「確認更新」。

4. 覆核是否公開回答（Admin）
   輸入：設為可公開回答
   輸入：設為導入教練參考
   草稿會顯示建議與原因；真正帳務 / 金額 / 權限 / 資料異常仍不得設為公開回答。

5. 轉成 JSON
   輸入：轉成 JSON（僅此時顯示正式 9 欄位 schema）

6. 確認更新知識庫（僅 Admin）
   輸入：確認更新 K-xxxxxxxx-xx
   多筆待審時請指定編號，單筆時可省略。
   也可以直接回覆草稿訊息 + 輸入「確認更新」。
   ※ Admin 請用「確認更新」，請勿使用「確認送出」。

7. 退回或要求修改草稿
   輸入：退回 K-xxxxxxxx-xx
   輸入：需要修改 K-xxxxxxxx-xx：……

7. 暫停知識卡
   輸入：暫停知識卡 [card_id 或編號]

8. 恢復知識卡（僅 Admin）
   輸入：恢復知識卡 [card_id 或編號]

9. 查看知識庫
   輸入：列出所有知識卡
   輸入：列出 active 的卡
   輸入：查詢知識卡 [關鍵字]
   輸入：找跟 [關鍵字] 有關的卡
   輸入：搜尋 [關鍵字]
   輸入：有沒有 [關鍵字] 的知識卡
   查詢結果為人類可讀格式；追蹤欄位請用「匯出所有知識卡」查看 raw JSON。

10. 匯出知識庫備份
    輸入：匯出所有知識卡
    輸入：匯出 low risk 的卡

11. 批量匯入知識卡（僅 Admin）
    輸入：批量匯入
    接著貼上 JSON，我會先列出清單讓您確認再寫入。

12. 代回群組
    當我私訊您待處理問題時，可以回：
    Q-xxxxxxxx-xx 回覆：……
    或：幫我回 Q-xxxxxxxx-xx：「……」
    代回成功後，可輸入「把剛剛代回整理成知識卡」，或「Q-xxxxxxxx-xx 整理成知識卡」。

13. 查看待處理問題
    輸入：查看待處理問題
    輸入：查看待處理問題 [群組名稱]
    只貼 Q-xxxxxxxx-xx 可顯示該題可操作指令。

14. 代號定位
    只貼 K-xxxxxxxx-xx、kc-xxxxxxxx-xxx 或 card_id 可顯示可操作指令。
    只貼群組名稱（唯一命中）可顯示群組相關操作。

15. 查詢群組服務期（Admin）
    輸入：查詢服務期 [群組名稱]

16. 群組內叫小助手協助（須以「小助手」開頭）
    小助手自我介紹一下｜小助手先休息一下｜小助手再麻煩了
    小助手重新啟用教學協助期｜小助手這題我更正
    顧問在群組一般回覆店家時，小助手會視為人工接手並保持沉默。

17. 取消或完成目前流程
    輸入：完成
    輸入：取消
    輸入：停止整理
    輸入：先不用

提醒：
- 知識卡草稿不會自動生效，Admin 請用「確認更新」正式上線（請勿使用「確認送出」）。
- 顧問送出的草稿會推送到您這裡，由您最終確認。
- 建議定期輸入「匯出所有知識卡」保存備份。`;

export const CONSULTANT_USAGE_GUIDE = `【小助手使用說明｜顧問】

我是教學小助手，目前私訊可以協助您：

1. 查詢身份與權限
   輸入：我的層級

2. 整理知識卡草稿
   輸入：幫我整理知識卡（預設新增，不會覆蓋既有卡）
   若要修改既有卡，請用：
   - 修改知識卡 [card_id 或編號]
   - 修改「標題」這張
   也可以直接貼截圖，我會先理解截圖內容再整理成草稿。
   AI 會協助建議不適用 / 需導入教練協助情境。

3. 補充或修改草稿
   輸入：補充：……
   輸入：修改：……

4. 建議是否公開回答（顧問僅能建議，需 Admin 確認更新）
   輸入：設為可公開回答
   輸入：設為導入教練參考

5. 轉成 JSON
   輸入：轉成 JSON

6. 確認送出草稿給 Admin 審核
   輸入：確認送出
   草稿會送到 Admin，由 Admin 確認後才會正式上線。
   ※ 顧問請用「確認送出」，請勿使用「確認更新」。

7. 代回群組
    當我私訊您待處理問題時，可以回：
    Q-xxxxxxxx-xx 回覆：……
    代回成功後，可輸入「把剛剛代回整理成知識卡」，或「Q-xxxxxxxx-xx 整理成知識卡」。

8. 查看待處理問題
    輸入：查看待處理問題
    只貼 Q-xxxxxxxx-xx 可顯示該題可操作指令。

9. 代號定位
    只貼 Q-xxxxxxxx-xx 可顯示代回、稍後處理、整理成知識卡等操作。

10. 群組內叫小助手協助（須以「小助手」開頭）
    小助手這題我更正｜小助手先休息一下｜小助手再麻煩了
    顧問在群組一般回覆店家時，小助手會視為人工接手並保持沉默。
    群組店家可問：小助手你會做什麼、小助手使用說明（店家視角說明）。

11. 查看知識庫（僅查看，不可修改）
   輸入：列出所有知識卡
   輸入：查詢知識卡 [關鍵字]
   輸入：找跟 [關鍵字] 有關的卡
   輸入：搜尋 [關鍵字]
   輸入：有沒有 [關鍵字] 的知識卡

9. 建議暫停知識卡
   輸入：建議暫停 [card_id 或編號]
   暫停需由 Admin 執行，您的建議會通知 Admin。

12. 取消或完成目前流程
    輸入：完成
    輸入：取消
    輸入：停止整理
    輸入：先不用

提醒：
- 您整理的草稿不會自動上線，需要確認送出給 Admin，由 Admin 確認更新後才生效。
- 代回群組的內容會逐字轉貼，小助手不會改寫您的回覆。
- 若草稿驗證失敗，請用「修改：…」調整後再確認送出。`;

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
