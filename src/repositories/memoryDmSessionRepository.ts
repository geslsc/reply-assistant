import { DmSessionDraftData, DmSessionRecord, DmSessionRepository, CreateDmSessionParams } from './dmSessionTypes';
import { KnowledgeCard } from '../schemas/knowledgeCardSchema';
import { KnowledgeCardDraftData } from '../schemas/knowledgeCardDraftSchema';

function cloneRecord(record: DmSessionRecord): DmSessionRecord {
  return {
    ...record,
    draftData: record.draftData
      ? {
          ...record.draftData,
          card: record.draftData.card ? { ...record.draftData.card } : undefined,
        }
      : null,
  };
}

export function mapDmSessionRow(row: Record<string, unknown>): DmSessionRecord {
  return {
    sessionId: String(row.session_id),
    userId: String(row.user_id),
    sessionType: row.session_type as DmSessionRecord['sessionType'],
    status: row.status as DmSessionRecord['status'],
    draftData: row.draft_data ? (row.draft_data as DmSessionDraftData) : null,
    createdAt: new Date(row.created_at as string | Date).toISOString(),
    updatedAt: new Date(row.updated_at as string | Date).toISOString(),
    expiredAt: row.expired_at ? new Date(row.expired_at as string | Date).toISOString() : null,
  };
}

export function createMemoryDmSessionRepository(
  pendingInsert: (params: {
    reviewId: string;
    cardData: KnowledgeCard;
    draftData?: KnowledgeCardDraftData;
    submittedBy: string;
    submittedAt: string;
  }) => Promise<void>
): DmSessionRepository {
  const sessions = new Map<string, DmSessionRecord>();
  let forceSubmitFailure = false;

  const repo: DmSessionRepository & { setForceSubmitFailure?: (value: boolean) => void } = {
    async create(params: CreateDmSessionParams) {
      const existing = await repo.findActiveByUserId(params.userId);
      if (existing) {
        throw new Error('ACTIVE_SESSION_EXISTS');
      }
      const record: DmSessionRecord = {
        sessionId: params.sessionId,
        userId: params.userId,
        sessionType: params.sessionType,
        status: 'active',
        draftData: params.draftData ?? null,
        createdAt: params.createdAt,
        updatedAt: params.updatedAt,
        expiredAt: null,
      };
      sessions.set(record.sessionId, record);
      return cloneRecord(record);
    },

    async findById(sessionId) {
      const record = sessions.get(sessionId);
      return record ? cloneRecord(record) : null;
    },

    async findActiveByUserId(userId) {
      const record = [...sessions.values()].find(
        (session) => session.userId === userId && session.status === 'active'
      );
      return record ? cloneRecord(record) : null;
    },

    async updateDraftData(sessionId, draftData, updatedAt) {
      const record = sessions.get(sessionId);
      if (!record || record.status !== 'active') {
        return null;
      }
      record.draftData = draftData;
      record.updatedAt = updatedAt;
      return cloneRecord(record);
    },

    async markSubmitted(sessionId, updatedAt) {
      const record = sessions.get(sessionId);
      if (!record) {
        return null;
      }
      record.status = 'submitted';
      record.updatedAt = updatedAt;
      return cloneRecord(record);
    },

    async markCompleted(sessionId, updatedAt) {
      const record = sessions.get(sessionId);
      if (!record) {
        return null;
      }
      record.status = 'completed';
      record.updatedAt = updatedAt;
      return cloneRecord(record);
    },

    async markCancelled(sessionId, updatedAt) {
      const record = sessions.get(sessionId);
      if (!record) {
        return null;
      }
      record.status = 'cancelled';
      record.updatedAt = updatedAt;
      return cloneRecord(record);
    },

    async cancelAllActiveForUser(userId, updatedAt) {
      let count = 0;
      for (const record of sessions.values()) {
        if (record.userId === userId && record.status === 'active') {
          record.status = 'cancelled';
          record.updatedAt = updatedAt;
          count += 1;
        }
      }
      return count;
    },

    async markExpired(sessionId, updatedAt, expiredAt) {
      const record = sessions.get(sessionId);
      if (!record) {
        return null;
      }
      record.status = 'expired';
      record.updatedAt = updatedAt;
      record.expiredAt = expiredAt;
      return cloneRecord(record);
    },

    async submitDraftAtomically(params) {
      const session = await repo.findActiveByUserId(params.userId);
      if (!session) {
        throw new Error('NO_ACTIVE_SESSION');
      }
      if (forceSubmitFailure) {
        throw new Error('FORCED_SUBMIT_FAILURE');
      }
      await pendingInsert({
        reviewId: params.reviewId,
        cardData: params.cardData,
        draftData: params.draftData,
        submittedBy: params.userId,
        submittedAt: params.submittedAt,
      });
      const updated = await repo.markSubmitted(session.sessionId, params.submittedAt);
      if (!updated) {
        throw new Error('SESSION_SUBMIT_FAILED');
      }
      return { session: updated, reviewId: params.reviewId };
    },

    async clear() {
      sessions.clear();
      forceSubmitFailure = false;
    },

    setForceSubmitFailure(value: boolean) {
      forceSubmitFailure = value;
    },
  };

  return repo;
}

export type MemoryDmSessionRepository = ReturnType<typeof createMemoryDmSessionRepository>;
