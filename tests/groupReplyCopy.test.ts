import {
  CHITCHAT_REDIRECT_POOL,
  CUSTOMER_HANDOFF_BUFFER_MESSAGE,
  CUSTOMER_OPERATION_STUCK_HANDOFF_MESSAGE,
  GROUP_FIRST_INTRO_MESSAGE,
  GROUP_FOLLOWUP_INTRO_MESSAGE,
  PUBLIC_REPLY_SUFFIX,
  assertHandoffCopyCompliance,
  getChitchatRedirectByIndex,
  pickDeterministicChitchatRedirectIndex,
  resolveHandoffCustomerMessage,
} from '../src/services/groupReplyCopyService';
import { buildPublicAnswer } from '../src/services/riskRouter';
import { loadEnv, resetEnvCache } from '../src/config/env';
import { resetRepositories, getRepos } from '../src/repositories';
import { groupMetadataToJson, mapGroupRow } from '../src/repositories/mappers';
import { processMessage } from '../src/handlers/lineWebhookHandler';
import { handleServiceIntroduction } from '../src/services/servicePeriodService';
import {
  buildChitchatReply,
  isPureChitchatMessage,
} from '../src/services/groupConversationToneService';
import { applySemanticClassification } from '../src/services/groupConvergenceActionService';
import { isGroupIntroShown, markGroupIntroShown } from '../src/services/groupMetadataService';
import { setLlmClient, LlmClient } from '../src/services/knowledgeCardDraftService';
import {
  registerAdmin,
  registerInviteCode,
  requestConsultantJoin,
  approveConsultant,
} from '../src/services/consultantWhitelist';
import { TEST_ADMIN, TEST_CONSULTANT, TEST_CUSTOMER, TEST_GROUP } from './helpers/testSetup';
import { initKnowledgeBase } from '../src/services/knowledgeBaseService';
import {
  createIssueThread,
  getActiveIssueThread,
  updateIssueThread,
} from '../src/services/issueThreadService';
import { getGroupFlags } from '../src/services/groupFlags';
import { refreshKnowledgeCache } from '../src/services/knowledgeBaseService';
import { EventType, RiskLevel } from '../src/types';
import { getEventsByType } from '../src/services/eventLogService';

async function setupRolesOnly(): Promise<void> {
  await registerAdmin(TEST_ADMIN, 'Admin');
  await registerInviteCode('COPYCODE', TEST_ADMIN);
  await requestConsultantJoin(TEST_CONSULTANT, 'COPYCODE', 'Consultant');
  await approveConsultant(TEST_ADMIN, TEST_CONSULTANT);
}

async function setupRolesAndService(): Promise<void> {
  await setupRolesOnly();
  await handleServiceIntroduction(TEST_GROUP, TEST_CONSULTANT);
}

function groupMsg(userId: string, text: string) {
  return { userId, groupId: TEST_GROUP, text, isGroup: true };
}

