import { KnowledgeCard } from '../src/schemas/knowledgeCardSchema';
import { processMessage } from '../src/handlers/lineWebhookHandler';
import { getRepos } from '../src/repositories';
import { getGroupFlags } from '../src/services/groupFlags';
import {
  GROUP_ASSISTANT_COMMANDS,
  GROUP_CUSTOMER_USAGE_GUIDE,
} from '../src/services/groupAssistantCommandService';
import {
  CORRECTION_GROUP_ACK,
  clearCorrectionRemindersForTest,
  handleAssistantCorrection,
  onThreadClosedAfterCorrection,
} from '../src/services/consultantCorrectionService';
import {
  CUSTOMER_TEACHING_FOLLOWUP_BUFFER,
  handleCustomerTeachingFollowUp,
} from '../src/services/customerTeachingFollowUpService';
import {
  handleServiceIntroduction,
  INTRO_MESSAGE,
} from '../src/services/servicePeriodService';
import { getCardById } from '../src/services/knowledgeBaseService';
import {
  createIssueThread,
  getActiveIssueThread,
  markConsultantAnswered,
} from '../src/services/issueThreadService';
import { createEvent } from '../src/services/eventLogService';
import {
  approveConsultant,
  registerAdmin,
  registerInviteCode,
  requestConsultantJoin,
} from '../src/services/consultantWhitelist';
import { Actor, EventType, RiskLevel, ThreadState } from '../src/types';
import { transitionState } from '../src/services/stateMachine';
import {
  storeHandoffReplyContext,
  clearHandoffReplyContext,
  ORGANIZE_FROM_HANDOFF_NOT_FOUND_MESSAGE,
} from '../src/services/handoffKnowledgeDraftService';
import { executeReplyToGroup } from '../src/services/replyToGroupService';
import { createPendingHandoff } from '../src/services/pendingHandoffService';
import { handleDmSessionPrivateMessage } from '../src/services/dmSessionService';
import { handlePrivateCodeNavigation } from '../src/services/privateCodeNavigationService';
import { handlePrivateUsageGuide } from '../src/services/knowledgeCardUsageGuideHandler';
import { setLlmClient } from '../src/services/knowledgeCardDraftService';
import { setLineGroupSummaryClient } from '../src/services/lineGroupSummaryService';
import { handleBotJoinGroup } from '../src/services/botJoinGroupService';
import {
  resetTestState,
  TEST_ADMIN,
  TEST_CONSULTANT,
  TEST_CUSTOMER,
  TEST_GROUP,
} from './helpers/testSetup';

const billingTutorialCard: KnowledgeCard = {
  card_id: 'kc-test-billing',
  title: '儲值卡設定教學',
  patterns: ['儲值'],
  standard_answer: '到票券管理新增儲值卡。',
  not_applicable: [],
  escalate_to_consultant: [],
  risk_level: RiskLevel.LOW,
  can_public_reply: true,
  status: '可用',
};

async function seedConsultants(): Promise<void> {
  await registerAdmin(TEST_ADMIN);
  await registerInviteCode('TESTCODE', TEST_ADMIN);
  await requestConsultantJoin(TEST_CONSULTANT, 'TESTCODE');
  await approveConsultant(TEST_ADMIN, TEST_CONSULTANT);
}

async function setupServicePeriod(): Promise<void> {
  await seedConsultants();
  await handleServiceIntroduction(TEST_GROUP, TEST_CONSULTANT);
}

function groupMsg(userId: string, text: string) {
  return { userId, groupId: TEST_GROUP, text, isGroup: true };
}

function privateMsg(userId: string, text: string) {
  return { userId, text, isGroup: false };
}

