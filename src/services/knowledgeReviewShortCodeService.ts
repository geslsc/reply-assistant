/** 知識卡待審草稿短碼，例：K-20260608-A7；KDR- 為別名 */
export const KNOWLEDGE_REVIEW_SHORT_CODE_PATTERN = /^K-\d{8}-[A-Z0-9]{2,}$/;
export const KNOWLEDGE_REVIEW_SHORT_CODE_ALIAS_PATTERN = /^KDR-\d{8}-[A-Z0-9]{2,}$/i;

export function normalizeKnowledgeReviewShortCode(text: string): string {
  const trimmed = text.trim();
  if (KNOWLEDGE_REVIEW_SHORT_CODE_ALIAS_PATTERN.test(trimmed)) {
    return trimmed.replace(/^KDR-/i, 'K-');
  }
  return trimmed;
}

export const PENDING_REVIEW_QUERY_PHRASES = ['查詢待審知識卡', '查看待審知識卡'] as const;

export function isPendingReviewQueryPhrase(text: string): boolean {
  return PENDING_REVIEW_QUERY_PHRASES.includes(
    text.trim() as (typeof PENDING_REVIEW_QUERY_PHRASES)[number]
  );
}

export function isViewPendingReviewCommand(text: string): string | null {
  const match = text.match(/^(?:查看|查)\s+(KDR-\d{8}-[A-Z0-9]{2,}|K-\d{8}-[A-Z0-9]{2,})(?:\s|$)/iu);
  if (!match) {
    return null;
  }
  return normalizeKnowledgeReviewShortCode(match[1]);
}

function formatShortCodeDate(submittedAt: string): string {
  const date = new Date(submittedAt);
  const y = date.getUTCFullYear();
  const m = String(date.getUTCMonth() + 1).padStart(2, '0');
  const d = String(date.getUTCDate()).padStart(2, '0');
  return `${y}${m}${d}`;
}

/** 初始 suffix：reviewId 前 2 字元；碰撞時逐步延長 */
export function deriveKnowledgeReviewShortCode(reviewId: string, submittedAt: string): string {
  const datePart = formatShortCodeDate(submittedAt);
  const idHex = reviewId.replace(/-/g, '').toUpperCase();
  const suffix = idHex.slice(0, 2);
  return `K-${datePart}-${suffix}`;
}

export function allocateUniqueKnowledgeReviewShortCode(
  reviewId: string,
  submittedAt: string,
  isTaken: (shortCode: string) => boolean
): string {
  const datePart = formatShortCodeDate(submittedAt);
  const idHex = reviewId.replace(/-/g, '').toUpperCase();

  for (let len = 2; len <= idHex.length; len += 1) {
    const candidate = `K-${datePart}-${idHex.slice(0, len)}`;
    if (!isTaken(candidate)) {
      return candidate;
    }
  }

  let counter = 1;
  while (counter < 1000) {
    const candidate = `K-${datePart}-${idHex.slice(0, 2)}${counter}`;
    if (!isTaken(candidate)) {
      return candidate;
    }
    counter += 1;
  }

  throw new Error('Unable to allocate unique knowledge review short code');
}

export function isKnowledgeReviewShortCode(text: string): boolean {
  return KNOWLEDGE_REVIEW_SHORT_CODE_PATTERN.test(text.trim());
}

/** 從文字中找出所有可能的短碼 token（含 KDR- 別名） */
export function findKnowledgeReviewShortCodeCandidates(text: string): string[] {
  const regex = /(?:KDR|K)-\d{8}-[A-Z0-9]{2,}/gi;
  return [...text.matchAll(regex)].map((match) => normalizeKnowledgeReviewShortCode(match[0]));
}

export function extractKnowledgeReviewShortCode(text: string): string | null {
  const candidates = findKnowledgeReviewShortCodeCandidates(text);
  return candidates.length > 0 ? candidates[0] : null;
}

/**
 * 在已知待審短碼集合中解析；0 個匹配 → null，>1 個匹配 → null（ambiguous）
 */
export function resolveKnowledgeReviewShortCodeFromText(
  text: string,
  knownShortCodes: Iterable<string>
): { shortCode: string | null; ambiguous: boolean } {
  const known = new Set(knownShortCodes);
  const matched = findKnowledgeReviewShortCodeCandidates(text).filter((code) => known.has(code));

  if (matched.length === 0) {
    const anyToken = extractKnowledgeReviewShortCode(text);
    if (anyToken) {
      return { shortCode: null, ambiguous: false };
    }
    return { shortCode: null, ambiguous: false };
  }

  if (matched.length > 1) {
    return { shortCode: null, ambiguous: true };
  }

  return { shortCode: matched[0], ambiguous: false };
}
