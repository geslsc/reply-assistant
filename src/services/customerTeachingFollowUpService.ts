import { Actor, BotReply, EventType, ThreadState } from '../types';
import { executeHandoff } from './consultantHandoffService';
import { getActiveIssueThread, updateIssueThread } from './issueThreadService';
import { getEventsByType } from './eventLogService';
import { RiskLevel } from '../types';
import { getCardById } from './knowledgeBaseService';
import { transitionState } from './stateMachine';

export const CUSTOMER_TEACHING_FOLLOWUP_BUFFER =
  '我先幫您把狀況記下來，這題我會請導入教練協助確認，請稍等一下喔。';

const FOLLOWUP_PATTERNS: RegExp[] = [
  /還是不行/u,
  /還是一樣/u,
  /我照你說的做還是不行/u,
  /畫面跟你說的不一樣/u,
  /畫面跟您說的不一樣/u,
  /找不到這個按鈕/u,
  /找不到.*按鈕/u,
];

export function isCustomerTeachingFollowUp(text: string): boolean {
  const trimmed = text.trim();
  return FOLLOWUP_PATTERNS.some((pattern) => pattern.test(trimmed));
}

async function getLastBotAnswerForThread(
  groupId: string,
  issueThreadId: string
): Promise<{ answer: string; cardId: string | null } | null> {
  const events = await getEventsByType(EventType.AI_ANSWER);
  const match = events
    .filter((e) => e.group_id === groupId && e.issue_thread_id === issueThreadId)
    .sort((a, b) => b.timestamp.localeCompare(a.timestamp))[0];
  if (!match?.detail) {
    return null;
  }
  return { answer: match.detail, cardId: match.knowledge_card_id };
}

export async function handleCustomerTeachingFollowUp(params: {
  groupId: string;
  customerUserId: string;
  text: string;
}): Promise<BotReply[] | null> {
  if (!isCustomerTeachingFollowUp(params.text)) {
    return null;
  }

  const thread = await getActiveIssueThread(params.groupId);
  if (!thread) {
    return null;
  }

  if (thread.state !== ThreadState.AI_ANSWERING && !thread.hasSubstantiveAnswer) {
    return null;
  }

  const lastAnswer = await getLastBotAnswerForThread(params.groupId, thread.issueThreadId);
  if (!lastAnswer) {
    return null;
  }

  await updateIssueThread(params.groupId, thread.issueThreadId, {
    autoReplyBlocked: true,
  });

  const card = lastAnswer.cardId ? getCardById(lastAnswer.cardId) ?? null : null;
  const customerQuestion = thread.customerQuestion ?? params.text;

  await executeHandoff({
    groupId: params.groupId,
    issueThreadId: thread.issueThreadId,
    customerQuestion,
    card,
    reason: '店家回報教學步驟未解決，需導入教練確認',
    riskLevel: card?.risk_level ?? RiskLevel.UNKNOWN,
    actorUserId: params.customerUserId,
    notifyTarget: 'fallback_admin',
  });

  return [{ type: 'group', text: CUSTOMER_TEACHING_FOLLOWUP_BUFFER }];
}