describe('group syntax and private code UX 2026-06-10', () => {
  beforeEach(async () => {
    await resetTestState();
    clearCorrectionRemindersForTest();
    clearHandoffReplyContext();
    await seedConsultants();
  });

  describe('group assistant command boundaries', () => {
    it('intro enables 30-day service period', async () => {
      const result = await processMessage(
        groupMsg(TEST_CONSULTANT, GROUP_ASSISTANT_COMMANDS.INTRO)
      );
      expect(result.replies[0].text).toBe(INTRO_MESSAGE);
      const flags = await getGroupFlags(TEST_GROUP);
      expect(flags.serviceStartAt).not.toBeNull();
    });

    it('mute and unmute with new syntax', async () => {
      await setupServicePeriod();
      const mute = await processMessage(
        groupMsg(TEST_CONSULTANT, GROUP_ASSISTANT_COMMANDS.MUTE)
      );
      expect(mute.replies[0].text).toContain('隨時叫我回來');
      expect((await getGroupFlags(TEST_GROUP)).mute).toBe(true);

      const unmute = await processMessage(
        groupMsg(TEST_CONSULTANT, GROUP_ASSISTANT_COMMANDS.UNMUTE)
      );
      expect(unmute.replies[0].text).toContain('隨時待命');
      expect((await getGroupFlags(TEST_GROUP)).mute).toBe(false);
    });

    it('accepts natural unmute wording used in real groups', async () => {
      await setupServicePeriod();
      await processMessage(groupMsg(TEST_CONSULTANT, GROUP_ASSISTANT_COMMANDS.MUTE));

      const unmute = await processMessage(groupMsg(TEST_CONSULTANT, '小助手再麻煩一下'));

      expect(unmute.replies[0].text).toContain('隨時待命');
      expect((await getGroupFlags(TEST_GROUP)).mute).toBe(false);
    });

    it('reactivates service period with status reply', async () => {
      await setupServicePeriod();
      const result = await processMessage(
        groupMsg(TEST_CONSULTANT, GROUP_ASSISTANT_COMMANDS.REACTIVATE)
      );
      expect(result.replies[0].text).toContain('已重新啟用教學協助期');
      expect(result.replies[0].text).toContain('【群組服務期】');
    });

    it('deprecated standby phrase does not set waitingFlag', async () => {
      await setupServicePeriod();
      await processMessage(groupMsg(TEST_CONSULTANT, '有什麼可以協助您的嗎？'));
      expect((await getGroupFlags(TEST_GROUP)).waitingFlag).toBe(false);
    });

    it('consultant general speech stays silent', async () => {
      await setupServicePeriod();
      const result = await processMessage(groupMsg(TEST_CONSULTANT, '我先看一下這題'));
      expect(result.replies).toHaveLength(0);
    });

    it('hydrates assignment with LINE group name before auto-bind notification', async () => {
      setLineGroupSummaryClient({
        async getGroupSummary() {
          return { groupName: '小助手測試' };
        },
      });

      const result = await processMessage(
        groupMsg(TEST_CONSULTANT, GROUP_ASSISTANT_COMMANDS.INTRO)
      );
      const assignment = await getRepos().groupConsultantAssignments.findByGroupId(TEST_GROUP);

      expect(assignment?.groupName).toBe('小助手測試');
      expect(result.replies.some((reply) => reply.text.includes('小助手測試（G-01）'))).toBe(
        true
      );
    });

    it('stores LINE group name when the bot joins a new group', async () => {
      setLineGroupSummaryClient({
        async getGroupSummary() {
          return { groupName: '小助手測試' };
        },
      });

      await handleBotJoinGroup(TEST_GROUP);

      const assignment = await getRepos().groupConsultantAssignments.findByGroupId(TEST_GROUP);
      const flags = await getGroupFlags(TEST_GROUP);
      expect(assignment?.groupName).toBe('小助手測試');
      expect(flags.groupName).toBe('小助手測試');
    });
  });

  describe('group customer usage guide', () => {
    it('returns store-facing guide without admin syntax', async () => {
      await setupServicePeriod();
      const result = await processMessage(groupMsg(TEST_CUSTOMER, '小助手你會做什麼'));
      expect(result.replies[0].text).toBe(GROUP_CUSTOMER_USAGE_GUIDE);
      expect(result.replies[0].text).not.toContain('確認更新');
      expect(result.replies[0].text).not.toContain('代回');
    });
  });

  describe('correction flow', () => {
    beforeEach(async () => {
      await setupServicePeriod();
      const thread = await createIssueThread(TEST_GROUP, '怎麼新增預約');
      await transitionState({
        groupId: TEST_GROUP,
        issueThreadId: thread.issueThreadId,
        toState: ThreadState.AI_ANSWERING,
        actor: Actor.BOT,
        detail: 'test answer',
      });
      await getRepos().threads.update(TEST_GROUP, thread.issueThreadId, {
        lastKnowledgeCardId: 'op-login',
        hasSubstantiveAnswer: true,
      });
      await createEvent({
        event_type: EventType.AI_ANSWER,
        group_id: TEST_GROUP,
        issue_thread_id: thread.issueThreadId,
        actor: Actor.BOT,
        knowledge_card_id: 'op-login',
        detail: getCardById('op-login')!.standard_answer,
      });
    });

    it('correction ack is customer-facing only', async () => {
      const result = await processMessage(
        groupMsg(TEST_CONSULTANT, GROUP_ASSISTANT_COMMANDS.CORRECTION)
      );
      expect(result.replies[0].text).toBe(CORRECTION_GROUP_ACK);
      expect(result.replies[0].text).not.toContain('暫停');
    });

    it('pauses matched card on correction', async () => {
      await handleAssistantCorrection(TEST_GROUP, TEST_CONSULTANT);
      const card = getCardById('op-login');
      expect(card?.status).toBe('暫停');
    });

    it('sends knowledge card suggestion after close', async () => {
      const thread = await getActiveIssueThread(TEST_GROUP);
      await handleAssistantCorrection(TEST_GROUP, TEST_CONSULTANT);
      await markConsultantAnswered(TEST_GROUP, thread!.issueThreadId);
      const pushes = await onThreadClosedAfterCorrection(
        TEST_GROUP,
        thread!.issueThreadId
      );
      expect(pushes.some((r) => r.text?.includes('【建議修改知識卡】'))).toBe(true);
    });
  });

  describe('customer teaching follow-up', () => {
    beforeEach(async () => {
      await setupServicePeriod();
      const thread = await createIssueThread(TEST_GROUP, '怎麼登入');
      await createEvent({
        event_type: EventType.AI_ANSWER,
        group_id: TEST_GROUP,
        issue_thread_id: thread.issueThreadId,
        actor: Actor.BOT,
        detail: '步驟一：打開後台',
      });
      await getRepos().threads.update(TEST_GROUP, thread.issueThreadId, {
        state: ThreadState.AI_ANSWERING,
        hasSubstantiveAnswer: true,
      });
    });

    it('returns buffer message and blocks auto reply', async () => {
      const replies = await handleCustomerTeachingFollowUp({
        groupId: TEST_GROUP,
        customerUserId: TEST_CUSTOMER,
        text: '還是不行',
      });
      expect(replies?.[0].text).toBe(CUSTOMER_TEACHING_FOLLOWUP_BUFFER);
      const thread = await getActiveIssueThread(TEST_GROUP);
      expect(thread?.autoReplyBlocked).toBe(true);
    });
  });

  describe('organize from handoff', () => {
    it('uses recent reply context without re-asking question', async () => {
      storeHandoffReplyContext(TEST_CONSULTANT, {
        groupId: TEST_GROUP,
        groupName: '測試群',
        shortCode: 'Q-20260610-1200-AA',
        customerQuestion: '怎麼儲值',
        replyText: '到票券管理新增。',
      });
      setLlmClient({
        complete: jest.fn().mockResolvedValue(JSON.stringify(billingTutorialCard)),
      });
      const replies = await handleDmSessionPrivateMessage({
        userId: TEST_CONSULTANT,
        text: '把剛剛代回整理成知識卡',
      });
      expect(replies?.[0].text).not.toBe(ORGANIZE_FROM_HANDOFF_NOT_FOUND_MESSAGE);
      const session = await getRepos().dmSessions.findActiveByUserId(TEST_CONSULTANT);
      expect(session).not.toBeNull();
    });

    it('returns not-found when no handoff context', async () => {
      const replies = await handleDmSessionPrivateMessage({
        userId: TEST_CONSULTANT,
        text: '把剛剛代回整理成知識卡',
      });
      expect(replies?.[0].text).toBe(ORGANIZE_FROM_HANDOFF_NOT_FOUND_MESSAGE);
    });
  });

  describe('reply to group format', () => {
    it('includes customer question prefix verbatim reply', async () => {
      await setupServicePeriod();
      const thread = await createIssueThread(TEST_GROUP, '怎麼登入後台');
      const handoff = await createPendingHandoff({
        consultantId: TEST_CONSULTANT,
        issueThreadId: thread.issueThreadId,
        groupId: TEST_GROUP,
        shortCode: 'Q-20260610-1300-BB',
        customerQuestion: '怎麼登入後台',
      });
      const result = await executeReplyToGroup({
        consultantId: TEST_CONSULTANT,
        replyText: '請從右上角登入。',
        shortCode: handoff.shortCode,
      });
      const groupReply = result.replies.find((r) => r.type === 'push' && r.userId === TEST_GROUP);
      expect(groupReply?.text).toContain('針對您剛剛提到');
      expect(groupReply?.text).toContain('怎麼登入後台');
      expect(groupReply?.text).toContain('請從右上角登入。');
      expect(groupReply?.text).not.toContain('導入教練回覆');
    });
  });

  describe('private code navigation', () => {
    it('admin group list accepts query wording from usage guide testing', async () => {
      await handleBotJoinGroup(TEST_GROUP);
      const result = await processMessage(privateMsg(TEST_ADMIN, '查詢群組列表'));
      expect(result.replies[0].text).toContain('【群組清單】');
    });

    it('consultant group list alias is rejected instead of silent', async () => {
      const result = await processMessage(privateMsg(TEST_CONSULTANT, '查詢群組列表'));
      expect(result.replies[0].text).toContain('僅 active admin');
    });

    it('shows Q code action list', async () => {
      const thread = await createIssueThread(TEST_GROUP, '問題');
      await createPendingHandoff({
        consultantId: TEST_CONSULTANT,
        issueThreadId: thread.issueThreadId,
        groupId: TEST_GROUP,
        shortCode: 'Q-20260610-1400-CC',
        customerQuestion: '問題',
      });
      const replies = await handlePrivateCodeNavigation(
        TEST_CONSULTANT,
        'Q-20260610-1400-CC'
      );
      expect(replies?.[0].text).toContain('我找到這筆待處理問題');
    });

    it('private usage guide triggers', async () => {
      const replies = await handlePrivateUsageGuide(TEST_CONSULTANT);
      expect(replies[0].text).toContain('代回群組');
      expect(replies[0].text).toContain('小助手這題我更正');
    });

    it('service period query blocked for consultant', async () => {
      const replies = await handlePrivateCodeNavigation(
        TEST_CONSULTANT,
        '查詢服務期 測試群'
      );
      expect(replies?.[0].text).toContain('尚未開放顧問查詢');
    });

    it('service period query works for admin', async () => {
      await getRepos().groups.update(TEST_GROUP, { groupName: '大寶寶測試群' });
      await handleServiceIntroduction(TEST_GROUP, TEST_ADMIN);
      const replies = await handlePrivateCodeNavigation(
        TEST_ADMIN,
        '查詢服務期 大寶寶測試群'
      );
      expect(replies?.[0].text).toContain('【群組服務期】');
    });

    it('service period query supports partial group name used in LINE', async () => {
      await getRepos().groups.update(TEST_GROUP, { groupName: '小助手測試 (3)' });
      await handleBotJoinGroup(TEST_GROUP);
      await handleServiceIntroduction(TEST_GROUP, TEST_ADMIN);
      const replies = await handlePrivateCodeNavigation(
        TEST_ADMIN,
        '查詢服務期 小助手測試'
      );
      expect(replies?.[0].text).toContain('【群組服務期】');
      expect(replies?.[0].text).toContain('小助手測試');
    });

    it('unknown private command-like text returns guidance instead of silence', async () => {
      const result = await processMessage(privateMsg(TEST_ADMIN, '設定神秘功能'));
      expect(result.replies.length).toBeGreaterThan(0);
      expect(result.replies[0].text).toContain('使用說明');
    });
  });

  describe('private usage guide triggers', () => {
    it.each(['你會做什麼', '小助手會幹嘛', '你可以幫我什麼'])(
      'returns guide for "%s"',
      async (phrase) => {
        const result = await processMessage(privateMsg(TEST_CONSULTANT, phrase));
        expect(result.replies[0].text).toContain('使用說明');
      }
    );
  });
});
