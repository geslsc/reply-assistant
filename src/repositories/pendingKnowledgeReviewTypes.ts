import { KnowledgeCard } from '../schemas/knowledgeCardSchema';

export type PendingKnowledgeReviewStatus = 'pending' | 'approved' | 'rejected' | 'expired';

export interface PendingKnowledgeReviewRecord {
  reviewId: string;
  cardData: KnowledgeCard;
  submittedBy: string;
  submittedAt: string;
  status: PendingKnowledgeReviewStatus;
  botMessageId: string | null;
  adminResponse: string | null;
  resolvedAt: string | null;
  resolvedBy: string | null;
}

export interface InsertPendingKnowledgeReviewParams {
  reviewId: string;
  cardData: KnowledgeCard;
  submittedBy: string;
  submittedAt: string;
}

export interface PendingKnowledgeReviewRepository {
  insert(params: InsertPendingKnowledgeReviewParams): Promise<PendingKnowledgeReviewRecord>;
  findById(reviewId: string): Promise<PendingKnowledgeReviewRecord | null>;
  findByStatus(status: PendingKnowledgeReviewStatus): Promise<PendingKnowledgeReviewRecord[]>;
  listPending(): Promise<PendingKnowledgeReviewRecord[]>;
  findByBotMessageId(botMessageId: string): Promise<PendingKnowledgeReviewRecord | null>;
  updateBotMessageId(reviewId: string, botMessageId: string): Promise<void>;
  updateAdminResponse(reviewId: string, adminResponse: string): Promise<void>;
  markApproved(reviewId: string, resolvedBy: string, resolvedAt: string): Promise<void>;
  markRejected(
    reviewId: string,
    resolvedBy: string,
    resolvedAt: string,
    adminResponse?: string | null
  ): Promise<void>;
  clear(): Promise<void>;
}
