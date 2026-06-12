import { Actor, BotReply, EventType, SERVICE_PERIOD_DAYS } from '../types';
import { createEvent } from './eventLogService';
import {
  getGroupFlags,
  isInServicePeriod,
  isServiceExpired,
  updateGroupFlags,
} from './groupFlags';
import { ensureGroupAssignment } from './groupConsultantAssignmentService';

export const INTRO_MESSAGE = `老師好，我是客立樂教學小助手。

接下來 30 天，我會和導入教練一起在這個群組協助您處理操作使用上的問題。

遇到基本的操作使用問題時，可以直接在群組用文字描述，例如：
「我的預約服務網站從哪邊設定？」
「我的服務項目跟價格要在哪裡新增或調整？」
「客人預約時可以選的服務要去哪裡開？」
「店內基本資料、地址或 logo 要在哪裡修改？」
「畫面出現錯誤訊息」

我會先協助整理問題，並提供可以參考的操作教學步驟。

如果是我目前還不會處理的問題，也會幫您整理起來，提醒導入教練後續協助您確認。

如果我回覆的步驟和您畫面不一樣，也可以再跟我說，或等導入教練確認喔。`;

const ALREADY_ACTIVE_MESSAGE =
  '我已經在這個群組待命囉,接下來有常見操作問題可以直接在群組裡詢問。';

const REACTIVATION_CONFIRM_PROMPT =
  '您確定要重新啟用教學協助期嗎?請回覆「確認重新啟用」以繼續。';

export async function handleServiceIntroduction(
  groupId: string,
  consultantUserId: string
): Promise<BotReply[]> {
  await ensureGroupAssignment(groupId);

  if (await isInServicePeriod(groupId)) {
    return [{ type: 'group', text: ALREADY_ACTIVE_MESSAGE }];
  }

  if (await isServiceExpired(groupId)) {
    return [{ type: 'group', text: '教學協助期已結束,請使用「重新啟用教學協助期」指令。' }];
  }

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

  return [{ type: 'group', text: INTRO_MESSAGE }];
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
    `服務開始：${start.toISOString().slice(0, 10)}`,
    `服務結束：${end.toISOString().slice(0, 10)}`,
    `剩餘天數：${remainingDays} 天`,
    `狀態：${status}`,
  ].join('\n');
}

export async function handleServiceReactivationRequest(
  groupId: string,
  _consultantUserId: string
): Promise<BotReply[]> {
  await updateGroupFlags(groupId, { serviceReactivationPending: true });
  return [{ type: 'group', text: REACTIVATION_CONFIRM_PROMPT }];
}

export async function handleServiceReactivationConfirm(
  groupId: string,
  consultantUserId: string
): Promise<BotReply[]> {
  const flags = await getGroupFlags(groupId);
  if (!flags.serviceReactivationPending) {
    return [];
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

  return [{ type: 'group', text: INTRO_MESSAGE }];
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
