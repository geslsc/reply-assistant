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
  isDraftOnlyIntent,
  isDirectExecuteIntent,
  requiresConfirmation,
} from './consultantIntentClassifier';
import {
  formatDraftReply,
  generateKnowledgeCardDraft,
} from './knowledgeCardDraftService';
import { summarizeCustomerQuestionForConsultant } from './consultantPrivateAiService';
import { getCardById, pauseLastReferencedCard } from './knowledgeBaseService';
import { getActiveIssueThread } from './issueThreadService';
import { canPauseKnowledgeCard, executeReplyToGroup } from './replyToGroupService';
import { handleServiceIntroduction } from './servicePeriodService';
import { isActiveAdmin, isActiveConsultantOrAdmin } from './consultantWhitelist';

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

async function handleDraftIntent(
  intent: ConsultantIntent,
  ctx: ConsultantActionContext
): Promise<BotReply[]> {
  const operation =
    intent === ConsultantIntent.ORGANIZE_KNOWLEDGE_CARD ? 'create' : 'modify';
  const thread = ctx.groupId ? await getActiveIssueThread(ctx.groupId) : null;
  const existingCard = thread?.lastKnowledgeCardId
    ? getCardById(thread.lastKnowledgeCardId)
    : null;

  const result = await generateKnowledgeCardDraft({
    operation,
    consultantRequest: ctx.text,
    existingCard,
  });

  return [
    {
      type: 'push',
      userId: ctx.userId,
      text: formatDraftReply(result),
    },
  ];
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
    setPendingConfirmation(ctx.userId, {
      intent,
      payload: classified.payload,
      shortCode: classified.shortCode,
      groupId: ctx.groupId,
    });
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
    if (isDraftOnlyIntent(intent)) {
      return handleDraftIntent(intent, ctx);
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
