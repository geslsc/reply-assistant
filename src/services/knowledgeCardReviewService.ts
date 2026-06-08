import { v4 as uuidv4 } from 'uuid';
import { KnowledgeCard } from '../schemas/knowledgeCardSchema';
import { getRepos } from '../repositories';
import { PendingKnowledgeReviewRecord } from '../repositories/pendingKnowledgeReviewTypes';
import {
  allocateUniqueKnowledgeReviewShortCode,
  resolveKnowledgeReviewShortCodeFromText,
} from './knowledgeReviewShortCodeService';
import { formatHumanReadableKnowledgeCard } from './knowledgeCardDraftService';
import { getConsultant } from './consultantWhitelist';
import { getSessionDraft, StoredDraft } from './dmSessionService';

export type { StoredDraft } from './dmSessionService';

export interface PendingAdminReview {
  reviewId: string;
  shortCode: string;
  consultantId: string;
  consultantName: string | null;
  submittedAt: string;
  card: KnowledgeCard;
  draftText: string;
}

export function clearKnowledgeCardReviewState(): void {
  // dm session state cleared via repos.dmSessions.clear() in resetRepositories
}

async function recordToPendingReview(
  record: PendingKnowledgeReviewRecord,
  draftText?: string
): Promise<PendingAdminReview> {
  const consultant = await getConsultant(record.submittedBy);
  return {
    reviewId: record.reviewId,
    shortCode: record.reviewId,
    consultantId: record.submittedBy,
    consultantName: consultant?.displayName ?? null,
    submittedAt: record.submittedAt,
    card: record.cardData,
    draftText: draftText ?? formatHumanReadableKnowledgeCard(record.cardData),
  };
}

export async function createPendingReview(params: {
  consultantId: string;
  consultantName: string | null;
  card: KnowledgeCard;
  draftText: string;
}): Promise<PendingAdminReview> {
  const submittedAt = new Date().toISOString();
  const entropyId = uuidv4();
  const pendingIds = new Set(
    (await getRepos().pendingKnowledgeReviews.listPending()).map((r) => r.reviewId)
  );
  const reviewId = allocateUniqueKnowledgeReviewShortCode(entropyId, submittedAt, (code) =>
    pendingIds.has(code)
  );

  const record = await getRepos().pendingKnowledgeReviews.insert({
    reviewId,
    cardData: params.card,
    submittedBy: params.consultantId,
    submittedAt,
  });

  return recordToPendingReview(record, params.draftText);
}

export async function registerReviewMessageMapping(
  reviewId: string,
  messageId: string
): Promise<void> {
  await getRepos().pendingKnowledgeReviews.updateBotMessageId(reviewId, messageId);
}

export async function getReviewIdByMessageId(messageId: string): Promise<string | undefined> {
  const record = await getRepos().pendingKnowledgeReviews.findByBotMessageId(messageId);
  return record?.reviewId;
}

const SHORT_CODE_NOT_UNIQUE_ERROR = '短碼無法唯一定位，請重新指定。';

export async function resolvePendingReviewByShortCode(shortCode: string): Promise<{
  review?: PendingAdminReview;
  error?: string;
}> {
  const record = await getRepos().pendingKnowledgeReviews.findById(shortCode);
  if (!record || record.status !== 'pending') {
    return { error: `找不到待審短碼 ${shortCode}，可能已處理或不存在。` };
  }

  const pendingList = await getRepos().pendingKnowledgeReviews.listPending();
  const sameCodeReviews = pendingList.filter((item) => item.reviewId === shortCode);
  if (sameCodeReviews.length !== 1) {
    return { error: SHORT_CODE_NOT_UNIQUE_ERROR };
  }

  return { review: await recordToPendingReview(record) };
}

export async function getPendingReviewByShortCode(
  shortCode: string
): Promise<PendingAdminReview | undefined> {
  return (await resolvePendingReviewByShortCode(shortCode)).review;
}

export async function getPendingReviewById(reviewId: string): Promise<PendingAdminReview | undefined> {
  const record = await getRepos().pendingKnowledgeReviews.findById(reviewId);
  if (!record || record.status !== 'pending') {
    return undefined;
  }
  return recordToPendingReview(record);
}

export async function listPendingReviews(): Promise<PendingAdminReview[]> {
  const records = await getRepos().pendingKnowledgeReviews.listPending();
  return Promise.all(records.map((record) => recordToPendingReview(record)));
}

export async function markReviewApproved(reviewId: string, adminUserId: string): Promise<void> {
  await getRepos().pendingKnowledgeReviews.markApproved(
    reviewId,
    adminUserId,
    new Date().toISOString()
  );
}

export async function markReviewRejected(
  reviewId: string,
  adminUserId: string,
  adminResponse?: string | null
): Promise<void> {
  await getRepos().pendingKnowledgeReviews.markRejected(
    reviewId,
    adminUserId,
    new Date().toISOString(),
    adminResponse ?? null
  );
}