describe('Group reply copy adjustments', () => {
  beforeEach(async () => {
    resetEnvCache();
    loadEnv({ USE_MEMORY_REPOS: true, DEBOUNCE_SECONDS: 0 });
    await resetRepositories('memory');
    setLlmClient(null);
    await initKnowledgeBase();
    await setupRolesAndService();
  });

  describe('fixed copy constants', () => {
    it('handoff messages do not contain forbidden phrases', () => {
      assertHandoffCopyCompliance(CUSTOMER_HANDOFF_BUFFER_MESSAGE);
      assertHandoffCopyCompliance(CUSTOMER_OPERATION_STUCK_HANDOFF_MESSAGE);
    });

    it('operation-stuck handoff triggers on stuck phrases', () => {
      expect(resolveHandoffCustomerMessage('還是不行')).toBe(
        CUSTOMER_OPERATION_STUCK_HANDOFF_MESSAGE,
      );
      expect(resolveHandoffCustomerMessage('畫面跟你說的不一樣')).toBe(
        CUSTOMER_OPERATION_STUCK_HANDOFF_MESSAGE,
      );
      expect(resolveHandoffCustomerMessage('找不到按鈕')).toBe(
        CUSTOMER_OPERATION_STUCK_HANDOFF_MESSAGE,
      );
      expect(resolveHandoffCustomerMessage('做到第二步就卡住了')).toBe(
        CUSTOMER_OPERATION_STUCK_HANDOFF_MESSAGE,
      );
      expect(resolveHandoffCustomerMessage('一般問題')).toBe(CUSTOMER_HANDOFF_BUFFER_MESSAGE);
    });

    it('chitchat pool returns verbatim text by index', () => {
      for (let i = 1; i <= CHITCHAT_REDIRECT_POOL.length; i++) {
        expect(getChitchatRedirectByIndex(i)).toBe(CHITCHAT_REDIRECT_POOL[i - 1]);
      }
    });

    it('public answer appends fixed suffix without altering body', () => {
      const body = '步驟一：到票券管理。\n步驟二：新增計次券。';
      const answer = buildPublicAnswer(body);
      expect(answer).toBe(`${body}\n\n${PUBLIC_REPLY_SUFFIX}`);
      expect(buildPublicAnswer(body)).toBe(answer);
    });
  });

  describe('intro deduplication via group metadata', () => {
    it('markIntroShown preserves unknown metadata keys', async () => {
      await getRepos().groups.update(TEST_GROUP, {
        metadataJson: { foo: 'bar' },
      });
      await markGroupIntroShown(TEST_GROUP);
      const flags = await getGroupFlags(TEST_GROUP);
      expect(flags.metadataJson?.foo).toBe('bar');
      expect(flags.metadataJson?.intro_shown).toBe(true);
    });

    it('markIntroShown writes intro_shown when metadata_json is null', async () => {
      await getRepos().groups.update(TEST_GROUP, { metadataJson: null });
      await markGroupIntroShown(TEST_GROUP);
      const flags = await getGroupFlags(TEST_GROUP);
      expect(flags.metadataJson?.intro_shown).toBe(true);
    });

    it('mapGroupRow preserves all metadata_json keys', () => {
      const flags = mapGroupRow({
        group_id: TEST_GROUP,
        group_name: null,
        waiting_flag: false,
        waiting_flag_set_at: null,
        mute: false,
        mute_until: null,
        service_start_at: null,
        service_end_at: null,
        active_issue_thread_id: null,
        service_reactivation_pending: false,
        bot_left_at: null,
        service_period_end_notified: false,
        metadata_json: { foo: 'bar', someFlag: true, intro_shown: false },
      });
      expect(flags.metadataJson?.foo).toBe('bar');
      expect(flags.metadataJson?.someFlag).toBe(true);
      expect(flags.metadataJson?.intro_shown).toBe(false);
    });

    it('groupMetadataToJson preserves unknown keys when writing intro_shown', () => {
      const json = groupMetadataToJson({ foo: 'bar', someFlag: true, intro_shown: true });
      expect(json.foo).toBe('bar');
      expect(json.someFlag).toBe(true);
      expect(json.intro_shown).toBe(true);
    });

    it('markIntroShown does not create intro-related event log', async () => {
      const eventsBefore = (await getRepos().events.findByGroup(TEST_GROUP)).length;
      await markGroupIntroShown(TEST_GROUP);
      const eventsAfter = await getRepos().events.findByGroup(TEST_GROUP);
      expect(eventsAfter.length).toBe(eventsBefore);
      expect(eventsAfter.some((event) => event.detail === 'group intro shown')).toBe(false);
      expect(await isGroupIntroShown(TEST_GROUP)).toBe(true);
    });

    it('first intro via service does not create intro-related event log', async () => {
      const freshGroup = 'group-copy-intro-no-event';
      await setupRolesOnly();
      const transitionsBefore = (await getEventsByType(EventType.STATE_TRANSITION)).filter(
        (event) => event.group_id === freshGroup,
      ).length;
      await handleServiceIntroduction(freshGroup, TEST_CONSULTANT);
      const transitionsAfter = await getEventsByType(EventType.STATE_TRANSITION);
      const groupEvents = transitionsAfter.filter((event) => event.group_id === freshGroup);
      expect(groupEvents.some((event) => event.detail === 'group intro shown')).toBe(false);
      expect(groupEvents.length).toBeGreaterThan(transitionsBefore);
      expect(await isGroupIntroShown(freshGroup)).toBe(true);
    });

    it('second intro question returns short version without 30 days', async () => {
      await markGroupIntroShown(TEST_GROUP);
      const result = await processMessage(
        groupMsg(TEST_CONSULTANT, '小助手自我介紹一下'),
      );
      const text = result.replies.map((r) => r.text).join('\n');
      expect(text).toContain(GROUP_FOLLOWUP_INTRO_MESSAGE);
      expect(text).not.toContain('30 天');
    });

    it('intro_shown persists after repository reset simulation', async () => {
      await markGroupIntroShown(TEST_GROUP);
      expect(await isGroupIntroShown(TEST_GROUP)).toBe(true);

      const flags = await getGroupFlags(TEST_GROUP);
      expect(flags.metadataJson?.intro_shown).toBe(true);
    });

    it('first intro returns long version with 30 days', async () => {
      const freshGroup = 'group-copy-first-intro';
      await setupRolesOnly();
      expect(await isGroupIntroShown(freshGroup)).toBe(false);
      const result = await processMessage(
        { userId: TEST_CONSULTANT, groupId: freshGroup, text: '小助手使用說明', isGroup: true },
      );
      const text = result.replies.map((r) => r.text).join('\n');
      expect(text).toContain(GROUP_FIRST_INTRO_MESSAGE);
      expect(await isGroupIntroShown(freshGroup)).toBe(true);
    });
  });

  describe('chitchat replies', () => {
    it('「我好無聊」without LLM returns exact pool text only', async () => {
      expect(isPureChitchatMessage('我好無聊')).toBe(true);
      const reply = await buildChitchatReply('我好無聊', 1);
      expect(CHITCHAT_REDIRECT_POOL).toContain(reply);
      expect(reply).toBe(
        getChitchatRedirectByIndex(pickDeterministicChitchatRedirectIndex('我好無聊')),
      );
    });

    it('with working LLM returns opener plus pool text', async () => {
      resetEnvCache();
      loadEnv({ USE_MEMORY_REPOS: true, DEBOUNCE_SECONDS: 0, OPENAI_API_KEY: 'test-key' });
      const mockLlm: LlmClient = {
        complete: async (system) => {
          if (system.includes('index')) {
            return '{"index": 2}';
          }
          return '今天天氣不錯呀';
        },
      };
      setLlmClient(mockLlm);

      const reply = await buildChitchatReply('今天天氣真好', 1);
      expect(reply).toBe(`今天天氣不錯呀\n\n${CHITCHAT_REDIRECT_POOL[1]}`);
    });

    it('multiple chitchat replies use unmodified pool text', async () => {
      const seen = new Set<string>();
      for (let i = 0; i < 5; i++) {
        const reply = await buildChitchatReply(`今天天氣真好${i}`, 1);
        expect(CHITCHAT_REDIRECT_POOL).toContain(reply);
        seen.add(reply);
      }
      expect(seen.size).toBeGreaterThan(0);
    });

    it('round 2 chitchat with LLM uses shorter opener', async () => {
      resetEnvCache();
      loadEnv({ USE_MEMORY_REPOS: true, DEBOUNCE_SECONDS: 0, OPENAI_API_KEY: 'test-key' });
      const mockLlm: LlmClient = {
        complete: async (system) => {
          if (system.includes('index')) {
            return '{"index": 1}';
          }
          return system.includes('更短') ? '嗯' : '收到';
        },
      };
      setLlmClient(mockLlm);

      const r1 = await buildChitchatReply('好無聊', 1);
      const r2 = await buildChitchatReply('好無聊', 2);
      const opener1 = r1.slice(0, r1.indexOf('\n\n'));
      const opener2 = r2.slice(0, r2.indexOf('\n\n'));
      expect(opener2.length).toBeLessThanOrEqual(opener1.length);
    });

    it('third pure chitchat returns no reply', async () => {
      const thread = await createIssueThread(TEST_GROUP, '好無聊啊');
      await updateIssueThread(TEST_GROUP, thread.issueThreadId, { pureChitchatCount: 2 });

      const replies = await applySemanticClassification({
        groupId: TEST_GROUP,
        issueThreadId: thread.issueThreadId,
        customerUserId: TEST_CUSTOMER,
        question: '好無聊啊',
        classification: {
          intentClear: false,
          cardId: null,
          confidence: 'low',
          clarifyQuestion: null,
          summary: 'chitchat',
          usedLlm: false,
          isChitchat: true,
        },
        clarifyRound: 0,
      });

      expect(replies).toEqual([]);
    });

    it('chitchat switching to operational question exits chitchat flow', async () => {
      const thread = await createIssueThread(TEST_GROUP, '計次券怎麼設定');
      await updateIssueThread(TEST_GROUP, thread.issueThreadId, { pureChitchatCount: 1 });

      await getRepos().knowledgeCards.insert({
        cardId: 'op-punch-copy',
        title: '計次券',
        patterns: ['計次券', '怎麼使用計次券', '計次券怎麼設定'],
        riskLevel: RiskLevel.LOW,
        canPublicReply: true,
        standardAnswer: '步驟一：到票券管理。',
        notApplicable: [],
        escalateToConsultant: [],
        status: 'active',
        createdBy: TEST_ADMIN,
        createdAt: new Date().toISOString(),
        confirmedBy: TEST_ADMIN,
        confirmedAt: new Date().toISOString(),
      });
      await refreshKnowledgeCache();

      const replies = await applySemanticClassification({
        groupId: TEST_GROUP,
        issueThreadId: thread.issueThreadId,
        customerUserId: TEST_CUSTOMER,
        question: '計次券怎麼設定',
        classification: {
          intentClear: true,
          cardId: 'op-punch-copy',
          confidence: 'high',
          clarifyQuestion: null,
          summary: '計次券設定',
          usedLlm: false,
          isChitchat: false,
        },
        clarifyRound: 0,
      });

      expect(replies.length).toBeGreaterThan(0);
      const chitchatPoolHit = replies.some((r) =>
        CHITCHAT_REDIRECT_POOL.some((pool) => r.text?.includes(pool)),
      );
      expect(chitchatPoolHit).toBe(false);

      const updated = await getActiveIssueThread(TEST_GROUP);
      expect(updated?.pureChitchatCount ?? 0).toBe(0);
    });

    it('missing OPENAI_API_KEY falls back to exact pool text without error', async () => {
      resetEnvCache();
      loadEnv({ USE_MEMORY_REPOS: true, DEBOUNCE_SECONDS: 0, OPENAI_API_KEY: '' });
      setLlmClient(null);

      const reply = await buildChitchatReply('今天好熱', 1);
      expect(CHITCHAT_REDIRECT_POOL).toContain(reply);
      expect(reply).toBe(getChitchatRedirectByIndex(pickDeterministicChitchatRedirectIndex('今天好熱')));
    });

    it('LLM failure falls back to exact pool text without error', async () => {
      resetEnvCache();
      loadEnv({ USE_MEMORY_REPOS: true, DEBOUNCE_SECONDS: 0, OPENAI_API_KEY: 'test-key' });
      const failingClient: LlmClient = {
        complete: async () => {
          throw new Error('LLM down');
        },
      };
      setLlmClient(failingClient);

      const reply = await buildChitchatReply('今天好熱', 1);
      expect(CHITCHAT_REDIRECT_POOL).toContain(reply);
      expect(reply).toBe(getChitchatRedirectByIndex(pickDeterministicChitchatRedirectIndex('今天好熱')));
    });

    it('LLM invalid index falls back to exact pool text', async () => {
      resetEnvCache();
      loadEnv({ USE_MEMORY_REPOS: true, DEBOUNCE_SECONDS: 0, OPENAI_API_KEY: 'test-key' });
      const invalidClient: LlmClient = {
        complete: async (system) => {
          if (system.includes('index')) {
            return '{"index": 99}';
          }
          return '收到';
        },
      };
      setLlmClient(invalidClient);

      const reply = await buildChitchatReply('今天好熱', 1);
      expect(CHITCHAT_REDIRECT_POOL).toContain(reply);
      expect(reply).toBe(getChitchatRedirectByIndex(pickDeterministicChitchatRedirectIndex('今天好熱')));
    });
  });
});
