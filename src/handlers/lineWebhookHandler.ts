import {
  Actor,
  BotReply,
  CLOSING_SIGNALS,
  ConsultantRole,
  EventType,
  ProcessResult,
  REOPEN_SIGNALS,
  STANDBY_PHRASES,
  ThreadState,
} from '../types';
import { logger } from '../config/logger';
import {
  approveConsultant,
  getActiveAdmins,
  getActiveConsultants,
  isActiveAdmin,
  isActiveConsultantOrAdmin,
  requestConsultantJoin,
} from '../services/consultantWhitelist';
import { createEvent, getEventLogs, logStateTransition } from '../services/eventLogService';
import {
  executeHandoff,
  handleKnowledgeMiss,
} from '../services/consultantHandoffService';
import {
  getGroupFlags,
  isMuted,
  setMute,
  setWaitingFlag,
} from '../services/groupFlags';
import { pauseLastReferencedCard } from '../services/knowledgeBaseService';
import { handleKnowledgeCardCommand } from '../services/knowledgeCardCommandService';
import {
  expireStaleSessionIfNeeded,
  handleDmSessionPrivateMessage,
} from '../services/dmSessionService';
import { appendBackupReminderIfNeeded } from '../services/knowledgeCardBackupReminderService';
import { handleConsultantNaturalLanguage } from '../services/consultantActionService';
import {
  ACTIVE_PRIVATE_FALLBACK_HINT,
  buildIdentityReply,
  buildInactiveWorkflowBlockReply,
  isIdentityQueryPhrase,
} from '../services/consultantIdentityService';
import {
  handlePrivateUsageGuide,
  handleGroupUsageGuide,
  isUsageGuideRequest,
} from '../services/knowledgeCardUsageGuideHandler';
import {
  consumePrivateFallbackHint,
  SIMPLIFIED_PRIVATE_FALLBACK_HINT,
} from '../services/privateFallbackHintService';
import { handleConsultantMute } from '../services/consultantGroupControlService';
import { isNannyPeriodPhrase, isNannyPeriodApproximatePhrase, NANNY_PERIOD_STANDARD_SYNTAX_HINT } from '../services/consultantIntentClassifier';
import { buildOfficialCsAnswer } from '../services/officialCsService';
import {
  createIssueThread,
  getActiveIssueThread,
  getThreadsByGroup,
  hasSubstantiveAnswer,
  markConsultantAnswered,
  reopenThread,
  resolveThread,
  updateIssueThread,
} from '../services/issueThreadService';
import { settleGroupTimeouts } from '../services/passiveTimeoutSettlement';
import {
  buildPublicAnswer,
  isQuestionUnclear,
  routeQuestion,
} from '../services/riskRouter';
import {
  handleServiceIntroduction,
  handleServiceReactivationConfirm,
  handleServiceReactivationRequest,
  isOutOfService,
} from '../services/servicePeriodService';
import { refreshGroupNameIfNeeded } from '../services/lineGroupSummaryService';
import {
  getClarifyRound,
  incrementClarifyRound,
  transitionState,
} from '../services/stateMachine';

export interface IncomingMessage {
  userId: string;
  groupId?: string;
  text: string;
  isGroup: boolean;
  isBotMentioned?: boolean;
  replyToken?: string;
  quotedMessageId?: string;
  timestamp?: string;
  sourceType?: 'group' | 'user';
}

const CONSULTANT_JOIN_PATTERN = /^加入顧問\s+(\S+)$/;
const APPROVE_CONSULTANT_PATTERN = /^核准顧問\s+(\S+)$/;

function isClosingSignal(text: string): boolean {
  const trimmed = text.trim();
  return CLOSING_SIGNALS.some((s) => trimmed === s);
}

function isReopenSignal(text: string): boolean {
  return REOPEN_SIGNALS.some((s) => text.includes(s));
}

function isStandbyPhrase(text: string): boolean {
  const trimmed = text.trim();
  return STANDBY_PHRASES.some((s) => trimmed === s || trimmed.includes(s.replace('?', '？')));
}

async function getOrCreateActiveThread(groupId: string, question: string) {
  let thread = await getActiveIssueThread(groupId);
  if (!thread) {
    thread = await createIssueThread(groupId, question);
    await logStateTransition({
      group_id: groupId,
      issue_thread_id: thread.issueThreadId,
      from_state: ThreadState.IDLE,
      to_state: ThreadState.IDLE,
      actor: Actor.CUSTOMER,
      detail: 'new issue thread created',
    });
  } else {
    await updateIssueThread(groupId, thread.issueThreadId, { customerQuestion: question });
  }
  return thread;
}

