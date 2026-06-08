import {
  Actor,
  BotReply,
  EventType,
  KnowledgeItem,
  RiskLevel,
  ThreadState,
} from '../types';
import { createEvent } from './eventLogService';
import { getActiveConsultants } from './consultantWhitelist';
import { transitionState } from './stateMachine';
import { updateIssueThread } from './issueThreadService';

export interface HandoffDraft {
  questionSummary: string;
  draft: string;
  reason: string;
  suggestedChecks: string[];
  knowledgeCardId: string | null;
  riskLevel: RiskLevel;
}

export function buildHandoffDraft(params: {
  customerQuestion: string;
  card: KnowledgeItem | null;
  reason: string;
  riskLevel: RiskLevel;
}): HandoffDraft {
  const card = params.card;
  return {
    questionSummary: params.customerQuestion,
    draft: card
      ? `【草稿-選項C】\n${card.standard_answer}\n\n※ 公開時必須逐字貼上顧問確認後草稿，不可重生成、不可潤飾。`
      : '【草稿】知識庫未命中，請顧問補充標準回答。',
    reason: params.reason,
    suggestedChecks: card
      ? ['請確認店家描述與知識卡情境一致', '請確認是否可公開回覆']
      : ['請確認問題是否為新題型', '請補充知識卡或請店家提供更多細節'],
    knowledgeCardId: card?.id ?? null,
    riskLevel: params.riskLevel,
  };
}

export function formatHandoffMessage(draft: HandoffDraft): string {
  return [
    '【問題收斂卡】',
    draft.questionSummary,
    '',
    draft.draft,
    '',
    `【判斷原因】${draft.reason}`,
    '',
    '【建議確認項】',
    ...draft.suggestedChecks.map((c) => `- ${c}`),
  ].join('\n');
}

export async function executeHandoff(params: {
  groupId: string;
  issueThreadId: string;
  customerQuestion: string;
  card: KnowledgeItem | null;
  reason: string;
  riskLevel: RiskLevel;
  actorUserId?: string | null;
}): Promise<{ replies: BotReply[]; draft: HandoffDraft }> {
  const draft = buildHandoffDraft({
    customerQuestion: params.customerQuestion,
    card: params.card,
    reason: params.reason,
    riskLevel: params.riskLevel,
  });

  await transitionState({
    issueThreadId: params.issueThreadId,
    groupId: params.groupId,
    toState: ThreadState.CONSULTANT_HANDOFF,
    actor: Actor.SYSTEM,
    detail: params.reason,
  });

  await updateIssueThread(params.groupId, params.issueThreadId, {
    lastKnowledgeCardId: params.card?.id ?? null,
  });

  await createEvent({
    event_type: EventType.HANDOFF_TO_CONSULTANT,
    group_id: params.groupId,
    issue_thread_id: params.issueThreadId,
    actor: Actor.SYSTEM,
    actor_user_id: params.actorUserId ?? null,
    risk_level: params.riskLevel,
    knowledge_card_id: params.card?.id ?? null,
    detail: params.reason,
  });

  const consultants = await getActiveConsultants();
  const replies: BotReply[] = consultants.map((c) => ({
    type: 'push' as const,
    userId: c.userId,
    text: formatHandoffMessage(draft),
  }));

  return { replies, draft };
}

export async function handleKnowledgeMiss(params: {
  groupId: string;
  issueThreadId: string;
  question: string;
  actorUserId?: string | null;
}): Promise<BotReply[]> {
  await createEvent({
    event_type: EventType.KNOWLEDGE_MISS,
    group_id: params.groupId,
    issue_thread_id: params.issueThreadId,
    actor: Actor.SYSTEM,
    actor_user_id: params.actorUserId ?? null,
    detail: params.question,
  });

  await createEvent({
    event_type: EventType.UNKNOWN_QUESTION,
    group_id: params.groupId,
    issue_thread_id: params.issueThreadId,
    actor: Actor.SYSTEM,
    actor_user_id: params.actorUserId ?? null,
    detail: params.question,
  });

  return (
    await executeHandoff({
      groupId: params.groupId,
      issueThreadId: params.issueThreadId,
      customerQuestion: params.question,
      card: null,
      reason: '知識庫未命中',
      riskLevel: RiskLevel.UNKNOWN,
      actorUserId: params.actorUserId,
    })
  ).replies;
}
