/** 由 issueThreadId 與建立時間衍生的可讀短碼，例：Q-20260608-0133-A7 */
export function deriveShortCode(issueThreadId: string, createdAt: string): string {
  const date = new Date(createdAt);
  const y = date.getUTCFullYear();
  const m = String(date.getUTCMonth() + 1).padStart(2, '0');
  const d = String(date.getUTCDate()).padStart(2, '0');
  const hh = String(date.getUTCHours()).padStart(2, '0');
  const mm = String(date.getUTCMinutes()).padStart(2, '0');
  const suffix = issueThreadId.split('-').pop()?.slice(0, 2).toUpperCase() ?? 'XX';
  return `Q-${y}${m}${d}-${hh}${mm}-${suffix}`;
}

export function isShortCode(text: string): boolean {
  return /^Q-\d{8}-\d{4}-[A-Z0-9]{2}$/.test(text.trim());
}

export function extractShortCodeFromText(text: string): string | null {
  const match = text.match(/Q-\d{8}-\d{4}-[A-Z0-9]{2}/);
  return match ? match[0] : null;
}
