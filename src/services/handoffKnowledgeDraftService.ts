export interface HandoffReplyContext {
  groupId: string;
  groupName: string | null;
  shortCode: string;
  customerQuestion: string;
  replyText: string;
  storedAt: string;
}

const lastReplyContextByUser = new Map<string, HandoffReplyContext>();

export function storeHandoffReplyContext(
  userId: string,
  context: Omit<HandoffReplyContext, 'storedAt'>
): void {
  lastReplyContextByUser.set(userId, {
    ...context,
    storedAt: new Date().toISOString(),
  });
}

export function consumeHandoffReplyContext(userId: string): HandoffReplyContext | null {
  const context = lastReplyContextByUser.get(userId) ?? null;
  return context ? { ...context } : null;
}

export function peekHandoffReplyContext(userId: string): HandoffReplyContext | null {
  const context = lastReplyContextByUser.get(userId) ?? null;
  return context ? { ...context } : null;
}

export function clearHandoffReplyContext(): void {
  lastReplyContextByUser.clear();
}

export function getHandoffReplyContextByShortCode(
  userId: string,
  shortCode: string
): HandoffReplyContext | null {
  const context = lastReplyContextByUser.get(userId) ?? null;
  if (!context || context.shortCode !== shortCode) {
    return null;
  }
  return { ...context };
}

export function parseOrganizeFromHandoffPhrase(
  text: string
): { mode: 'recent' } | { mode: 'shortCode'; shortCode: string } | null {
  const trimmed = text.trim();
  if (
    trimmed === '把剛剛代回整理成知識卡' ||
    trimmed === '把這次代回整理成知識卡' ||
    trimmed === '將這題代回整理成知識卡'
  ) {
    return { mode: 'recent' };
  }
  const shortCodeMatch = trimmed.match(/^(Q-\d{8}-\d{4}-[A-Z0-9]{2})\s*整理成知識卡$/u);
  if (shortCodeMatch) {
    return { mode: 'shortCode', shortCode: shortCodeMatch[1] };
  }
  return null;
}

export function isOrganizeFromHandoffPhrase(text: string): boolean {
  return parseOrganizeFromHandoffPhrase(text) !== null;
}

export const ORGANIZE_FROM_HANDOFF_NOT_FOUND_MESSAGE =
  '目前找不到最近可整理的代回紀錄。請先完成一次代回群組，或改用「幫我整理知識卡」手動新增。';

export function buildOrganizeContentFromHandoff(context: HandoffReplyContext): string {
  return [
    '店家問題：',
    context.customerQuestion,
    '',
    '導入教練回覆：',
    context.replyText,
    '',
    `來源群組短碼：${context.shortCode}`,
  ].join('\n');
}
