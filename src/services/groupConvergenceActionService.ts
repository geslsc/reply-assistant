import {
  Actor,
  BotReply,
  CUSTOMER_HANDOFF_BUFFER_MESSAGE,
  ConvergenceStateRef,
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
import { getIssueThread, updateIssueThread } from './issueThreadService';
import {
  buildPublicAnswer,
  routeByRisk,
} from './riskRouter';
import { resolveThread } from './issueThreadService';
import {
  classifyCustomerQuestion,
  rankCandidatesForQuestion,
  resolveCardFromClassification,
  SemanticClassification,
} from './groupSemanticRoutingService';
import {
  getClarifyRound,
  incrementClarifyRound,
  transitionState,
} from './stateMachine';
import { highRiskHandoffReason } from './groupHighRiskService';
import { shouldSkipAutoReplyForThread } from './roundQuietService';
import {
  hasCandidateSetNarrowed,
  isNoInformationReply,
  isVagueGroupQuestion,
  narrowCandidatesWithinPreviousSet,
  parseOptionSelection,
  rankEnhancedCardCandidates,
  ScoredCardCandidate,
  shouldImmediateHandoffForCard,
} from './groupEnhancedCardMatchingService';
import {
  buildRound1ClarifyMessage,
  buildRound2ClarifyMessage,
  buildRound3ClarifyMessage,
  getConvergenceState,
  resolveOptionCard,
} from './groupConvergenceStateService';
import {
  buildChitchatReply,
  buildQuestionOpeningReply,
  hasOperationalQuestionClues,
  isQuestionOpeningMessage,
  isPureChitchatMessage,
} from './groupConversationToneService';
import {
  CUSTOMER_OPERATION_STUCK_HANDOFF_MESSAGE,
  assertHandoffCopyCompliance,
  resolveHandoffCustomerMessage,
} from './groupReplyCopyService';

const MAX_CLARIFY_ROUNDS = 3;

const OPERATIONAL_QUESTION_PATTERN =
  /(怎麼|如何|在哪|哪裡|設定|新增|調整|修改|開啟|關閉|建立|操作|使用|預約|服務項目|價格|店家資料|logo|儲值|票券|會員|結帳|後台)/u;

function isLikelyOperationalQuestion(question: string): boolean {
  const trimmed = question.trim();
  if (trimmed.length < 4) {
    return false;
  }
  return OPERATIONAL_QUESTION_PATTERN.test(trimmed);
}

function buildNoCandidateClarifyQuestion(question: string, clarifyRound: number): string {
  if (/儲值/u.test(question)) {
    return [
      '我想先確認一下，你問的「儲值」比較接近哪一種情況？',
      '',
      '請補充你現在想處理的是：設定或開啟儲值卡功能、建立儲值方案或規則，還是某筆儲值金額 / 入帳 / 退款 / 交易狀態。',
      '',
      '如果是實際金額、入帳、退款或交易個案，我會整理給導入教練確認喔。',
    ].join('\n');
  }

  if (clarifyRound <= 1) {
    return [
      '我想先確認一下你要操作的情境。',
      '',
      '可以補充你現在在哪個畫面、想設定什麼功能，或目前卡在哪一步嗎？',
    ].join('\n');
  }

  return [
    '我還需要再確認一點細節，才不會回錯方向。',
    '',
    '請補充你看到的畫面名稱、按鈕名稱，或你原本想完成的動作。',
  ].join('\n');
}

async function clarifyUnknownOperationalQuestion(params: {
  groupId: string;
  issueThreadId: string;
  question: string;
  clarifyRound: number;
}): Promise<BotReply[]> {
  return applyClarify({
    groupId: params.groupId,
    issueThreadId: params.issueThreadId,
    question: buildNoCandidateClarifyQuestion(params.question, params.clarifyRound),
    clarifyRound: params.clarifyRound,
    convergenceState: {
      candidateCardIds: [],
    },
  });
}

function withCustomerBufferMessage(replies: BotReply[], customerQuestion: string): BotReply[] {
  const handoffMessage = resolveHandoffCustomerMessage(customerQuestion);
  assertHandoffCopyCompliance(handoffMessage);
  const hasBuffer = replies.some(
    (r) =>
      r.type === 'group' &&
      (r.text === CUSTOMER_HANDOFF_BUFFER_MESSAGE ||
        r.text === CUSTOMER_OPERATION_STUCK_HANDOFF_MESSAGE)
  );
  if (hasBuffer) {
    return replies;
  }
  return [{ type: 'group', text: handoffMessage }, ...replies];
}

async function handlePureChitchatReply(params: {
  groupId: string;
  issueThreadId: string;
  question: string;
}): Promise<BotReply[]> {
  const thread = await getIssueThread(params.groupId, params.issueThreadId);
  const count = thread?.pureChitchatCount ?? 0;
  if (count >= 2) {
    await resolveThread(params.groupId, params.issueThreadId);
    return [];
  }

  const round = (count + 1) as 1 | 2;
  await updateIssueThread(params.groupId, params.issueThreadId, {
    pureChitchatCount: count + 1,
  });
  return [{ type: 'group', text: await buildChitchatReply(params.question, round) }];
}

async function persistConvergenceState(
  groupId: string,
  issueThreadId: string,
  state: ConvergenceStateRef | null
): Promise<void> {
  await updateIssueThread(groupId, issueThreadId, { convergenceState: state });
}

async function applyPublicAnswer(params: {
  groupId: string;
  issueThreadId: string;
  card: KnowledgeCard;
  customerQuestion?: string;
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
    customerQuestion: params.customerQuestion ?? params.card.title,
    convergenceState: null,
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
  convergenceState?: ConvergenceStateRef | null;
}): Promise<BotReply[]> {
  await incrementClarifyRound(params.groupId, params.issueThreadId);
  await transitionState({
    groupId: params.groupId,
    issueThreadId: params.issueThreadId,
    toState: ThreadState.AI_CLARIFYING,
    actor: Actor.BOT,
    detail: `clarify round ${params.clarifyRound + 1}`,
  });
  if (params.convergenceState) {
    await persistConvergenceState(params.groupId, params.issueThreadId, params.convergenceState);
  }
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
  await updateIssueThread(params.groupId, params.issueThreadId, { convergenceState: null });
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
  return withCustomerBufferMessage(handoff.replies, params.customerQuestion);
}

async function applyResolvedCard(params: {
  groupId: string;
  issueThreadId: string;
  customerUserId: string;
  customerQuestion: string;
  card: KnowledgeCard;
}): Promise<BotReply[]> {
  if (isOfficialCsCard(params.card)) {
    const csAnswer = buildOfficialCsAnswer(params.card);
    await createEvent({
      event_type: EventType.OFFICIAL_CS_REDIRECT,
      group_id: params.groupId,
      issue_thread_id: params.issueThreadId,
      actor: Actor.BOT,
      knowledge_card_id: params.card.card_id,
    });
    await updateIssueThread(params.groupId, params.issueThreadId, { convergenceState: null });
    return [{ type: 'group', text: csAnswer }];
  }

  if (params.card.risk_level === RiskLevel.LOW && params.card.can_public_reply) {
    return applyPublicAnswer({
      groupId: params.groupId,
      issueThreadId: params.issueThreadId,
      card: params.card,
      customerQuestion: params.customerQuestion,
    });
  }

  return applyHandoff({
    groupId: params.groupId,
    issueThreadId: params.issueThreadId,
    customerQuestion: params.customerQuestion,
    card: params.card,
    reason: '命中知識卡但不可公開自動回覆',
    riskLevel: params.card.risk_level,
    actorUserId: params.customerUserId,
  });
}

async function startConvergenceRound1(params: {
  groupId: string;
  issueThreadId: string;
  question: string;
  candidates: ScoredCardCandidate[];
  clarifyRound: number;
}): Promise<BotReply[]> {
  const message = await buildRound1ClarifyMessage({
    question: params.question,
    candidates: params.candidates,
  });
  return applyClarify({
    groupId: params.groupId,
    issueThreadId: params.issueThreadId,
    question: message,
    clarifyRound: params.clarifyRound,
    convergenceState: {
      candidateCardIds: params.candidates.map((item) => item.card.card_id),
    },
  });
}

async function startConvergenceRound2(params: {
  groupId: string;
  issueThreadId: string;
  question: string;
  candidates: ScoredCardCandidate[];
  clarifyRound: number;
}): Promise<BotReply[]> {
  const round2 = await buildRound2ClarifyMessage({
    question: params.question,
    candidates: params.candidates,
  });
  return applyClarify({
    groupId: params.groupId,
    issueThreadId: params.issueThreadId,
    question: round2.message,
    clarifyRound: params.clarifyRound,
    convergenceState: {
      candidateCardIds: params.candidates.map((item) => item.card.card_id),
      round2Options: round2.options,
    },
  });
}

async function startConvergenceRound3(params: {
  groupId: string;
  issueThreadId: string;
  question: string;
  candidates: ScoredCardCandidate[];
  clarifyRound: number;
  round2Options: ConvergenceStateRef['round2Options'];
}): Promise<BotReply[]> {
  const round3 = await buildRound3ClarifyMessage({
    question: params.question,
    candidates: params.candidates,
  });
  return applyClarify({
    groupId: params.groupId,
    issueThreadId: params.issueThreadId,
    question: round3.message,
    clarifyRound: params.clarifyRound,
    convergenceState: {
      candidateCardIds: params.candidates.map((item) => item.card.card_id),
      round2Options: params.round2Options,
      round3Options: round3.options,
    },
  });
}

async function resolveCandidatesFromState(
  question: string,
  state: ConvergenceStateRef | null
): Promise<ScoredCardCandidate[]> {
  const ranked = await rankEnhancedCardCandidates(question);
  if (!state?.candidateCardIds?.length) {
    return ranked;
  }
  const allowed = new Set(state.candidateCardIds);
  return ranked.filter((item) => allowed.has(item.card.card_id));
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

  if (isQuestionOpeningMessage(params.question)) {
    await resolveThread(params.groupId, params.issueThreadId);
    return [{ type: 'group', text: buildQuestionOpeningReply() }];
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

  if (
    (classification.isChitchat || isPureChitchatMessage(params.question)) &&
    !hasOperationalQuestionClues(params.question)
  ) {
    return handlePureChitchatReply({
      groupId: params.groupId,
      issueThreadId: params.issueThreadId,
      question: params.question,
    });
  }

  await updateIssueThread(params.groupId, params.issueThreadId, {
    pureChitchatCount: 0,
  });

  const candidates = await rankCandidatesForQuestion(params.question);

  if (classification.requiresConvergence || !classification.intentClear) {
    if (clarifyRound > MAX_CLARIFY_ROUNDS) {
      return applyHandoff({
        groupId: params.groupId,
        issueThreadId: params.issueThreadId,
        customerQuestion: params.question,
        card: resolveCardFromClassification(classification),
        reason: '釐清 3 輪後仍無法收斂',
        riskLevel: RiskLevel.UNKNOWN,
        actorUserId: params.customerUserId,
      });
    }

    if (candidates.length === 0) {
      if (clarifyRound < MAX_CLARIFY_ROUNDS && isVagueGroupQuestion(params.question)) {
        return startConvergenceRound1({
          groupId: params.groupId,
          issueThreadId: params.issueThreadId,
          question: params.question,
          candidates: [],
          clarifyRound,
        });
      }
      if (clarifyRound < MAX_CLARIFY_ROUNDS && isLikelyOperationalQuestion(params.question)) {
        return clarifyUnknownOperationalQuestion({
          groupId: params.groupId,
          issueThreadId: params.issueThreadId,
          question: params.question,
          clarifyRound,
        });
      }
      return applyHandoff({
        groupId: params.groupId,
        issueThreadId: params.issueThreadId,
        customerQuestion: params.question,
        card: null,
        reason: '店家問題模糊，且知識庫無可用候選卡',
        riskLevel: RiskLevel.UNKNOWN,
        actorUserId: params.customerUserId,
      });
    }

    if (clarifyRound === 0) {
      return startConvergenceRound1({
        groupId: params.groupId,
        issueThreadId: params.issueThreadId,
        question: params.question,
        candidates,
        clarifyRound,
      });
    }

    if (clarifyRound === 1) {
      return startConvergenceRound2({
        groupId: params.groupId,
        issueThreadId: params.issueThreadId,
        question: params.question,
        candidates,
        clarifyRound,
      });
    }

    return applyHandoff({
      groupId: params.groupId,
      issueThreadId: params.issueThreadId,
      customerQuestion: params.question,
      card: null,
      reason: '釐清後仍無法收斂',
      riskLevel: RiskLevel.UNKNOWN,
      actorUserId: params.customerUserId,
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
    if (
      clarifyRound < MAX_CLARIFY_ROUNDS &&
      isLikelyOperationalQuestion(params.question)
    ) {
      return clarifyUnknownOperationalQuestion({
        groupId: params.groupId,
        issueThreadId: params.issueThreadId,
        question: params.question,
        clarifyRound,
      });
    }
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

  if (shouldImmediateHandoffForCard(card) && card.risk_level === RiskLevel.HIGH) {
    return applyHandoff({
      groupId: params.groupId,
      issueThreadId: params.issueThreadId,
      customerQuestion: params.question,
      card,
      reason: '高風險問題需導入教練協助',
      riskLevel: card.risk_level,
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
      customerQuestion: params.question,
    });
  }

  const routed = routeByRisk(card, params.question);
  if (routed.type === 'public_answer') {
    return applyPublicAnswer({
      groupId: params.groupId,
      issueThreadId: params.issueThreadId,
      card,
      customerQuestion: params.question,
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
    }),
    params.question
  );
}

export async function applyClarifyFollowUp(params: {
  groupId: string;
  issueThreadId: string;
  customerUserId: string;
  previousQuestion: string;
  followUpText: string;
}): Promise<BotReply[]> {
  const thread = await getIssueThread(params.groupId, params.issueThreadId);
  if (thread && shouldSkipAutoReplyForThread(thread)) {
    return [];
  }

  const clarifyRound = await getClarifyRound(params.groupId, params.issueThreadId);
  const combined = [params.previousQuestion, params.followUpText].filter(Boolean).join('\n');
  const convergenceState = getConvergenceState(thread);

  await updateIssueThread(params.groupId, params.issueThreadId, {
    customerQuestion: combined,
  });

  if (clarifyRound > MAX_CLARIFY_ROUNDS) {
    return applyHandoff({
      groupId: params.groupId,
      issueThreadId: params.issueThreadId,
      customerQuestion: combined,
      card: null,
      reason: '釐清 3 輪後仍無法收斂',
      riskLevel: RiskLevel.UNKNOWN,
      actorUserId: params.customerUserId,
    });
  }

  if (clarifyRound === 1) {
    const classification = await classifyCustomerQuestion(combined, { clarifyRound });
    if (classification.intentClear && classification.cardId) {
      const card = resolveCardFromClassification(classification);
      if (card) {
        return applyResolvedCard({
          groupId: params.groupId,
          issueThreadId: params.issueThreadId,
          customerUserId: params.customerUserId,
          customerQuestion: combined,
          card,
        });
      }
    }

    const candidates = await resolveCandidatesFromState(combined, convergenceState);
    if (candidates.length === 0) {
      if (
        clarifyRound < MAX_CLARIFY_ROUNDS &&
        isLikelyOperationalQuestion(combined) &&
        !isNoInformationReply(params.followUpText)
      ) {
        return clarifyUnknownOperationalQuestion({
          groupId: params.groupId,
          issueThreadId: params.issueThreadId,
          question: combined,
          clarifyRound,
        });
      }
      return applyHandoff({
        groupId: params.groupId,
        issueThreadId: params.issueThreadId,
        customerQuestion: combined,
        card: null,
        reason: '釐清後仍無可用候選卡',
        riskLevel: RiskLevel.UNKNOWN,
        actorUserId: params.customerUserId,
      });
    }
    return startConvergenceRound2({
      groupId: params.groupId,
      issueThreadId: params.issueThreadId,
      question: combined,
      candidates,
      clarifyRound,
    });
  }

  if (clarifyRound === 2) {
    const round2Options = convergenceState?.round2Options ?? [];
    const selection = parseOptionSelection(params.followUpText, round2Options.length);
    if (selection) {
      const card = resolveOptionCard(round2Options, selection);
      if (!card) {
        return applyHandoff({
          groupId: params.groupId,
          issueThreadId: params.issueThreadId,
          customerQuestion: combined,
          card: null,
          reason: '選項對應的知識卡不存在',
          riskLevel: RiskLevel.UNKNOWN,
          actorUserId: params.customerUserId,
        });
      }
      return applyResolvedCard({
        groupId: params.groupId,
        issueThreadId: params.issueThreadId,
        customerUserId: params.customerUserId,
        customerQuestion: combined,
        card,
      });
    }

    if (isNoInformationReply(params.followUpText)) {
      return applyHandoff({
        groupId: params.groupId,
        issueThreadId: params.issueThreadId,
        customerQuestion: combined,
        card: null,
        reason: '店家未提供可縮小候選卡範圍的新資訊',
        riskLevel: RiskLevel.UNKNOWN,
        actorUserId: params.customerUserId,
      });
    }

    const previousIds = convergenceState?.candidateCardIds ?? [];
    const followUpCandidates = await rankEnhancedCardCandidates(params.followUpText);
    const narrowedCandidates = narrowCandidatesWithinPreviousSet({
      followUpText: params.followUpText,
      previousIds,
      candidates: followUpCandidates,
    });
    const nextIds = narrowedCandidates.map((item) => item.card.card_id);

    if (narrowedCandidates.length === 1) {
      return applyResolvedCard({
        groupId: params.groupId,
        issueThreadId: params.issueThreadId,
        customerUserId: params.customerUserId,
        customerQuestion: combined,
        card: narrowedCandidates[0].card,
      });
    }

    if (!hasCandidateSetNarrowed(previousIds, nextIds) || narrowedCandidates.length < 2) {
      return applyHandoff({
        groupId: params.groupId,
        issueThreadId: params.issueThreadId,
        customerQuestion: combined,
        card: null,
        reason: '補充描述未能縮小候選卡範圍',
        riskLevel: RiskLevel.UNKNOWN,
        actorUserId: params.customerUserId,
      });
    }

    return startConvergenceRound3({
      groupId: params.groupId,
      issueThreadId: params.issueThreadId,
      question: combined,
      candidates: narrowedCandidates.slice(0, 3),
      clarifyRound,
      round2Options,
    });
  }

  if (clarifyRound === 3) {
    const round3Options = convergenceState?.round3Options ?? [];
    const selection = parseOptionSelection(params.followUpText, round3Options.length);
    if (selection) {
      const card = resolveOptionCard(round3Options, selection);
      if (!card) {
        return applyHandoff({
          groupId: params.groupId,
          issueThreadId: params.issueThreadId,
          customerQuestion: combined,
          card: null,
          reason: '第三輪選項對應的知識卡不存在',
          riskLevel: RiskLevel.UNKNOWN,
          actorUserId: params.customerUserId,
        });
      }
      return applyResolvedCard({
        groupId: params.groupId,
        issueThreadId: params.issueThreadId,
        customerUserId: params.customerUserId,
        customerQuestion: combined,
        card,
      });
    }

    return applyHandoff({
      groupId: params.groupId,
      issueThreadId: params.issueThreadId,
      customerQuestion: combined,
      card: null,
      reason: '第三輪後仍無法收斂',
      riskLevel: RiskLevel.UNKNOWN,
      actorUserId: params.customerUserId,
    });
  }

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
