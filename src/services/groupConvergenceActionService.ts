import {
  Actor,
  BotReply,
  CUSTOMER_HANDOFF_BUFFER_MESSAGE,
  EventType,
  RiskLevel,
  ThreadState,
} from '../types';
import { KnowledgeCard } from '../schemas/knowledgeCardSchema';
import { createEvent } from './eventLogService';
import {
  executeHandoff,
  handleKnowledgeMiss,
} from './consultantHandoffService';
import { isOfficialCsCard } from './knowledgeBaseService';
import { buildOfficialCsAnswer } from './officialCsService';
import { updateIssueThread } from './issueThreadService';
import {
  buildPublicAnswer,
  routeByRisk,
} from './riskRouter';
import {
  classifyCustomerQuestion,
  resolveCardFromClassification,
  SemanticClassification,
} from './groupSemanticRoutingService';
import {
  getClarifyRound,
  incrementClarifyRound,
  transitionState,
} from './stateMachine';
import { highRiskHandoffReason } from './groupHighRiskService';
import { getIssueThread } from './issueThreadService';
import { shouldSkipAutoReplyForThread } from './roundQuietService';

const CHITCHAT_REPLY = '收到，若之後有操作使用上的問題，歡迎直接在群組描述喔。';

function withCustomerBufferMessage(replies: BotReply[]): BotReply[] {
  const hasBuffer = replies.some(
    (r) => r.type === 'group' && r.text === CUSTOMER_HANDOFF_BUFFER_MESSAGE
  );
  if (hasBuffer) {
    return replies;
  }
  return [{ type: 'group', text: CUSTOMER_HANDOFF_BUFFER_MESSAGE }, ...replies];
}

async function applyPublicAnswer(params: {
  groupId: string;
  issueThreadId: string;
  card: KnowledgeCard;
}): Promise<BotReply[]> {
  const answer = buildPublicAnswer(params.card.standard_answer);
  await transitionState({
    groupId: params.groupId,
    issueThreadId: params.issueThreadId,
    toState: ThreadState.AI_ANSWERING,
    actor: Actor.BOT,
    detail: 'low risk public answer',
  });
  await updateIssueThread(params.groupId, params.issueThreadId, {
    lastKnowledgeCardId: params.card.card_id,
    customerQuestion: params.card.title,
  });
  await createEvent({
    event_type: EventType.KNOWLEDGE_HIT,
    group_id: params.groupId,
    issue_thread_id: params.issueThreadId,
    actor: Actor.BOT,
    risk_level: params.card.risk_level,
    knowledge_card_id: params.card.card_id,
  });
  await createEvent({
    event_type: EventType.AI_ANSWER,
    group_id: params.groupId,
    issue_thread_id: params.issueThreadId,
    actor: Actor.BOT,
    risk_level: params.card.risk_level,
    knowledge_card_id: params.card.card_id,
    detail: answer,
  });
  return [{ type: 'group', text: answer }];
}

async function applyClarify(params: {
  groupId: string;
  issueThreadId: string;
  question: string;
  clarifyRound: number;
}): Promise<BotReply[]> {
  await incrementClarifyRound(params.groupId, params.issueThreadId);
  await transitionState({
    groupId: params.groupId,
    issueThreadId: params.issueThreadId,
    toState: ThreadState.AI_CLARIFYING,
    actor: Actor.BOT,
    detail: `clarify round ${params.clarifyRound + 1}`,
  });
  return [{ type: 'group', text: params.question }];
}

/** 群組收斂 handoff 一律只通知 fallback admin */
const GROUP_CONVERGENCE_HANDOFF_NOTIFY = 'fallback_admin' as const;

async function applyHandoff(params: {
  groupId: string;
  issueThreadId: string;
  customerQuestion: string;
  card: KnowledgeCard | null;
  reason: string;
  riskLevel: RiskLevel;
  actorUserId: string;
}): Promise<BotReply[]> {
  if (params.card) {
    await createEvent({
      event_type: EventType.KNOWLEDGE_HIT,
      group_id: params.groupId,
      issue_thread_id: params.issueThreadId,
      actor: Actor.BOT,
      risk_level: params.riskLevel,
      knowledge_card_id: params.card.card_id,
    });
  }
  const handoff = await executeHandoff({
    groupId: params.groupId,
    issueThreadId: params.issueThreadId,
    customerQuestion: params.customerQuestion,
    card: params.card,
    reason: params.reason,
    riskLevel: params.riskLevel,
    actorUserId: params.actorUserId,
    notifyTarget: GROUP_CONVERGENCE_HANDOFF_NOTIFY,
  });
  return withCustomerBufferMessage(handoff.replies);
}

export async function applyConvergedQuestion(params: {
  groupId: string;
  issueThreadId: string;
  customerUserId: string;
  question: string;
  options?: {
    forceHighRiskHandoff?: boolean;
    highRiskText?: string;
  };
}): Promise<BotReply[]> {
  const clarifyRound = await getClarifyRound(params.groupId, params.issueThreadId);
  await updateIssueThread(params.groupId, params.issueThreadId, {
    customerQuestion: params.question,
  });

  if (params.options?.forceHighRiskHandoff) {
    return applyHandoff({
      groupId: params.groupId,
      issueThreadId: params.issueThreadId,
      customerQuestion: params.question,
      card: null,
      reason: highRiskHandoffReason(params.options.highRiskText ?? params.question),
      riskLevel: RiskLevel.HIGH,
      actorUserId: params.customerUserId,
    });
  }

  const classification = await classifyCustomerQuestion(params.question, { clarifyRound });
  return applySemanticClassification({
    ...params,
    classification,
    clarifyRound,
  });
}

