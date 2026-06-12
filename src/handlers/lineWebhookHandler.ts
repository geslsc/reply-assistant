import {
  Actor,
  BotReply,
  CLOSING_SIGNALS,
  ConsultantStatus,
  ProcessResult,
  REOPEN_SIGNALS,
  ThreadState,
} from '../types';
import { logger } from '../config/logger';
import {
  approveConsultant,
  getActiveAdmins,
  isActiveAdmin,
  isActiveConsultantOrAdmin,
  requestConsultantJoin,
  validateConsultantInvite,
} from '../services/consultantWhitelist';
import { getEventLogs, logStateTransition } from '../services/eventLogService';
import { getGroupFlags, isMuted } from '../services/groupFlags';
import { handleKnowledgeCardCommand } from '../services/knowledgeCardCommandService';
import {
  expireStaleSessionIfNeeded,
  handleDmSessionPrivateMessage,
} from '../services/dmSessionService';
import { appendBackupReminderIfNeeded } from '../services/knowledgeCardBackupReminderService';
import { handleConsultantNaturalLanguage } from '../services/consultantActionService';
import {
  GROUP_ASSISTANT_COMMANDS,
  getDeprecatedSyntaxHint,
  isGroupCustomerUsageGuideRequest,
  normalizeGroupAssistantCommand,
  startsWithAssistantPrefix,
} from '../services/groupAssistantCommandService';
import {
  handleAssistantCorrection,
  onConsultantHumanReplyDuringCorrection,
  onThreadClosedAfterCorrection,
} from '../services/consultantCorrectionService';
import { handleCustomerTeachingFollowUp } from '../services/customerTeachingFollowUpService';
import { handlePrivateCodeNavigation } from '../services/privateCodeNavigationService';
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
import { isIntroFollowUpQuestion } from '../services/groupReplyCopyService';
import {
  classifyConsultantIntent,
  ConsultantIntent,
  isConsultantPrivateAiIntent,
  isDirectExecuteIntent,
  isNannyPeriodApproximatePhrase,
  requiresConfirmation,
} from '../services/consultantIntentClassifier';
import {
  consumePrivateFallbackHint,
  SIMPLIFIED_PRIVATE_FALLBACK_HINT,
} from '../services/privateFallbackHintService';
import { handleConsultantMute } from '../services/consultantGroupControlService';
import {
  getActiveIssueThread,
  getThreadsByGroup,
  hasSubstantiveAnswer,
  markConsultantAnswered,
  reopenThread,
  resolveThread,
} from '../services/issueThreadService';
import { settleGroupTimeouts } from '../services/passiveTimeoutSettlement';
import {
  handleIncomingCustomerGroupMessage,
  resolveCollectingBuffersForThread,
  settleExpiredGroupBuffers,
} from '../services/groupMessageConvergenceService';
import {
  handleServiceIntroduction,
  handleServiceReactivationDirect,
  isOutOfService,
} from '../services/servicePeriodService';
import { handleApplyConsultant, APPLY_CONSULTANT_PHRASE, approveApplicationByCode } from '../services/consultantApplicationService';
import { getRepos } from '../repositories';
import { handleConsultantManagementCommand } from '../services/consultantManagementService';
import {
  handleGroupAdminCommand,
  rejectConsultantGroupList,
} from '../services/groupConsultantAdminService';
import { handleMyServiceGroups, MY_SERVICE_GROUPS_PHRASE } from '../services/consultantServiceGroupsService';
import {
  ensureGroupAssignment,
  handleGroupConsultantSideEffects,
  updateLastCustomerMessageAt,
} from '../services/groupConsultantAssignmentService';
import { handleDisabledConsultantGroupCommand } from '../services/disabledConsultantGroupService';
import { maybeSendServicePeriodEndedMessage } from '../services/servicePeriodEndMessageService';
import { refreshGroupNameIfNeeded } from '../services/lineGroupSummaryService';
import { enableRoundQuietForGroup, isRoundQuietPhrase } from '../services/roundQuietService';
import { buildPrivateCommandKeywordHint } from '../services/privateCommandHintService';

export interface IncomingMessage {
  userId: string;
  groupId?: string;
  text: string;
  isGroup: boolean;
  isBotMentioned?: boolean;
  messageId?: string;
  replyToken?: string;
  quotedMessageId?: string;
  timestamp?: string;
  sourceType?: 'group' | 'user';
}

const CONSULTANT_JOIN_PATTERN = /^加入顧問\s+(\S+)$/;
const APPROVE_CONSULTANT_PATTERN = /^核准顧問\s+(\S+)$/;

