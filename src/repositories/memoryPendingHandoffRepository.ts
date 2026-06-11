import { v4 as uuidv4 } from 'uuid';
import {
  ACTIONABLE_HANDOFF_STATUSES,
  CreatePendingHandoffParams,
  PendingHandoff,
  PendingHandoffInvalidReason,
  PendingHandoffRepository,
  PendingHandoffStatus,
  UpdateHandoffStatusParams,
} from './pendingHandoffTypes';

function isActionable(status: PendingHandoffStatus): boolean {
  return ACTIONABLE_HANDOFF_STATUSES.includes(status as (typeof ACTIONABLE_HANDOFF_STATUSES)[number]);
}

function applyStatusUpdate(
  handoff: PendingHandoff,
  params: UpdateHandoffStatusParams
): PendingHandoff {
  const now = new Date().toISOString();
  handoff.status = params.status;
  handoff.statusUpdatedBy = params.updatedBy;
  handoff.statusUpdatedAt = now;
  handoff.updatedAt = now;
  if (params.status === PendingHandoffStatus.IGNORED) {
    handoff.reason = params.reason ?? null;
  } else {
    handoff.reason = null;
  }
  if (params.status === PendingHandoffStatus.RESOLVED) {
    handoff.closedAt = now;
  }
  return handoff;
}

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
        status: PendingHandoffStatus.PENDING,
        statusUpdatedBy: 'system',
        statusUpdatedAt: now,
        reason: null,
        customerQuestion: params.customerQuestion,
        snoozed: false,
        acknowledgedAt: null,
        createdAt: now,
        updatedAt: now,
        closedAt: null,
      };
      store.set(handoff.id, handoff);
      return { ...handoff };
    },

    async findActionableByConsultant(consultantId) {
      return Array.from(store.values())
        .filter((h) => h.consultantId === consultantId && isActionable(h.status))
        .map((h) => ({ ...h }));
    },

    async findOpenByConsultant(consultantId) {
      return this.findActionableByConsultant(consultantId);
    },

    async findActionableByConsultantAndShortCode(consultantId, shortCode) {
      const handoff = Array.from(store.values()).find(
        (h) =>
          h.consultantId === consultantId &&
          h.shortCode === shortCode &&
          isActionable(h.status)
      );
      return handoff ? { ...handoff } : null;
    },

    async findOpenByConsultantAndShortCode(consultantId, shortCode) {
      return this.findActionableByConsultantAndShortCode(consultantId, shortCode);
    },

    async findByConsultant(consultantId) {
      return Array.from(store.values())
        .filter((h) => h.consultantId === consultantId)
        .map((h) => ({ ...h }));
    },

    async findById(id) {
      const handoff = store.get(id);
      return handoff ? { ...handoff } : null;
    },

    async findActionableByGroup(groupId) {
      return Array.from(store.values())
        .filter((h) => h.groupId === groupId && isActionable(h.status))
        .map((h) => ({ ...h }));
    },

    async findActionableByThread(groupId, issueThreadId) {
      return Array.from(store.values())
        .filter(
          (h) =>
            h.groupId === groupId &&
            h.issueThreadId === issueThreadId &&
            isActionable(h.status)
        )
        .map((h) => ({ ...h }));
    },

    async updateStatus(params) {
      const handoff = store.get(params.id);
      if (!handoff) {
        return null;
      }
      applyStatusUpdate(handoff, params);
      return { ...handoff };
    },

    async markClosed(id) {
      return this.updateStatus({
        id,
        status: PendingHandoffStatus.RESOLVED,
        updatedBy: 'system',
      });
    },

    async markInvalid(id, reason) {
      return this.updateStatus({
        id,
        status: PendingHandoffStatus.IGNORED,
        updatedBy: 'system',
        reason,
      });
    },

    async markInvalidByGroup(groupId, reason) {
      let count = 0;
      for (const handoff of store.values()) {
        if (handoff.groupId === groupId && isActionable(handoff.status)) {
          applyStatusUpdate(handoff, {
            id: handoff.id,
            status: PendingHandoffStatus.IGNORED,
            updatedBy: 'system',
            reason,
          });
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
          isActionable(handoff.status)
        ) {
          applyStatusUpdate(handoff, {
            id: handoff.id,
            status: PendingHandoffStatus.IGNORED,
            updatedBy: 'system',
            reason,
          });
          count++;
        }
      }
      return count;
    },

    async markSnoozed(id) {
      const handoff = store.get(id);
      if (!handoff || !isActionable(handoff.status)) {
        return null;
      }
      const now = new Date().toISOString();
      handoff.snoozed = true;
      handoff.acknowledgedAt = now;
      handoff.status = PendingHandoffStatus.IN_PROGRESS;
      handoff.statusUpdatedBy = handoff.consultantId;
      handoff.statusUpdatedAt = now;
      handoff.updatedAt = now;
      return { ...handoff };
    },

    async findActionableByConsultantAndGroup(consultantId, groupId) {
      return Array.from(store.values())
        .filter(
          (h) =>
            h.consultantId === consultantId &&
            h.groupId === groupId &&
            isActionable(h.status)
        )
        .map((h) => ({ ...h }));
    },

    async findOpenByConsultantAndGroup(consultantId, groupId) {
      return this.findActionableByConsultantAndGroup(consultantId, groupId);
    },

    async transferActionableHandoffs({ fromConsultantId, toConsultantId, groupId }) {
      let count = 0;
      const now = new Date().toISOString();
      for (const handoff of store.values()) {
        if (
          handoff.consultantId === fromConsultantId &&
          handoff.groupId === groupId &&
          isActionable(handoff.status)
        ) {
          handoff.consultantId = toConsultantId;
          handoff.updatedAt = now;
          count++;
        }
      }
      return count;
    },

    async transferOpenHandoffs(params) {
      return this.transferActionableHandoffs(params);
    },

    async clear() {
      store.clear();
    },
  };
}
