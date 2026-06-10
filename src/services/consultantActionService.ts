import { BotReply, ThreadState } from '../types';
import {
  clearPendingConfirmation,
  getPendingConfirmation,
  isConfirmationPhrase,
  setPendingConfirmation,
} from './consultantConfirmationService';
import { handleConsultantMute } from './consultantGroupControlService';
import {
  classifyConsultantIntent,
  ConsultantIntent,
  isConsultantPrivateAiIntent,
  isDirectExecuteIntent,
  requiresConfirmation,
} from './consultantIntentClassifier';
import { handleServiceIntroduction } from './servicePeriodService';
import { isActiveAdmin, isActiveConsultantOrAdmin } from './consultantWhitelist';
import { pauseLastReferencedCard } from './knowledgeBaseService';
import { summarizeCustomerQuestionForConsultant } from './consultantPrivateAiService';
import { getActiveIssueThread } from './issueThreadService';
import { canPauseKnowledgeCard, executeReplyToGroup, buildReplyToGroupConfirmationText } from './replyToGroupService';
import {
  formatGroupLabelForHandoff,
  getOpenPendingHandoffs,
  findOpenHandoffByShortCode,
} from './pendingHandoffService';
import { getGroupDisplayName } from './lineGroupSummaryService';

export interface ConsultantActionContext {
  userId: string;
  text: string;
  groupId?: string;
  isGroup: boolean;
}

async function handleDirectIntent(
  intent: ConsultantIntent,
  ctx: ConsultantActionContext
): Promise<BotReply[]> {
  const pushUser = ctx.userId;

  switch (intent) {
    case ConsultantIntent.SELF_INTRO:
      if (!ctx.groupId) {
        return [{ type: 'push', userId: pushUser, text: '自我介紹請在群組內使用。' }];
      }
      return handleServiceIntroduction(ctx.groupId, ctx.userId);
    case ConsultantIntent.REQUEST_CUSTOMER_INFO:
      if (!ctx.groupId) {
        return [{ type: 'push', userId: pushUser, text: '請店家補充資訊請在群組內使用。' }];
      }
      return [
        {
          type: 'group',
          text: '想再請您補充一下：可以描述一下目前畫面上看到的狀況或錯誤訊息嗎？',
        },
      ];
    case ConsultantIntent.PAUSE_ASSISTANT:
      if (!ctx.groupId) {
        return [{ type: 'push', userId: pushUser, text: '暫停小助手請在群組內使用。' }];
      }
      return handleConsultantMute(ctx.groupId, ctx.userId, true);
    case ConsultantIntent.RESUME_ASSISTANT:
      if (!ctx.groupId) {
        return [{ type: 'push', userId: pushUser, text: '恢復小助手請在群組內使用。' }];
      }
      return handleConsultantMute(ctx.groupId, ctx.userId, false);
    case ConsultantIntent.ENABLE_NANNY_PERIOD:
      if (!ctx.groupId) {
        return [
          {
            type: 'push',
            userId: pushUser,
            text: '保母期啟用請在群組內使用標準語法：「小助手啟用保母期 30 天」或「小助手開始協助 30 天」。',
          },
        ];
      }
      return handleServiceIntroduction(ctx.groupId, ctx.userId);
    default:
      return [];
  }
}

async function requestHighImpactConfirmation(
  intent: ConsultantIntent,
  ctx: ConsultantActionContext,
  classified: ReturnType<typeof classifyConsultantIntent>
): Promise<BotReply[]> {
  if (intent === ConsultantIntent.PAUSE_KNOWLEDGE_CARD) {
    if (!(await canPauseKnowledgeCard(ctx.userId))) {
      return [
        {
          type: 'push',
          userId: ctx.userId,
          text: '暫停知識卡需 active admin 權限。consultant 僅能向 admin 提出建議。',
        },
      ];
    }
    setPendingConfirmation(ctx.userId, {
      intent,
      groupId: ctx.groupId,
    });
    return [
      {
        type: 'push',
        userId: ctx.userId,
        text: '暫停知識卡屬高副作用操作。請回覆「確認」以暫停最近引用的知識卡。',
      },
    ];
  }

  if (intent === ConsultantIntent.REPLY_TO_GROUP) {
    const openList = await getOpenPendingHandoffs(ctx.userId);
    let handoff = null as Awaited<ReturnType<typeof findOpenHandoffByShortCode>>;
    if (classified.shortCode) {
      handoff = await findOpenHandoffByShortCode(ctx.userId, classified.shortCode);
    } else if (openList.length === 1) {
      handoff = openList[0];
    }

    setPendingConfirmation(ctx.userId, {
      intent,
      payload: classified.payload,
      shortCode: classified.shortCode ?? handoff?.shortCode,
      groupId: ctx.groupId,
    });

    if (!handoff) {
      const preview = classified.payload
        ? `內容：${classified.payload}`
        : '（請在確認後再送一次完整代回內容）';
      return [
        {
          type: 'push',
          userId: ctx.userId,
          text: `代回群組屬高副作用操作，將逐字轉貼至群組。\n${preview}\n請回覆「確認代回」以執行。`,
        },
      ];
    }

    const groupName = await getGroupDisplayName(handoff.groupId);
    const replyPreview = classified.payload?.trim() || '（請在確認後再送一次完整代回內容）';
    return [
      {
        type: 'push',
        userId: ctx.userId,
        text: buildReplyToGroupConfirmationText({
          groupName,
          groupId: handoff.groupId,
          shortCode: handoff.shortCode,
          customerQuestion: handoff.customerQuestion ?? '（無摘要）',
          replyText: replyPreview,
        }),
      },
    ];
  }

  return [];
}

