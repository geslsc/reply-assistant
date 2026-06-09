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

export function isOrganizeFromHandoffPhrase(text: string): boolean {
  return text.trim() === '整理成知識卡';
}

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
