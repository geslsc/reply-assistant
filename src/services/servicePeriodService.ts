import { Actor, BotReply, EventType, SERVICE_PERIOD_DAYS } from '../types';
import { createEvent } from './eventLogService';
import {
  getGroupFlags,
  isInServicePeriod,
  isServiceExpired,
  updateGroupFlags,
} from './groupFlags';
import { ensureGroupAssignment } from './groupConsultantAssignmentService';
import { GROUP_FIRST_INTRO_MESSAGE, GROUP_FOLLOWUP_INTRO_MESSAGE } from './groupReplyCopyService';
import {
  isGroupIntroShown,
  markGroupIntroShown,
  resolveGroupIntroMessage,
} from './groupMetadataService';

export const INTRO_MESSAGE = GROUP_FIRST_INTRO_MESSAGE;

const REACTIVATION_CONFIRM_PROMPT =
  '您確定要重新啟用教學協助期嗎?請回覆「確認重新啟用」以繼續。';

export async function handleServiceIntroduction(
  groupId: string,
  consultantUserId: string
): Promise<BotReply[]> {
  await ensureGroupAssignment(groupId);

  if (await isServiceExpired(groupId)) {
    return [{ type: 'group', text: '教學協助期已結束,請使用「重新啟用教學協助期」指令。' }];
  }

  const introShown = await isGroupIntroShown(groupId);
  const message = introShown ? GROUP_FOLLOWUP_INTRO_MESSAGE : GROUP_FIRST_INTRO_MESSAGE;

  if (!(await isInServicePeriod(groupId))) {
    const now = new Date();
    const end = new Date(now);
    end.setDate(end.getDate() + SERVICE_PERIOD_DAYS);

    await updateGroupFlags(groupId, {
      serviceStartAt: now.toISOString(),
      serviceEndAt: end.toISOString(),
    });

    await createEvent({
      event_type: EventType.STATE_TRANSITION,
      group_id: groupId,
      issue_thread_id: null,
      actor: Actor.CONSULTANT,
      actor_user_id: consultantUserId,
      from_state: null,
      to_state: null,
      detail: 'service period started',
    });
  }

  if (!introShown) {
    await markGroupIntroShown(groupId, consultantUserId);
  }

  return [{ type: 'group', text: message }];
}

export async function handleServiceReactivationDirect(
  groupId: string,
  consultantUserId: string
): Promise<BotReply[]> {
  const now = new Date();
  const end = new Date(now);
  end.setDate(end.getDate() + SERVICE_PERIOD_DAYS);

  await updateGroupFlags(groupId, {
    serviceStartAt: now.toISOString(),
    serviceEndAt: end.toISOString(),
    serviceReactivationPending: false,
  });

  await createEvent({
    event_type: EventType.STATE_TRANSITION,
    group_id: groupId,
    issue_thread_id: null,
    actor: Actor.CONSULTANT,
    actor_user_id: consultantUserId,
    from_state: null,
    to_state: null,
    detail: 'service period reactivated via assistant command',
  });

  const status = await formatServicePeriodStatus(groupId);
  return [
    {
      type: 'group',
      text: ['已重新啟用教學協助期。', '', status].join('\n'),
    },
  ];
}

export async function formatServicePeriodStatus(groupId: string): Promise<string> {
  const flags = await getGroupFlags(groupId);
  if (!flags.serviceStartAt || !flags.serviceEndAt) {
    return '【群組服務期】\n狀態：尚未啟用';
  }
  const start = new Date(flags.serviceStartAt);
  const end = new Date(flags.serviceEndAt);
  const now = new Date();
  const remainingMs = end.getTime() - now.getTime();
  const remainingDays = Math.max(0, Math.ceil(remainingMs / (1000 * 60 * 60 * 24)));
  let status = '進行中';
  if (remainingMs <= 0) {
    status = '已結束';
  } else if (now < start) {
    status = '尚未啟用';
  }
  const groupName = flags.groupName ?? groupId;
  return [
    '【群組服務期】',
    `群組：${groupName}`,
    `狀態：${status}`,
    `開始：${start.toLocaleString('zh-TW')}`,
    `結束：${end.toLocaleString('zh-TW')}`,
    `剩餘：${remainingDays} 天`,
  ].join('\n');
}

export async function handleServiceReactivationConfirm(
  groupId: string,
  consultantUserId: string
): Promise<BotReply[]> {
  const flags = await getGroupFlags(groupId);
  if (!flags.serviceReactivationPending) {
    return [{ type: 'group', text: '目前沒有待確認的重新啟用請求。' }];
  }

  const now = new Date();
  const end = new Date(now);
  end.setDate(end.getDate() + SERVICE_PERIOD_DAYS);

  await updateGroupFlags(groupId, {
    serviceStartAt: now.toISOString(),
    serviceEndAt: end.toISOString(),
    serviceReactivationPending: false,
  });

  await createEvent({
    event_type: EventType.STATE_TRANSITION,
    group_id: groupId,
    issue_thread_id: null,
    actor: Actor.CONSULTANT,
    actor_user_id: consultantUserId,
    from_state: null,
    to_state: null,
    detail: 'service period reactivated',
  });

  const { message, isFirstIntro } = await resolveGroupIntroMessage(groupId);
  if (isFirstIntro) {
    await markGroupIntroShown(groupId, consultantUserId);
  }
  return [{ type: 'group', text: message }];
}

export async function isOutOfService(groupId: string): Promise<boolean> {
  const flags = await getGroupFlags(groupId);
  if (!flags.serviceStartAt) {
    return true;
  }
  return !(await isInServicePeriod(groupId));
}

export async function getServiceDay(groupId: string): Promise<number | null> {
  const flags = await getGroupFlags(groupId);
  if (!flags.serviceStartAt) {
    return null;
  }
  const start = new Date(flags.serviceStartAt);
  const now = new Date();
  const diffMs = now.getTime() - start.getTime();
  return Math.floor(diffMs / (1000 * 60 * 60 * 24)) + 1;
}

export function parseServicePeriodQuery(
  text: string
): { groupName?: string } | null {
  const trimmed = text.trim();
  const patterns: RegExp[] = [
    /^查詢群組服務期$/u,
    /^查詢服務期\s+(.+)$/u,
    /^(.+)\s+服務期還剩多久$/u,
    /^(.+)\s+服務期$/u,
  ];
  if (trimmed === '查詢群組服務期') {
    return {};
  }
  for (const pattern of patterns.slice(1)) {
    const match = trimmed.match(pattern);
    if (match?.[1]) {
      return { groupName: match[1].trim() };
    }
  }
  return null;
}

export { REACTIVATION_CONFIRM_PROMPT };