export async function applySemanticClassification(params: {
  groupId: string;
  issueThreadId: string;
  customerUserId: string;
  question: string;
  classification: SemanticClassification;
  clarifyRound: number;
}): Promise<BotReply[]> {
  const { classification, clarifyRound } = params;

  const thread = await getIssueThread(params.groupId, params.issueThreadId);
  if (thread && shouldSkipAutoReplyForThread(thread)) {
    return [];
  }

  if (classification.isChitchat) {
    return [{ type: 'group', text: CHITCHAT_REPLY }];
  }

  if (!classification.intentClear) {
    if (clarifyRound >= 2) {
      return applyHandoff({
        groupId: params.groupId,
        issueThreadId: params.issueThreadId,
        customerQuestion: params.question,
        card: resolveCardFromClassification(classification),
        reason: '釐清 2 輪後仍無法收斂',
        riskLevel: RiskLevel.UNKNOWN,
        actorUserId: params.customerUserId,
      });
    }
    const clarifyQuestion =
      classification.clarifyQuestion?.trim() ||
      '想再確認一下，您是指哪個功能或哪個步驟呢？';
    return applyClarify({
      groupId: params.groupId,
      issueThreadId: params.issueThreadId,
      question: clarifyQuestion,
      clarifyRound,
    });
  }

  const card = resolveCardFromClassification(classification);

  if (!card || classification.confidence === 'low') {
    await createEvent({
      event_type: EventType.KNOWLEDGE_MISS,
      group_id: params.groupId,
      issue_thread_id: params.issueThreadId,
      actor: Actor.SYSTEM,
      actor_user_id: params.customerUserId,
      detail: params.question,
    });
    await createEvent({
      event_type: EventType.UNKNOWN_QUESTION,
      group_id: params.groupId,
      issue_thread_id: params.issueThreadId,
      actor: Actor.SYSTEM,
      actor_user_id: params.customerUserId,
      detail: params.question,
    });
    return applyHandoff({
      groupId: params.groupId,
      issueThreadId: params.issueThreadId,
      customerQuestion: params.question,
      card: null,
      reason: '店家問題明確，但知識庫無對應卡，建議整理新卡',
      riskLevel: RiskLevel.UNKNOWN,
      actorUserId: params.customerUserId,
    });
  }

  if (isOfficialCsCard(card)) {
    const csAnswer = buildOfficialCsAnswer(card);
    await createEvent({
      event_type: EventType.OFFICIAL_CS_REDIRECT,
      group_id: params.groupId,
      issue_thread_id: params.issueThreadId,
      actor: Actor.BOT,
      knowledge_card_id: card.card_id,
    });
    return [{ type: 'group', text: csAnswer }];
  }

  if (
    classification.confidence === 'high' &&
    card.risk_level === RiskLevel.LOW &&
    card.can_public_reply
  ) {
    return applyPublicAnswer({
      groupId: params.groupId,
      issueThreadId: params.issueThreadId,
      card,
    });
  }

  const routed = routeByRisk(card, params.question);
  if (routed.type === 'public_answer') {
    return applyPublicAnswer({
      groupId: params.groupId,
      issueThreadId: params.issueThreadId,
      card,
    });
  }

  if (routed.type === 'handoff') {
    return applyHandoff({
      groupId: params.groupId,
      issueThreadId: params.issueThreadId,
      customerQuestion: params.question,
      card,
      reason: routed.reason,
      riskLevel: routed.riskLevel,
      actorUserId: params.customerUserId,
    });
  }

  await transitionState({
    groupId: params.groupId,
    issueThreadId: params.issueThreadId,
    toState: ThreadState.CONSULTANT_HANDOFF,
    actor: Actor.SYSTEM,
    detail: 'knowledge miss after semantic routing',
  });
  return withCustomerBufferMessage(
    await handleKnowledgeMiss({
      groupId: params.groupId,
      issueThreadId: params.issueThreadId,
      question: params.question,
      actorUserId: params.customerUserId,
      notifyTarget: GROUP_CONVERGENCE_HANDOFF_NOTIFY,
    })
  );
}

export async function applyClarifyFollowUp(params: {
  groupId: string;
  issueThreadId: string;
  customerUserId: string;
  previousQuestion: string;
  followUpText: string;
}): Promise<BotReply[]> {
  const combined = [params.previousQuestion, params.followUpText].filter(Boolean).join('\n');
  const clarifyRound = await getClarifyRound(params.groupId, params.issueThreadId);
  const classification = await classifyCustomerQuestion(combined, { clarifyRound });
  return applySemanticClassification({
    groupId: params.groupId,
    issueThreadId: params.issueThreadId,
    customerUserId: params.customerUserId,
    question: combined,
    classification,
    clarifyRound,
  });
}
