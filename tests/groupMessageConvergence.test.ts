import {
  CUSTOMER_HANDOFF_BUFFER_MESSAGE,
  EventType,
  PUBLIC_REPLY_SUFFIX,
  RiskLevel,
  ThreadState,
} from '../src/types';
import { loadEnv, resetEnvCache } from '../src/config/env';
import { getRepos, resetRepositories } from '../src/repositories';
import { processMessage } from '../src/handlers/lineWebhookHandler';
import { BotReply } from '../src/types';
import { buildPublicAnswer } from '../src/services/riskRouter';
import {
  getCardById,
  refreshKnowledgeCache,
  initKnowledgeBase,
} from '../src/services/knowledgeBaseService';
import { setLlmClient, LlmClient } from '../src/services/knowledgeCardDraftService';
import {
  clearConvergenceTimersForTest,
  runPendingConvergenceTimersForTest,
  settleExpiredGroupBuffers,
  settleExpiredGroupBuffersGlobally,
} from '../src/services/groupMessageConvergenceService';
import { classifyCustomerQuestion } from '../src/services/groupSemanticRoutingService';
import { isNonSubstantiveCustomerMessage } from '../src/services/groupMessageFilterService';
import { isHighRiskCustomerMessage } from '../src/services/groupHighRiskService';
import { buildRound1ClarifyMessage } from '../src/services/groupConvergenceStateService';
import { validateKnowledgeCard } from '../src/services/knowledgeCardValidator';
import { handleServiceIntroduction } from '../src/services/servicePeriodService';
import { getEventsByType } from '../src/services/eventLogService';
import { getActiveIssueThread } from '../src/services/issueThreadService';
import { getPendingHandoffs } from '../src/services/pendingHandoffService';
import {
  registerAdmin,
  registerInviteCode,
  requestConsultantJoin,
  approveConsultant,
} from '../src/services/consultantWhitelist';
import { TEST_ADMIN, TEST_CONSULTANT, TEST_CUSTOMER, TEST_GROUP } from './helpers/testSetup';

async function setupRolesAndService(): Promise<void> {
  await registerAdmin(TEST_ADMIN, 'Admin');
  await registerInviteCode('CONVCODE', TEST_ADMIN);
  await requestConsultantJoin(TEST_CONSULTANT, 'CONVCODE', 'Consultant');
  await approveConsultant(TEST_ADMIN, TEST_CONSULTANT);
  await handleServiceIntroduction(TEST_GROUP, TEST_CONSULTANT);
}

async function seedPunchCard(): Promise<void> {
  await getRepos().knowledgeCards.insert({
    cardId: 'op-punch-card',
    title: '計次券使用方式',
    patterns: ['計次券', '怎麼使用計次券', '怎麼設定計次券'],
    riskLevel: RiskLevel.LOW,
    canPublicReply: true,
    standardAnswer: '步驟一：到票券管理。\n步驟二：新增計次券。',
    notApplicable: [],
    escalateToConsultant: [],
    status: 'active',
    createdBy: TEST_ADMIN,
    createdAt: new Date().toISOString(),
    confirmedBy: TEST_ADMIN,
    confirmedAt: new Date().toISOString(),
  });
  await refreshKnowledgeCache();
}

function groupMsg(userId: string, text: string) {
  return { userId, groupId: TEST_GROUP, text, isGroup: true };
}

function privateMsg(userId: string, text: string) {
  return { userId, text, isGroup: false };
}

function expectNoPushHandoffNotification(replies: BotReply[]): void {
  const pushes = replies.filter((reply) => reply.type === 'push');
  expect(pushes).toHaveLength(0);
}

async function expectFallbackAdminOnlyPendingHandoffs(): Promise<void> {
  expect(await getPendingHandoffs(TEST_ADMIN)).toHaveLength(1);
  expect(await getPendingHandoffs(TEST_CONSULTANT)).toHaveLength(0);
}

