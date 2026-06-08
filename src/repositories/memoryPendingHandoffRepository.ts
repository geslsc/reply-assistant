import { v4 as uuidv4 } from 'uuid';
import {
  CreatePendingHandoffParams,
  PendingHandoff,
  PendingHandoffInvalidReason,
  PendingHandoffRepository,
  PendingHandoffStatus,
} from './pendingHandoffTypes';

export function createMemoryPendingHandoffRepository(): PendingHandoffRepository {
  const store = new Map<string, PendingHandoff>();

  return {
    async create(params: CreatePendingHandoffParams) {
      const now = new Date().toISOString();
      const handoff: PendingHandoff = {
        id: uuidv4(),
        consultantId: params.consultantId,
        issueThreadId: params.issueThreadId,
        groupId: params.groupId,
        shortCode: params.shortCode,
        status: PendingHandoffStatus.OPEN,
        invalidReason: null,
        customerQuestion: params.customerQuestion,
        createdAt: now,
        updatedAt: now,
        closedAt: null,
      };
      store.set(handoff.id, handoff);
      return { ...handoff };
    },

    async findOpenByConsultant(consultantId) {
      return Array.from(store.values())
        .filter(
          (h) => h.consultantId === consultantId && h.status === PendingHandoffStatus.OPEN
        )
        .map((h) => ({ ...h }));
    },

    async findOpenByConsultantAndShortCode(consultantId, shortCode) {
      const handoff = Array.from(store.values()).find(
        (h) =>
          h.consultantId === consultantId &&
          h.shortCode === shortCode &&
          h.status === PendingHandoffStatus.OPEN
      );
      return handoff ? { ...handoff } : null;
    },

    async findByConsultant(consultantId) {
      return Array.from(store.values())
        .filter((h) => h.consultantId === consultantId)
        .map((h) => ({ ...h }));
    },

    async markClosed(id) {
      const handoff = store.get(id);
      if (!handoff) {
        return null;
      }
      const now = new Date().toISOString();
      handoff.status = PendingHandoffStatus.CLOSED;
      handoff.updatedAt = now;
      handoff.closedAt = now;
      return { ...handoff };
    },

    async markInvalid(id, reason) {
      const handoff = store.get(id);
      if (!handoff) {
        return null;
      }
      const now = new Date().toISOString();
      handoff.status = PendingHandoffStatus.INVALID;
      handoff.invalidReason = reason;
      handoff.updatedAt = now;
      return { ...handoff };
    },

    async markInvalidByGroup(groupId, reason) {
      let count = 0;
      for (const handoff of store.values()) {
        if (handoff.groupId === groupId && handoff.status === PendingHandoffStatus.OPEN) {
          handoff.status = PendingHandoffStatus.INVALID;
          handoff.invalidReason = reason;
          handoff.updatedAt = new Date().toISOString();
          count++;
        }
      }
      return count;
    },

    async markInvalidByThread(groupId, issueThreadId, reason) {
      let count = 0;
      for (const handoff of store.values()) {
        if (
          handoff.groupId === groupId &&
          handoff.issueThreadId === issueThreadId &&
          handoff.status === PendingHandoffStatus.OPEN
        ) {
          handoff.status = PendingHandoffStatus.INVALID;
          handoff.invalidReason = reason;
          handoff.updatedAt = new Date().toISOString();
          count++;
        }
      }
      return count;
    },

    async clear() {
      store.clear();
    },
  };
}
