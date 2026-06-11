import { v4 as uuidv4 } from 'uuid';
import { BotReply } from '../types';
import { getRepos } from '../repositories';
import {
  CreatePendingHandoffParams,
  PendingHandoff,
  PendingHandoffInvalidReason,
  PendingHandoffStatus,
} from '../repositories/pendingHandoffTypes';
import { getGroupDisplayName } from './lineGroupSummaryService';
import { markHandoffIgnored, markHandoffResolved, markHandoffsIgnoredByGroup, markHandoffsIgnoredByThread } from './handoffStatusService';

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

export async function closePendingHandoff(
  id: string,
  updatedBy = 'system'
): Promise<PendingHandoff | null> {
  return markHandoffResolved(id, updatedBy);
}

export async function invalidatePendingHandoff(
  id: string,
  reason: PendingHandoffInvalidReason,
  updatedBy = 'system'
): Promise<PendingHandoff | null> {
  return markHandoffIgnored(id, updatedBy, reason);
}

export async function invalidatePendingHandoffsByGroup(
  groupId: string,
  reason: PendingHandoffInvalidReason
): Promise<number> {
  return markHandoffsIgnoredByGroup(groupId, reason);
}

export async function invalidatePendingHandoffsByThread(
  groupId: string,
  issueThreadId: string,
  reason: PendingHandoffInvalidReason
): Promise<number> {
  return markHandoffsIgnoredByThread(groupId, issueThreadId, reason);
}

export function formatGroupLabelForHandoff(groupId: string, groupName?: string | null): string {
  if (groupName && groupName !== groupId) {
    return groupName;
  }
  return `尚未取得群組名稱（groupId: ${groupId}）`;
}

export function buildHandoffShortReminder(params: {
  groupId: string;
  groupName?: string | null;
  shortCode: string;
}): string {
  const groupLabel = formatGroupLabelForHandoff(params.groupId, params.groupName ?? null);
  return [
    '【群組新問題提醒】',
    '您目前正在整理知識卡，我先幫您記下新的群組問題。',
    '',
    `群組：${groupLabel}`,
    `問題短碼：${params.shortCode}`,
    '',
    '完成目前整理後，可輸入「查看待處理問題」查看完整內容。',
  ].join('\n');
}

export function isViewPendingHandoffsPhrase(text: string): boolean {
  return text.trim() === '查看待處理問題';
}

export function isSnoozeHandoffPhrase(text: string): boolean {
  return text.trim() === '稍後處理';
}

export function formatHandoffStatusLabel(handoff: PendingHandoff): string {
  return handoff.snoozed ? '稍後處理' : '未處理';
}

async function resolveTargetOpenHandoff(
  consultantId: string,
  shortCode?: string
): Promise<{ handoff: PendingHandoff | null; error?: string }> {
  const openList = await getOpenPendingHandoffs(consultantId);

  if (shortCode) {
    const matched = await findOpenHandoffByShortCode(consultantId, shortCode);
    if (matched) {
      return { handoff: matched };
    }
    return { handoff: null, error: `找不到短碼 ${shortCode} 的 open handoff。` };
  }

  if (openList.length === 0) {
    return { handoff: null, error: '目前沒有待處理的 handoff。' };
  }

  if (openList.length > 1) {
    const codes = openList.map((handoff) => handoff.shortCode).join('、');
    return {
      handoff: null,
      error: `您有多筆待處理問題（${codes}），請指定問題短碼。`,
    };
  }

  return { handoff: openList[0] };
}

export async function handleSnoozeHandoff(
  consultantId: string,
  shortCode?: string
): Promise<BotReply[]> {
  const { handoff, error } = await resolveTargetOpenHandoff(consultantId, shortCode);
  if (!handoff || error) {
    return [{ type: 'push', userId: consultantId, text: error ?? '無法標記稍後處理。' }];
  }

  await getRepos().pendingHandoffs.markSnoozed(handoff.id);
  return [
    {
      type: 'push',
      userId: consultantId,
      text: '已先標記為稍後處理。之後可輸入「查看待處理問題」叫回未處理清單。',
    },
  ];
}

export async function handleViewPendingHandoffs(userId: string): Promise<BotReply[]> {
  const handoffs = await getOpenPendingHandoffs(userId);
  if (handoffs.length === 0) {
    return [{ type: 'push', userId, text: '目前沒有待處理問題。' }];
  }

  const lines: string[] = ['【待處理問題清單】', ''];
  for (const handoff of handoffs) {
    const groupName = await getGroupDisplayName(handoff.groupId);
    const groupLabel = formatGroupLabelForHandoff(handoff.groupId, groupName);
    lines.push(
      `群組：${groupLabel}`,
      `問題短碼：${handoff.shortCode}`,
      `問題摘要：${handoff.customerQuestion ?? '（無摘要）'}`,
      `目前狀態：${formatHandoffStatusLabel(handoff)}`,
      '可用操作：',
      `- 輸入短碼查看詳情：${handoff.shortCode}`,
      '- 稍後處理',
      '- 不處理 / 略過',
      '- 整理成知識卡草稿',
      ''
    );
  }
  lines.push('輸入問題短碼可查看詳情並撰寫回覆草稿（私訊）。');
  return [{ type: 'push', userId, text: lines.join('\n') }];
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
    `- 輸入短碼查看詳情：${params.shortCode}`,
    '- 不處理 / 稍後處理：回覆「稍後處理」',
    '- 若稍後處理，之後可輸入「查看待處理問題」叫回清單',
    '',
    '※ 回覆草稿請透過私訊撰寫，系統會以 replyMessage 提供草稿。',
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
  return (
    handoff.status === PendingHandoffStatus.PENDING ||
    handoff.status === PendingHandoffStatus.IN_PROGRESS
  );
}

export function isPendingHandoffInvalid(handoff: PendingHandoff): boolean {
  return handoff.status === PendingHandoffStatus.IGNORED;
}
