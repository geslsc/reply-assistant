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

const VALID_EVENT_TYPES = new Set(Object.values(EventType));
const VALID_ACTORS = new Set(Object.values(Actor));
const VALID_RISK_LEVELS = new Set(Object.values(RiskLevel));

function defaultGroupFlags(groupId: string): GroupFlags {
  return {
    groupId,
    waitingFlag: false,
    waitingFlagSetAt: null,
    mute: false,
    muteUntil: null,
    serviceStartAt: null,
    serviceEndAt: null,
    activeIssueThreadId: null,
    serviceReactivationPending: false,
  };
}

export function createMemoryRepositories(): Repositories {
  const groups = new Map<string, GroupFlags>();
  const threads = new Map<string, IssueThread>();
  const events: EventLogEntry[] = [];
  const consultants = new Map<string, ConsultantRecord>();
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
      const record: ConsultantRecord = {
        userId,
        role: ConsultantRole.ADMIN,
        status: ConsultantStatus.ACTIVE,
        inviteCode: null,
        displayName: displayName ?? null,
        createdAt: new Date().toISOString(),
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
      const record: ConsultantRecord = {
        userId,
        role: ConsultantRole.CONSULTANT,
        status: ConsultantStatus.PENDING,
        inviteCode: inviteCode.toUpperCase(),
        displayName: displayName ?? null,
        createdAt: new Date().toISOString(),
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
      if (!record || record.status !== ConsultantStatus.PENDING) {
        return { success: false, message: '找不到 pending 顧問' };
      }
      record.status = ConsultantStatus.ACTIVE;
      return { success: true, message: '已核准' };
    },
    async disable(adminUserId, targetUserId) {
      const admin = consultants.get(adminUserId);
      if (!admin || admin.status !== ConsultantStatus.ACTIVE || admin.role !== ConsultantRole.ADMIN) {
        return { success: false, message: '只有 active admin 可停用' };
      }
      const record = consultants.get(targetUserId);
      if (!record) {
        return { success: false, message: '找不到顧問' };
      }
      record.status = ConsultantStatus.DISABLED;
      return { success: true, message: '已停用' };
    },
    async findById(userId) {
      const record = consultants.get(userId);
      return record ? { ...record } : null;
    },
    async findActive() {
      return Array.from(consultants.values()).filter(
        (c) =>
          c.status === ConsultantStatus.ACTIVE &&
          (c.role === ConsultantRole.CONSULTANT || c.role === ConsultantRole.ADMIN)
      );
    },
    async findPending() {
      return Array.from(consultants.values()).filter(
        (c) => c.status === ConsultantStatus.PENDING
      );
    },
    async findActiveAdmins() {
      return Array.from(consultants.values()).filter(
        (c) => c.status === ConsultantStatus.ACTIVE && c.role === ConsultantRole.ADMIN
      );
    },
    async clear() {
      consultants.clear();
      inviteCodes.clear();
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

  return {
    groups: groupRepo,
    threads: threadRepo,
    events: eventRepo,
    consultants: consultantRepo,
    knowledgeOverrides: overrideRepo,
    pendingHandoffs: createMemoryPendingHandoffRepository(),
  };
}
