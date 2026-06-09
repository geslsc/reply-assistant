import {
  Actor,
  BotReply,
  EventType,
  IssueThreadStatus,
  ThreadState,
} from '../types';
import { createEvent } from './eventLogService';
import { isActiveAdmin, isActiveConsultantOrAdmin } from './consultantWhitelist';
import { isMuted } from './groupFlags';
import { isOutOfService } from './servicePeriodService';
import { getIssueThread } from './issueThreadService';
import {
  closePendingHandoff,
  findOpenHandoffByShortCode,
  getOpenPendingHandoffs,
  getPendingHandoffs,
  isPendingHandoffOpen,
} from './pendingHandoffService';
import { getGroupDisplayName } from './lineGroupSummaryService';
import { storeHandoffReplyContext } from './handoffKnowledgeDraftService';
import {
  PendingHandoff,
  PendingHandoffInvalidReason,
  PendingHandoffStatus,
} from '../repositories/pendingHandoffTypes';

export interface ReplyToGroupResult {
  success: boolean;
  replies: BotReply[];
  detail?: string;
}

export interface ReplyToGroupParams {
  consultantId: string;
  replyText: string;
  shortCode?: string;
}

function formatEventDetail(params: {
  issueThreadId: string;
  groupId: string;
  shortCode: string;
  consultantId: string;
  result: string;
}): string {
  return [
    'intent=REPLY_TO_GROUP',
    `issueThreadId=${params.issueThreadId}`,
    `groupId=${params.groupId}`,
    `shortCode=${params.shortCode}`,
    `consultantId=${params.consultantId}`,
    `result=${params.result}`,
  ].join('; ');
}

function mapInvalidReason(reason: PendingHandoffInvalidReason | null): string {
  switch (reason) {
    case PendingHandoffInvalidReason.GROUP_MUTED:
      return '群組已 mute，無法代回群組。';
    case PendingHandoffInvalidReason.OUT_OF_SERVICE:
      return '群組處於 OUT_OF_SERVICE_PERIOD，無法代回。';
    case PendingHandoffInvalidReason.SERVICE_ENDED:
      return '教學協助期已結束，無法代回群組。';
    case PendingHandoffInvalidReason.PASSIVE_TIMEOUT:
      return '此題已逾時結算，無法代回群組。';
    default:
      return '此 handoff 已失效，無法代回群組。';
  }
}

/** 檢查一：是哪一題 */
async function resolveTargetHandoff(
  consultantId: string,
  options: { shortCode?: string }
): Promise<{ handoff: PendingHandoff | null; error?: string }> {
  const openList = await getOpenPendingHandoffs(consultantId);

  if (options.shortCode) {
    const matched = await findOpenHandoffByShortCode(consultantId, options.shortCode);
    if (matched) {
      return { handoff: matched };
    }
    const all = await getPendingHandoffs(consultantId);
    const invalid = all.find(
      (h) => h.shortCode === options.shortCode && h.status === PendingHandoffStatus.INVALID
    );
    if (invalid) {
      return { handoff: null, error: mapInvalidReason(invalid.invalidReason) };
    }
    return {
      handoff: null,
      error: `找不到短碼 ${options.shortCode} 的 open handoff，可能已失效或已處理。`,
    };
  }

  if (openList.length === 0) {
    return { handoff: null, error: '目前沒有待處理的 handoff。' };
  }

  if (openList.length > 1) {
    const codes = openList.map((h) => h.shortCode).join('、');
    return {
      handoff: null,
      error: `您有多筆待處理問題（${codes}），請指定問題短碼後再代回。`,
    };
  }

  return { handoff: openList[0] };
}

