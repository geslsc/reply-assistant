import { KnowledgeCardDraftData } from '../schemas/knowledgeCardDraftSchema';
import { PendingAdminReview } from './knowledgeCardReviewService';
import { formatHumanReadableKnowledgeCard } from './knowledgeCardDraftService';
import { draftDataToKnowledgeCard } from './knowledgeCardDraftMappingService';

export interface DraftDisplayOptions {
  shortCode?: string;
  consultantName?: string | null;
  consultantId?: string;
  submittedAt?: string;
}

export function formatHumanReadableDraftData(
  draft: KnowledgeCardDraftData,
  options?: DraftDisplayOptions
): string {
  const header: string[] = ['【待審知識卡草稿】'];
  if (options?.shortCode) {
    header.push(`短碼：${options.shortCode}`);
  }
  if (options?.consultantName || options?.consultantId) {
    header.push(`顧問：${options.consultantName ?? options.consultantId}`);
  }
  if (options?.submittedAt) {
    header.push(`送出時間：${options.submittedAt}`);
  }
  header.push('');

  const cardView = formatHumanReadableKnowledgeCard(draftDataToKnowledgeCard(draft));

  return [
    ...header,
    cardView,
    '',
    '可回覆：',
    options?.shortCode
      ? `- 確認更新 ${options.shortCode}`
      : '- 確認更新 K-YYYYMMDD-XX',
    options?.shortCode
      ? `- 編輯草稿 ${options.shortCode} + JSON`
      : '- 編輯草稿 K-YYYYMMDD-XX + JSON',
  ].join('\n');
}

export function formatPendingReviewDetail(review: PendingAdminReview): string {
  return [
    `【待審知識卡草稿】${review.shortCode}`,
    '',
    review.draftText,
  ].join('\n');
}
