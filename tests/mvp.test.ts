import {
  Actor,
  EventType,
  PUBLIC_REPLY_SUFFIX,
  ThreadState,
  TIMEOUT_MS,
} from '../src/types';
import { processMessage, settleGroupTimeouts } from '../src/handlers/lineWebhookHandler';
import { getEventLogs, getEventsByType } from '../src/services/eventLogService';
import { getGroupFlags } from '../src/services/groupFlags';
import {
  createIssueThread,
  getActiveIssueThread,
  getIssueThread,
  updateIssueThread,
} from '../src/services/issueThreadService';
import {
  registerAdmin,
  requestConsultantJoin,
  approveConsultant,
  registerInviteCode,
} from '../src/services/consultantWhitelist';
import { buildPublicAnswer, routeQuestion } from '../src/services/riskRouter';
import {
  getCardById,
  getLoadedFromPath,
  loadKnowledgeBase,
  matchKnowledgeCard,
} from '../src/services/knowledgeBaseService';
import { transitionState } from '../src/services/stateMachine';
import { handleServiceIntroduction } from '../src/services/servicePeriodService';
import {
  resetTestState,
  TEST_ADMIN,
  TEST_CONSULTANT,
  TEST_CUSTOMER,
  TEST_GROUP,
} from './helpers/testSetup';

async function setupConsultant(): Promise<void> {
  await registerAdmin(TEST_ADMIN);
  await registerInviteCode('TESTCODE', TEST_ADMIN);
  await requestConsultantJoin(TEST_CONSULTANT, 'TESTCODE');
  await approveConsultant(TEST_ADMIN, TEST_CONSULTANT);
}

async function setupServicePeriod(): Promise<void> {
  await setupConsultant();
  await handleServiceIntroduction(TEST_GROUP, TEST_CONSULTANT);
}

function groupMsg(userId: string, text: string) {
  return {
    userId,
    groupId: TEST_GROUP,
    text,
    isGroup: true,
  };
}