async function handleClosingSignal(
  groupId: string,
  userId: string,
  text: string
): Promise<BotReply[]> {
  const thread = await getActiveIssueThread(groupId);
  if (!thread || !hasSubstantiveAnswer(thread) || !isClosingSignal(text)) {
    return [];
  }

  const fromState = thread.state;
  await resolveThread(groupId, thread.issueThreadId);
  await logStateTransition({
    group_id: groupId,
    issue_thread_id: thread.issueThreadId,
    from_state: fromState,
    to_state: ThreadState.IDLE,
    actor: Actor.CONSULTANT,
    actor_user_id: userId,
    detail: `closing signal: ${text.trim()}`,
  });
  return [];
}

async function handleConsultantCorrection(
  groupId: string,
  userId: string
): Promise<BotReply[]> {
  const thread = await getActiveIssueThread(groupId);
  await createEvent({
    event_type: EventType.CONSULTANT_CORRECTION,
    group_id: groupId,
    issue_thread_id: thread?.issueThreadId ?? null,
    actor: Actor.CONSULTANT,
    actor_user_id: userId,
    detail: 'manual correction triggered',
  });
  return [
    {
      type: 'group',
      text: '已記錄顧問更正,後續將依顧問確認內容處理。',
    },
  ];
}

async function handlePauseKnowledgeCard(
  groupId: string,
  userId: string
): Promise<BotReply[]> {
  const thread = await getActiveIssueThread(groupId);
  const cardId = thread?.lastKnowledgeCardId ?? null;
  const card = await pauseLastReferencedCard(cardId, userId);
  const replies: BotReply[] = [];

  if (card) {
    replies.push({
      type: 'group',
      text: `已將知識卡「${card.card_id}」標記暫停,管理者將收到提醒。`,
    });
    const admins = (await getActiveConsultants()).filter(
      (c) => c.role === ConsultantRole.ADMIN
    );
    for (const admin of admins) {
      replies.push({
        type: 'push',
        userId: admin.userId,
        text: `【知識卡暫停】顧問 ${userId} 標記「${card.card_id}」需修正。`,
      });
    }
  } else {
    replies.push({
      type: 'group',
      text: '目前沒有可暫停的知識卡,請在回答後再使用此指令。',
    });
  }
  return replies;
}

async function handleCustomerQuestion(
  groupId: string,
  userId: string,
  text: string
): Promise<BotReply[]> {
  if (await isMuted(groupId)) {
    return [];
  }

  const flags = await getGroupFlags(groupId);
  if (flags.mute && flags.waitingFlag) {
    return [];
  }

  if (await isOutOfService(groupId)) {
    if (!text.includes('@') && !text.includes('小助手')) {
      return [];
    }
  }

  const resolvedThreads = (await getThreadsByGroup(groupId)).filter(
    (t) => t.status === 'resolved'
  );
  for (const rt of resolvedThreads) {
    if (isReopenSignal(text)) {
      await reopenThread(groupId, rt.issueThreadId);
      await logStateTransition({
        group_id: groupId,
        issue_thread_id: rt.issueThreadId,
        from_state: ThreadState.IDLE,
        to_state: ThreadState.IDLE,
        actor: Actor.CUSTOMER,
        actor_user_id: userId,
        detail: 'thread reopened by customer follow-up',
      });
    }
  }

  const thread = await getOrCreateActiveThread(groupId, text);
  const clarifyRound = await getClarifyRound(groupId, thread.issueThreadId);
  const unclear = isQuestionUnclear(text);
  const action = await routeQuestion(text, { clarifyRound, isUnclear: unclear });

  switch (action.type) {
    case 'public_answer': {
      const answer = buildPublicAnswer(action.card.standard_answer);
      await transitionState({
        groupId,
        issueThreadId: thread.issueThreadId,
        toState: ThreadState.AI_ANSWERING,
        actor: Actor.BOT,
        detail: 'low risk public answer',
      });
      await updateIssueThread(groupId, thread.issueThreadId, {
        lastKnowledgeCardId: action.card.card_id,
      });
      await createEvent({
        event_type: EventType.KNOWLEDGE_HIT,
        group_id: groupId,
        issue_thread_id: thread.issueThreadId,
        actor: Actor.BOT,
        risk_level: action.card.risk_level,
        knowledge_card_id: action.card.card_id,
      });
      await createEvent({
        event_type: EventType.AI_ANSWER,
        group_id: groupId,
        issue_thread_id: thread.issueThreadId,
        actor: Actor.BOT,
        risk_level: action.card.risk_level,
        knowledge_card_id: action.card.card_id,
        detail: answer,
      });
      return [{ type: 'group', text: answer }];
    }
    case 'clarify': {
      await incrementClarifyRound(groupId, thread.issueThreadId);
      await transitionState({
        groupId,
        issueThreadId: thread.issueThreadId,
        toState: ThreadState.AI_CLARIFYING,
        actor: Actor.BOT,
        detail: `clarify round ${clarifyRound + 1}`,
      });
      return [{ type: 'group', text: action.question }];
    }
    case 'handoff': {
      if (action.card) {
        await createEvent({
          event_type: EventType.KNOWLEDGE_HIT,
          group_id: groupId,
          issue_thread_id: thread.issueThreadId,
          actor: Actor.BOT,
          risk_level: action.riskLevel,
          knowledge_card_id: action.card.card_id,
        });
      }
      return (
        await executeHandoff({
          groupId,
          issueThreadId: thread.issueThreadId,
          customerQuestion: text,
          card: action.card,
          reason: action.reason,
          riskLevel: action.riskLevel,
          actorUserId: userId,
        })
      ).replies;
    }
    case 'knowledge_miss': {
      await transitionState({
        groupId,
        issueThreadId: thread.issueThreadId,
        toState: ThreadState.CONSULTANT_HANDOFF,
        actor: Actor.SYSTEM,
        detail: 'knowledge miss',
      });
      return handleKnowledgeMiss({
        groupId,
        issueThreadId: thread.issueThreadId,
        question: text,
        actorUserId: userId,
      });
    }
    case 'official_cs': {
      const csAnswer = buildOfficialCsAnswer(action.card);
      await createEvent({
        event_type: EventType.OFFICIAL_CS_REDIRECT,
        group_id: groupId,
        issue_thread_id: thread.issueThreadId,
        actor: Actor.BOT,
        knowledge_card_id: action.card.card_id,
      });
      return [{ type: 'group', text: csAnswer }];
    }
    case 'no_action':
    default:
      return [];
  }
}

