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
      text: compactLines('【知識卡】我可以協助新增、查詢、修改教學知識卡：', [
        '新增草稿：幫我整理知識卡',
        '查詢卡片：查詢知識卡 [關鍵字或 card_id]',
        '搜尋卡片：搜尋 [關鍵字]',
        '修改草稿：修改知識卡 [card_id 或編號]',
        '補充草稿：補充：你的補充內容',
        '調整草稿：修改：你的修改方向',
        isAdmin
          ? '暫停 / 恢復：暫停知識卡 [card_id 或編號] / 恢復知識卡 [card_id 或編號]'
          : '建議暫停：建議暫停 [card_id 或編號]',
      ]),
    };
  }

  if (/群組|服務期|負責|副手|主負責/u.test(trimmed)) {
    return {
      type: 'push',
      userId,
      text: compactLines('【群組 / 服務期】我有看到您在查群組或服務期，可以用：', [
        isAdmin ? '查看全部群組：群組清單 / 查詢群組列表' : '查看我的群組：我的服務群組',
        '查詢服務期：查詢服務期 [群組名稱或 G-xx]',
        '查特定群組待處理：查看待處理問題 [群組名稱]',
        '查看群組狀態：小助手群組狀態 [群組名稱]',
        ...(isAdmin ? ['設定群組 G-xx 主負責 C-xx', '解除群組 G-xx 負責人'] : []),
      ]),
    };
  }

  if (/待處理|handoff|稍後處理/u.test(trimmed)) {
    return {
      type: 'push',
      userId,
      text: compactLines('【待處理】我可以協助查看與標記群組未處理問題：', [
        '查看清單：查看待處理問題',
        '查看詳情：輸入問題短碼，例如 Q-20260612-0303-37',
        '稍後處理：Q-20260612-0303-37 稍後處理',
        '標記已處理：Q-20260612-0303-37 已處理',
        '略過：Q-20260612-0303-37 不處理',
        '整理成知識卡草稿：Q-20260612-0303-37 整理成知識卡：貼上你的建議回答',
      ]),
    };
  }

  if (/匯出|備份|backup|json/i.test(trimmed)) {
    return {
      type: 'push',
      userId,
      text: compactLines('【匯出】我可以協助匯出知識卡備份：', [
        isAdmin ? '匯出全部：匯出所有知識卡' : '匯出功能僅 active admin 可用',
        isAdmin ? '匯出低風險卡：匯出 low risk 的卡' : '請洽 Admin 匯出知識卡備份',
        '轉成 JSON（草稿流程中使用）',
      ]),
    };
  }

  if (/確認|送出|更新|退回|需要修改/u.test(trimmed)) {
    return {
      type: 'push',
      userId,
      text: compactLines('【確認】我可以協助處理草稿送出或審核：', [
        isAdmin ? '正式上線：確認更新 K-xxxxxxxx-xx' : '送出草稿：確認送出',
        isAdmin ? '請顧問修改：需要修改 K-xxxxxxxx-xx：你的意見' : '修改目前草稿：修改：你的修改方向',
        isAdmin ? '退回草稿：退回 K-xxxxxxxx-xx' : '取消草稿：取消 / 停止整理',
      ]),
    };
  }

  return null;
}
