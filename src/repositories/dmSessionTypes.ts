import { KnowledgeCard } from '../schemas/knowledgeCardSchema';

export type DmSessionType = 'knowledge_draft';

export type DmSessionStatus = 'active' | 'submitted' | 'completed' | 'cancelled' | 'expired';

export interface DmSessionDraftData {
  card?: KnowledgeCard;
  draftJson?: string | null;
  draftText: string;
  humanReadableDraft: string;
  /** 累積的文字輸入（含 vision 摘要），不含圖片資料 */
  inputNotes?: string;
  /** 等待使用者確認的截圖理解摘要，不含圖片資料 */
  pendingVisionSummary?: string;
}

export interface DmSessionRecord {
  sessionId: string;
  userId: string;
  sessionType: DmSessionType;
  status: DmSessionStatus;
  draftData: DmSessionDraftData | null;
  createdAt: string;
  updatedAt: string;
  expiredAt: string | null;
}

export interface CreateDmSessionParams {
  sessionId: string;
  userId: string;
  sessionType: DmSessionType;
  draftData?: DmSessionDraftData | null;
  createdAt: string;
  updatedAt: string;
}

export interface DmSessionRepository {
  create(params: CreateDmSessionParams): Promise<DmSessionRecord>;
  findById(sessionId: string): Promise<DmSessionRecord | null>;
  findActiveByUserId(userId: string): Promise<DmSessionRecord | null>;
  updateDraftData(
    sessionId: string,
    draftData: DmSessionDraftData | null,
    updatedAt: string
  ): Promise<DmSessionRecord | null>;
  markSubmitted(sessionId: string, updatedAt: string): Promise<DmSessionRecord | null>;
  markCompleted(sessionId: string, updatedAt: string): Promise<DmSessionRecord | null>;
  markCancelled(sessionId: string, updatedAt: string): Promise<DmSessionRecord | null>;
  markExpired(sessionId: string, updatedAt: string, expiredAt: string): Promise<DmSessionRecord | null>;
  submitDraftAtomically(params: {
    userId: string;
    reviewId: string;
    cardData: KnowledgeCard;
    submittedAt: string;
    draftText: string;
  }): Promise<{ session: DmSessionRecord; reviewId: string }>;
  clear(): Promise<void>;
}