async function handlePrivateMessage(message: IncomingMessage): Promise<BotReply[]> {
  const replies: BotReply[] = [];
  const text = message.text.trim();

  logger.info('LINE private message received', { userId: message.userId, text });

  const joinMatch = text.match(CONSULTANT_JOIN_PATTERN);
  if (joinMatch) {
    const result = await requestConsultantJoin(message.userId, joinMatch[1]);
    replies.push({ type: 'push', userId: message.userId, text: result.message });
    if (result.success) {
      const admins = await getActiveAdmins();
      if (admins.length > 0) {
        for (const admin of admins) {
          replies.push({
            type: 'push',
            userId: admin.userId,
            text: `【待核准顧問】userId: ${message.userId}\n請私訊「核准顧問 ${message.userId}」`,
          });
        }
      } else {
        logger.warn('Pending consultant created but no active admin to notify', {
          userId: message.userId,
        });
      }
    }
    return replies;
  }

  const approveMatch = text.match(APPROVE_CONSULTANT_PATTERN);
  if (approveMatch) {
    const result = await approveConsultant(message.userId, approveMatch[1]);
    replies.push({ type: 'push', userId: message.userId, text: result.message });
    if (result.success) {
      replies.push({
        type: 'push',
        userId: approveMatch[1],
        text: '您的顧問身份已核准,可以開始使用顧問指令。',
      });
    }
    return replies;
  }

  const isActive = await isActiveConsultantOrAdmin(message.userId);

  if (isActive) {
    if (isUsageGuideRequest(text)) {
      return handlePrivateUsageGuide(message.userId);
    }

    const expiredReplies = await expireStaleSessionIfNeeded(message.userId);
    if (expiredReplies) {
      if (await isActiveAdmin(message.userId)) {
        await appendBackupReminderIfNeeded(message.userId, expiredReplies);
      }
      return expiredReplies;
    }

    const dmSessionReplies = await handleDmSessionPrivateMessage({
      userId: message.userId,
      text,
      quotedMessageId: message.quotedMessageId,
    });
    if (dmSessionReplies) {
      if (await isActiveAdmin(message.userId)) {
        await appendBackupReminderIfNeeded(message.userId, dmSessionReplies);
      }
      return dmSessionReplies;
    }

    const knowledgeReplies = await handleKnowledgeCardCommand({
      userId: message.userId,
      text,
      quotedMessageId: message.quotedMessageId,
    });
    if (knowledgeReplies) {
      if (await isActiveAdmin(message.userId)) {
        await appendBackupReminderIfNeeded(message.userId, knowledgeReplies);
      }
      return knowledgeReplies;
    }

    const naturalReplies = await handleConsultantNaturalLanguage({
      userId: message.userId,
      text,
      isGroup: false,
    });
    if (naturalReplies) {
      if (await isActiveAdmin(message.userId)) {
        await appendBackupReminderIfNeeded(message.userId, naturalReplies);
      }
      return naturalReplies;
    }

    if (isIdentityQueryPhrase(text)) {
      replies.push({
        type: 'push',
        userId: message.userId,
        text: await buildIdentityReply(message.userId),
      });
      if (await isActiveAdmin(message.userId)) {
        await appendBackupReminderIfNeeded(message.userId, replies);
      }
      return replies;
    }

    if (consumePrivateFallbackHint(message.userId)) {
      replies.push({
        type: 'push',
        userId: message.userId,
        text: SIMPLIFIED_PRIVATE_FALLBACK_HINT,
      });
    }
    if (await isActiveAdmin(message.userId)) {
      await appendBackupReminderIfNeeded(message.userId, replies);
    }
    return replies.length > 0 ? replies : [];
  }

  if (isUsageGuideRequest(text)) {
    return [
      {
        type: 'push',
        userId: message.userId,
        text: await buildIdentityReply(message.userId),
      },
    ];
  }

  if (isIdentityQueryPhrase(text)) {
    replies.push({
      type: 'push',
      userId: message.userId,
      text: await buildIdentityReply(message.userId),
    });
    return replies;
  }

  const inactiveBlock = await buildInactiveWorkflowBlockReply(message.userId, text);
  if (inactiveBlock) {
    return inactiveBlock;
  }

  replies.push({
    type: 'push',
    userId: message.userId,
    text: `已收到訊息。\n您的 LINE userId: ${message.userId}\n請等待管理員核准或輸入「加入顧問 [邀請碼]」。`,
  });
  return replies;
}

