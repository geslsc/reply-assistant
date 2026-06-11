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

常用指令：
1. 我的層級
2. 幫我整理知識卡
3. 查詢知識卡 [關鍵字]
4. 確認更新 K-xxxxxxxx-xx
5. 退回 K-xxxxxxxx-xx
6. 查看待處理問題
7. 查詢群組列表
8. 查詢服務期 [群組名稱或 G-xx]
9. 編輯草稿 K-xxxxxxxx-xx（admin）
10. 匯出所有知識卡

整理知識卡：
- 新增：幫我整理知識卡
- 修改：修改知識卡 [card_id 或編號]
- 補充：補充：……
- 調整：修改：……
- 設定：設為可公開回答 / 設為導入教練參考
- 上線：確認更新 K-xxxxxxxx-xx
- 取消：取消 / 停止整理 / 先不用

群組測試：
- 小助手自我介紹一下
- 小助手先休息一下
- 小助手再麻煩了
- 小助手這題我更正
- 小助手使用說明

想看某類操作，直接輸入：
知識卡 / 群組 / 服務期 / 待處理 / 匯出 / 確認

提醒：Admin 用「確認更新」正式上線；顧問送出的草稿仍需 Admin 確認。`;

export const CONSULTANT_USAGE_GUIDE = `【小助手使用說明｜顧問】

常用指令：
1. 我的層級
2. 幫我整理知識卡
3. 查詢知識卡 [關鍵字]
4. 確認送出
5. 查看待處理問題
6. 查看待處理問題
7. 建議暫停 [card_id 或編號]
8. 取消 / 停止整理 / 先不用

整理知識卡：
- 新增：幫我整理知識卡
- 修改：修改知識卡 [card_id 或編號]
- 補充：補充：……
- 調整：修改：……
- 建議：設為可公開回答 / 設為導入教練參考
- 送審：確認送出

群組測試：
- 小助手自我介紹一下
- 小助手先休息一下
- 小助手再麻煩了
- 小助手這題我更正
- 小助手使用說明

想看某類操作，直接輸入：
知識卡 / 待處理 / 確認 / 群組

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
