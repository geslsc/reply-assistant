import { KnowledgeCard } from '../schemas/knowledgeCardSchema';
import { KnowledgeCardDraftData } from '../schemas/knowledgeCardDraftSchema';
import {
  draftDataToKnowledgeCard,
  knowledgeCardToDraftData,
} from '../services/knowledgeCardDraftMappingService';
import {
  InsertPendingKnowledgeReviewParams,
  PendingKnowledgeReviewRecord,
  PendingKnowledgeReviewRepository,
  PendingKnowledgeReviewStatus,
} from './pendingKnowledgeReviewTypes';

function cloneRecord(record: PendingKnowledgeReviewRecord): PendingKnowledgeReviewRecord {
  return {
    ...record,
    cardData: { ...record.cardData },
    draftData: record.draftData ? { ...record.draftData } : null,
  };
}

export function createMemoryPendingKnowledgeReviewRepository(): PendingKnowledgeReviewRepository {
  const reviews = new Map<string, PendingKnowledgeReviewRecord>();
  const botMessageIndex = new Map<string, string>();

  return {
    async insert(params: InsertPendingKnowledgeReviewParams) {
      const draftData =
        params.draftData ??
        knowledgeCardToDraftData(params.cardData);
      const cardData = draftDataToKnowledgeCard(draftData);
      const record: PendingKnowledgeReviewRecord = {
        reviewId: params.reviewId,
        cardData,
        draftData,
        submittedBy: params.submittedBy,
        submittedAt: params.submittedAt,
        status: 'pending',
        botMessageId: null,
        adminResponse: null,
        resolvedAt: null,
        resolvedBy: null,
        lastEditedBy: null,
        lastEditedAt: null,
        editReason: null,
      };
      reviews.set(record.reviewId, record);
      return cloneRecord(record);
    },

    async findById(reviewId) {
      const record = reviews.get(reviewId);
      return record ? cloneRecord(record) : null;
    },

    async findByStatus(status: PendingKnowledgeReviewStatus) {
      return Array.from(reviews.values())
        .filter((record) => record.status === status)
        .map(cloneRecord);
    },

    async listPending() {
      return this.findByStatus('pending');
    },

    async findByBotMessageId(botMessageId) {
      const reviewId = botMessageIndex.get(botMessageId);
      if (!reviewId) {
        return null;
      }
      return this.findById(reviewId);
    },

    async updateBotMessageId(reviewId, botMessageId) {
      const record = reviews.get(reviewId);
      if (!record) {
        return;
      }
      if (record.botMessageId) {
        botMessageIndex.delete(record.botMessageId);
      }
      record.botMessageId = botMessageId;
      botMessageIndex.set(botMessageId, reviewId);
    },

    async updateAdminResponse(reviewId, adminResponse) {
      const record = reviews.get(reviewId);
      if (record) {
        record.adminResponse = adminResponse;
      }
    },

    async updateDraftData(params) {
      const record = reviews.get(params.reviewId);
      if (!record || record.status !== 'pending') {
        return null;
      }
      record.draftData = params.draftData;
      record.cardData = params.cardData;
      record.lastEditedBy = params.lastEditedBy;
      record.lastEditedAt = params.lastEditedAt;
      record.editReason = params.editReason ?? null;
      return cloneRecord(record);
    },

    async markApproved(reviewId, resolvedBy, resolvedAt) {
      const record = reviews.get(reviewId);
      if (record) {
        record.status = 'approved';
        record.resolvedBy = resolvedBy;
        record.resolvedAt = resolvedAt;
      }
    },

    async markRejected(reviewId, resolvedBy, resolvedAt, adminResponse = null) {
      const record = reviews.get(reviewId);
      if (record) {
        record.status = 'rejected';
        record.resolvedBy = resolvedBy;
        record.resolvedAt = resolvedAt;
        if (adminResponse !== undefined) {
          record.adminResponse = adminResponse;
        }
      }
    },

    async clear() {
      reviews.clear();
      botMessageIndex.clear();
    },
  };
}

export function mapPendingKnowledgeReviewRow(row: Record<string, unknown>): PendingKnowledgeReviewRecord {
  const rawDraft = row.draft_data as KnowledgeCardDraftData | KnowledgeCard | null | undefined;
  const rawCard = row.card_data as KnowledgeCard | undefined;
  let draftData: KnowledgeCardDraftData | null = null;
  let cardData: KnowledgeCard;

  if (rawDraft && typeof rawDraft === 'object' && 'public_answer_draft' in rawDraft) {
    draftData = rawDraft as KnowledgeCardDraftData;
    cardData = draftDataToKnowledgeCard(draftData);
  } else if (rawDraft && typeof rawDraft === 'object' && 'standard_answer' in rawDraft) {
    cardData = rawDraft as KnowledgeCard;
    draftData = knowledgeCardToDraftData(cardData);
  } else if (rawCard) {
    cardData = rawCard;
    draftData = knowledgeCardToDraftData(cardData);
  } else {
    cardData = {
      card_id: '__pending__',
      title: '',
      patterns: [],
      risk_level: 'unknown' as KnowledgeCard['risk_level'],
      can_public_reply: false,
      standard_answer: '',
      not_applicable: [],
      escalate_to_consultant: [],
      status: '可用',
    };
    draftData = null;
  }

  return {
    reviewId: String(row.review_id),
    cardData,
    draftData,
    submittedBy: String(row.submitted_by),
    submittedAt: new Date(row.submitted_at as string | Date).toISOString(),
    status: row.status as PendingKnowledgeReviewRecord['status'],
    botMessageId: row.bot_message_id ? String(row.bot_message_id) : null,
    adminResponse: row.admin_response ? String(row.admin_response) : null,
    resolvedAt: row.resolved_at ? new Date(row.resolved_at as string | Date).toISOString() : null,
    resolvedBy: row.resolved_by ? String(row.resolved_by) : null,
    lastEditedBy: row.last_edited_by ? String(row.last_edited_by) : null,
    lastEditedAt: row.last_edited_at
      ? new Date(row.last_edited_at as string | Date).toISOString()
      : null,
    editReason: row.edit_reason ? String(row.edit_reason) : null,
  };
}
