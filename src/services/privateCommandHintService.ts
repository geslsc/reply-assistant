import { BotReply } from '../types';

function compactLines(title: string, lines: string[]): string {
  return [title, ...lines.map((line) => `- ${line}`), '', '輸入「使用說明」可查看完整指令。'].join(
    '\n'
  );
}

export function buildPrivateCommandKeywordHint(
  userId: string,
  text: string,
  isAdmin: boolean
): BotReply | null {
  const trimmed = text.trim();
  if (!trimmed) {
    return null;
  }

  if (/知識卡|知識庫|卡片|查卡|找卡|搜尋|修改|新增|整理|暫停|恢復/u.test(trimmed)) {
    return {
      type: 'push',
      userId,
      text: compactLines('我有看到您在操作知識卡，可以用：', [
        '幫我整理知識卡',
        '查詢知識卡 [關鍵字或 card_id]',
        '搜尋 [關鍵字]',
        '修改知識卡 [card_id 或編號]',
        isAdmin ? '暫停知識卡 [card_id 或編號] / 恢復知識卡 [card_id 或編號]' : '建議暫停 [card_id 或編號]',
      ]),
    };
  }

  if (/群組|服務期|負責|副手|主負責/u.test(trimmed)) {
    return {
      type: 'push',
      userId,
      text: compactLines('我有看到您在查群組或服務期，可以用：', [
        isAdmin ? '群組清單 / 查詢群組列表' : '我的服務群組',
        '查詢服務期 [群組名稱或 G-xx]',
        '查看待處理問題 [群組名稱]',
        '小助手群組狀態 [群組名稱]',
        ...(isAdmin ? ['設定群組 G-xx 主負責 C-xx', '解除群組 G-xx 負責人'] : []),
      ]),
    };
  }

  if (/待處理|handoff|稍後處理/u.test(trimmed)) {
    return {
      type: 'push',
      userId,
      text: compactLines('我有看到您在處理群組問題，可以用：', [
        '查看待處理問題',
        '輸入問題短碼查看詳情',
        '於私訊撰寫回覆草稿',
      ]),
    };
  }

  if (/匯出|備份|backup|json/i.test(trimmed)) {
    return {
      type: 'push',
      userId,
      text: compactLines('我有看到您在處理備份或匯出，可以用：', [
        isAdmin ? '匯出所有知識卡' : '匯出功能僅 active admin 可用',
        isAdmin ? '匯出 low risk 的卡' : '請洽 admin 匯出知識卡備份',
        '轉成 JSON（草稿流程中使用）',
      ]),
    };
  }

  if (/確認|送出|更新|退回|需要修改/u.test(trimmed)) {
    return {
      type: 'push',
      userId,
      text: compactLines('我有看到您在處理草稿審核，可以用：', [
        isAdmin ? '確認更新 K-xxxxxxxx-xx' : '確認送出',
        isAdmin ? '需要修改 K-xxxxxxxx-xx：……' : '修改：……',
        isAdmin ? '退回 K-xxxxxxxx-xx' : '取消 / 停止整理',
      ]),
    };
  }

  return null;
}
