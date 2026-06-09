import { BotReply, ConsultantRecord, ConsultantRole, ConsultantStatus } from '../types';
import { getRepos } from '../repositories';
import {
  getActiveAdmins,
  isActiveAdmin,
} from './consultantWhitelist';
import { runConsultantDisableCleanup } from './consultantDisableCleanupService';
import { logConsultantManagementEvent } from './consultantEventLogService';
import {
  approveApplicationByCode,
  rejectApplicationByCode,
} from './consultantApplicationService';

const APPROVE_PATTERN = /^核准\s+(C-[\w-]+)$/u;
const REJECT_PATTERN = /^拒絕\s+(C-[\w-]+)$/u;
const DISABLE_PATTERN = /^停用\s+(.+)$/u;
const ENABLE_PATTERN = /^啟用\s+(.+)$/u;

export async function resolveConsultantTarget(identifier: string): Promise<ConsultantRecord | null> {
  const trimmed = identifier.trim();
  if (trimmed.startsWith('C-')) {
    return (await getRepos().consultants.findByConsultantCode(trimmed)) ?? null;
  }
  return (await getRepos().consultants.findById(trimmed)) ?? null;
}

export async function handleConsultantManagementCommand(
  adminUserId: string,
  text: string
): Promise<BotReply[] | null> {
  if (!(await isActiveAdmin(adminUserId))) {
    return null;
  }

  const trimmed = text.trim();
  if (trimmed === '顧問名單') {
    return listConsultants(adminUserId);
  }
  if (trimmed === '查詢待審顧問') {
    return listPendingApplications(adminUserId);
  }

  const disableMatch = trimmed.match(DISABLE_PATTERN);
  if (disableMatch) {
    return disableConsultantByIdentifier(adminUserId, disableMatch[1]);
  }

  const enableMatch = trimmed.match(ENABLE_PATTERN);
  if (enableMatch) {
    return enableConsultantByIdentifier(adminUserId, enableMatch[1]);
  }

  const approveMatch = trimmed.match(APPROVE_PATTERN);
  if (approveMatch) {
    return approveApplicationByCode(adminUserId, approveMatch[1]);
  }

  const rejectMatch = trimmed.match(REJECT_PATTERN);
  if (rejectMatch) {
    return rejectApplicationByCode(adminUserId, rejectMatch[1]);
  }

  return null;
}

async function listConsultants(adminUserId: string): Promise<BotReply[]> {
  const consultants = await getRepos().consultants.findAll();
  if (consultants.length === 0) {
    return [{ type: 'push', userId: adminUserId, text: '目前沒有顧問資料。' }];
  }
  const lines = consultants.map((item) => {
    const code = item.consultantCode ?? '（無短碼）';
    const approved = item.approvedAt?.slice(0, 10) ?? item.createdAt.slice(0, 10);
    const updated = item.updatedAt?.slice(0, 10) ?? approved;
    return [
      `${code}｜${item.displayName ?? '（無名稱）'}`,
      `userId：${item.userId}`,
      `status：${item.status}｜role：${item.role}`,
      `加入/核准：${approved}｜最近更新：${updated}`,
    ].join('\n');
  });
  return [{ type: 'push', userId: adminUserId, text: ['【顧問名單】', ...lines].join('\n\n') }];
}

async function listPendingApplications(adminUserId: string): Promise<BotReply[]> {
  const pending = await getRepos().consultantApplications.listPending();
  if (pending.length === 0) {
    return [{ type: 'push', userId: adminUserId, text: '目前沒有待審顧問申請。' }];
  }
  const lines = pending.map(
    (item) =>
      `${item.applicationCode}｜${item.displayName ?? '（無名稱）'}｜${item.userId}｜${item.appliedAt.slice(0, 19).replace('T', ' ')}`
  );
  return [
    {
      type: 'push',
      userId: adminUserId,
      text: ['【待審顧問申請】', ...lines].join('\n'),
    },
  ];
}

async function disableConsultantByIdentifier(
  adminUserId: string,
  identifier: string
): Promise<BotReply[]> {
  const target = await resolveConsultantTarget(identifier);
  if (!target) {
    return [{ type: 'push', userId: adminUserId, text: `找不到顧問 ${identifier}。` }];
  }

  if (target.role === ConsultantRole.ADMIN && target.status === ConsultantStatus.ACTIVE) {
    const admins = await getActiveAdmins();
    if (admins.length <= 1) {
      return [{ type: 'push', userId: adminUserId, text: '不可停用最後一位管理者' }];
    }
  }

  const disableResult = await getRepos().consultants.disable(
    adminUserId,
    target.userId,
    adminUserId
  );
  if (!disableResult.success) {
    return [{ type: 'push', userId: adminUserId, text: disableResult.message }];
  }

  const cleanup = await runConsultantDisableCleanup(target);

  await logConsultantManagementEvent({
    action: 'consultant_disabled',
    actorUserId: adminUserId,
    payload: {
      consultant_code: target.consultantCode,
      disabled_by: adminUserId,
      cancelled_drafts_count: cleanup.cancelledDraftsCount,
      preserved_reviews_count: cleanup.preservedReviewsCount,
      suspended_groups_count: cleanup.suspendedGroupsCount,
    },
  });

  return [
    {
      type: 'push',
      userId: adminUserId,
      text: cleanup.summaryText,
    },
    ...cleanup.adminPushReplies,
  ];
}

async function enableConsultantByIdentifier(
  adminUserId: string,
  identifier: string
): Promise<BotReply[]> {
  const target = await resolveConsultantTarget(identifier);
  if (!target) {
    return [{ type: 'push', userId: adminUserId, text: `找不到顧問 ${identifier}。` }];
  }

  const enableResult = await getRepos().consultants.enable(adminUserId, target.userId);
  if (!enableResult.success) {
    return [{ type: 'push', userId: adminUserId, text: enableResult.message }];
  }

  await logConsultantManagementEvent({
    action: 'consultant_enabled',
    actorUserId: adminUserId,
    payload: {
      consultant_code: target.consultantCode,
      enabled_by: adminUserId,
    },
  });

  return [
    {
      type: 'push',
      userId: adminUserId,
      text: `已啟用顧問 ${target.consultantCode ?? target.userId}。`,
    },
    {
      type: 'push',
      userId: target.userId,
      text: '您的顧問身份已恢復，可以繼續使用顧問指令。',
    },
  ];
}
