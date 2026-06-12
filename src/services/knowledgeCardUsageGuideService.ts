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

我是你的教學小助手。店家在群組問基礎操作問題時，我會協助釐清、查知識卡並回覆；如果遇到我還不能安全回答的問題，我會整理成待處理問題，讓你私訊查看。

你可以直接輸入下面分類，我會給你該分類可用指令：

1. 待處理
查看群組中還沒處理完的店家問題，並標記稍後、已處理或略過。

2. 知識卡
新增、查詢、修改、送審或上線知識卡。

3. 群組
查看群組列表、負責人與服務群組資訊。

4. 服務期
查詢指定群組的小助手服務狀態。

5. 確認
處理知識卡草稿確認、退回或修改意見。

6. 匯出
匯出知識卡備份。

常用入口：
- 查看待處理問題
- 幫我整理知識卡
- 查詢知識卡 [關鍵字]
- 查詢群組列表
- 查詢服務期 [群組名稱或 G-xx]

群組內測試：
- 小助手自我介紹一下
- 小助手先休息一下
- 小助手再麻煩了
- 小助手這題我更正
- 小助手使用說明

提醒：Admin 用「確認更新 K-xxxxxxxx-xx」正式上線；顧問送出的草稿仍需 Admin 確認。`;

export const CONSULTANT_USAGE_GUIDE = `【小助手使用說明｜顧問】

我是你的教學小助手。店家在群組問基礎操作問題時，我會協助釐清、查知識卡並回覆；如果遇到我還不能安全回答的問題，我會整理成待處理問題，讓你私訊查看。

你私訊我時，可以直接輸入下面分類，我會給你該分類可用指令：

1. 待處理
查看目前有哪些群組問題還沒處理，並標記稍後、已處理或略過。

2. 知識卡
新增、查詢、修改教學知識卡，或把待處理問題整理成草稿。

3. 群組
查看你負責的群組。

4. 服務期
查詢群組的小助手服務狀態；若權限不足，我會提醒你找 Admin。

5. 確認
送出目前整理中的知識卡草稿。

常用入口：
- 查看待處理問題
- 幫我整理知識卡
- 查詢知識卡 [關鍵字]
- 我的服務群組

群組內測試：
- 小助手自我介紹一下
- 小助手先休息一下
- 小助手再麻煩了
- 小助手這題我更正
- 小助手使用說明

提醒：顧問用「確認送出」，草稿送給 Admin 後才會正式上線。`;

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
