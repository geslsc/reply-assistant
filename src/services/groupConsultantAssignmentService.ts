import { BotReply, ConsultantRecord, ConsultantStatus } from '../types';
import { getRepos } from '../repositories';
import { GroupConsultantAssignmentRecord } from '../repositories/groupConsultantAssignmentTypes';
import { allocateGroupCode } from './groupCodeService';
import { fetchLineGroupName } from './lineGroupSummaryService';
import { logConsultantManagementEvent } from './consultantEventLogService';
import {
  getActiveAdmins,
  isActiveAdmin,
} from './consultantWhitelist';
import {
  normalizeGroupAssistantCommand,
} from './groupAssistantCommandService';
import { updateGroupFlags } from './groupFlags';

export function formatAssignmentGroupLabel(assignment: GroupConsultantAssignmentRecord): string {
  if (assignment.groupName) {
    return assignment.groupName;
  }
  return `尚未取得群組名稱（groupId: ${assignment.groupId}）`;
}

export function isValidGroupAssistantCommand(text: string): boolean {
  return normalizeGroupAssistantCommand(text) !== null;
}

export async function isActiveAssignee(userId: string | null): Promise<boolean> {
  if (!userId) {
    return false;
  }
  const record = await getRepos().consultants.findById(userId);
  return !!record && record.status === ConsultantStatus.ACTIVE;
}

export async function getFallbackAdminUserId(): Promise<string | null> {
  const admins = await getActiveAdmins();
  return admins[0]?.userId ?? null;
}

async function resolveGroupName(groupId: string): Promise<string | null> {
  const lineName = await fetchLineGroupName(groupId);
  if (lineName) {
    await updateGroupFlags(groupId, { groupName: lineName });
    return lineName;
  }
  return null;
}

async function hydrateMissingGroupName(
  assignment: GroupConsultantAssignmentRecord
): Promise<GroupConsultantAssignmentRecord> {
  if (assignment.groupName) {
    return assignment;
  }

  const groupName = await resolveGroupName(assignment.groupId);
  if (!groupName) {
    return assignment;
  }

  const updated = await getRepos().groupConsultantAssignments.update(assignment.groupId, {
    groupName,
    updatedBy: 'system',
  });
  return updated ?? assignment;
}

/** 新群組偵測：若 group_id 不存在則建立 assignment 記錄 */
export async function ensureGroupAssignment(
  groupId: string,
  options?: { reactivateIfLeft?: boolean }
): Promise<GroupConsultantAssignmentRecord> {
  const existing = await getRepos().groupConsultantAssignments.findByGroupId(groupId);
  if (existing) {
    if (options?.reactivateIfLeft && existing.status === 'left') {
      const updated = await getRepos().groupConsultantAssignments.update(groupId, {
        status: 'active',
        updatedBy: 'system',
      });
      if (updated) {
        return hydrateMissingGroupName(updated);
      }
    }
    return hydrateMissingGroupName(existing);
  }

  const groupCode = await allocateGroupCode();
  const groupName = await resolveGroupName(groupId);
  const created = await getRepos().groupConsultantAssignments.create({
    groupId,
    groupCode,
    groupName,
    updatedBy: 'system',
  });

  await logConsultantManagementEvent({
    action: 'new_group_detected',
    actorUserId: 'system',
    payload: {
      group_id: groupId,
      group_code: groupCode,
      group_name: formatAssignmentGroupLabel(created),
    },
  });

  return created;
}

export async function updateLastConsultantActionAt(groupId: string): Promise<void> {
  const now = new Date().toISOString();
  await getRepos().groupConsultantAssignments.update(groupId, {
    lastConsultantActionAt: now,
    updatedBy: 'system',
  });
}

export async function updateLastCustomerMessageAt(groupId: string): Promise<void> {
  await ensureGroupAssignment(groupId);
  const now = new Date().toISOString();
  await getRepos().groupConsultantAssignments.update(groupId, {
    lastCustomerMessageAt: now,
    updatedBy: 'system',
  });
}

function formatConsultantLabel(record: ConsultantRecord): string {
  const name = record.displayName ?? '（無名稱）';
  const code = record.consultantCode ?? '（無短碼）';
  return `${name}（${code}）`;
}

async function buildAutoBindAdminNotifications(params: {
  assignment: GroupConsultantAssignmentRecord;
  binder: ConsultantRecord;
  binderIsAdmin: boolean;
}): Promise<BotReply[]> {
  const groupLabel = `${formatAssignmentGroupLabel(params.assignment)}（${params.assignment.groupCode}）`;
  const replies: BotReply[] = [];
  const admins = await getActiveAdmins();

  for (const admin of admins) {
    let text: string;
    if (params.binderIsAdmin && admin.userId === params.binder.userId) {
      text = `已將您自動綁定為 ${groupLabel} 的主負責顧問。`;
    } else if (params.binderIsAdmin) {
      text = `已將 ${formatConsultantLabel(params.binder)} 自動綁定為 ${groupLabel} 的主負責顧問。`;
    } else {
      text = `已將 ${formatConsultantLabel(params.binder)} 自動綁定為 ${groupLabel} 的主負責顧問。`;
    }
    replies.push({ type: 'push', userId: admin.userId, text });
  }

  return replies;
}

