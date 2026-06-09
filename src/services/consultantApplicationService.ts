import { v4 as uuidv4 } from 'uuid';
import { BotReply } from '../types';
import { getRepos } from '../repositories';
import {
  getActiveAdmins,
  isActiveAdmin,
  isActiveConsultantRole,
} from './consultantWhitelist';
import { allocateApplicationCode } from './consultantCodeService';
import { logConsultantManagementEvent } from './consultantEventLogService';

export const APPLY_CONSULTANT_PHRASE = '申請顧問';

export async function handleApplyConsultant(params: {
  userId: string;
  displayName?: string | null;
}): Promise<BotReply[]> {
  if (await isActiveAdmin(params.userId)) {
    return [{ type: 'push', userId: params.userId, text: '您已經是管理者身份' }];
  }
  if (await isActiveConsultantRole(params.userId)) {
    return [{ type: 'push', userId: params.userId, text: '您已經是顧問身份' }];
  }

  const existingPending = await getRepos().consultantApplications.findPendingByUserId(
    params.userId
  );
  if (existingPending) {
    return [
      {
        type: 'push',
        userId: params.userId,
        text: `您已有待審申請（${existingPending.applicationCode}），請等待管理者審核。`,
      },
    ];
  }

  const applicationCode = await allocateApplicationCode();
  const appliedAt = new Date().toISOString();
  await getRepos().consultantApplications.create({
    applicationId: uuidv4(),
    applicationCode,
    userId: params.userId,
    displayName: params.displayName ?? null,
    appliedAt,
  });

  await logConsultantManagementEvent({
    action: 'consultant_application_submitted',
    actorUserId: params.userId,
    payload: {
      user_id: params.userId,
      display_name: params.displayName ?? null,
      application_code: applicationCode,
    },
  });

  const replies: BotReply[] = [
    {
      type: 'push',
      userId: params.userId,
      text: `已收到您的顧問申請（${applicationCode}），管理者審核後會通知您。`,
    },
  ];

  const adminMessage = [
    '【待審顧問申請】',
    `申請者：${params.displayName ?? '（未提供名稱）'}`,
    `userId：${params.userId}`,
    `申請時間：${appliedAt.slice(0, 19).replace('T', ' ')}`,
    `申請短碼：${applicationCode}`,
    '',
    `請私訊「核准 ${applicationCode}」或「拒絕 ${applicationCode}」`,
  ].join('\n');

  for (const admin of await getActiveAdmins()) {
    replies.push({ type: 'push', userId: admin.userId, text: adminMessage });
  }

  return replies;
}

export async function resolveApplicationCode(text: string): Promise<string | null> {
  const match = text.trim().match(/^(?:核准|拒絕)\s+(C-[\w-]+)$/u);
  return match?.[1] ?? null;
}

export async function approveApplicationByCode(
  adminUserId: string,
  applicationCode: string
): Promise<BotReply[]> {
  if (!(await isActiveAdmin(adminUserId))) {
    return [{ type: 'push', userId: adminUserId, text: '只有 active admin 可操作' }];
  }

  const resolvedAt = new Date().toISOString();
  const application = await getRepos().consultantApplications.approve({
    applicationCode,
    resolvedBy: adminUserId,
    resolvedAt,
  });
  if (!application) {
    return [{ type: 'push', userId: adminUserId, text: `找不到待審申請 ${applicationCode}。` }];
  }

  await getRepos().consultants.upsertApprovedConsultant({
    userId: application.userId,
    displayName: application.displayName,
    consultantCode: application.applicationCode,
    approvedBy: adminUserId,
    approvedAt: resolvedAt,
  });

  await logConsultantManagementEvent({
    action: 'consultant_approved',
    actorUserId: adminUserId,
    payload: {
      application_code: application.applicationCode,
      consultant_code: application.applicationCode,
      approved_by: adminUserId,
    },
  });

  return [
    { type: 'push', userId: adminUserId, text: `已核准顧問申請 ${applicationCode}。` },
    {
      type: 'push',
      userId: application.userId,
      text: `您的顧問身份已核准（${application.applicationCode}），可以開始使用顧問指令。`,
    },
  ];
}

export async function rejectApplicationByCode(
  adminUserId: string,
  applicationCode: string
): Promise<BotReply[]> {
  if (!(await isActiveAdmin(adminUserId))) {
    return [{ type: 'push', userId: adminUserId, text: '只有 active admin 可操作' }];
  }

  const resolvedAt = new Date().toISOString();
  const application = await getRepos().consultantApplications.reject({
    applicationCode,
    resolvedBy: adminUserId,
    resolvedAt,
  });
  if (!application) {
    return [{ type: 'push', userId: adminUserId, text: `找不到待審申請 ${applicationCode}。` }];
  }

  await logConsultantManagementEvent({
    action: 'consultant_rejected',
    actorUserId: adminUserId,
    payload: {
      application_code: application.applicationCode,
      rejected_by: adminUserId,
    },
  });

  return [
    { type: 'push', userId: adminUserId, text: `已拒絕顧問申請 ${applicationCode}。` },
    {
      type: 'push',
      userId: application.userId,
      text: '您的顧問申請未通過。若需再次申請，請輸入「申請顧問」。',
    },
  ];
}
