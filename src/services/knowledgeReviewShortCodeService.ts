/** 知識卡待審草稿短碼，例：K-20260608-A7；必要時延長 suffix 至唯一 */
export const KNOWLEDGE_REVIEW_SHORT_CODE_PATTERN = /^K-\d{8}-[A-Z0-9]{2,}$/;

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

/** 從文字中找出所有可能的短碼 token */
export function findKnowledgeReviewShortCodeCandidates(text: string): string[] {
  const regex = /K-\d{8}-[A-Z0-9]{2,}/g;
  return [...text.matchAll(regex)].map((match) => match[0]);
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
