import { v4 as uuidv4 } from 'uuid';
import {
  ConsultantRecord,
  ConsultantRole,
  ConsultantStatus,
} from '../types';
import { getRepos } from '../repositories';

export function generateInviteCode(): string {
  return uuidv4().slice(0, 8).toUpperCase();
}

export async function registerInviteCode(code: string, createdByAdminId: string): Promise<void> {
  await getRepos().consultants.registerInviteCode(code, createdByAdminId);
}

export async function requestConsultantJoin(
  userId: string,
  inviteCode: string,
  displayName?: string
): Promise<{ success: boolean; message: string; record?: ConsultantRecord }> {
  const code = inviteCode.trim().toUpperCase();
  const valid = await getRepos().consultants.isValidInviteCode(code);
  if (!valid) {
    return { success: false, message: '邀請碼無效' };
  }

  const existing = await getRepos().consultants.findById(userId);
  if (existing && existing.status === ConsultantStatus.ACTIVE) {
    return { success: false, message: '您已是 active 顧問' };
  }

  const record = await getRepos().consultants.requestJoin(userId, code, displayName);
  return {
    success: true,
    message: '已建立 pending consultant，等待 admin 核准',
    record,
  };
}

export async function approveConsultant(
  adminUserId: string,
  targetUserId: string
): Promise<{ success: boolean; message: string }> {
  if (!(await isActiveAdmin(adminUserId))) {
    return { success: false, message: '只有 active admin 可核准' };
  }
  return getRepos().consultants.approve(adminUserId, targetUserId);
}

export async function disableConsultant(
  adminUserId: string,
  targetUserId: string
): Promise<{ success: boolean; message: string }> {
  if (!(await isActiveAdmin(adminUserId))) {
    return { success: false, message: '只有 active admin 可停用' };
  }
  return getRepos().consultants.disable(adminUserId, targetUserId);
}

export async function registerAdmin(userId: string, displayName?: string): Promise<ConsultantRecord> {
  return getRepos().consultants.upsertAdmin(userId, displayName);
}

export async function getConsultant(userId: string): Promise<ConsultantRecord | undefined> {
  const record = await getRepos().consultants.findById(userId);
  return record ?? undefined;
}

export async function isActiveConsultant(userId: string): Promise<boolean> {
  const record = await getRepos().consultants.findById(userId);
  return (
    !!record &&
    record.status === ConsultantStatus.ACTIVE &&
    (record.role === ConsultantRole.CONSULTANT || record.role === ConsultantRole.ADMIN)
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
  return isActiveConsultant(userId);
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