async function autoBindPrimaryConsultant(
  groupId: string,
  userId: string,
  assignment: GroupConsultantAssignmentRecord
): Promise<BotReply[]> {
  const binder = await getRepos().consultants.findById(userId);
  if (!binder || binder.status !== ConsultantStatus.ACTIVE) {
    return [];
  }

  const updated = await getRepos().groupConsultantAssignments.update(groupId, {
    primaryConsultantUserId: userId,
    updatedBy: 'system',
  });
  if (!updated) {
    return [];
  }

  const binderIsAdmin = binder.role === 'admin';
  await logConsultantManagementEvent({
    action: 'auto_bind_primary',
    actorUserId: userId,
    payload: {
      group_id: groupId,
      group_code: updated.groupCode,
      consultant_code: binder.consultantCode,
      consultant_user_id: userId,
      is_admin: binderIsAdmin,
    },
  });

  return buildAutoBindAdminNotifications({
    assignment: updated,
    binder,
    binderIsAdmin,
  });
}

async function notifySecondConsultantDetected(
  groupId: string,
  newUserId: string,
  assignment: GroupConsultantAssignmentRecord,
  existingPrimaryId: string
): Promise<BotReply[]> {
  const primary = await getRepos().consultants.findById(existingPrimaryId);
  const newcomer = await getRepos().consultants.findById(newUserId);
  if (!primary || !newcomer) {
    return [];
  }

  const groupLabel = `${formatAssignmentGroupLabel(assignment)}（${assignment.groupCode}）`;
  const text = `偵測到群組 ${groupLabel} 已有主負責顧問 ${formatConsultantLabel(primary)}，但顧問 ${formatConsultantLabel(newcomer)} 也在該群使用顧問指令。如需調整，請指派主負責/副手。`;

  await logConsultantManagementEvent({
    action: 'second_consultant_detected',
    actorUserId: newUserId,
    payload: {
      group_id: groupId,
      group_code: assignment.groupCode,
      existing_primary: existingPrimaryId,
      new_consultant: newUserId,
    },
  });

  const replies: BotReply[] = [];
  for (const admin of await getActiveAdmins()) {
    replies.push({ type: 'push', userId: admin.userId, text });
  }
  return replies;
}

/** 顧問 / admin 使用「小助手」有效語法時的綁定與偵測副作用 */
export async function handleGroupConsultantSideEffects(params: {
  groupId: string;
  userId: string;
  text: string;
}): Promise<BotReply[]> {
  if (!isValidGroupAssistantCommand(params.text)) {
    return [];
  }

  const assignment = await ensureGroupAssignment(params.groupId);
  await updateLastConsultantActionAt(params.groupId);

  const primary = assignment.primaryConsultantUserId;
  if (!primary) {
    return autoBindPrimaryConsultant(params.groupId, params.userId, assignment);
  }

  if (primary === params.userId) {
    return [];
  }

  return notifySecondConsultantDetected(
    params.groupId,
    params.userId,
    assignment,
    primary
  );
}

export async function markGroupAssignmentLeft(groupId: string): Promise<void> {
  const existing = await getRepos().groupConsultantAssignments.findByGroupId(groupId);
  if (!existing) {
    return;
  }
  await getRepos().groupConsultantAssignments.update(groupId, {
    status: 'left',
    updatedBy: 'system',
  });
}

export async function resolveConsultantByCodeOrUserId(
  identifier: string
): Promise<ConsultantRecord | null> {
  const trimmed = identifier.trim();
  if (trimmed.startsWith('C-')) {
    return (await getRepos().consultants.findByConsultantCode(trimmed)) ?? null;
  }
  return (await getRepos().consultants.findById(trimmed)) ?? null;
}

export async function validateActiveAssignee(
  record: ConsultantRecord | null
): Promise<{ ok: boolean; message?: string }> {
  if (!record) {
    return { ok: false, message: '找不到顧問。' };
  }
  if (record.status !== ConsultantStatus.ACTIVE) {
    return { ok: false, message: '只能指派 active 顧問或 admin。' };
  }
  return { ok: true };
}

export async function formatConsultantAssignmentDisplay(
  userId: string | null
): Promise<string> {
  if (!userId) {
    return '未設定';
  }
  const record = await getRepos().consultants.findById(userId);
  if (!record) {
    return `未設定（${userId}）`;
  }
  return [
    record.displayName ?? '（無名稱）',
    record.consultantCode ?? '（無短碼）',
    userId,
    record.status,
  ].join('｜');
}

export async function isAdminOnlyGroupListCommand(text: string): Promise<boolean> {
  return text.trim() === '群組清單';
}
