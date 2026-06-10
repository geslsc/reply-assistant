import { v4 as uuidv4 } from 'uuid';
import {
  Actor,
  ConsultantRecord,
  ConsultantRole,
  ConsultantStatus,
  EventLogEntry,
  EventType,
  GroupFlags,
  IssueThread,
  IssueThreadStatus,
  RiskLevel,
  ThreadState,
} from '../types';
import { CreateEventParams } from '../repositories/interfaces';
import {
  ConsultantRepository,
  EventLogRepository,
  GroupRepository,
  IssueThreadRepository,
  KnowledgeOverride,
  KnowledgeOverrideRepository,
  Repositories,
} from './interfaces';
import { createMemoryPendingHandoffRepository } from './memoryPendingHandoffRepository';
import { createMemoryKnowledgeCardRepository } from './memoryKnowledgeCardRepository';
import { createMemoryPendingKnowledgeReviewRepository } from './memoryPendingKnowledgeReviewRepository';
import { createMemoryDmSessionRepository } from './memoryDmSessionRepository';
import { createMemoryConsultantApplicationRepository } from './memoryConsultantApplicationRepository';
import { createMemoryGroupConsultantAssignmentRepository } from './memoryGroupConsultantAssignmentRepository';
import { createMemoryGroupMessageBufferRepository } from './memoryGroupMessageBufferRepository';
import { createMemoryLineEventDedupRepository } from './memoryLineEventDedupRepository';

const VALID_EVENT_TYPES = new Set(Object.values(EventType));
const VALID_ACTORS = new Set(Object.values(Actor));
const VALID_RISK_LEVELS = new Set(Object.values(RiskLevel));

function defaultGroupFlags(groupId: string): GroupFlags {
  return {
    groupId,
    groupName: null,
    waitingFlag: false,
    waitingFlagSetAt: null,
    mute: false,
    muteUntil: null,
    serviceStartAt: null,
    serviceEndAt: null,
    activeIssueThreadId: null,
    serviceReactivationPending: false,
    botLeftAt: null,
    servicePeriodEndNotified: false,
  };
}

