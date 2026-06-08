import { KnowledgeCard } from '../schemas/knowledgeCardSchema';
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
  };
}

export function createMemoryPendingKnowledgeReviewRepository(): PendingKnowledgeReviewRepository {
  const reviews = new Map<string, PendingKnowledgeReviewRecord>();
  const botMessageIndex = new Map<string, string>();

  return {
    async insert(params: InsertPendingKnowledgeReviewParams) {
      const record: PendingKnowledgeReviewRecord = {
        reviewId: params.reviewId,
        cardData: params.cardData,
        submittedBy: params.submittedBy,
        submittedAt: params.submittedAt,
        status: 'pending',
        botMessageId: null,
        adminResponse: null,
        resolvedAt: null,
        resolvedBy: null,
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
  return {
    reviewId: String(row.review_id),
    cardData: row.card_data as KnowledgeCard,
    submittedBy: String(row.submitted_by),
    submittedAt: new Date(row.submitted_at as string | Date).toISOString(),
    status: row.status as PendingKnowledgeReviewRecord['status'],
    botMessageId: row.bot_message_id ? String(row.bot_message_id) : null,
    adminResponse: row.admin_response ? String(row.admin_response) : null,
    resolvedAt: row.resolved_at ? new Date(row.resolved_at as string | Date).toISOString() : null,
    resolvedBy: row.resolved_by ? String(row.resolved_by) : null,
  };
}
