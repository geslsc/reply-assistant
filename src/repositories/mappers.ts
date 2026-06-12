import {
  ConvergenceStateRef,
  ConsultantRecord,
  ConsultantRole,
  ConsultantStatus,
  GroupFlags,
  GroupMetadata,
  IssueThread,
  IssueThreadStatus,
  ThreadState,
} from '../types';
import { KnowledgeOverride } from './interfaces';

export function mapGroupRow(row: Record<string, unknown>): GroupFlags {
  return {
    groupId: String(row.group_id),
    groupName: row.group_name ? String(row.group_name) : null,
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
    botLeftAt: row.bot_left_at
      ? new Date(String(row.bot_left_at)).toISOString()
      : null,
    servicePeriodEndNotified: Boolean(row.service_period_end_notified),
    metadataJson: parseGroupMetadata(row.metadata_json),
  };
}

function parseGroupMetadata(raw: unknown): GroupMetadata | null {
  if (raw == null) {
    return null;
  }
  if (typeof raw !== 'object' || Array.isArray(raw)) {
    return {};
  }
  return { ...(raw as Record<string, unknown>) };
}

export function groupMetadataToJson(metadata: GroupMetadata | null | undefined): Record<string, unknown> {
  if (!metadata) {
    return {};
  }
  return { ...metadata };
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
    autoReplyBlocked: Boolean(metadata.autoReplyBlocked),
    convergenceState: parseConvergenceState(metadata.convergenceState),
    pureChitchatCount:
      typeof metadata.pureChitchatCount === 'number' ? metadata.pureChitchatCount : 0,
  };
}

function parseConvergenceState(raw: unknown): ConvergenceStateRef | null {
  if (!raw || typeof raw !== 'object') {
    return null;
  }
  const obj = raw as Record<string, unknown>;
  const candidateCardIds = Array.isArray(obj.candidateCardIds)
    ? obj.candidateCardIds.filter((id): id is string => typeof id === 'string')
    : [];
  const parseOptions = (value: unknown) => {
    if (!Array.isArray(value)) {
      return undefined;
    }
    return value
      .map((item) => {
        if (!item || typeof item !== 'object') {
          return null;
        }
        const option = item as Record<string, unknown>;
        if (typeof option.cardId !== 'string' || typeof option.label !== 'string') {
          return null;
        }
        return {
          index: Number(option.index),
          cardId: option.cardId,
          label: option.label,
        };
      })
      .filter(
        (
          item
        ): item is { index: number; cardId: string; label: string } => Boolean(item)
      );
  };
  return {
    candidateCardIds,
    round2Options: parseOptions(obj.round2Options),
    round3Options: parseOptions(obj.round3Options),
  };
}

export function mapConsultantRow(row: Record<string, unknown>): ConsultantRecord {
  return {
    userId: String(row.line_user_id),
    role: row.role as ConsultantRole,
    status: row.status as ConsultantStatus,
    inviteCode: row.invite_code ? String(row.invite_code) : null,
    displayName: row.display_name ? String(row.display_name) : null,
    consultantCode: row.consultant_code ? String(row.consultant_code) : null,
    createdAt: new Date(String(row.created_at)).toISOString(),
    updatedAt: row.updated_at ? new Date(String(row.updated_at)).toISOString() : null,
    approvedBy: row.approved_by ? String(row.approved_by) : null,
    approvedAt: row.approved_at
      ? new Date(String(row.approved_at)).toISOString()
      : null,
    disabledBy: row.disabled_by ? String(row.disabled_by) : null,
    disabledAt: row.disabled_at
      ? new Date(String(row.disabled_at)).toISOString()
      : null,
    lastKnowledgeExportAt: row.last_knowledge_export_at
      ? new Date(String(row.last_knowledge_export_at)).toISOString()
      : null,
    pushFailureCount: Number(row.push_failure_count ?? 0),
    lastPushFailedAt: row.last_push_failed_at
      ? new Date(String(row.last_push_failed_at)).toISOString()
      : null,
    lastPushSucceededAt: row.last_push_succeeded_at
      ? new Date(String(row.last_push_succeeded_at)).toISOString()
      : null,
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
    autoReplyBlocked: thread.autoReplyBlocked ?? false,
    convergenceState: thread.convergenceState ?? null,
    pureChitchatCount: thread.pureChitchatCount ?? 0,
  };
}
