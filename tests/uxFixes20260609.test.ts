import express from 'express';
import crypto from 'crypto';
import request from 'supertest';
import { EventType, RiskLevel, ThreadState } from '../src/types';
import { loadEnv, resetEnvCache } from '../src/config/env';
import { resetRepositories, getRepos } from '../src/repositories';
import { processMessage } from '../src/handlers/lineWebhookHandler';
import { handleLineWebhook, mapLineEvent } from '../src/routes/lineWebhook';
import { INTRO_MESSAGE, handleServiceIntroduction } from '../src/services/servicePeriodService';
import {
  isNannyPeriodApproximatePhrase,
  isNannyPeriodPhrase,
  NANNY_PERIOD_STANDARD_SYNTAX_HINT,
} from '../src/services/consultantIntentClassifier';
import {
  formatHumanReadableKnowledgeCard,
  formatDraftReply,
  setLlmClient,
} from '../src/services/knowledgeCardDraftService';
import { enforceKnowledgeCardRules } from '../src/services/knowledgeCardValidator';
import { formatValidationErrorsForHuman } from '../src/services/knowledgeCardValidationMessages';
import {
  buildHandoffPrivateCard,
  buildHandoffShortReminder,
  handleViewPendingHandoffs,
} from '../src/services/pendingHandoffService';
import { executeHandoff } from '../src/services/consultantHandoffService';
import {
  handleDmSessionPrivateMessage,
  seedActiveSessionForTest,
} from '../src/services/dmSessionService';
import {
  handleConsultantConfirmUpdateAttempt,
} from '../src/services/knowledgeCardWriteService';
import { updateGroupFlags } from '../src/services/groupFlags';
import { createIssueThread } from '../src/services/issueThreadService';
import {
  registerAdmin,
  registerInviteCode,
  requestConsultantJoin,
  approveConsultant,
} from '../src/services/consultantWhitelist';
import { setLineGroupSummaryClient } from '../src/services/lineGroupSummaryService';
import { KnowledgeCard } from '../src/schemas/knowledgeCardSchema';
import { TEST_ADMIN, TEST_CONSULTANT, TEST_CUSTOMER, TEST_GROUP } from './helpers/testSetup';

const SECRET = 'test-channel-secret';

const sampleCard: KnowledgeCard = {
  card_id: 'ux-card',
  title: '登入問題',
  patterns: ['怎麼登入後台'],
  risk_level: RiskLevel.LOW,
  can_public_reply: true,
  standard_answer: '請至後台登入頁輸入帳號密碼。',
  not_applicable: ['不是登入相關問題'],
  escalate_to_consultant: ['帳號被鎖定'],
  status: '可用',
};

const billingDisplayCard: KnowledgeCard = {
  card_id: 'billing-display-card',
  title: '儲值卡設定',
  patterns: ['儲值卡要怎麼設定？', '客人要買儲值卡時怎麼操作？'],
  risk_level: RiskLevel.LOW,
  can_public_reply: true,
  standard_answer:
    '儲值卡設定需先到「設定」→「票券管理」建立儲值卡。結帳時若客人要購買儲值卡，需另外開快速結帳單協助購買。',
  not_applicable: ['不是儲值卡相關問題'],
  escalate_to_consultant: ['儲值金額有誤', '店家看不懂帳務或扣抵狀況'],
  status: '可用',
};

async function setupConsultant(): Promise<void> {
  await registerAdmin(TEST_ADMIN);
  await registerInviteCode('UXCODE', TEST_ADMIN);
  await requestConsultantJoin(TEST_CONSULTANT, 'UXCODE');
  await approveConsultant(TEST_ADMIN, TEST_CONSULTANT);
}

function sign(body: string): string {
  return crypto.createHmac('sha256', SECRET).update(body).digest('base64');
}

