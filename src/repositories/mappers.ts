import {
  ConsultantRecord,
  ConsultantRole,
  ConsultantStatus,
  GroupFlags,
  IssueThread,
  IssueThreadStatus,
  ThreadState,
} from '../types';
import { KnowledgeOverride } from './interfaces';

export function mapGroupRow(row: Record<string, unknown>): GroupFlags {
  return {
    groupId: String(row.group_id),
    waitingFlag: Boolean(row.waiting_flag),
    waitingFlagSetAt: row.waiting_flag_set_at
      ? new Date(String(row.waiting_flag_set_at)).toISOString()
      : null,
    mute: Boolean(row.mute),
    muteUntil: row.mute_until ? String(row.mute_until) : null,
    serviceStartAt: row.service_start_at
      ? new Date(String(row.service_start_at)).toISOString()
      : null,
    serviceEndAt: row.service_end_at
      ? new Date(String(row.service_end_at)).toISOString()
      : null,
    activeIssueThreadId: row.active_issue_thread_id
      ? String(row.active_issue_thread_id)
      : null,
    serviceReactivationPending: Boolean(row.service_reactivation_pending),
  };
}

export function mapThreadRow(row: Record<string, unknown>): IssueThread {
  const metadata = (row.metadata_json ?? {}) as Record<string, unknown>;
  return {
    issueThreadId: String(row.issue_thread_id),
    groupId: String(row.group_id),
    state: row.state as ThreadState,
    status: row.status as IssueThreadStatus,
    createdAt: new Date(String(row.created_at)).toISOString(),
    updatedAt: new Date(String(row.updated_at)).toISOString(),
    lastStateChangeAt: new Date(String(row.last_message_at)).toISOString(),
    clarifyRound: Number(row.clarify_count ?? 0),
    hasSubstantiveAnswer: Boolean(row.has_substantive_answer),
    consultantAnswered: Boolean(metadata.consultantAnswered),
    lastKnowledgeCardId: row.knowledge_card_id ? String(row.knowledge_card_id) : null,
    customerQuestion: metadata.customerQuestion ? String(metadata.customerQuestion) : null,
  };
}

export function mapConsultantRow(row: Record<string, unknown>): ConsultantRecord {
  return {
    userId: String(row.line_user_id),
    role: row.role as ConsultantRole,
    status: row.status as ConsultantStatus,
    inviteCode: row.invite_code ? String(row.invite_code) : null,
    displayName: row.display_name ? String(row.display_name) : null,
    createdAt: new Date(String(row.created_at)).toISOString(),
  };
}

export function mapOverrideRow(row: Record<string, unknown>): KnowledgeOverride {
  return {
    knowledgeCardId: String(row.knowledge_card_id),
    statusOverride: '暫停',
    reason: row.reason ? String(row.reason) : null,
    updatedBy: row.updated_by ? String(row.updated_by) : null,
    updatedAt: new Date(String(row.updated_at)).toISOString(),
  };
}

export function threadToMetadata(thread: Partial<IssueThread>): Record<string, unknown> {
  return {
    consultantAnswered: thread.consultantAnswered ?? false,
    customerQuestion: thread.customerQuestion ?? null,
  };
}
