const sentFallbackUsers = new Set<string>();

export function clearPrivateFallbackState(): void {
  sentFallbackUsers.clear();
  suppressFallbackUsers.clear();
}

export function resetPrivateFallbackForUser(userId: string): void {
  sentFallbackUsers.delete(userId);
}

export function consumePrivateFallbackHint(userId: string): boolean {
  if (suppressFallbackUsers.has(userId)) {
    suppressFallbackUsers.delete(userId);
    return false;
  }
  if (sentFallbackUsers.has(userId)) {
    return false;
  }
  sentFallbackUsers.add(userId);
  return true;
}

const suppressFallbackUsers = new Set<string>();

export function suppressPrivateFallbackForUser(userId: string): void {
  suppressFallbackUsers.add(userId);
  sentFallbackUsers.add(userId);
}

export function clearPrivateFallbackSuppressForUser(userId: string): void {
  suppressFallbackUsers.delete(userId);
}

export const SIMPLIFIED_PRIVATE_FALLBACK_HINT =
  '已收到。輸入「使用說明」查看可用指令，或「我的層級」查身份。';
