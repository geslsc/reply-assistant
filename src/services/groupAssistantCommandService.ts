/** 群組內顧問 / 管理者叫小助手做事，一律以「小助手」開頭 */
export const ASSISTANT_PREFIX = '小助手';

export function startsWithAssistantPrefix(text: string): boolean {
  return text.trim().startsWith(ASSISTANT_PREFIX);
}

/** 群組店家視角使用說明觸發語 */
export const GROUP_CUSTOMER_USAGE_GUIDE_PHRASES = [
  '小助手使用說明',
  '小助手你會做什麼',
  '小助手可以幫什麼',
  '小助手會做什麼',
  '小助手會幹嘛',
] as const;

export function isGroupCustomerUsageGuideRequest(text: string): boolean {
  const trimmed = text.trim();
  return GROUP_CUSTOMER_USAGE_GUIDE_PHRASES.some((phrase) => trimmed === phrase);
}

/** 正式群組協助語法（須以「小助手」開頭） */
export const GROUP_ASSISTANT_COMMANDS = {
  INTRO: '小助手自我介紹一下',
  MUTE: '小助手先休息一下',
  UNMUTE: '小助手再麻煩了',
  REACTIVATE: '小助手重新啟用教學協助期',
  CORRECTION: '小助手這題我更正',
} as const;

export type GroupAssistantCommand =
  (typeof GROUP_ASSISTANT_COMMANDS)[keyof typeof GROUP_ASSISTANT_COMMANDS];

const GROUP_ASSISTANT_COMMAND_ALIASES: Record<string, GroupAssistantCommand> = {
  小助手自我介紹一下: GROUP_ASSISTANT_COMMANDS.INTRO,
  小助手介紹一下: GROUP_ASSISTANT_COMMANDS.INTRO,
  小助手你會做什麼: GROUP_ASSISTANT_COMMANDS.INTRO,
  小助手使用說明: GROUP_ASSISTANT_COMMANDS.INTRO,
  自我介紹一下: GROUP_ASSISTANT_COMMANDS.INTRO,
  介紹一下小助手: GROUP_ASSISTANT_COMMANDS.INTRO,
  跟店家介紹小助手: GROUP_ASSISTANT_COMMANDS.INTRO,
  小助手先休息一下: GROUP_ASSISTANT_COMMANDS.MUTE,
  小助手先休息: GROUP_ASSISTANT_COMMANDS.MUTE,
  小助手暫停一下: GROUP_ASSISTANT_COMMANDS.MUTE,
  小助手暫停: GROUP_ASSISTANT_COMMANDS.MUTE,
  小助手再麻煩了: GROUP_ASSISTANT_COMMANDS.UNMUTE,
  小助手再麻煩一下: GROUP_ASSISTANT_COMMANDS.UNMUTE,
  小助手回來: GROUP_ASSISTANT_COMMANDS.UNMUTE,
  小助手醒醒: GROUP_ASSISTANT_COMMANDS.UNMUTE,
  恢復小助手: GROUP_ASSISTANT_COMMANDS.UNMUTE,
  喚醒小助手: GROUP_ASSISTANT_COMMANDS.UNMUTE,
  小助手重新啟用教學協助期: GROUP_ASSISTANT_COMMANDS.REACTIVATE,
  小助手重新啟用: GROUP_ASSISTANT_COMMANDS.REACTIVATE,
  小助手這題我更正: GROUP_ASSISTANT_COMMANDS.CORRECTION,
  小助手這題要更正: GROUP_ASSISTANT_COMMANDS.CORRECTION,
  小助手這篇要改: GROUP_ASSISTANT_COMMANDS.CORRECTION,
};

export function normalizeGroupAssistantCommand(text: string): GroupAssistantCommand | null {
  const trimmed = text.trim();
  return GROUP_ASSISTANT_COMMAND_ALIASES[trimmed] ?? null;
}

/** 已停用舊語法 → 引導新語法（僅對 active admin / consultant 提示） */
export const DEPRECATED_GROUP_SYNTAX_HINTS: Record<string, string> = {
  '小助手啟用保母期 30 天': '此語法已停用。請改用「小助手自我介紹一下」啟用 30 天教學協助期。',
  '小助手開始協助 30 天': '此語法已停用。請改用「小助手自我介紹一下」啟用 30 天教學協助期。',
  啟用保母期: '此語法已停用。請改用「小助手自我介紹一下」啟用 30 天教學協助期。',
  開始保母期: '此語法已停用。請改用「小助手自我介紹一下」啟用 30 天教學協助期。',
  保母期: '此語法已停用。請改用「小助手自我介紹一下」啟用 30 天教學協助期。',
  開始協助: '此語法已停用。請改用「小助手自我介紹一下」啟用 30 天教學協助期。',
  小助手要麻煩你一下: '此語法已停用。請改用「小助手再麻煩了」。',
  '有什麼可以協助您的嗎?': '此語法已停用。顧問一般回覆店家時，小助手會保持沉默。',
  '有什麼可以協助您的嗎？': '此語法已停用。顧問一般回覆店家時，小助手會保持沉默。',
  '有什麼可以協助您嗎?': '此語法已停用。顧問一般回覆店家時，小助手會保持沉默。',
  '有什麼可以協助您嗎？': '此語法已停用。顧問一般回覆店家時，小助手會保持沉默。',
  '請問有什麼可以協助您的嗎?': '此語法已停用。顧問一般回覆店家時，小助手會保持沉默。',
  '請問有什麼可以協助您的嗎？': '此語法已停用。顧問一般回覆店家時，小助手會保持沉默。',
  確認重新啟用: '此語法已停用。請改用「小助手重新啟用教學協助期」。',
  重新啟用教學協助期: '此語法已停用。請改用「小助手重新啟用教學協助期」。',
  這篇要改: '此語法已停用。請改用「小助手這題我更正」。',
};

export function getDeprecatedSyntaxHint(text: string): string | null {
  const trimmed = text.trim();
  return DEPRECATED_GROUP_SYNTAX_HINTS[trimmed] ?? null;
}

export const GROUP_CUSTOMER_USAGE_GUIDE = `我是客立樂教學小助手，接下來的教學協助期間，我會和導入教練一起協助您處理操作使用上的問題。

您可以直接在群組描述遇到的狀況，例如：
「請問要怎麼新增預約？」
「儲值卡要怎麼設定？」
「這個畫面我不知道下一步要按哪裡」

如果是基本的操作使用問題，我會提供教學步驟給您參考。
如果是我目前還不會、需要確認，或不適合直接回答的問題，我會幫您整理起來，提醒導入教練協助確認。`;
