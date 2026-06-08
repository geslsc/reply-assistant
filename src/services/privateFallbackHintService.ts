const sentFallbackUsers = new Set<string>();

export function clearPrivateFallbackState(): void {
  sentFallbackUsers.clear();
}

export function resetPrivateFallbackForUser(userId: string): void {
  sentFallbackUsers.delete(userId);
}

export function consumePrivateFallbackHint(userId: string): boolean {
  if (sentFallbackUsers.has(userId)) {
    return false;
  }
  sentFallbackUsers.add(userId);
  return true;
}

export const SIMPLIFIED_PRIVATE_FALLBACK_HINT =
  '已收到。輸入「使用說明」查看可用指令，或「我的層級」查身份。';
