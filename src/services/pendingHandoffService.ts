import { v4 as uuidv4 } from 'uuid';
import { getRepos } from '../repositories';
import {
  CreatePendingHandoffParams,
  PendingHandoff,
  PendingHandoffInvalidReason,
  PendingHandoffStatus,
} from '../repositories/pendingHandoffTypes';

export async function createPendingHandoff(
  params: CreatePendingHandoffParams
): Promise<PendingHandoff> {
  return getRepos().pendingHandoffs.create(params);
}

export async function getOpenPendingHandoffs(consultantId: string): Promise<PendingHandoff[]> {
  return getRepos().pendingHandoffs.findOpenByConsultant(consultantId);
}

export async function getPendingHandoffs(consultantId: string): Promise<PendingHandoff[]> {
  return getRepos().pendingHandoffs.findByConsultant(consultantId);
}

export async function findOpenHandoffByShortCode(
  consultantId: string,
  shortCode: string
): Promise<PendingHandoff | null> {
  return getRepos().pendingHandoffs.findOpenByConsultantAndShortCode(consultantId, shortCode);
}

export async function closePendingHandoff(id: string): Promise<PendingHandoff | null> {
  return getRepos().pendingHandoffs.markClosed(id);
}

export async function invalidatePendingHandoff(
  id: string,
  reason: PendingHandoffInvalidReason
): Promise<PendingHandoff | null> {
  return getRepos().pendingHandoffs.markInvalid(id, reason);
}

export async function invalidatePendingHandoffsByGroup(
  groupId: string,
  reason: PendingHandoffInvalidReason
): Promise<number> {
  return getRepos().pendingHandoffs.markInvalidByGroup(groupId, reason);
}

export async function invalidatePendingHandoffsByThread(
  groupId: string,
  issueThreadId: string,
  reason: PendingHandoffInvalidReason
): Promise<number> {
  return getRepos().pendingHandoffs.markInvalidByThread(groupId, issueThreadId, reason);
}

export function formatGroupLabelForHandoff(groupId: string, groupName?: string | null): string {
  if (groupName && groupName !== groupId) {
    return groupName;
  }
  return `尚未取得群組名稱（groupId: ${groupId}）`;
}

export function buildHandoffPrivateCard(params: {
  groupId: string;
  groupName?: string | null;
  shortCode: string;
  customerQuestion: string;
}): string {
  const groupLabel = formatGroupLabelForHandoff(params.groupId, params.groupName ?? null);
  return [
    '【問題收斂卡】',
    `群組：${groupLabel}`,
    `問題短碼：${params.shortCode}`,
    '',
    '【店家問題】',
    params.customerQuestion,
    '',
    '【可回覆選項】',
    '- 回覆這題：[您的回覆內容]（僅單筆 pending 時可用「這題」指代）',
    `- 指定短碼回覆：${params.shortCode} [您的回覆內容]`,
    '- 不處理 / 稍後處理：回覆「稍後處理」',
    '',
    '※ 代回群組屬高副作用操作，執行前會再確認一次，內容將逐字轉貼至群組。',
  ].join('\n');
}

export async function registerHandoffsForConsultants(params: {
  groupId: string;
  groupName?: string | null;
  issueThreadId: string;
  shortCode: string;
  customerQuestion: string;
  consultantIds: string[];
}): Promise<void> {
  for (const consultantId of params.consultantIds) {
    await createPendingHandoff({
      consultantId,
      issueThreadId: params.issueThreadId,
      groupId: params.groupId,
      shortCode: params.shortCode,
      customerQuestion: params.customerQuestion,
    });
  }
}

export function generatePendingHandoffId(): string {
  return uuidv4();
}

export async function clearAllPendingHandoffs(): Promise<void> {
  await getRepos().pendingHandoffs.clear();
}

export function isPendingHandoffOpen(handoff: PendingHandoff): boolean {
  return handoff.status === PendingHandoffStatus.OPEN;
}

export function isPendingHandoffInvalid(handoff: PendingHandoff): boolean {
  return handoff.status === PendingHandoffStatus.INVALID;
}