export function createMemoryRepositories(): Repositories {
  const groups = new Map<string, GroupFlags>();
  const threads = new Map<string, IssueThread>();
  const events: EventLogEntry[] = [];
  const consultants = new Map<string, ConsultantRecord>();
  const consultantExportAt = new Map<string, string>();
  const inviteCodes = new Map<string, string>();
  const overrides = new Map<string, KnowledgeOverride>();

  const groupRepo: GroupRepository = {
    async getOrCreate(groupId) {
      let flags = groups.get(groupId);
      if (!flags) {
        flags = defaultGroupFlags(groupId);
        groups.set(groupId, flags);
      }
      return { ...flags };
    },
    async update(groupId, patch) {
      const flags = await groupRepo.getOrCreate(groupId);
      Object.assign(flags, patch);
      groups.set(groupId, flags);
      return { ...flags };
    },
    async findAll() {
      return Array.from(groups.values()).map((g) => ({ ...g }));
    },
    async clear() {
      groups.clear();
    },
  };

  const threadKey = (groupId: string, issueThreadId: string): string =>
    `${groupId}:${issueThreadId}`;

  const threadRepo: IssueThreadRepository = {
    async create(groupId, customerQuestion) {
      const now = new Date().toISOString();
      const thread: IssueThread = {
        issueThreadId: uuidv4(),
        groupId,
        state: ThreadState.IDLE,
        status: IssueThreadStatus.ACTIVE,
        createdAt: now,
        updatedAt: now,
        lastStateChangeAt: now,
        clarifyRound: 0,
        hasSubstantiveAnswer: false,
        consultantAnswered: false,
        lastKnowledgeCardId: null,
        customerQuestion: customerQuestion ?? null,
      };
      threads.set(threadKey(groupId, thread.issueThreadId), thread);
      await groupRepo.update(groupId, { activeIssueThreadId: thread.issueThreadId });
      return { ...thread };
    },
    async findById(groupId, issueThreadId) {
      const thread = threads.get(threadKey(groupId, issueThreadId));
      return thread ? { ...thread } : null;
    },
    async findActiveByGroup(groupId) {
      const flags = await groupRepo.getOrCreate(groupId);
      if (!flags.activeIssueThreadId) {
        return null;
      }
      return this.findById(groupId, flags.activeIssueThreadId);
    },
    async findByGroup(groupId) {
      return Array.from(threads.values())
        .filter((t) => t.groupId === groupId)
        .map((t) => ({ ...t }));
    },
    async update(groupId, issueThreadId, patch) {
      const thread = threads.get(threadKey(groupId, issueThreadId));
      if (!thread) {
        return null;
      }
      Object.assign(thread, patch, { updatedAt: new Date().toISOString() });
      return { ...thread };
    },
    async clear() {
      threads.clear();
    },
  };

  const eventRepo: EventLogRepository = {
    async create(params) {
      if (!VALID_EVENT_TYPES.has(params.event_type)) {
        throw new Error(`Invalid event_type: ${params.event_type}`);
      }
      if (params.actor && !VALID_ACTORS.has(params.actor)) {
        throw new Error(`Invalid actor: ${params.actor}`);
      }
      if (params.risk_level && !VALID_RISK_LEVELS.has(params.risk_level)) {
        throw new Error(`Invalid risk_level: ${params.risk_level}`);
      }
      const entry: EventLogEntry = {
        event_id: uuidv4(),
        timestamp: params.timestamp ?? new Date().toISOString(),
        event_type: params.event_type,
        group_id: params.group_id ?? null,
        issue_thread_id: params.issue_thread_id ?? null,
        actor: params.actor ?? Actor.SYSTEM,
        actor_user_id: params.actor_user_id ?? null,
        risk_level: params.risk_level ?? null,
        from_state: params.from_state ?? null,
        to_state: params.to_state ?? null,
        knowledge_card_id: params.knowledge_card_id ?? null,
        detail: params.detail ?? null,
        service_day: params.service_day ?? null,
      };
      events.push(entry);
      return { ...entry };
    },
    async findAll() {
      return [...events];
    },
    async findByGroup(groupId) {
      return events.filter((e) => e.group_id === groupId);
    },
    async findByType(eventType) {
      return events.filter((e) => e.event_type === eventType);
    },
    async clear() {
      events.length = 0;
    },
  };

  const consultantRepo: ConsultantRepository = {
    async upsertAdmin(userId, displayName) {
      const now = new Date().toISOString();
      const record: ConsultantRecord = {
        userId,
        role: ConsultantRole.ADMIN,
        status: ConsultantStatus.ACTIVE,
        inviteCode: null,
        displayName: displayName ?? null,
        consultantCode: null,
        createdAt: now,
        updatedAt: now,
        approvedBy: null,
        approvedAt: null,
        disabledBy: null,
        disabledAt: null,
      };
      consultants.set(userId, record);
      return { ...record };
    },
    async registerInviteCode(code, createdByAdminId) {
      inviteCodes.set(code.toUpperCase(), createdByAdminId);
    },
    async isValidInviteCode(code) {
      return inviteCodes.has(code.toUpperCase());
    },
    async requestJoin(userId, inviteCode, displayName) {
      const now = new Date().toISOString();
      const record: ConsultantRecord = {
        userId,
        role: ConsultantRole.CONSULTANT,
        status: ConsultantStatus.DISABLED,
        inviteCode: inviteCode.toUpperCase(),
        displayName: displayName ?? null,
        consultantCode: null,
        createdAt: now,
        updatedAt: now,
        approvedBy: null,
        approvedAt: null,
        disabledBy: null,
        disabledAt: null,
      };
      consultants.set(userId, record);
      return { ...record };
    },
    async approve(adminUserId, targetUserId) {
      const admin = consultants.get(adminUserId);
      if (!admin || admin.status !== ConsultantStatus.ACTIVE || admin.role !== ConsultantRole.ADMIN) {
        return { success: false, message: '只有 active admin 可核准' };
      }
      const record = consultants.get(targetUserId);
      if (!record) {
        return { success: false, message: '找不到顧問' };
      }
      const now = new Date().toISOString();
      record.status = ConsultantStatus.ACTIVE;
      record.approvedBy = adminUserId;
      record.approvedAt = now;
      record.updatedAt = now;
      if (!record.consultantCode) {
        record.consultantCode = `C-legacy-${targetUserId.slice(-4)}`;
      }
      return { success: true, message: '已核准' };
    },
    async disable(adminUserId, targetUserId, disabledBy) {
      const admin = consultants.get(adminUserId);
      if (!admin || admin.status !== ConsultantStatus.ACTIVE || admin.role !== ConsultantRole.ADMIN) {
        return { success: false, message: '只有 active admin 可停用' };
      }
      const record = consultants.get(targetUserId);
      if (!record) {
        return { success: false, message: '找不到顧問' };
      }
      const now = new Date().toISOString();
      record.status = ConsultantStatus.DISABLED;
      record.disabledBy = disabledBy ?? adminUserId;
      record.disabledAt = now;
      record.updatedAt = now;
      return { success: true, message: '已停用' };
    },
    async enable(adminUserId, targetUserId) {
      const admin = consultants.get(adminUserId);
      if (!admin || admin.status !== ConsultantStatus.ACTIVE || admin.role !== ConsultantRole.ADMIN) {
        return { success: false, message: '只有 active admin 可啟用' };
      }
      const record = consultants.get(targetUserId);
      if (!record) {
        return { success: false, message: '找不到顧問' };
      }
      const now = new Date().toISOString();
      record.status = ConsultantStatus.ACTIVE;
      record.disabledBy = null;
      record.disabledAt = null;
      record.updatedAt = now;
      return { success: true, message: '已啟用' };
    },
    async upsertApprovedConsultant(params) {
      const existing = consultants.get(params.userId);
      const now = params.approvedAt;
      const record: ConsultantRecord = {
        userId: params.userId,
        role: ConsultantRole.CONSULTANT,
        status: ConsultantStatus.ACTIVE,
        inviteCode: existing?.inviteCode ?? null,
        displayName: params.displayName,
        consultantCode: params.consultantCode,
        createdAt: existing?.createdAt ?? now,
        updatedAt: now,
        approvedBy: params.approvedBy,
        approvedAt: params.approvedAt,
        disabledBy: null,
        disabledAt: null,
        pushFailureCount: existing?.pushFailureCount ?? 0,
        lastPushFailedAt: existing?.lastPushFailedAt ?? null,
        lastPushSucceededAt: existing?.lastPushSucceededAt ?? null,
      };
      consultants.set(params.userId, record);
      return { ...record };
    },
    async findById(userId) {
      const record = consultants.get(userId);
      return record ? { ...record } : null;
    },
    async findByConsultantCode(consultantCode) {
      const record = Array.from(consultants.values()).find(
        (item) => item.consultantCode === consultantCode
      );
      return record ? { ...record } : null;
    },
    async findAll() {
      return Array.from(consultants.values()).map((item) => ({ ...item }));
    },
    async findActive() {
      return Array.from(consultants.values()).filter(
        (c) =>
          c.status === ConsultantStatus.ACTIVE &&
          (c.role === ConsultantRole.CONSULTANT || c.role === ConsultantRole.ADMIN)
      );
    },
    async findPending() {
      return [];
    },
    async findActiveAdmins() {
      return Array.from(consultants.values()).filter(
        (c) => c.status === ConsultantStatus.ACTIVE && c.role === ConsultantRole.ADMIN
      );
    },
    async recordPushSuccess(userId, succeededAt) {
      const record = consultants.get(userId);
      if (record) {
        record.pushFailureCount = 0;
        record.lastPushSucceededAt = succeededAt;
        record.updatedAt = succeededAt;
      }
    },
    async recordPushFailure(userId, failedAt) {
      const record = consultants.get(userId);
      if (record) {
        record.pushFailureCount = (record.pushFailureCount ?? 0) + 1;
        record.lastPushFailedAt = failedAt;
        record.updatedAt = failedAt;
      }
    },
    async setLastKnowledgeExportAt(userId, exportedAt) {
      consultantExportAt.set(userId, exportedAt);
      const record = consultants.get(userId);
      if (record) {
        record.lastKnowledgeExportAt = exportedAt;
      }
    },
    async getLastKnowledgeExportAt(userId) {
      return consultantExportAt.get(userId) ?? consultants.get(userId)?.lastKnowledgeExportAt ?? null;
    },
    async clear() {
      consultants.clear();
      inviteCodes.clear();
      consultantExportAt.clear();
    },
  };

  const overrideRepo: KnowledgeOverrideRepository = {
    async setPaused(cardId, updatedBy, reason) {
      const entry: KnowledgeOverride = {
        knowledgeCardId: cardId,
        statusOverride: '暫停',
        reason: reason ?? null,
        updatedBy,
        updatedAt: new Date().toISOString(),
      };
      overrides.set(cardId, entry);
      return { ...entry };
    },
    async findByCardId(cardId) {
      const entry = overrides.get(cardId);
      return entry ? { ...entry } : null;
    },
    async findAll() {
      return Array.from(overrides.values()).map((o) => ({ ...o }));
    },
    async clear() {
      overrides.clear();
    },
  };

  const pendingKnowledgeReviews = createMemoryPendingKnowledgeReviewRepository();
  const dmSessions = createMemoryDmSessionRepository(async (params) => {
    await pendingKnowledgeReviews.insert({
      reviewId: params.reviewId,
      cardData: params.cardData,
      submittedBy: params.submittedBy,
      submittedAt: params.submittedAt,
    });
  });

  return {
    groups: groupRepo,
    threads: threadRepo,
    events: eventRepo,
    consultants: consultantRepo,
    knowledgeOverrides: overrideRepo,
    knowledgeCards: createMemoryKnowledgeCardRepository(),
    pendingHandoffs: createMemoryPendingHandoffRepository(),
    pendingKnowledgeReviews,
    dmSessions,
    groupMessageBuffers: createMemoryGroupMessageBufferRepository(),
    consultantApplications: createMemoryConsultantApplicationRepository(),
    groupConsultantAssignments: createMemoryGroupConsultantAssignmentRepository(),
    lineEventDedup: createMemoryLineEventDedupRepository(),
  };
}