async function executeConfirmedAction(ctx: ConsultantActionContext): Promise<BotReply[]> {
  const pending = getPendingConfirmation(ctx.userId);
  if (!pending) {
    return [];
  }

  if (pending.intent === ConsultantIntent.PAUSE_KNOWLEDGE_CARD) {
    clearPendingConfirmation(ctx.userId);
    if (!(await isActiveAdmin(ctx.userId))) {
      return [
        {
          type: 'push',
          userId: ctx.userId,
          text: '權限不足：暫停知識卡限 active admin。',
        },
      ];
    }
    const groupId = pending.groupId ?? ctx.groupId;
    if (!groupId) {
      return [{ type: 'push', userId: ctx.userId, text: '請在群組脈絡下暫停知識卡。' }];
    }
    const thread = await getActiveIssueThread(groupId);
    const card = await pauseLastReferencedCard(thread?.lastKnowledgeCardId ?? null, ctx.userId);
    if (!card) {
      return [
        {
          type: 'push',
          userId: ctx.userId,
          text: '目前沒有可暫停的知識卡。',
        },
      ];
    }
    return [
      {
        type: 'push',
        userId: ctx.userId,
        text: `已暫停知識卡「${card.card_id}」。`,
      },
    ];
  }

  if (pending.intent === ConsultantIntent.REPLY_TO_GROUP) {
    clearPendingConfirmation(ctx.userId);
    const replyText = pending.payload ?? ctx.text;
    const result = await executeReplyToGroup({
      consultantId: ctx.userId,
      replyText,
      shortCode: pending.shortCode,
    });
    return result.replies;
  }

  return [];
}

/** 處理顧問自然語法；回傳 null 表示未匹配意圖 */
export async function handleConsultantNaturalLanguage(
  ctx: ConsultantActionContext
): Promise<BotReply[] | null> {
  if (isConfirmationPhrase(ctx.text)) {
    const pending = getPendingConfirmation(ctx.userId);
    if (pending) {
      return executeConfirmedAction(ctx);
    }
  }

  const classified = classifyConsultantIntent(ctx.text);
  const { intent } = classified;

  if (!ctx.isGroup) {
    if (/^補充[:：]/u.test(ctx.text.trim()) || /^修改[:：]/u.test(ctx.text.trim())) {
      return null;
    }
    if (/^(幫我整理知識卡|整理知識卡|新增知識卡)$/.test(ctx.text.trim())) {
      return null;
    }
  }

  if (intent === ConsultantIntent.UNKNOWN) {
    return null;
  }

  if (isConsultantPrivateAiIntent(intent)) {
    if (!(await isActiveConsultantOrAdmin(ctx.userId))) {
      return null;
    }
    if (ctx.isGroup) {
      return [
        {
          type: 'push',
          userId: ctx.userId,
          text: 'AI 草稿／摘要輔助請私訊小助手，不在群組內處理。',
        },
      ];
    }
    if (intent === ConsultantIntent.SUMMARIZE_CUSTOMER_QUESTION) {
      const thread = ctx.groupId ? await getActiveIssueThread(ctx.groupId) : null;
      const text = await summarizeCustomerQuestionForConsultant({
        consultantRequest: ctx.text,
        customerQuestion: thread?.customerQuestion ?? null,
      });
      return [{ type: 'push', userId: ctx.userId, text }];
    }
    if (
      intent === ConsultantIntent.ORGANIZE_KNOWLEDGE_CARD ||
      intent === ConsultantIntent.MODIFY_KNOWLEDGE_CARD
    ) {
      return [
        {
          type: 'push',
          userId: ctx.userId,
          text: [
            '我有看到您在操作知識卡，可以用：',
            '- 幫我整理知識卡',
            '- 查詢知識卡 [關鍵字或 card_id]',
            '- 搜尋 [關鍵字]',
            '- 修改知識卡 [card_id 或編號]',
            '輸入「使用說明」可查看完整指令。',
          ].join('\n'),
        },
      ];
    }
  }

  if (isDirectExecuteIntent(intent)) {
    const replies = await handleDirectIntent(intent, ctx);
    return replies.length > 0 ? replies : null;
  }

  if (requiresConfirmation(intent)) {
    return requestHighImpactConfirmation(intent, ctx, classified);
  }

  return null;
}

export function isConsultantHandoffAnswering(
  thread: { state: ThreadState } | null | undefined,
  text: string,
  isConsultant: boolean
): boolean {
  return Boolean(
    isConsultant &&
      thread &&
      thread.state === ThreadState.CONSULTANT_HANDOFF &&
      text.length > 0
  );
}
