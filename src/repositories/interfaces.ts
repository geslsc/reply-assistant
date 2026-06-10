import {
  Actor,
  ConsultantRecord,
  EventLogEntry,
  EventType,
  GroupFlags,
  IssueThread,
  RiskLevel,
  ThreadState,
} from '../types';
import { ConsultantApplicationRepository } from './consultantApplicationTypes';

export interface CreateEventParams {
  event_type: EventType;
  group_id?: string | null;
  issue_thread_id?: string | null;
  actor?: Actor;
  actor_user_id?: string | null;
  risk_level?: RiskLevel | null;
  from_state?: ThreadState | null;
  to_state?: ThreadState | null;
  knowledge_card_id?: string | null;
  detail?: string | null;
  service_day?: number | null;
  timestamp?: string;
}

export interface KnowledgeOverride {
  knowledgeCardId: string;
  statusOverride: '暫停';
  reason: string | null;
  updatedBy: string | null;
  updatedAt: string;
}

export interface GroupRepository {
  getOrCreate(groupId: string): Promise<GroupFlags>;
  update(groupId: string, patch: Partial<Omit<GroupFlags, 'groupId'>>): Promise<GroupFlags>;
  findAll(): Promise<GroupFlags[]>;
  clear(): Promise<void>;
}

export interface IssueThreadRepository {
  create(groupId: string, customerQuestion?: string): Promise<IssueThread>;
  findById(groupId: string, issueThreadId: string): Promise<IssueThread | null>;
  findActiveByGroup(groupId: string): Promise<IssueThread | null>;
  findByGroup(groupId: string): Promise<IssueThread[]>;
  update(
    groupId: string,
    issueThreadId: string,
    patch: Partial<IssueThread>
  ): Promise<IssueThread | null>;
  clear(): Promise<void>;
}

export interface EventLogRepository {
  create(params: CreateEventParams): Promise<EventLogEntry>;
  findAll(): Promise<EventLogEntry[]>;
  findByGroup(groupId: string): Promise<EventLogEntry[]>;
  findByType(eventType: string): Promise<EventLogEntry[]>;
  clear(): Promise<void>;
}

export interface ConsultantRepository {
  upsertAdmin(userId: string, displayName?: string | null): Promise<ConsultantRecord>;
  registerInviteCode(code: string, createdByAdminId: string): Promise<void>;
  isValidInviteCode(code: string): Promise<boolean>;
  requestJoin(userId: string, inviteCode: string, displayName?: string | null): Promise<ConsultantRecord>;
  approve(adminUserId: string, targetUserId: string): Promise<{ success: boolean; message: string }>;
  disable(
    adminUserId: string,
    targetUserId: string,
    disabledBy?: string
  ): Promise<{ success: boolean; message: string }>;
  enable(adminUserId: string, targetUserId: string): Promise<{ success: boolean; message: string }>;
  upsertApprovedConsultant(params: {
    userId: string;
    displayName: string | null;
    consultantCode: string;
    approvedBy: string;
    approvedAt: string;
  }): Promise<ConsultantRecord>;
  findById(userId: string): Promise<ConsultantRecord | null>;
  findByConsultantCode(consultantCode: string): Promise<ConsultantRecord | null>;
  findAll(): Promise<ConsultantRecord[]>;
  findActive(): Promise<ConsultantRecord[]>;
  findPending(): Promise<ConsultantRecord[]>;
  findActiveAdmins(): Promise<ConsultantRecord[]>;
  setLastKnowledgeExportAt(userId: string, exportedAt: string): Promise<void>;
  getLastKnowledgeExportAt(userId: string): Promise<string | null>;
  clear(): Promise<void>;
}

export interface KnowledgeOverrideRepository {
  setPaused(cardId: string, updatedBy: string, reason?: string): Promise<KnowledgeOverride>;
  findByCardId(cardId: string): Promise<KnowledgeOverride | null>;
  findAll(): Promise<KnowledgeOverride[]>;
  clear(): Promise<void>;
}

export interface LineEventDedupRepository {
  claim(eventId: string, processedAt: string): Promise<boolean>;
  clear(): Promise<void>;
}

export interface Repositories {
  groups: GroupRepository;
  threads: IssueThreadRepository;
  events: EventLogRepository;
  consultants: ConsultantRepository;
  knowledgeOverrides: KnowledgeOverrideRepository;
  knowledgeCards: import('./knowledgeCardTypes').KnowledgeCardRepository;
  pendingHandoffs: import('./pendingHandoffTypes').PendingHandoffRepository;
  pendingKnowledgeReviews: import('./pendingKnowledgeReviewTypes').PendingKnowledgeReviewRepository;
  dmSessions: import('./dmSessionTypes').DmSessionRepository;
  groupMessageBuffers: import('./groupMessageBufferTypes').GroupMessageBufferRepository;
  consultantApplications: ConsultantApplicationRepository;
  groupConsultantAssignments: import('./groupConsultantAssignmentTypes').GroupConsultantAssignmentRepository;
  lineEventDedup: LineEventDedupRepository;
}