describe('UX fixes 2026-06-09', () => {
  beforeEach(async () => {
    resetEnvCache();
    loadEnv({ USE_MEMORY_REPOS: true, LINE_CHANNEL_SECRET: SECRET });
    await resetRepositories('memory');
    await setupConsultant();
    setLlmClient(null);
    setLineGroupSummaryClient(null);
  });

  describe('group intro message', () => {
    it('uses finalized INTRO_MESSAGE and writes service period', async () => {
      const replies = await handleServiceIntroduction(TEST_GROUP, TEST_CONSULTANT);
      expect(replies[0].text).toBe(INTRO_MESSAGE);
      expect(INTRO_MESSAGE).toMatch(/老師好，我是客立樂教學小助手/);
      expect(INTRO_MESSAGE).toMatch(/接下來 30 天/);
      const flags = await getRepos().groups.getOrCreate(TEST_GROUP);
      expect(flags.serviceStartAt).not.toBeNull();
      expect(flags.serviceEndAt).not.toBeNull();
    });

    it('activates service via 小助手自我介紹一下', async () => {
      const result = await processMessage({
        userId: TEST_CONSULTANT,
        groupId: TEST_GROUP,
        text: '小助手自我介紹一下',
        isGroup: true,
        isBotMentioned: false,
        sourceType: 'group',
      });
      expect(result.replies[0].text).toBe(INTRO_MESSAGE);
      const flags = await getRepos().groups.getOrCreate(TEST_GROUP);
      expect(flags.serviceStartAt).not.toBeNull();
    });
  });

  describe('nanny period approximate syntax hints', () => {
    it('detects approximate phrases without matching standard syntax', () => {
      expect(isNannyPeriodApproximatePhrase('啟用保母期')).toBe(true);
      expect(isNannyPeriodApproximatePhrase('小助手啟用保母期 30 天')).toBe(false);
      expect(isNannyPeriodPhrase('小助手開始協助 30 天')).toBe(true);
    });

    it('replies hint for consultant approximate phrase without enabling service', async () => {
      const result = await processMessage({
        userId: TEST_CONSULTANT,
        groupId: TEST_GROUP,
        text: '啟用保母期',
        isGroup: true,
        isBotMentioned: false,
        sourceType: 'group',
      });
      expect(result.replies[0].text).toBe(NANNY_PERIOD_STANDARD_SYNTAX_HINT);
      const flags = await getRepos().groups.getOrCreate(TEST_GROUP);
      expect(flags.serviceStartAt).toBeNull();
    });

    it('formally enables with standard syntax', async () => {
      const result = await processMessage({
        userId: TEST_CONSULTANT,
        groupId: TEST_GROUP,
        text: '小助手啟用保母期 30 天',
        isGroup: true,
        isBotMentioned: false,
        sourceType: 'group',
      });
      expect(result.replies[0].text).toBe(INTRO_MESSAGE);
      const flags = await getRepos().groups.getOrCreate(TEST_GROUP);
      expect(flags.serviceStartAt).not.toBeNull();
    });

    it('does not reply to customer approximate phrase', async () => {
      await handleServiceIntroduction(TEST_GROUP, TEST_CONSULTANT);
      const result = await processMessage({
        userId: TEST_CUSTOMER,
        groupId: TEST_GROUP,
        text: '啟用保母期',
        isGroup: true,
        isBotMentioned: false,
        sourceType: 'group',
      });
      expect(result.replies).toHaveLength(0);
    });
  });

  describe('group sticker and non-text ignore', () => {
    it('maps sticker events to non_text', () => {
      const mapped = mapLineEvent({
        type: 'message',
        source: { type: 'group', userId: TEST_CONSULTANT, groupId: TEST_GROUP },
        message: { type: 'sticker' },
        replyToken: 'token',
      });
      expect(mapped).toBe('non_text');
    });

    it('does not reply to group sticker webhook events', async () => {
      const app = express();
      app.post('/webhook/line', express.raw({ type: '*/*' }), (req, res) => {
        void handleLineWebhook(req, res);
      });
      let replied = false;
      const { setLineMessageClient } = await import('../src/services/lineMessageService');
      setLineMessageClient({
        async replyText() {
          replied = true;
        },
        async pushText() {
          throw new Error('should not push');
        },
      });

      const body = JSON.stringify({
        events: [
          {
            type: 'message',
            source: { type: 'group', userId: TEST_CONSULTANT, groupId: TEST_GROUP },
            message: { type: 'sticker' },
            replyToken: 'reply-sticker',
          },
        ],
      });

      await request(app)
        .post('/webhook/line')
        .set('Content-Type', 'application/json')
        .set('x-line-signature', sign(body))
        .send(body)
        .expect(200);

      expect(replied).toBe(false);
      const events = await getRepos().events.findByType(EventType.STATE_TRANSITION);
      expect(events).toHaveLength(0);
    });
  });

  describe('human readable draft and validator messages', () => {
    it('default draft hides internal field names', () => {
      const text = formatHumanReadableKnowledgeCard(billingDisplayCard);
      expect(text).toMatch(/【知識卡草稿】/);
      expect(text).toMatch(/主題：/);
      expect(text).not.toMatch(/risk_level/);
      expect(text).not.toMatch(/can_public_reply/);
      expect(text).not.toMatch(/patterns/);
      expect(text).not.toMatch(/card_id/);
    });

    it('validator failure uses human readable message', () => {
      const invalid = {
        ...sampleCard,
        card_id: 'billing-card',
        title: '帳務問題',
        patterns: ['帳務異常怎麼看'],
        standard_answer: '請先對帳',
        risk_level: RiskLevel.LOW,
        can_public_reply: true,
      };
      const validation = enforceKnowledgeCardRules(invalid);
      const message = formatValidationErrorsForHuman(validation.errors);
      expect(message).toMatch(/不會設定成小助手自動公開回答/);
      expect(message).not.toMatch(/risk_level/);
      expect(message).not.toMatch(/can_public_reply/);
    });

    it('formatDraftReply surfaces human readable validation failure', () => {
      const reply = formatDraftReply({
        kind: 'single_card',
        operation: 'create',
        draftJson: '{}',
        reasonText: null,
        validation: enforceKnowledgeCardRules({
          ...sampleCard,
          card_id: 'billing-card',
          title: '帳務問題',
          patterns: ['帳務異常怎麼看'],
          standard_answer: '請先對帳',
          risk_level: RiskLevel.LOW,
          can_public_reply: true,
        }),
      });
      expect(reply).toMatch(/驗證失敗/);
      expect(reply).not.toMatch(/risk_level:/);
    });
  });

  describe('active dm_session command routing', () => {
    beforeEach(() => {
      setLlmClient({
        complete: jest.fn().mockResolvedValue(JSON.stringify(sampleCard)),
      });
    });

    it('routes 確認更新 for admin instead of treating as draft content', async () => {
      await seedActiveSessionForTest({ userId: TEST_ADMIN, card: sampleCard });
      const replies = await handleDmSessionPrivateMessage({
        userId: TEST_ADMIN,
        text: '確認更新',
      });
      expect(replies?.[0].text).toMatch(/已確認更新/);
    });

    it('rejects consultant 確認更新 during active session', async () => {
      await seedActiveSessionForTest({ userId: TEST_CONSULTANT, card: sampleCard });
      const replies = await handleDmSessionPrivateMessage({
        userId: TEST_CONSULTANT,
        text: '確認更新',
      });
      expect(replies?.[0].text).toMatch(/只有 active admin 可確認更新/);
    });

    it('routes consultant 確認送出 during active session', async () => {
      await seedActiveSessionForTest({ userId: TEST_CONSULTANT, card: sampleCard });
      const replies = await handleDmSessionPrivateMessage({
        userId: TEST_CONSULTANT,
        text: '確認送出',
      });
      expect(replies?.[0].text).toMatch(/已送出草稿給 admin 審核/);
    });
  });

  describe('group name and handoff UX', () => {
    it('shows group name in handoff card when available', () => {
      const card = buildHandoffPrivateCard({
        groupId: TEST_GROUP,
        groupName: '大寶寶測試群',
        shortCode: 'Q-20260608-0100-A1',
        customerQuestion: '登入問題',
      });
      expect(card).toContain('群組：大寶寶測試群');
      expect(card).not.toContain(`groupId: ${TEST_GROUP}`);
    });

    it('falls back to groupId label when group name unavailable', () => {
      const card = buildHandoffPrivateCard({
        groupId: TEST_GROUP,
        shortCode: 'Q-20260608-0100-A1',
        customerQuestion: '登入問題',
      });
      expect(card).toContain(`groupId: ${TEST_GROUP}`);
    });

    it('stores group name from LINE summary API', async () => {
      setLineGroupSummaryClient({
        getGroupSummary: jest.fn(async () => ({ groupName: '大寶寶測試群' })),
      });
      await processMessage({
        userId: TEST_CONSULTANT,
        groupId: TEST_GROUP,
        text: '小助手自我介紹一下',
        isGroup: true,
        isBotMentioned: false,
        sourceType: 'group',
      });
      const flags = await getRepos().groups.getOrCreate(TEST_GROUP);
      expect(flags.groupName).toBe('大寶寶測試群');
    });

    it('pushes short reminder when consultant has active dm_session', async () => {
      await handleServiceIntroduction(TEST_GROUP, TEST_CONSULTANT);
      await updateGroupFlags(TEST_GROUP, { groupName: '大寶寶測試群' });
      await seedActiveSessionForTest({ userId: TEST_CONSULTANT, card: sampleCard });
      const thread = await createIssueThread(TEST_GROUP, '登入不了');
      const { replies } = await executeHandoff({
        groupId: TEST_GROUP,
        issueThreadId: thread.issueThreadId,
        customerQuestion: '登入不了',
        card: null,
        reason: '知識庫未命中',
        riskLevel: RiskLevel.UNKNOWN,
      });
      const consultantReply = replies.find((reply) => reply.userId === TEST_CONSULTANT);
      expect(consultantReply?.text).toMatch(/【群組新問題提醒】/);
      expect(consultantReply?.text).toContain('大寶寶測試群');
      expect(consultantReply?.text).not.toMatch(/【問題收斂卡】/);
    });

    it('lists open pending handoffs via 查看待處理問題', async () => {
      await updateGroupFlags(TEST_GROUP, { groupName: '大寶寶測試群' });
      await getRepos().pendingHandoffs.create({
        consultantId: TEST_CONSULTANT,
        issueThreadId: 'thread-ux-1',
        groupId: TEST_GROUP,
        shortCode: 'Q-20260608-0100-A1',
        customerQuestion: '登入問題',
      });
      const replies = await handleViewPendingHandoffs(TEST_CONSULTANT);
      expect(replies[0].text).toMatch(/【待處理問題清單】/);
      expect(replies[0].text).toContain('大寶寶測試群');
      expect(replies[0].text).toContain('Q-20260608-0100-A1');
    });

    it('buildHandoffShortReminder uses expected format', () => {
      const text = buildHandoffShortReminder({
        groupId: TEST_GROUP,
        groupName: '大寶寶測試群',
        shortCode: 'Q-20260608-0100-A1',
      });
      expect(text).toMatch(/查看待處理問題/);
      expect(text).toContain('大寶寶測試群');
    });
  });

  describe('red line regression', () => {
    it('ThreadState count remains 5', () => {
      expect(Object.keys(ThreadState).length).toBe(5);
    });

    it('EventType count remains 10', () => {
      expect(Object.keys(EventType).length).toBe(10);
    });
  });
});
