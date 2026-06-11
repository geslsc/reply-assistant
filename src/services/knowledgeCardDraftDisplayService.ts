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
  const extraLines: string[] = [];

  if (draft.core_question) {
    extraLines.push('', '核心問題：', draft.core_question);
  }
  if (draft.match_features.length > 0) {
    extraLines.push('', '匹配特徵：', ...draft.match_features.map((item) => `- ${item}`));
  }
  if (draft.applicability_rules.length > 0) {
    extraLines.push('', '適用規則：', ...draft.applicability_rules.map((item) => `- ${item}`));
  }
  if (draft.exclusion_rules.length > 0) {
    extraLines.push('', '排除規則：', ...draft.exclusion_rules.map((item) => `- ${item}`));
  }
  if (draft.reasoning) {
    extraLines.push('', '推理說明：', draft.reasoning);
  }
  if (draft.handoff_conditions.length > 0) {
    extraLines.push('', '導入條件：', ...draft.handoff_conditions.map((item) => `- ${item}`));
  }

  return [
    ...header,
    cardView,
    ...extraLines,
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
