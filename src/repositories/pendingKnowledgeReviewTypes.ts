import { KnowledgeCard } from '../schemas/knowledgeCardSchema';
import { KnowledgeCardDraftData } from '../schemas/knowledgeCardDraftSchema';

export type PendingKnowledgeReviewStatus = 'pending' | 'approved' | 'rejected' | 'expired';

export interface PendingKnowledgeReviewRecord {
  reviewId: string;
  cardData: KnowledgeCard;
  draftData: KnowledgeCardDraftData | null;
  submittedBy: string;
  submittedAt: string;
  status: PendingKnowledgeReviewStatus;
  botMessageId: string | null;
  adminResponse: string | null;
  resolvedAt: string | null;
  resolvedBy: string | null;
  lastEditedBy: string | null;
  lastEditedAt: string | null;
  editReason: string | null;
}

export interface InsertPendingKnowledgeReviewParams {
  reviewId: string;
  cardData: KnowledgeCard;
  draftData?: KnowledgeCardDraftData | null;
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
  updateDraftData(params: {
    reviewId: string;
    draftData: KnowledgeCardDraftData;
    cardData: KnowledgeCard;
    lastEditedBy: string;
    lastEditedAt: string;
    editReason?: string | null;
  }): Promise<PendingKnowledgeReviewRecord | null>;
  markApproved(reviewId: string, resolvedBy: string, resolvedAt: string): Promise<void>;
  markRejected(
    reviewId: string,
    resolvedBy: string,
    resolvedAt: string,
    adminResponse?: string | null
  ): Promise<void>;
  clear(): Promise<void>;
}