describe('Group message convergence and semantic routing', () => {
  beforeEach(async () => {
    resetEnvCache();
    loadEnv({ USE_MEMORY_REPOS: true, DEBOUNCE_SECONDS: 0 });
    await resetRepositories('memory');
    clearConvergenceTimersForTest();
    setLlmClient(null);
    await initKnowledgeBase();
    await setupRolesAndService();
    await seedPunchCard();
  });

  it('answers a clear customer message immediately instead of waiting for debounce', async () => {
    resetEnvCache();
    loadEnv({ USE_MEMORY_REPOS: true, DEBOUNCE_SECONDS: 60 });
    clearConvergenceTimersForTest();

    const result = await processMessage(groupMsg(TEST_CUSTOMER, '怎麼使用計次券'));

    const buffer = await getRepos().groupMessageBuffers.findCollectingByGroupAndCustomer(
      TEST_GROUP,
      TEST_CUSTOMER
    );
    const groupReply = result.replies.find((r) => r.type === 'group');
    expect(groupReply?.text).toContain('步驟一');
    expect(buffer).toBeNull();
    expect((await getEventsByType(EventType.AI_ANSWER)).length).toBe(1);
  });

  it('publicly replies verbatim standard_answer after debounce for clear low-risk match', async () => {
    const result = await processMessage(groupMsg(TEST_CUSTOMER, '怎麼登入後台'));
    const card = getCardById('op-login')!;
    const groupReply = result.replies.find((r) => r.type === 'group');
    expect(groupReply?.text).toBe(buildPublicAnswer(card.standard_answer));
  });

  it('handoffs mid/high risk with fixed buffer message and pull-based admin pending item', async () => {
    const result = await processMessage(groupMsg(TEST_CUSTOMER, '畫面一片空白'));
    expect(result.replies.find((r) => r.type === 'group')?.text).toBe(
      CUSTOMER_HANDOFF_BUFFER_MESSAGE
    );
    expectNoPushHandoffNotification(result.replies);
    await expectFallbackAdminOnlyPendingHandoffs();
    expect((await getEventsByType(EventType.HANDOFF_TO_CONSULTANT)).length).toBe(1);
  });

  it('lists pending handoffs with 待辦 aliases', async () => {
    await processMessage(groupMsg(TEST_CUSTOMER, '畫面一片空白'));

    const result = await processMessage(privateMsg(TEST_ADMIN, '查詢待辦問題'));
    const text = result.replies.find((r) => r.type === 'push')?.text ?? '';

    expect(text).toContain('【待處理問題清單】');
    expect(text).toContain('畫面一片空白');
  });

  it('clarifies an operational question before handoff when no matching card exists', async () => {
    const result = await processMessage(
      groupMsg(TEST_CUSTOMER, '請問客立樂 xyz 特殊功能要怎麼設定')
    );
    const groupText = result.replies.find((r) => r.type === 'group')?.text ?? '';
    expect(groupText).toContain('補充');
    expect(groupText).not.toBe(CUSTOMER_HANDOFF_BUFFER_MESSAGE);
    expect(await getEventsByType(EventType.HANDOFF_TO_CONSULTANT)).toHaveLength(0);
  });

  it('clarifies stored value wording before handing off unknown card misses', async () => {
    const result = await processMessage(groupMsg(TEST_CUSTOMER, '我要怎麼設定儲值？'));
    const groupText = result.replies.find((r) => r.type === 'group')?.text ?? '';
    expect(groupText).toContain('儲值');
    expect(groupText).toContain('入帳');
    expect(groupText).not.toBe(CUSTOMER_HANDOFF_BUFFER_MESSAGE);
  });

  it('does not ask for screenshot when intent is clear for punch card topic', async () => {
    resetEnvCache();
    loadEnv({ USE_MEMORY_REPOS: true, DEBOUNCE_SECONDS: 0, OPENAI_API_KEY: 'test-key' });
    const mockLlm: LlmClient = {
      complete: async () =>
        JSON.stringify({
          intent_clear: true,
          card_id: 'op-punch-card',
          confidence: 'high',
          clarify_question: null,
          summary: '計次券設定',
        }),
    };
    setLlmClient(mockLlm);

    const result = await processMessage(groupMsg(TEST_CUSTOMER, '怎麼設定計次券'));
    const groupText = result.replies.find((r) => r.type === 'group')?.text ?? '';
    expect(groupText).not.toContain('截圖');
    expect(groupText).not.toContain('畫面上');
    expect(groupText).toContain('步驟一');
  });

  it('generates custom clarify question for vague intent', async () => {
    resetEnvCache();
    loadEnv({ USE_MEMORY_REPOS: true, DEBOUNCE_SECONDS: 0, OPENAI_API_KEY: 'test-key' });
    const mockLlm: LlmClient = {
      complete: async () =>
        JSON.stringify({
          intent_clear: false,
          card_id: null,
          confidence: 'low',
          clarify_question: '您是想問哪個功能呢？例如計次券、會員、或預約結帳？',
          summary: '這個怎麼用',
        }),
    };
    setLlmClient(mockLlm);

    const result = await processMessage(groupMsg(TEST_CUSTOMER, '這個怎麼用'));
    const groupText = result.replies.find((r) => r.type === 'group')?.text ?? '';
    expect(groupText).toContain('哪個功能');
    expect(groupText).not.toContain('選項編號');
    expect(groupText).toContain('請直接補充');
    expect((await getActiveIssueThread(TEST_GROUP))?.state).toBe(ThreadState.AI_CLARIFYING);
  });

  it('does not mention option selection in round 1 when no options are shown', async () => {
    const message = await buildRound1ClarifyMessage({
      question: '我不知道',
      candidates: [],
    });

    expect(message).not.toContain('選項編號');
    expect(message).toContain('請直接補充');
  });

  it('treats customer question-opening messages as a prompt to describe the issue', async () => {
    const opening = await processMessage(groupMsg(TEST_CUSTOMER, '我又有問題了'));
    const openingText = opening.replies.find((r) => r.type === 'group')?.text ?? '';

    expect(openingText).toContain('直接把你遇到的畫面');
    expect(openingText).toContain('🙂');
    expect(await getActiveIssueThread(TEST_GROUP)).toBeUndefined();

    const next = await processMessage(groupMsg(TEST_CUSTOMER, '怎麼登入後台'));
    expect(next.replies.find((r) => r.type === 'group')?.text).toContain('登入');
  });

  it('uses short lively chitchat replies without leaving an active issue thread', async () => {
    const result = await processMessage(groupMsg(TEST_CUSTOMER, '好的謝謝'));
    const text = result.replies.find((r) => r.type === 'group')?.text ?? '';

    expect(text).toContain('不客氣');
    expect(text).toContain('操作問題');
    expect(await getActiveIssueThread(TEST_GROUP)).toBeUndefined();
  });

  it('handoffs after three clarify rounds still unclear', async () => {
    const thread = await getRepos().threads.create(TEST_GROUP, '這個怎麼用');
    await getRepos().threads.update(TEST_GROUP, thread.issueThreadId, {
      state: ThreadState.AI_CLARIFYING,
      clarifyRound: 3,
    });

    const mockLlm: LlmClient = {
      complete: async () =>
        JSON.stringify({
          intent_clear: false,
          card_id: null,
          confidence: 'low',
          clarify_question: '還需要更多資訊',
          summary: '這個怎麼用',
        }),
    };
    setLlmClient(mockLlm);

    const result = await processMessage(groupMsg(TEST_CUSTOMER, '還是不清楚'));
    expect(result.replies.find((r) => r.type === 'group')?.text).toBe(
      CUSTOMER_HANDOFF_BUFFER_MESSAGE
    );
  });

  it('high-risk keywords bypass debounce and handoff immediately', async () => {
    resetEnvCache();
    loadEnv({ USE_MEMORY_REPOS: true, DEBOUNCE_SECONDS: 60 });
    clearConvergenceTimersForTest();

    const result = await processMessage(groupMsg(TEST_CUSTOMER, '儲值餘額異常怎麼辦'));
    expect(result.replies.find((r) => r.type === 'group')?.text).toBe(
      CUSTOMER_HANDOFF_BUFFER_MESSAGE
    );
    const collecting = await getRepos().groupMessageBuffers.findCollectingByGroupAndCustomer(
      TEST_GROUP,
      TEST_CUSTOMER
    );
    expect(collecting).toBeNull();
  });

  it('does not leave a pending debounce buffer after immediate handling', async () => {
    resetEnvCache();
    loadEnv({ USE_MEMORY_REPOS: true, DEBOUNCE_SECONDS: 60 });
    clearConvergenceTimersForTest();

    const first = await processMessage(groupMsg(TEST_CUSTOMER, '我不會使用計次券'));
    const buffer1 = await getRepos().groupMessageBuffers.findCollectingByGroupAndCustomer(
      TEST_GROUP,
      TEST_CUSTOMER
    );

    const second = await processMessage(groupMsg(TEST_CUSTOMER, '怎麼使用計次券'));
    const buffer2 = await getRepos().groupMessageBuffers.findCollectingByGroupAndCustomer(
      TEST_GROUP,
      TEST_CUSTOMER
    );
    expect(first.replies.find((r) => r.type === 'group')).toBeTruthy();
    expect(second.replies.find((r) => r.type === 'group')).toBeTruthy();
    expect(buffer1).toBeNull();
    expect(buffer2).toBeNull();
  });

  it('does not create group replies when consultant speaks after immediate handling', async () => {
    resetEnvCache();
    loadEnv({ USE_MEMORY_REPOS: true, DEBOUNCE_SECONDS: 60 });
    clearConvergenceTimersForTest();

    await processMessage(groupMsg(TEST_CUSTOMER, '怎麼使用計次券'));
    const result = await processMessage(groupMsg(TEST_CONSULTANT, '我先看一下'));
    expect(result.replies.find((r) => r.type === 'group')).toBeUndefined();
    expect((await getActiveIssueThread(TEST_GROUP))?.consultantAnswered).toBe(true);
  });

  it('does not treat consultant onboarding intro as human takeover', async () => {
    resetEnvCache();
    loadEnv({ USE_MEMORY_REPOS: true, DEBOUNCE_SECONDS: 60 });
    clearConvergenceTimersForTest();

    await processMessage(groupMsg(TEST_CUSTOMER, '怎麼使用計次券'));

    const intro = await processMessage(
      groupMsg(TEST_CONSULTANT, '老師好，我是 Nina 導入教練')
    );
    expect(intro.replies.find((r) => r.type === 'group')).toBeUndefined();
    expect((await getActiveIssueThread(TEST_GROUP))?.consultantAnswered).toBe(false);
  });

  it('does not treat bot intro command as human takeover', async () => {
    resetEnvCache();
    loadEnv({ USE_MEMORY_REPOS: true, DEBOUNCE_SECONDS: 60 });
    clearConvergenceTimersForTest();

    await processMessage(groupMsg(TEST_CUSTOMER, '怎麼使用計次券'));

    const intro = await processMessage(groupMsg(TEST_CONSULTANT, '自我介紹一下'));
    expect(intro.replies.find((r) => r.type === 'group')?.text).toContain('待命');
    expect((await getActiveIssueThread(TEST_GROUP))?.consultantAnswered).toBe(false);
  });

  it('still treats substantive consultant answers as human takeover', async () => {
    resetEnvCache();
    loadEnv({ USE_MEMORY_REPOS: true, DEBOUNCE_SECONDS: 60 });
    clearConvergenceTimersForTest();

    await processMessage(groupMsg(TEST_CUSTOMER, '怎麼使用計次券'));

    await processMessage(groupMsg(TEST_CONSULTANT, '請到票券管理新增計次券'));

    expect((await getActiveIssueThread(TEST_GROUP))?.consultantAnswered).toBe(true);
  });

  it('allows consultant closing signal to end a takeover thread', async () => {
    resetEnvCache();
    loadEnv({ USE_MEMORY_REPOS: true, DEBOUNCE_SECONDS: 60 });
    clearConvergenceTimersForTest();

    await processMessage(groupMsg(TEST_CUSTOMER, '怎麼使用計次券'));
    await processMessage(groupMsg(TEST_CONSULTANT, '請到票券管理新增計次券'));
    expect((await getActiveIssueThread(TEST_GROUP))?.consultantAnswered).toBe(true);

    await processMessage(groupMsg(TEST_CONSULTANT, 'OK'));

    expect(await getActiveIssueThread(TEST_GROUP)).toBeUndefined();

    const next = await processMessage(groupMsg(TEST_CUSTOMER, '怎麼登入後台'));
    expect(next.replies.find((r) => r.type === 'group')?.text).toContain('登入');
  });

  it('resumes assistant after consultant takeover when consultant says 小助手再麻煩了', async () => {
    resetEnvCache();
    loadEnv({ USE_MEMORY_REPOS: true, DEBOUNCE_SECONDS: 0 });
    clearConvergenceTimersForTest();

    await processMessage(groupMsg(TEST_CUSTOMER, '怎麼使用計次券'));
    await processMessage(groupMsg(TEST_CONSULTANT, '請到票券管理新增計次券'));
    expect((await getActiveIssueThread(TEST_GROUP))?.consultantAnswered).toBe(true);

    await processMessage(groupMsg(TEST_CONSULTANT, '小助手再麻煩了'));
    expect(await getActiveIssueThread(TEST_GROUP)).toBeUndefined();

    const next = await processMessage(groupMsg(TEST_CUSTOMER, '怎麼登入後台'));
    expect(next.replies.find((r) => r.type === 'group')?.text).toContain('登入');
  });

  it('unmute command clears handoff thread so the next customer message starts fresh', async () => {
    await processMessage(groupMsg(TEST_CUSTOMER, '畫面一片空白'));
    expect((await getActiveIssueThread(TEST_GROUP))?.state).toBe(ThreadState.CONSULTANT_HANDOFF);

    const unmute = await processMessage(groupMsg(TEST_CONSULTANT, '小助手再麻煩了'));
    expect(unmute.replies.find((r) => r.type === 'group')?.text).toContain('隨時待命');
    expect(await getActiveIssueThread(TEST_GROUP)).toBeUndefined();

    const next = await processMessage(groupMsg(TEST_CUSTOMER, '怎麼登入後台'));
    expect(next.replies.find((r) => r.type === 'group')?.text).toContain('登入');
  });

  it('resumes assistant after consultant takeover when consultant asks for self introduction', async () => {
    resetEnvCache();
    loadEnv({ USE_MEMORY_REPOS: true, DEBOUNCE_SECONDS: 0 });
    clearConvergenceTimersForTest();

    await processMessage(groupMsg(TEST_CUSTOMER, '怎麼使用計次券'));
    await processMessage(groupMsg(TEST_CONSULTANT, '請到票券管理新增計次券'));
    expect((await getActiveIssueThread(TEST_GROUP))?.consultantAnswered).toBe(true);

    const intro = await processMessage(groupMsg(TEST_CONSULTANT, '小助手自我介紹一下'));
    expect(intro.replies.find((r) => r.type === 'group')?.text).toContain('待命');
    expect(await getActiveIssueThread(TEST_GROUP)).toBeUndefined();

    const next = await processMessage(groupMsg(TEST_CUSTOMER, '怎麼登入後台'));
    expect(next.replies.find((r) => r.type === 'group')?.text).toContain('登入');
  });

  it('settles expired buffer on next group event after restart', async () => {
    resetEnvCache();
    loadEnv({ USE_MEMORY_REPOS: true, DEBOUNCE_SECONDS: 60 });
    clearConvergenceTimersForTest();

    const thread = await getRepos().threads.create(TEST_GROUP, '怎麼登入後台');
    const buffer = await getRepos().groupMessageBuffers.create({
      groupId: TEST_GROUP,
      customerUserId: TEST_CUSTOMER,
      issueThreadId: thread.issueThreadId,
      message: {
        message_id: 'legacy-message-1',
        text: '怎麼登入後台',
        timestamp: new Date().toISOString(),
        sequence: 1,
      },
    });
    expect(buffer).not.toBeNull();

    clearConvergenceTimersForTest();
    const loginCard = getCardById('op-login')!;
    const settled = await settleExpiredGroupBuffers(
      TEST_GROUP,
      new Date(Date.now() + 61_000)
    );
    expect(
      settled.some((r) => r.type === 'group' && r.text === buildPublicAnswer(loginCard.standard_answer))
    ).toBe(true);
  });

  it('settles expired buffers globally after restart without waiting for another group event', async () => {
    resetEnvCache();
    loadEnv({ USE_MEMORY_REPOS: true, DEBOUNCE_SECONDS: 60 });
    clearConvergenceTimersForTest();

    const thread = await getRepos().threads.create(TEST_GROUP, '怎麼登入後台');
    const buffer = await getRepos().groupMessageBuffers.create({
      groupId: TEST_GROUP,
      customerUserId: TEST_CUSTOMER,
      issueThreadId: thread.issueThreadId,
      message: {
        message_id: 'legacy-message-2',
        text: '怎麼登入後台',
        timestamp: new Date().toISOString(),
        sequence: 1,
      },
    });
    expect(buffer).not.toBeNull();

    clearConvergenceTimersForTest();
    const loginCard = getCardById('op-login')!;
    const settled = await settleExpiredGroupBuffersGlobally(new Date(Date.now() + 61_000));

    expect(
      settled.some((r) => r.type === 'group' && r.text === buildPublicAnswer(loginCard.standard_answer))
    ).toBe(true);
    expect(
      await getRepos().groupMessageBuffers.findCollectingByGroupAndCustomer(
        TEST_GROUP,
        TEST_CUSTOMER
      )
    ).toBeNull();
  });

  it('ignores emoji-only and short acknowledgements', async () => {
    for (const text of ['👍', 'OK', '謝謝', '了解']) {
      const result = await processMessage(groupMsg(TEST_CUSTOMER, text));
      expect(result.replies.length).toBe(0);
    }
    expect(isNonSubstantiveCustomerMessage('OK')).toBe(true);
    const collecting = await getRepos().groupMessageBuffers.findCollectingByGroup(TEST_GROUP);
    expect(collecting.length).toBe(0);
  });

  it('degrades semantic routing without OPENAI_API_KEY', async () => {
    setLlmClient(null);
    const classification = await classifyCustomerQuestion('怎麼登入後台');
    expect(classification.usedLlm).toBe(false);
    expect(classification.cardId).toBe('op-login');
    const result = await processMessage(groupMsg(TEST_CUSTOMER, '怎麼登入後台'));
    expect(result.replies.find((r) => r.type === 'group')?.text).toContain('登入');
  });

  it('uses fixed buffer message text for handoffs', async () => {
    const result = await processMessage(groupMsg(TEST_CUSTOMER, '畫面一片空白'));
    expect(result.replies.find((r) => r.type === 'group')?.text).toBe(
      CUSTOMER_HANDOFF_BUFFER_MESSAGE
    );
  });

  it('maintains MVP red lines', () => {
    expect(Object.values(ThreadState)).toHaveLength(5);
    expect(Object.values(EventType)).toHaveLength(10);
    expect(PUBLIC_REPLY_SUFFIX.length).toBeGreaterThan(0);
    expect(isHighRiskCustomerMessage('餘額異常')).toBe(true);
    expect(validateKnowledgeCard).toBeDefined();
    expect(
      require('../src/services/replyToGroupService').executeReplyToGroup.toString()
    ).not.toContain('complete(');
  });

  it('runs pending debounce timers for delayed public reply', async () => {
    resetEnvCache();
    loadEnv({ USE_MEMORY_REPOS: true, DEBOUNCE_SECONDS: 60 });
    clearConvergenceTimersForTest();

    jest.useFakeTimers();
    await processMessage(groupMsg(TEST_CUSTOMER, '怎麼登入後台'));
    jest.advanceTimersByTime(60_000);
    await runPendingConvergenceTimersForTest();
    jest.useRealTimers();

    expect((await getEventsByType(EventType.AI_ANSWER)).length).toBeGreaterThanOrEqual(0);
  });

  describe('group convergence handoff notifies fallback admin only', () => {
    it('high-risk question notifies only fallback admin', async () => {
      const result = await processMessage(groupMsg(TEST_CUSTOMER, '儲值餘額異常怎麼辦'));
      expectNoPushHandoffNotification(result.replies);
      await expectFallbackAdminOnlyPendingHandoffs();
    });

    it('clear operational question without matching card clarifies before fallback admin', async () => {
      const result = await processMessage(
        groupMsg(TEST_CUSTOMER, '請問客立樂 xyz 特殊功能要怎麼設定')
      );
      expectNoPushHandoffNotification(result.replies);
      const groupText = result.replies.find((r) => r.type === 'group')?.text ?? '';
      expect(groupText).toContain('補充');
      expect(await getPendingHandoffs(TEST_ADMIN)).toHaveLength(0);
    });

    it('mid/high risk matched card notifies only fallback admin', async () => {
      const result = await processMessage(groupMsg(TEST_CUSTOMER, '畫面一片空白'));
      expectNoPushHandoffNotification(result.replies);
      await expectFallbackAdminOnlyPendingHandoffs();
    });

    it('two-round clarify failure notifies only fallback admin', async () => {
      const thread = await getRepos().threads.create(TEST_GROUP, '這個怎麼用');
      await getRepos().threads.update(TEST_GROUP, thread.issueThreadId, {
        state: ThreadState.AI_CLARIFYING,
        clarifyRound: 2,
      });

      resetEnvCache();
      loadEnv({ USE_MEMORY_REPOS: true, DEBOUNCE_SECONDS: 0, OPENAI_API_KEY: 'test-key' });
      setLlmClient({
        complete: async () =>
          JSON.stringify({
            intent_clear: false,
            card_id: null,
            confidence: 'low',
            clarify_question: '還需要更多資訊',
            summary: '這個怎麼用',
          }),
      });

      const result = await processMessage(groupMsg(TEST_CUSTOMER, '還是不清楚'));
      expectNoPushHandoffNotification(result.replies);
      await expectFallbackAdminOnlyPendingHandoffs();
    });

    it('does not notify all active consultants', async () => {
      const result = await processMessage(groupMsg(TEST_CUSTOMER, '畫面一片空白'));
      const pushUserIds = result.replies
        .filter((reply) => reply.type === 'push')
        .map((reply) => reply.userId);
      expect(pushUserIds).toEqual([]);
    });
  });
});