describe('MVP Core Tests', () => {
  beforeEach(async () => {
    await resetTestState();
  });

  describe('1. 五狀態轉移測試', () => {
    it('supports all 5 fixed states', async () => {
      await setupServicePeriod();
      const thread = await createIssueThread(TEST_GROUP, 'test');

      const transitions: Array<[ThreadState, ThreadState]> = [
        [ThreadState.IDLE, ThreadState.AI_CLARIFYING],
        [ThreadState.AI_CLARIFYING, ThreadState.AI_ANSWERING],
        [ThreadState.AI_ANSWERING, ThreadState.CONSULTANT_HANDOFF],
        [ThreadState.CONSULTANT_HANDOFF, ThreadState.IDLE],
        [ThreadState.IDLE, ThreadState.OUT_OF_SERVICE_PERIOD],
      ];

      for (const [from, to] of transitions) {
        await updateIssueThread(TEST_GROUP, thread.issueThreadId, {
          state: from,
          lastStateChangeAt: new Date().toISOString(),
        });
        const result = await transitionState({
          groupId: TEST_GROUP,
          issueThreadId: thread.issueThreadId,
          toState: to,
          actor: Actor.SYSTEM,
        });
        expect(result).not.toBeNull();
        expect(result!.toState).toBe(to);
      }

      const stateEvents = await getEventsByType(EventType.STATE_TRANSITION);
      expect(stateEvents.length).toBeGreaterThanOrEqual(5);
    });
  });

  describe('2. 被動結算批次清掉同群組逾時 thread', () => {
    it('settles all stale threads in group on any message', async () => {
      await setupServicePeriod();
      const t1 = await createIssueThread(TEST_GROUP, 'q1');
      const t2 = await createIssueThread(TEST_GROUP, 'q2');

      const staleTime = new Date(Date.now() - TIMEOUT_MS.AI_CLARIFYING - 1000).toISOString();
      await updateIssueThread(TEST_GROUP, t1.issueThreadId, {
        state: ThreadState.AI_CLARIFYING,
        lastStateChangeAt: staleTime,
      });
      await updateIssueThread(TEST_GROUP, t2.issueThreadId, {
        state: ThreadState.CONSULTANT_HANDOFF,
        lastStateChangeAt: new Date(Date.now() - TIMEOUT_MS.CONSULTANT_HANDOFF - 1000).toISOString(),
      });

      const result = await settleGroupTimeouts(TEST_GROUP, new Date());

      expect(result.settledThreads.length).toBe(2);
      expect((await getIssueThread(TEST_GROUP, t1.issueThreadId))!.state).toBe(ThreadState.IDLE);
      expect((await getIssueThread(TEST_GROUP, t2.issueThreadId))!.state).toBe(ThreadState.IDLE);

      const staleEvents = (await getEventLogs()).filter(
        (e) => e.event_type === EventType.STATE_TRANSITION && e.detail?.startsWith('stale:')
      );
      expect(staleEvents.length).toBeGreaterThanOrEqual(2);
    });
  });

  describe('3. 低風險公開回答逐字等於 standard_answer', () => {
    it('public reply body equals knowledge card standard_answer plus suffix only', async () => {
      await setupServicePeriod();
      const card = getCardById('op-login')!;
      const result = await processMessage(groupMsg(TEST_CUSTOMER, '怎麼登入後台'));

      const groupReply = result.replies.find((r) => r.type === 'group');
      expect(groupReply).toBeDefined();
      expect(groupReply!.text).toBe(buildPublicAnswer(card.standard_answer));
    });
  });

  describe('4. 公開回答固定收尾句存在', () => {
    it('appends fixed suffix when not in standard_answer', () => {
      const card = getCardById('op-login')!;
      expect(buildPublicAnswer(card.standard_answer)).toContain(PUBLIC_REPLY_SUFFIX);
    });
  });

  describe('5. 中高風險不公開改私訊顧問', () => {
    it('mid/high risk handoffs to consultant via push with buffer message only', async () => {
      await setupServicePeriod();
      const result = await processMessage(groupMsg(TEST_CUSTOMER, '畫面一片空白'));

      const groupReply = result.replies.find((r) => r.type === 'group');
      expect(groupReply?.text).toBe(
        '您的問題我已經記下並請導入教練協助確認，請稍等一下喔。'
      );
      expect(result.replies.filter((r) => r.type === 'push').length).toBeGreaterThan(0);
      expect((await getEventsByType(EventType.HANDOFF_TO_CONSULTANT)).length).toBe(1);
    });
  });

  describe('6. knowledge_miss 獨立寫入並產生 unknown_question', () => {
    it('records knowledge_miss and unknown_question separately', async () => {
      await setupServicePeriod();
      await processMessage(groupMsg(TEST_CUSTOMER, '完全沒有對應的問題 xyzabc123'));

      const missEvents = await getEventsByType(EventType.KNOWLEDGE_MISS);
      const unknownEvents = await getEventsByType(EventType.UNKNOWN_QUESTION);
      expect(missEvents.length).toBe(1);
      expect(unknownEvents.length).toBe(1);
    });
  });

  describe('7. mute 啟用', () => {
    it('mutes assistant with 小助手先休息一下', async () => {
      await setupServicePeriod();
      await processMessage(groupMsg(TEST_CONSULTANT, '小助手先休息一下'));
      const flags = await getGroupFlags(TEST_GROUP);
      expect(flags.mute).toBe(true);
    });
  });

  describe('8. mute 優先於 customer message', () => {
    it('does not respond to customer when muted', async () => {
      await setupServicePeriod();
      await processMessage(groupMsg(TEST_CONSULTANT, '小助手先休息一下'));

      const result = await processMessage(groupMsg(TEST_CUSTOMER, '怎麼登入後台'));
      expect(result.replies.length).toBe(0);
    });
  });

  describe('9. 顧問收尾訊號在無實質回答 thread 不生效', () => {
    it('consultant closing signal ignored without substantive answer', async () => {
      await setupServicePeriod();
      await createIssueThread(TEST_GROUP, 'new question');
      await processMessage(groupMsg(TEST_CONSULTANT, 'OK'));

      const thread = await getActiveIssueThread(TEST_GROUP);
      expect(thread).toBeDefined();
      expect(thread!.status).toBe('active');
    });
  });

  describe('10. 店家 OK / 👍 / ✅ 不會結案', () => {
    it('customer emoji/OK does not close thread', async () => {
      await setupServicePeriod();
      await processMessage(groupMsg(TEST_CUSTOMER, '怎麼登入後台'));

      for (const signal of ['OK', '👍', '✅']) {
        await processMessage(groupMsg(TEST_CUSTOMER, signal));
        const thread = await getActiveIssueThread(TEST_GROUP);
        expect(thread).toBeDefined();
        expect(thread!.status).not.toBe('resolved');
      }
    });
  });

  describe('11. 顧問 correction 只能手動觸發', () => {
    it('consultant_correction only via manual command', async () => {
      await setupServicePeriod();
      await processMessage(groupMsg(TEST_CUSTOMER, '怎麼登入後台'));
      await processMessage(groupMsg(TEST_CONSULTANT, 'OK'));
      expect((await getEventsByType(EventType.CONSULTANT_CORRECTION)).length).toBe(0);

      await processMessage(groupMsg(TEST_CONSULTANT, '小助手這題我更正'));
      expect((await getEventsByType(EventType.CONSULTANT_CORRECTION)).length).toBe(1);
    });
  });

  describe('12. 小助手查 JSON 不即時查 Notion', () => {
    it('loads knowledge from local JSON only', async () => {
      loadKnowledgeBase();
      expect(getLoadedFromPath()).toContain('knowledge_items.json');
      expect((await matchKnowledgeCard('怎麼登入後台')).card?.card_id).toBe('op-login');
    });
  });

  describe('13. 第一版禁止項目未被實作', () => {
    it('does not contain forbidden states or event types', () => {
      const forbiddenStates = ['AI_WAITING', 'CONSULTANT_TAKING_OVER', 'CONFIRMATION_WAITING'];
      for (const s of forbiddenStates) {
        expect(Object.values(ThreadState)).not.toContain(s);
      }
    });

    it('routeQuestion never generates free-form operational answers', async () => {
      const action = await routeQuestion('怎麼登入後台');
      expect(action.type).toBe('public_answer');
      if (action.type === 'public_answer') {
        expect(action.card.standard_answer).toBe(getCardById('op-login')!.standard_answer);
      }
    });
  });

  describe('consultant closing signal with substantive answer', () => {
    it('closes thread when consultant sends OK after AI answer', async () => {
      await setupServicePeriod();
      await processMessage(groupMsg(TEST_CUSTOMER, '怎麼登入後台'));
      await processMessage(groupMsg(TEST_CONSULTANT, 'OK'));
      expect(await getActiveIssueThread(TEST_GROUP)).toBeUndefined();
    });
  });
});