export async function processMessage(message: IncomingMessage): Promise<ProcessResult> {
  const replies: BotReply[] = [];

  if (!message.isGroup) {
    replies.push(...(await handlePrivateMessage(message)));
    return { replies, events: await getEventLogs() };
  }

  const groupId = message.groupId!;
  await refreshGroupNameIfNeeded(groupId);
  await settleGroupTimeouts(groupId);

  const text = message.text.trim();
  const isConsultant = await isActiveConsultantOrAdmin(message.userId);

  if (isConsultant) {
    if (isUsageGuideRequest(text)) {
      replies.push(...handleGroupUsageGuide());
      return { replies, events: await getEventLogs() };
    }

    if (text === '小助手先休息') {
      replies.push(...(await handleConsultantMute(groupId, message.userId, true)));
      return { replies, events: await getEventLogs() };
    }
    if (text === '小助手回來') {
      replies.push(...(await handleConsultantMute(groupId, message.userId, false)));
      return { replies, events: await getEventLogs() };
    }
    if (text === '小助手自我介紹一下') {
      replies.push(...(await handleServiceIntroduction(groupId, message.userId)));
      return { replies, events: await getEventLogs() };
    }
    if (isNannyPeriodPhrase(text)) {
      replies.push(...(await handleServiceIntroduction(groupId, message.userId)));
      return { replies, events: await getEventLogs() };
    }
    if (isNannyPeriodApproximatePhrase(text)) {
      replies.push({ type: 'group', text: NANNY_PERIOD_STANDARD_SYNTAX_HINT });
      return { replies, events: await getEventLogs() };
    }
    if (text === '重新啟用教學協助期') {
      replies.push(...(await handleServiceReactivationRequest(groupId, message.userId)));
      return { replies, events: await getEventLogs() };
    }
    if (text === '確認重新啟用') {
      replies.push(...(await handleServiceReactivationConfirm(groupId, message.userId)));
      return { replies, events: await getEventLogs() };
    }
    if (isStandbyPhrase(text)) {
      if (!(await isMuted(groupId))) {
        await setWaitingFlag(groupId, true);
      }
      return { replies, events: await getEventLogs() };
    }
    if (text === '小助手這題我更正') {
      replies.push(...(await handleConsultantCorrection(groupId, message.userId)));
      return { replies, events: await getEventLogs() };
    }
    if (text === '這篇要改') {
      replies.push(...(await handlePauseKnowledgeCard(groupId, message.userId)));
      return { replies, events: await getEventLogs() };
    }
    if (isClosingSignal(text)) {
      await handleClosingSignal(groupId, message.userId, text);
      return { replies, events: await getEventLogs() };
    }

    const naturalReplies = await handleConsultantNaturalLanguage({
      userId: message.userId,
      text,
      groupId,
      isGroup: true,
    });
    if (naturalReplies) {
      replies.push(...naturalReplies);
      return { replies, events: await getEventLogs() };
    }

    const activeThread = await getActiveIssueThread(groupId);
    if (
      activeThread &&
      activeThread.state === ThreadState.CONSULTANT_HANDOFF &&
      text.length > 0
    ) {
      await markConsultantAnswered(groupId, activeThread.issueThreadId);
    }
  } else if (isClosingSignal(text)) {
    return { replies: [], events: await getEventLogs() };
  }

  if (isNannyPeriodApproximatePhrase(text)) {
    return { replies, events: await getEventLogs() };
  }

  if (!isConsultant) {
    replies.push(...(await handleCustomerQuestion(groupId, message.userId, text)));
  }

  return { replies, events: await getEventLogs() };
}

export { settleGroupTimeouts };
