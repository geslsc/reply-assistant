import { BotReply } from '../types';
import { isActiveAdmin } from './consultantWhitelist';
import {
  formatPendingReviewList,
  getPendingReviewByShortCode,
  listPendingReviews,
} from './knowledgeCardReviewService';
import {
  formatHumanReadableDraftData,
  formatPendingReviewDetail,
} from './knowledgeCardDraftDisplayService';
import {
  extractKnowledgeReviewShortCode,
  isPendingReviewQueryPhrase,
  isViewPendingReviewCommand,
  normalizeKnowledgeReviewShortCode,
} from './knowledgeReviewShortCodeService';

export function parsePendingReviewListQuery(text: string): boolean {
  return isPendingReviewQueryPhrase(text.trim());
}

export function parseViewPendingReviewCommand(text: string): string | null {
  return isViewPendingReviewCommand(text.trim());
}

export async function handlePendingReviewListQuery(userId: string): Promise<BotReply[]> {
  if (!(await isActiveAdmin(userId))) {
    return [{ type: 'push', userId, text: '只有 active admin 可查詢待審知識卡。' }];
  }

  const pendingList = await listPendingReviews();
  if (pendingList.length === 0) {
    return [{ type: 'push', userId, text: '目前沒有待審知識卡草稿。' }];
  }

  return [
    {
      type: 'push',
      userId,
      text: [
        '【待審知識卡清單】',
        formatPendingReviewList(pendingList),
        '',
        '可回覆：',
        '- 查看 K-YYYYMMDD-XX（或 KDR-YYYYMMDD-XX）',
        '- 確認更新 K-YYYYMMDD-XX',
        '- 編輯草稿 K-YYYYMMDD-XX + JSON',
      ].join('\n'),
    },
  ];
}

export async function handleViewPendingReviewDetail(
  userId: string,
  rawCode: string
): Promise<BotReply[]> {
  if (!(await isActiveAdmin(userId))) {
    return [{ type: 'push', userId, text: '只有 active admin 可查看待審知識卡。' }];
  }

  const shortCode = normalizeKnowledgeReviewShortCode(rawCode);
  const review = await getPendingReviewByShortCode(shortCode);
  if (!review) {
    return [{ type: 'push', userId, text: `找不到待審知識卡草稿 ${rawCode}。` }];
  }

  const detail = review.draftData
    ? formatHumanReadableDraftData(review.draftData, {
        shortCode: review.shortCode,
        consultantName: review.consultantName,
        consultantId: review.consultantId,
        submittedAt: review.submittedAt,
      })
    : formatPendingReviewDetail(review);

  return [
    {
      type: 'push',
      userId,
      text: detail,
    },
  ];
}

export async function handlePendingReviewQueryCommand(
  userId: string,
  text: string
): Promise<BotReply[] | null> {
  const trimmed = text.trim();

  if (parsePendingReviewListQuery(trimmed)) {
    return handlePendingReviewListQuery(userId);
  }

  const viewCode = parseViewPendingReviewCommand(trimmed);
  if (viewCode) {
    return handleViewPendingReviewDetail(userId, viewCode);
  }

  const bareCode = extractKnowledgeReviewShortCode(trimmed);
  if (bareCode && /^(查看|查)\s*/u.test(trimmed)) {
    return handleViewPendingReviewDetail(userId, bareCode);
  }

  return null;
}