function buildUnknownPrivateCommandReply(userId: string, isAdmin: boolean): BotReply {
  const lines = [
    '我目前沒有判讀到可執行的指令。',
    '',
    '可先試：',
    '- 使用說明',
    isAdmin ? '- 群組清單' : '- 我的服務群組',
    '- 查詢服務期 [群組名稱或 G-xx]',
  ];
  return { type: 'push', userId, text: lines.join('\n') };
}

function isClosingSignal(text: string): boolean {
  const trimmed = text.trim();
  return CLOSING_SIGNALS.some((s) => trimmed === s);
}

function isReopenSignal(text: string): boolean {
  return REOPEN_SIGNALS.some((s) => text.includes(s));
}

const CONSULTANT_ONBOARDING_PATTERNS: RegExp[] = [
  /^(老師好|老師|大家|各位|店家|您好|你好|哈囉|嗨)[，,\s]*(我是|我這邊是).{0,30}(導入|教練|顧問|客服|客立樂|iCHEF|POS)/iu,
  /^(我是|我這邊是).{0,30}(導入|教練|顧問|客服|客立樂|iCHEF|POS)/iu,
  /(自我介紹|介紹一下小助手|跟店家介紹小助手)/u,
];

function isConsultantNonTakeoverMessage(text: string): boolean {
  const trimmed = text.trim();
  if (!trimmed) {
    return true;
  }

  if (startsWithAssistantPrefix(trimmed) || normalizeGroupAssistantCommand(trimmed)) {
    return true;
  }

  const { intent } = classifyConsultantIntent(trimmed);
  if (
    intent !== ConsultantIntent.UNKNOWN &&
    (isDirectExecuteIntent(intent) ||
      isConsultantPrivateAiIntent(intent) ||
      requiresConfirmation(intent) ||
      intent === ConsultantIntent.ENABLE_NANNY_PERIOD)
  ) {
    return true;
  }

  return CONSULTANT_ONBOARDING_PATTERNS.some((pattern) => pattern.test(trimmed));
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
  const issueThreadId = thread.issueThreadId;
  await resolveCollectingBuffersForThread(groupId, issueThreadId);
  await resolveThread(groupId, issueThreadId);
  await logStateTransition({
    group_id: groupId,
    issue_thread_id: issueThreadId,
    from_state: fromState,
    to_state: ThreadState.IDLE,
    actor: Actor.CONSULTANT,
    actor_user_id: userId,
    detail: `closing signal: ${text.trim()}`,
  });
  return onThreadClosedAfterCorrection(groupId, issueThreadId);
}

async function resolveHumanTakeoverThreadOnResume(
  groupId: string,
  userId: string,
  options?: { force?: boolean }
): Promise<void> {
  const thread = await getActiveIssueThread(groupId);
  if (
    !thread ||
    (!options?.force && !thread.consultantAnswered && !thread.autoReplyBlocked)
  ) {
    return;
  }

  await resolveCollectingBuffersForThread(groupId, thread.issueThreadId);
  await resolveThread(groupId, thread.issueThreadId);
  await logStateTransition({
    group_id: groupId,
    issue_thread_id: thread.issueThreadId,
    from_state: thread.state,
    to_state: ThreadState.IDLE,
    actor: Actor.CONSULTANT,
    actor_user_id: userId,
    detail: 'assistant resumed after consultant takeover',
  });
}

async function ensureServicePeriodForResume(
  groupId: string,
  userId: string,
  options?: { preferIntro?: boolean }
): Promise<BotReply[]> {
  if (!(await isOutOfService(groupId))) {
    return [];
  }
  const flags = await getGroupFlags(groupId);
  if (options?.preferIntro && !flags.serviceStartAt) {
    return handleServiceIntroduction(groupId, userId);
  }
  return handleServiceReactivationDirect(groupId, userId);
}

async function handleConsultantHumanTakeover(
  groupId: string,
  userId: string,
  text: string
): Promise<void> {
  if (text.length === 0) {
    return;
  }
  if (isConsultantNonTakeoverMessage(text)) {
    return;
  }
  const thread = await getActiveIssueThread(groupId);
  if (!thread) {
    return;
  }
  await markConsultantAnswered(groupId, thread.issueThreadId);
  await onConsultantHumanReplyDuringCorrection(groupId, text);
}

