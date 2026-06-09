import { v4 as uuidv4 } from 'uuid';
import {
  ConsultantRecord,
  ConsultantRole,
  ConsultantStatus,
} from '../types';
import { getRepos } from '../repositories';
import { allocateApplicationCode } from './consultantCodeService';

export function generateInviteCode(): string {
  return uuidv4().slice(0, 8).toUpperCase();
}

export async function registerInviteCode(code: string, createdByAdminId: string): Promise<void> {
  await getRepos().consultants.registerInviteCode(code, createdByAdminId);
}

export async function validateConsultantInvite(
  inviteCode: string
): Promise<{ success: boolean; message: string }> {
  const code = inviteCode.trim().toUpperCase();
  const valid = await getRepos().consultants.isValidInviteCode(code);
  if (!valid) {
    return { success: false, message: '邀請碼無效' };
  }
  return { success: true, message: '邀請碼有效' };
}

export async function requestConsultantJoin(
  userId: string,
  inviteCode: string,
  displayName?: string
): Promise<{ success: boolean; message: string; record?: ConsultantRecord }> {
  const validated = await validateConsultantInvite(inviteCode);
  if (!validated.success) {
    return validated;
  }

  const existing = await getRepos().consultants.findById(userId);
  if (existing?.status === ConsultantStatus.ACTIVE) {
    return { success: false, message: '您已是 active 顧問' };
  }

  const pending = await getRepos().consultantApplications.findPendingByUserId(userId);
  if (!pending) {
    const applicationCode = await allocateApplicationCode();
    await getRepos().consultantApplications.create({
      applicationId: uuidv4(),
      applicationCode,
      userId,
      displayName: displayName ?? null,
      appliedAt: new Date().toISOString(),
    });
  }

  return { success: true, message: '已建立顧問申請，等待 admin 核准' };
}

export async function approveConsultant(
  adminUserId: string,
  targetUserId: string
): Promise<{ success: boolean; message: string }> {
  if (!(await isActiveAdmin(adminUserId))) {
    return { success: false, message: '只有 active admin 可核准' };
  }
  const pending = await getRepos().consultantApplications.findPendingByUserId(targetUserId);
  if (pending) {
    const resolvedAt = new Date().toISOString();
    const application = await getRepos().consultantApplications.approve({
      applicationCode: pending.applicationCode,
      resolvedBy: adminUserId,
      resolvedAt,
    });
    if (!application) {
      return { success: false, message: '找不到 pending 申請' };
    }
    await getRepos().consultants.upsertApprovedConsultant({
      userId: application.userId,
      displayName: application.displayName,
      consultantCode: application.applicationCode,
      approvedBy: adminUserId,
      approvedAt: resolvedAt,
    });
    return { success: true, message: '已核准' };
  }
  const consultantCode = await allocateApplicationCode();
  await getRepos().consultants.upsertApprovedConsultant({
    userId: targetUserId,
    displayName: null,
    consultantCode,
    approvedBy: adminUserId,
    approvedAt: new Date().toISOString(),
  });
  return { success: true, message: '已核准' };
}

export async function disableConsultant(
  adminUserId: string,
  targetUserId: string
): Promise<{ success: boolean; message: string }> {
  if (!(await isActiveAdmin(adminUserId))) {
    return { success: false, message: '只有 active admin 可停用' };
  }
  return getRepos().consultants.disable(adminUserId, targetUserId, adminUserId);
}

export async function registerAdmin(userId: string, displayName?: string): Promise<ConsultantRecord> {
  return getRepos().consultants.upsertAdmin(userId, displayName);
}

export async function getConsultant(userId: string): Promise<ConsultantRecord | undefined> {
  const record = await getRepos().consultants.findById(userId);
  return record ?? undefined;
}

/** consultant-only 權限單一入口（不含 admin） */
export async function isActiveConsultant(userId: string): Promise<boolean> {
  return isActiveConsultantRole(userId);
}

export async function isActiveConsultantRole(userId: string): Promise<boolean> {
  const record = await getRepos().consultants.findById(userId);
  return (
    !!record &&
    record.status === ConsultantStatus.ACTIVE &&
    record.role === ConsultantRole.CONSULTANT
  );
}

export async function isActiveAdmin(userId: string): Promise<boolean> {
  const record = await getRepos().consultants.findById(userId);
  return (
    !!record &&
    record.status === ConsultantStatus.ACTIVE &&
    record.role === ConsultantRole.ADMIN
  );
}

export async function isActiveConsultantOrAdmin(userId: string): Promise<boolean> {
  return (await isActiveConsultantRole(userId)) || (await isActiveAdmin(userId));
}

export async function isDisabledConsultant(userId: string): Promise<boolean> {
  const record = await getRepos().consultants.findById(userId);
  return (
    !!record &&
    record.status === ConsultantStatus.DISABLED &&
    record.role === ConsultantRole.CONSULTANT
  );
}

export async function getPendingConsultants(): Promise<ConsultantRecord[]> {
  return getRepos().consultants.findPending();
}

export async function getActiveConsultants(): Promise<ConsultantRecord[]> {
  return getRepos().consultants.findActive();
}

export async function getActiveAdmins(): Promise<ConsultantRecord[]> {
  return getRepos().consultants.findActiveAdmins();
}

export async function clearConsultants(): Promise<void> {
  await getRepos().consultants.clear();
}
