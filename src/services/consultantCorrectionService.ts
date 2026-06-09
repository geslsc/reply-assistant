import { Actor, BotReply, EventType, ThreadState } from '../types';
import { createEvent, getEventsByType } from './eventLogService';
import { getActiveAdmins } from './consultantWhitelist';
import { getCardById, pauseLastReferencedCard } from './knowledgeBaseService';
import {
  getActiveIssueThread,
  markConsultantAnswered,
  updateIssueThread,
} from './issueThreadService';
import { transitionState } from './stateMachine';

export const CORRECTION_GROUP_ACK = '好的，這題先交由導入教練協助確認。';

interface PendingCorrectionReminder {
  groupId: string;
  issueThreadId: string;
  consultantUserId: string;
  cardId: string | null;
  cardTitle: string | null;
  customerQuestion: string | null;
  botAnswer: string | null;
  consultantCorrectionText: string | null;
}

const pendingReminders = new Map<string, PendingCorrectionReminder>();

function reminderKey(groupId: string, issueThreadId: string): string {
  return `${groupId}:${issueThreadId}`;
}

async function getLastBotAnswer(
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

export async function handleAssistantCorrection(
  groupId: string,
  userId: string
): Promise<BotReply[]> {
  const thread = await getActiveIssueThread(groupId);
  const lastAnswer = thread
    ? await getLastBotAnswer(groupId, thread.issueThreadId)
    : null;
  const cardId = thread?.lastKnowledgeCardId ?? lastAnswer?.cardId ?? null;
  let pausedCardId: string | null = null;

  if (cardId) {
    const paused = await pauseLastReferencedCard(cardId, userId);
    if (paused) {
      pausedCardId = paused.card_id;
    }
  }

  await createEvent({
    event_type: EventType.CONSULTANT_CORRECTION,
    group_id: groupId,
    issue_thread_id: thread?.issueThreadId ?? null,
    actor: Actor.CONSULTANT,
    actor_user_id: userId,
    knowledge_card_id: pausedCardId,
    detail: pausedCardId
      ? `operation=correction;card_id=${pausedCardId};reason=consultant_correction`
      : 'operation=correction;card_id=none;reason=consultant_correction_no_card',
  });

  if (thread) {
    await updateIssueThread(groupId, thread.issueThreadId, {
      autoReplyBlocked: true,
    });
    await transitionState({
      groupId,
      issueThreadId: thread.issueThreadId,
      toState: ThreadState.CONSULTANT_HANDOFF,
      actor: Actor.CONSULTANT,
      actorUserId: userId,
      detail: 'consultant correction',
    });
    pendingReminders.set(reminderKey(groupId, thread.issueThreadId), {
      groupId,
      issueThreadId: thread.issueThreadId,
      consultantUserId: userId,
      cardId: pausedCardId,
      cardTitle: pausedCardId ? getCardById(pausedCardId)?.title ?? null : null,
      customerQuestion: thread.customerQuestion,
      botAnswer: lastAnswer?.answer ?? null,
      consultantCorrectionText: null,
    });
  }

  return [{ type: 'group', text: CORRECTION_GROUP_ACK }];
}

export async function onConsultantHumanReplyDuringCorrection(
  groupId: string,
  text: string
): Promise<void> {
  const thread = await getActiveIssueThread(groupId);
  if (!thread) {
    return;
  }
  const key = reminderKey(groupId, thread.issueThreadId);
  const pending = pendingReminders.get(key);
  if (pending) {
    pending.consultantCorrectionText = text;
    pendingReminders.set(key, pending);
  }
  await markConsultantAnswered(groupId, thread.issueThreadId);
}

export async function onThreadClosedAfterCorrection(
  groupId: string,
  issueThreadId: string
): Promise<BotReply[]> {
  const key = reminderKey(groupId, issueThreadId);
  const pending = pendingReminders.get(key);
  if (!pending) {
    return [];
  }
  pendingReminders.delete(key);

  const admins = await getActiveAdmins();
  const recipients =
    admins.length > 0 ? admins.map((admin) => admin.userId) : [pending.consultantUserId];

  const lines = pending.cardId
    ? [
        '【建議修改知識卡】',
        '剛剛群組中有一題由教練更正，我已先暫停相關知識卡的自動回覆，避免再次誤用。',
        '',
        `群組：${groupId}`,
        `原問題：${pending.customerQuestion ?? '（無）'}`,
        `暫停知識卡：${pending.cardId}${pending.cardTitle ? `｜${pending.cardTitle}` : ''}`,
        `小助手原回覆：${pending.botAnswer ?? '（無）'}`,
        `教練更正內容：${pending.consultantCorrectionText ?? '（請見群組對話）'}`,
        '',
        '您可以回覆：',
        '- 整理成知識卡修改草稿',
        '- 恢復這張知識卡',
        '- 先不用',
      ]
    : [
        '【建議修改知識卡】',
        '這次更正沒有找到明確命中的知識卡，請確認是否需要新增或修改知識卡。',
        '',
        `群組：${groupId}`,
        `原問題：${pending.customerQuestion ?? '（無）'}`,
        `教練更正內容：${pending.consultantCorrectionText ?? '（請見群組對話）'}`,
      ];

  const replies: BotReply[] = [];
  for (const userId of recipients) {
    replies.push({ type: 'push', userId, text: lines.join('\n') });
  }
  return replies;
}

export function clearCorrectionRemindersForTest(): void {
  pendingReminders.clear();
}