async function handleCustomerQuestion(
  groupId: string,
  userId: string,
  text: string,
  options?: { messageId?: string; timestamp?: string }
): Promise<BotReply[]> {
  if (await isMuted(groupId)) {
    logger.info('Group customer message skipped', {
      groupId,
      userId,
      reason: 'muted',
    });
    return [];
  }

  const flags = await getGroupFlags(groupId);
  if (flags.mute && flags.waitingFlag) {
    logger.info('Group customer message skipped', {
      groupId,
      userId,
      reason: 'mute_waiting',
    });
    return [];
  }

  if (await isOutOfService(groupId)) {
    if (!text.includes('@') && !text.includes('小助手')) {
      logger.info('Group customer message skipped', {
        groupId,
        userId,
        reason: 'out_of_service_without_mention',
      });
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

  const followUpReplies = await handleCustomerTeachingFollowUp({
    groupId,
    customerUserId: userId,
    text,
  });
  if (followUpReplies) {
    return followUpReplies;
  }

  return handleIncomingCustomerGroupMessage({
    groupId,
    customerUserId: userId,
    text,
    messageId: options?.messageId,
    timestamp: options?.timestamp,
  });
}

async function handlePrivateMessage(message: IncomingMessage): Promise<BotReply[]> {
  const replies: BotReply[] = [];
  const text = message.text.trim();

  logger.info('LINE private message received', { userId: message.userId, text });

  const consultantRecord = await getRepos().consultants.findById(message.userId);
  if (consultantRecord?.status === ConsultantStatus.ACTIVE) {
    try {
      await getRepos().consultants.recordPushSuccess(message.userId, new Date().toISOString());
    } catch (error) {
      logger.warn('Failed to record private inbound delivery health; continuing', {
        userId: message.userId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  if (text === APPLY_CONSULTANT_PHRASE) {
    return handleApplyConsultant({ userId: message.userId });
  }

  const managementReplies = await handleConsultantManagementCommand(message.userId, text);
  if (managementReplies) {
    return managementReplies;
  }

  const groupListReject = await rejectConsultantGroupList(message.userId, text);
  if (groupListReject) {
    return groupListReject;
  }

  const groupAdminReplies = await handleGroupAdminCommand(message.userId, text);
  if (groupAdminReplies) {
    return groupAdminReplies;
  }

  if (text === MY_SERVICE_GROUPS_PHRASE) {
    const serviceGroupReplies = await handleMyServiceGroups(message.userId);
    return serviceGroupReplies ?? [];
  }

  const joinMatch = text.match(CONSULTANT_JOIN_PATTERN);
  if (joinMatch) {
    const validated = await validateConsultantInvite(joinMatch[1]);
    if (!validated.success) {
      return [{ type: 'push', userId: message.userId, text: validated.message }];
    }
    return handleApplyConsultant({ userId: message.userId });
  }

  const approveMatch = text.match(APPROVE_CONSULTANT_PATTERN);
  if (approveMatch) {
    const pending = await getRepos().consultantApplications.findPendingByUserId(approveMatch[1]);
    if (pending) {
      return approveApplicationByCode(message.userId, pending.applicationCode);
    }
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

    const codeNavReplies = await handlePrivateCodeNavigation(message.userId, text);
    if (codeNavReplies) {
      if (await isActiveAdmin(message.userId)) {
        await appendBackupReminderIfNeeded(message.userId, codeNavReplies);
      }
      return codeNavReplies;
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

    const isAdmin = await isActiveAdmin(message.userId);
    const keywordHint = buildPrivateCommandKeywordHint(message.userId, text, isAdmin);
    if (keywordHint) {
      replies.push(keywordHint);
    } else if (
      replies.length === 0 &&
      /^(查詢|列出|查看|小助手|設定|解除|新增|修改|確認|搜尋|找|有沒有)/u.test(text)
    ) {
      replies.push(buildUnknownPrivateCommandReply(message.userId, isAdmin));
    } else if (consumePrivateFallbackHint(message.userId)) {
      replies.push({
        type: 'push',
        userId: message.userId,
        text: SIMPLIFIED_PRIVATE_FALLBACK_HINT,
      });
    }
    if (isAdmin) {
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
  await ensureGroupAssignment(groupId);
  await settleGroupTimeouts(groupId);
  replies.push(...(await settleExpiredGroupBuffers(groupId)));
  replies.push(...(await maybeSendServicePeriodEndedMessage(groupId)));

  const text = message.text.trim();
  const disabledCommandReplies = await handleDisabledConsultantGroupCommand({
    userId: message.userId,
    groupId,
    text,
  });
  if (disabledCommandReplies) {
    return { replies: disabledCommandReplies, events: await getEventLogs() };
  }

  const isConsultant = await isActiveConsultantOrAdmin(message.userId);
  logger.info('Group message classified', {
    groupId,
    userId: message.userId,
    isConsultant,
    textPreview: text.slice(0, 40),
  });

  if (isConsultant) {
    if (isClosingSignal(text)) {
      replies.push(...(await handleClosingSignal(groupId, message.userId, text)));
      return { replies, events: await getEventLogs() };
    }

    const deprecatedHint = getDeprecatedSyntaxHint(text);
    if (deprecatedHint) {
      replies.push({ type: 'group', text: deprecatedHint });
      return { replies, events: await getEventLogs() };
    }

    if (isGroupCustomerUsageGuideRequest(text)) {
      replies.push(...(await handleGroupUsageGuide(groupId, message.userId)));
      return { replies, events: await getEventLogs() };
    }

    if (isRoundQuietPhrase(text)) {
      const enabled = await enableRoundQuietForGroup(groupId);
      if (enabled) {
        replies.push({
          type: 'group',
          text: '好的，這一輪我先保持安靜。下一題開始時會恢復協助。',
        });
      }
      return { replies, events: await getEventLogs() };
    }

    const assistantCommand = normalizeGroupAssistantCommand(text);
    const sideEffectReplies = assistantCommand
      ? await handleGroupConsultantSideEffects({
          groupId,
          userId: message.userId,
          text: assistantCommand,
        })
      : [];

    if (assistantCommand === GROUP_ASSISTANT_COMMANDS.INTRO) {
      replies.push(
        ...(await ensureServicePeriodForResume(groupId, message.userId, { preferIntro: true }))
      );
      if (replies.length === 0) {
        replies.push(...(await handleServiceIntroduction(groupId, message.userId)));
      }
      await resolveHumanTakeoverThreadOnResume(groupId, message.userId);
      replies.push(...sideEffectReplies);
      return { replies, events: await getEventLogs() };
    }
    if (assistantCommand === GROUP_ASSISTANT_COMMANDS.MUTE) {
      replies.push(...(await handleConsultantMute(groupId, message.userId, true)));
      replies.push(...sideEffectReplies);
      return { replies, events: await getEventLogs() };
    }
    if (assistantCommand === GROUP_ASSISTANT_COMMANDS.UNMUTE) {
      replies.push(...(await handleConsultantMute(groupId, message.userId, false)));
      await resolveHumanTakeoverThreadOnResume(groupId, message.userId, { force: true });
      replies.push(...(await ensureServicePeriodForResume(groupId, message.userId)));
      replies.push(...sideEffectReplies);
      return { replies, events: await getEventLogs() };
    }
    if (assistantCommand === GROUP_ASSISTANT_COMMANDS.REACTIVATE) {
      replies.push(...(await handleServiceReactivationDirect(groupId, message.userId)));
      replies.push(...sideEffectReplies);
      return { replies, events: await getEventLogs() };
    }
    if (assistantCommand === GROUP_ASSISTANT_COMMANDS.CORRECTION) {
      replies.push(...(await handleAssistantCorrection(groupId, message.userId)));
      replies.push(...sideEffectReplies);
      return { replies, events: await getEventLogs() };
    }

    const naturalReplies = await handleConsultantNaturalLanguage({
      userId: message.userId,
      groupId,
      text,
      isGroup: true,
    });
    if (naturalReplies) {
      replies.push(...naturalReplies);
      return { replies, events: await getEventLogs() };
    }

    await handleConsultantHumanTakeover(groupId, message.userId, text);
    logger.info('Group consultant message ignored for customer flow', {
      groupId,
      userId: message.userId,
      reason: 'consultant_non_command',
      textPreview: text.slice(0, 40),
    });
    return { replies, events: await getEventLogs() };
  }

  if (isGroupCustomerUsageGuideRequest(text) || isIntroFollowUpQuestion(text)) {
    replies.push(...(await handleGroupUsageGuide(groupId, message.userId)));
    return { replies, events: await getEventLogs() };
  }

  if (getDeprecatedSyntaxHint(text)) {
    return { replies, events: await getEventLogs() };
  }

  if (isClosingSignal(text)) {
    logger.info('Group customer message skipped', {
      groupId,
      userId: message.userId,
      reason: 'closing_signal',
    });
    return { replies: [], events: await getEventLogs() };
  }

  if (isNannyPeriodApproximatePhrase(text)) {
    logger.info('Group customer message skipped', {
      groupId,
      userId: message.userId,
      reason: 'nanny_period_approximate_phrase',
    });
    return { replies, events: await getEventLogs() };
  }

  replies.push(
    ...(await (async () => {
      await updateLastCustomerMessageAt(groupId);
      return handleCustomerQuestion(groupId, message.userId, text, {
        messageId: message.messageId ?? message.replyToken,
        timestamp: message.timestamp,
      });
    })())
  );

  return { replies, events: await getEventLogs() };
}

export { settleGroupTimeouts };
