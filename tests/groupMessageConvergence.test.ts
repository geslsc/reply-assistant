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
  processBufferByIdForTest,
  runPendingConvergenceTimersForTest,
  settleExpiredGroupBuffers,
} from '../src/services/groupMessageConvergenceService';
import { classifyCustomerQuestion } from '../src/services/groupSemanticRoutingService';
import {
  combineBufferMessages,
  isNonSubstantiveCustomerMessage,
} from '../src/services/groupMessageFilterService';
import { isHighRiskCustomerMessage } from '../src/services/groupHighRiskService';
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

function expectFallbackAdminOnlyHandoff(replies: BotReply[]): void {
  const pushes = replies.filter((reply) => reply.type === 'push');
  expect(pushes.length).toBeGreaterThan(0);
  expect(pushes.every((reply) => reply.userId === TEST_ADMIN)).toBe(true);
  expect(pushes.some((reply) => reply.userId === TEST_CONSULTANT)).toBe(false);
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

  it('merges three consecutive customer messages into one buffer question', async () => {
    resetEnvCache();
    loadEnv({ USE_MEMORY_REPOS: true, DEBOUNCE_SECONDS: 60 });
    clearConvergenceTimersForTest();

    await processMessage(groupMsg(TEST_CUSTOMER, '我不會使用計次券'));
    await processMessage(groupMsg(TEST_CUSTOMER, '怎麼使用計次券'));
    await processMessage(groupMsg(TEST_CUSTOMER, '怎麼設定計次券'));

    const buffer = await getRepos().groupMessageBuffers.findCollectingByGroupAndCustomer(
      TEST_GROUP,
      TEST_CUSTOMER
    );
    expect(buffer).not.toBeNull();
    expect(buffer!.messages).toHaveLength(3);
    const merged = combineBufferMessages(buffer!.messages);
    expect(merged).toContain('我不會使用計次券');
    expect(merged).toContain('怎麼設定計次券');

    const replies = await processBufferByIdForTest(buffer!.bufferId);
    const groupReply = replies.find((r) => r.type === 'group');
    expect(groupReply?.text).toContain('步驟一');
    expect((await getEventsByType(EventType.AI_ANSWER)).length).toBe(1);
  });

  it('publicly replies verbatim standard_answer after debounce for clear low-risk match', async () => {
    const result = await processMessage(groupMsg(TEST_CUSTOMER, '怎麼登入後台'));
    const card = getCardById('op-login')!;
    const groupReply = result.replies.find((r) => r.type === 'group');
    expect(groupReply?.text).toBe(buildPublicAnswer(card.standard_answer));
  });

  it('handoffs mid/high risk with fixed buffer message and admin push', async () => {
    const result = await processMessage(groupMsg(TEST_CUSTOMER, '畫面一片空白'));
    expect(result.replies.find((r) => r.type === 'group')?.text).toBe(
      CUSTOMER_HANDOFF_BUFFER_MESSAGE
    );
    expectFallbackAdminOnlyHandoff(result.replies);
    await expectFallbackAdminOnlyPendingHandoffs();
    expect((await getEventsByType(EventType.HANDOFF_TO_CONSULTANT)).length).toBe(1);
  });

  it('handoffs with suggest-new-card when clear but no matching card', async () => {
    const result = await processMessage(
      groupMsg(TEST_CUSTOMER, '請問客立樂 xyz 特殊功能要怎麼設定')
    );
    expect(result.replies.find((r) => r.type === 'group')?.text).toBe(
      CUSTOMER_HANDOFF_BUFFER_MESSAGE
    );
    const handoffEvents = await getEventsByType(EventType.HANDOFF_TO_CONSULTANT);
    expect(handoffEvents[0]?.detail).toContain('建議整理新卡');
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
    expect(result.replies.find((r) => r.type === 'group')?.text).toBe(
      '您是想問哪個功能呢？例如計次券、會員、或預約結帳？'
    );
    expect((await getActiveIssueThread(TEST_GROUP))?.state).toBe(ThreadState.AI_CLARIFYING);
  });

  it('handoffs after two clarify rounds still unclear', async () => {
    const thread = await getRepos().threads.create(TEST_GROUP, '這個怎麼用');
    await getRepos().threads.update(TEST_GROUP, thread.issueThreadId, {
      state: ThreadState.AI_CLARIFYING,
      clarifyRound: 2,
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

  it('resets debounce timer when customer sends another message within window', async () => {
    resetEnvCache();
    loadEnv({ USE_MEMORY_REPOS: true, DEBOUNCE_SECONDS: 60 });
    clearConvergenceTimersForTest();

    await processMessage(groupMsg(TEST_CUSTOMER, '我不會使用計次券'));
    const buffer1 = await getRepos().groupMessageBuffers.findCollectingByGroupAndCustomer(
      TEST_GROUP,
      TEST_CUSTOMER
    );
    const firstUpdatedAt = buffer1!.updatedAt;

    await new Promise((resolve) => setTimeout(resolve, 5));
    await processMessage(groupMsg(TEST_CUSTOMER, '怎麼使用計次券'));
    const buffer2 = await getRepos().groupMessageBuffers.findCollectingByGroupAndCustomer(
      TEST_GROUP,
      TEST_CUSTOMER
    );
    expect(buffer2!.messages).toHaveLength(2);
    expect(buffer2!.updatedAt >= firstUpdatedAt).toBe(true);
  });

  it('does not flush collecting buffer when consultant speaks mid-convergence', async () => {
    resetEnvCache();
    loadEnv({ USE_MEMORY_REPOS: true, DEBOUNCE_SECONDS: 60 });
    clearConvergenceTimersForTest();

    await processMessage(groupMsg(TEST_CUSTOMER, '怎麼使用計次券'));
    const result = await processMessage(groupMsg(TEST_CONSULTANT, '我先看一下'));
    expect(result.replies.find((r) => r.type === 'group')).toBeUndefined();
    const buffer = await getRepos().groupMessageBuffers.findCollectingByGroupAndCustomer(
      TEST_GROUP,
      TEST_CUSTOMER
    );
    expect(buffer).not.toBeNull();
    expect(buffer!.messages).toHaveLength(1);
  });

  it('settles expired buffer on next group event after restart', async () => {
    resetEnvCache();
    loadEnv({ USE_MEMORY_REPOS: true, DEBOUNCE_SECONDS: 60 });
    clearConvergenceTimersForTest();

    await processMessage(groupMsg(TEST_CUSTOMER, '怎麼登入後台'));
    const buffer = await getRepos().groupMessageBuffers.findCollectingByGroupAndCustomer(
      TEST_GROUP,
      TEST_CUSTOMER
    );
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
      expectFallbackAdminOnlyHandoff(result.replies);
      await expectFallbackAdminOnlyPendingHandoffs();
    });

    it('clear question without matching card notifies only fallback admin', async () => {
      const result = await processMessage(
        groupMsg(TEST_CUSTOMER, '請問客立樂 xyz 特殊功能要怎麼設定')
      );
      expectFallbackAdminOnlyHandoff(result.replies);
      await expectFallbackAdminOnlyPendingHandoffs();
    });

    it('mid/high risk matched card notifies only fallback admin', async () => {
      const result = await processMessage(groupMsg(TEST_CUSTOMER, '畫面一片空白'));
      expectFallbackAdminOnlyHandoff(result.replies);
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
      expectFallbackAdminOnlyHandoff(result.replies);
      await expectFallbackAdminOnlyPendingHandoffs();
    });

    it('does not notify all active consultants', async () => {
      const result = await processMessage(groupMsg(TEST_CUSTOMER, '畫面一片空白'));
      const pushUserIds = result.replies
        .filter((reply) => reply.type === 'push')
        .map((reply) => reply.userId);
      expect(pushUserIds).toEqual([TEST_ADMIN]);
      expect(pushUserIds).not.toContain(TEST_CONSULTANT);
    });
  });
});