/** 檢查二：thread 是否仍 open */
async function checkThreadOpenForReply(
  groupId: string,
  issueThreadId: string
): Promise<{ ok: boolean; reason?: string }> {
  const thread = await getIssueThread(groupId, issueThreadId);
  if (!thread) {
    return { ok: false, reason: '找不到對應 issue thread。' };
  }
  if (thread.status === IssueThreadStatus.RESOLVED) {
    return { ok: false, reason: '此題已結案，無法代回群組。' };
  }
  if (await isMuted(groupId)) {
    return { ok: false, reason: '群組已 mute，無法代回群組。' };
  }
  if (thread.state === ThreadState.OUT_OF_SERVICE_PERIOD) {
    return { ok: false, reason: '群組處於 OUT_OF_SERVICE_PERIOD，無法代回。' };
  }
  if (await isOutOfService(groupId)) {
    return { ok: false, reason: '教學協助期已結束，無法代回群組。' };
  }
  return { ok: true };
}

/** 檢查三：權限 */
async function checkReplyPermission(consultantId: string): Promise<{ ok: boolean; message?: string }> {
  if (!(await isActiveConsultantOrAdmin(consultantId))) {
    return {
      ok: false,
      message: '權限不足：代回群組限 active admin 或 consultant。',
    };
  }
  return { ok: true };
}

/**
 * 代回群組：三道檢查 + 逐字轉貼 + pushMessage（不使用 replyMessage、不經 LLM）
 */
export async function executeReplyToGroup(params: ReplyToGroupParams): Promise<ReplyToGroupResult> {
  const trimmedReply = params.replyText.trim();
  if (!trimmedReply) {
    return {
      success: false,
      replies: [
        {
          type: 'push',
          userId: params.consultantId,
          text: '請提供要代回群組的內容。',
        },
      ],
    };
  }

  const permission = await checkReplyPermission(params.consultantId);
  if (!permission.ok) {
    return {
      success: false,
      replies: [
        {
          type: 'push',
          userId: params.consultantId,
          text: permission.message ?? '權限不足。',
        },
      ],
    };
  }

  const { handoff, error: resolveError } = await resolveTargetHandoff(params.consultantId, {
    shortCode: params.shortCode,
  });
  if (!handoff || resolveError) {
    return {
      success: false,
      replies: [
        { type: 'push', userId: params.consultantId, text: resolveError ?? '無法解析目標問題。' },
      ],
    };
  }

  if (!isPendingHandoffOpen(handoff)) {
    return {
      success: false,
      replies: [
        {
          type: 'push',
          userId: params.consultantId,
          text: `短碼 ${handoff.shortCode} 已失效或已處理，無法代回。`,
        },
      ],
    };
  }

  const threadCheck = await checkThreadOpenForReply(handoff.groupId, handoff.issueThreadId);
  if (!threadCheck.ok) {
    return {
      success: false,
      replies: [
        {
          type: 'push',
          userId: params.consultantId,
          text: threadCheck.reason ?? 'thread 不可代回。',
        },
      ],
    };
  }

  const pushReplies: BotReply[] = [
    {
      type: 'push',
      userId: handoff.groupId,
      text: trimmedReply,
    },
  ];

  await createEvent({
    event_type: EventType.CONSULTANT_OVERRIDE,
    group_id: handoff.groupId,
    issue_thread_id: handoff.issueThreadId,
    actor: Actor.CONSULTANT,
    actor_user_id: params.consultantId,
    detail: formatEventDetail({
      issueThreadId: handoff.issueThreadId,
      groupId: handoff.groupId,
      shortCode: handoff.shortCode,
      consultantId: params.consultantId,
      result: 'success',
    }),
  });

  await closePendingHandoff(handoff.id);

  const groupName = await getGroupDisplayName(handoff.groupId);
  storeHandoffReplyContext(params.consultantId, {
    groupId: handoff.groupId,
    groupName,
    shortCode: handoff.shortCode,
    customerQuestion: handoff.customerQuestion ?? '',
    replyText: trimmedReply,
  });

  pushReplies.push({
    type: 'push',
    userId: params.consultantId,
    text: [
      `已成功代回群組（${handoff.shortCode}）。`,
      '若這題適合沉澱成知識卡，可輸入「整理成知識卡」，我會把店家問題與您的回覆整理成草稿。',
    ].join('\n'),
  });

  return { success: true, replies: pushReplies };
}

export async function canPauseKnowledgeCard(userId: string): Promise<boolean> {
  return isActiveAdmin(userId);
}