export async function saveReviewAdminResponse(reviewId: string, adminResponse: string): Promise<void> {
  await getRepos().pendingKnowledgeReviews.updateAdminResponse(reviewId, adminResponse);
}

export function formatPendingReviewList(reviews: PendingAdminReview[]): string {
  if (reviews.length === 0) {
    return '（目前無待審草稿）';
  }
  return reviews
    .map(
      (r) =>
        `- ${r.shortCode}｜顧問 ${r.consultantName ?? r.consultantId}｜card_id=${r.card.card_id}`
    )
    .join('\n');
}

export interface ResolveReviewTargetParams {
  text: string;
  quotedMessageId?: string;
  allowOwnDraft?: boolean;
  adminUserId?: string;
}

export interface ResolveReviewTargetResult {
  review?: PendingAdminReview;
  ownDraft?: StoredDraft;
  error?: string;
}

export async function resolveReviewTarget(
  params: ResolveReviewTargetParams
): Promise<ResolveReviewTargetResult> {
  const pendingList = await listPendingReviews();
  const knownShortCodes = pendingList.map((item) => item.shortCode);
  const resolvedCode = resolveKnowledgeReviewShortCodeFromText(params.text, knownShortCodes);

  if (resolvedCode.ambiguous) {
    return { error: SHORT_CODE_NOT_UNIQUE_ERROR };
  }

  if (resolvedCode.shortCode) {
    const located = await resolvePendingReviewByShortCode(resolvedCode.shortCode);
    if (located.error) {
      return { error: located.error };
    }
    return { review: located.review };
  }

  const tokenInText = params.text.match(/K-\d{8}-[A-Z0-9]{2,}/);
  if (tokenInText) {
    return { error: `找不到待審短碼 ${tokenInText[0]}，可能已處理或不存在。` };
  }

  if (params.quotedMessageId) {
    const reviewId = await getReviewIdByMessageId(params.quotedMessageId);
    if (reviewId) {
      const review = await getPendingReviewById(reviewId);
      if (review) {
        return { review };
      }
    }
  }

  if (pendingList.length === 1) {
    return { review: pendingList[0] };
  }

  if (pendingList.length > 1) {
    return {
      error: [
        '目前有多筆待審知識卡草稿，請指定短碼：',
        formatPendingReviewList(pendingList),
        '',
        '範例：確認更新 K-20260608-A7',
      ].join('\n'),
    };
  }

  if (params.allowOwnDraft && params.adminUserId) {
    const ownDraft = await getSessionDraft(params.adminUserId);
    if (ownDraft) {
      return { ownDraft };
    }
  }

  return { error: '目前沒有待確認的知識卡草稿。' };
}

export async function getPendingReviewCount(): Promise<number> {
  return (await getRepos().pendingKnowledgeReviews.listPending()).length;
}

/** 測試用：直接建立待審並註冊 message 對應 */
export async function seedPendingReviewForTest(
  review: Omit<PendingAdminReview, 'reviewId' | 'shortCode' | 'submittedAt'> & {
    reviewId?: string;
    shortCode?: string;
    submittedAt?: string;
  },
  messageId?: string
): Promise<PendingAdminReview> {
  const submittedAt = review.submittedAt ?? new Date().toISOString();
  let reviewId = review.reviewId ?? review.shortCode;
  if (!reviewId) {
    const pendingIds = new Set(
      (await getRepos().pendingKnowledgeReviews.listPending()).map((r) => r.reviewId)
    );
    reviewId = allocateUniqueKnowledgeReviewShortCode(uuidv4(), submittedAt, (code) =>
      pendingIds.has(code)
    );
  }

  const record = await getRepos().pendingKnowledgeReviews.insert({
    reviewId,
    cardData: review.card,
    submittedBy: review.consultantId,
    submittedAt,
  });

  if (messageId) {
    await registerReviewMessageMapping(reviewId, messageId);
  }

  return {
    reviewId,
    shortCode: reviewId,
    consultantId: review.consultantId,
    consultantName: review.consultantName,
    submittedAt,
    card: review.card,
    draftText: review.draftText,
  };
}

/** @deprecated 改用 seedTwoPendingReviewsForTest；保留供舊測試編譯過渡 */
export async function seedPendingReviewAmbiguityForTest(
  _shortCode: string,
  reviewA: PendingAdminReview,
  reviewB: PendingAdminReview
): Promise<void> {
  await getRepos().pendingKnowledgeReviews.insert({
    reviewId: reviewA.reviewId,
    cardData: reviewA.card,
    submittedBy: reviewA.consultantId,
    submittedAt: reviewA.submittedAt,
  });
  await getRepos().pendingKnowledgeReviews.insert({
    reviewId: reviewB.reviewId,
    cardData: reviewB.card,
    submittedBy: reviewB.consultantId,
    submittedAt: reviewB.submittedAt,
  });
}
