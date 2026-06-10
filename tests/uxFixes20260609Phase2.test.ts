import { RiskLevel } from '../src/types';
import { loadEnv, resetEnvCache } from '../src/config/env';
import { resetRepositories, getRepos } from '../src/repositories';
import { processMessage } from '../src/handlers/lineWebhookHandler';
import {
  formatDraftActionHints,
  formatDraftReply,
  formatHumanReadableKnowledgeCard,
  setLlmClient,
} from '../src/services/knowledgeCardDraftService';
import { enforceKnowledgeCardRules } from '../src/services/knowledgeCardValidator';
import { writeKnowledgeCardWithValidation } from '../src/services/knowledgeCardWriteGate';
import { refreshKnowledgeCache } from '../src/services/knowledgeBaseService';
import { routeQuestion } from '../src/services/riskRouter';
import {
  handleDmSessionPrivateMessage,
  seedActiveSessionForTest,
} from '../src/services/dmSessionService';
import {
  handleConsultantConfirmSubmit,
  handleConsultantConfirmUpdateAttempt,
  handleConfirmUpdate,
} from '../src/services/knowledgeCardWriteService';
import {
  handleKnowledgeCardCommand,
} from '../src/services/knowledgeCardCommandService';
import {
  handleViewCommand,
  parseKnowledgeSearchQuery,
} from '../src/services/knowledgeCardViewService';
import {
  createPendingHandoff,
  handleSnoozeHandoff,
  handleViewPendingHandoffs,
  getOpenPendingHandoffs,
} from '../src/services/pendingHandoffService';
import { executeReplyToGroup } from '../src/services/replyToGroupService';
import { handleConsultantNaturalLanguage } from '../src/services/consultantActionService';
import { storeHandoffReplyContext } from '../src/services/handoffKnowledgeDraftService';
import {
  consumePrivateFallbackHint,
  clearPrivateFallbackState,
  SIMPLIFIED_PRIVATE_FALLBACK_HINT,
} from '../src/services/privateFallbackHintService';
import { handleServiceIntroduction } from '../src/services/servicePeriodService';
import { createIssueThread } from '../src/services/issueThreadService';
import { updateGroupFlags } from '../src/services/groupFlags';
import { parseExportCommand, exportKnowledgeCards } from '../src/services/knowledgeCardExportService';
import {
  registerAdmin,
  registerInviteCode,
  requestConsultantJoin,
  approveConsultant,
} from '../src/services/consultantWhitelist';
import { KnowledgeCard } from '../src/schemas/knowledgeCardSchema';
import { PendingHandoffStatus } from '../src/repositories/pendingHandoffTypes';
import { TEST_ADMIN, TEST_CONSULTANT, TEST_CUSTOMER, TEST_GROUP } from './helpers/testSetup';

const billingTutorialCard: KnowledgeCard = {
  card_id: 'stored-value-setup',
  title: '儲值卡設定',
  patterns: ['請問要怎麼儲值', '儲值卡要去哪裡設定'],
  risk_level: RiskLevel.LOW,
  can_public_reply: true,
  standard_answer: '儲值卡設定可以到「設定」→「票券管理」中新增。',
  not_applicable: ['儲值金額錯誤', '扣抵異常'],
  escalate_to_consultant: ['金額、付款、餘額或帳務相關問題'],
  status: '可用',
};

const invalidBillingCard = {
  ...billingTutorialCard,
  card_id: 'billing-invalid',
  title: '帳務問題',
  patterns: ['帳務異常怎麼看'],
  standard_answer: '請先對帳',
};

const quickCheckoutCard: KnowledgeCard = {
  card_id: 'kc-20260609-002',
  title: '快速結帳功能常見問題',
  patterns: ['快速結帳功能在哪裡', '如何新增快速結帳單'],
  risk_level: RiskLevel.LOW,
  can_public_reply: true,
  standard_answer: '可以在行事曆畫面右上角按 +，選擇新增快速結帳單。',
  not_applicable: [],
  escalate_to_consultant: [],
  status: '可用',
};

const regularCheckoutCard: KnowledgeCard = {
  card_id: 'regular-checkout',
  title: '一般結帳流程',
  patterns: ['客人怎麼結帳', '如何完成結帳'],
  risk_level: RiskLevel.LOW,
  can_public_reply: true,
  standard_answer: '請進入訂單後確認品項，再按結帳完成。',
  not_applicable: [],
  escalate_to_consultant: [],
  status: '可用',
};

async function setupConsultant(): Promise<void> {
  await registerAdmin(TEST_ADMIN, 'Admin');
  await registerInviteCode('P2CODE', TEST_ADMIN);
  await requestConsultantJoin(TEST_CONSULTANT, 'P2CODE', 'Consultant');
  await approveConsultant(TEST_ADMIN, TEST_CONSULTANT);
}

async function seedStoredValueCard(): Promise<void> {
  await writeKnowledgeCardWithValidation({
    card: billingTutorialCard,
    operatorUserId: TEST_ADMIN,
    operation: 'create',
    summary: 'test seed',
    logValidationFailure: false,
  });
  await refreshKnowledgeCache();
}

async function seedKnowledgeCard(card: KnowledgeCard): Promise<void> {
  await writeKnowledgeCardWithValidation({
    card,
    operatorUserId: TEST_ADMIN,
    operation: 'create',
    summary: 'test seed',
    logValidationFailure: false,
  });
  await refreshKnowledgeCache();
}

describe('UX fixes 2026-06-09 phase 2', () => {
  beforeEach(async () => {
    resetEnvCache();
    loadEnv({ USE_MEMORY_REPOS: true });
    await resetRepositories('memory');
    await setupConsultant();
    setLlmClient(null);
    clearPrivateFallbackState();
  });

  describe('validation failed draft persistence', () => {
    beforeEach(() => {
      setLlmClient({
        complete: jest
          .fn()
          .mockResolvedValueOnce(JSON.stringify(invalidBillingCard))
          .mockResolvedValueOnce(JSON.stringify(billingTutorialCard)),
      });
    });

    it('keeps failed draft in dm_session after validator failure', async () => {
      await handleDmSessionPrivateMessage({
        userId: TEST_CONSULTANT,
        text: '幫我整理知識卡：店家問如何新增結帳單，這是操作教學',
      });
      const session = await getRepos().dmSessions.findActiveByUserId(TEST_CONSULTANT);
      expect(session?.draftData?.validationStatus).toBe('failed');
      expect(session?.draftData?.lastInvalidDraft).toBeDefined();
      expect(session?.draftData?.validationFailureReason).toBeTruthy();
    });

    it('modify updates same draft after validator failure', async () => {
      await handleDmSessionPrivateMessage({
        userId: TEST_CONSULTANT,
        text: '幫我整理知識卡：店家問如何新增結帳單，這是操作教學',
      });
      const failedSession = await getRepos().dmSessions.findActiveByUserId(TEST_CONSULTANT);
      const failedCardId = failedSession?.draftData?.lastInvalidDraft?.card_id;

      const modifyReplies = await handleDmSessionPrivateMessage({
        userId: TEST_CONSULTANT,
        text: '修改：這張知識卡主要是教店家怎麼新增結帳單的操作，並沒有真的涉及帳務問題。',
      });
      expect(modifyReplies?.[0].text).toMatch(/【知識卡草稿｜/);

      const session = await getRepos().dmSessions.findActiveByUserId(TEST_CONSULTANT);
      expect(session?.draftData?.validationStatus).toBe('valid');
      expect(session?.draftData?.card?.card_id).toBe(billingTutorialCard.card_id);
      expect(failedCardId).toBeDefined();
    });

    it('admin confirm update on failed draft does not say no draft', async () => {
      await handleDmSessionPrivateMessage({
        userId: TEST_ADMIN,
        text: '幫我整理知識卡：帳務異常教學',
      });
      const replies = await handleDmSessionPrivateMessage({
        userId: TEST_ADMIN,
        text: '確認更新',
      });
      expect(replies?.[0].text).toMatch(/尚未通過驗證/);
      expect(replies?.[0].text).not.toMatch(/沒有待確認的知識卡草稿/);
    });

    it('repeat validation failure uses simplified message', async () => {
      setLlmClient({
        complete: jest.fn().mockResolvedValue(JSON.stringify(invalidBillingCard)),
      });
      const initialReply = (
        await handleDmSessionPrivateMessage({
          userId: TEST_CONSULTANT,
          text: '幫我整理知識卡：帳務異常教學',
        })
      )?.[0].text;
      expect(initialReply).toMatch(/【驗證失敗】/);

      const repeatReply = (
        await handleDmSessionPrivateMessage({
          userId: TEST_CONSULTANT,
          text: '修改：還是帳務異常',
        })
      )?.[0].text;
      expect(repeatReply).toMatch(/仍未通過驗證/);
      expect(repeatReply).not.toMatch(/【驗證失敗】/);
    });
  });

  describe('role-based draft action hints', () => {
    it('admin draft hints exclude 確認送出', () => {
      const hints = formatDraftActionHints(true);
      expect(hints).toMatch(/確認更新/);
      expect(hints).not.toMatch(/確認送出/);
    });

    it('consultant draft hints exclude 確認更新', () => {
      const hints = formatDraftActionHints(false);
      expect(hints).toMatch(/確認送出/);
      expect(hints).not.toMatch(/確認更新/);
    });

    it('admin human readable draft excludes 確認送出', () => {
      const text = formatHumanReadableKnowledgeCard(billingTutorialCard, { isAdmin: true });
      expect(text).toMatch(/確認更新/);
      expect(text).not.toMatch(/確認送出/);
    });

    it('consultant human readable draft excludes 確認更新', () => {
      const text = formatHumanReadableKnowledgeCard(billingTutorialCard, { isAdmin: false });
      expect(text).toMatch(/確認送出/);
      expect(text).not.toMatch(/確認更新/);
    });

    it('admin typing 確認送出 gets redirect message', async () => {
      await seedActiveSessionForTest({ userId: TEST_ADMIN, card: billingTutorialCard });
      const replies = await handleConsultantConfirmSubmit(TEST_ADMIN);
      expect(replies[0].text).toMatch(/您是 admin，請輸入「確認更新」/);
    });

    it('consultant typing 確認更新 is rejected', async () => {
      await seedActiveSessionForTest({ userId: TEST_CONSULTANT, card: billingTutorialCard });
      const replies = await handleConsultantConfirmUpdateAttempt({
        userId: TEST_CONSULTANT,
        text: '確認更新',
      });
      expect(replies[0].text).toMatch(/只有 active admin 可確認更新/);
    });
  });

  describe('cancel and fallback suppression', () => {
    it('cancel returns only one message without fallback', async () => {
      await handleDmSessionPrivateMessage({
        userId: TEST_CONSULTANT,
        text: '幫我整理知識卡',
      });
      const replies = await handleDmSessionPrivateMessage({
        userId: TEST_CONSULTANT,
        text: '取消',
      });
      expect(replies).toHaveLength(1);
      expect(replies?.[0].text).toBe('已取消目前知識卡整理流程，草稿資料已保留。');
      expect(consumePrivateFallbackHint(TEST_CONSULTANT)).toBe(false);
    });

    it('draft commands without active session return single message without fallback', async () => {
      for (const text of ['修改：test', '補充：test', '轉成 JSON', '確認送出']) {
        clearPrivateFallbackState();
        const replies = await handleDmSessionPrivateMessage({
          userId: TEST_CONSULTANT,
          text,
        });
        expect(replies).toHaveLength(1);
        expect(replies?.[0].text).toMatch(/目前沒有進行中的知識卡草稿/);
        expect(consumePrivateFallbackHint(TEST_CONSULTANT)).toBe(false);
      }

      clearPrivateFallbackState();
      const confirmUpdateReplies = await handleDmSessionPrivateMessage({
        userId: TEST_CONSULTANT,
        text: '確認更新',
      });
      expect(confirmUpdateReplies).toHaveLength(1);
      expect(confirmUpdateReplies?.[0].text).toMatch(/只有 active admin 可確認更新/);
      expect(consumePrivateFallbackHint(TEST_CONSULTANT)).toBe(false);
    });

    it('processMessage after cancel does not append fallback in same flow', async () => {
      await handleDmSessionPrivateMessage({
        userId: TEST_CONSULTANT,
        text: '幫我整理知識卡',
      });
      const replies = await processMessage({
        userId: TEST_CONSULTANT,
        text: '取消',
        isGroup: false,
      });
      expect(replies.replies).toHaveLength(1);
      expect(replies.replies[0].text).not.toContain(SIMPLIFIED_PRIVATE_FALLBACK_HINT);
    });
  });

  describe('snooze and pending handoff list', () => {
    beforeEach(async () => {
      await handleServiceIntroduction(TEST_GROUP, TEST_CONSULTANT);
    });

    it('snooze keeps pending_handoff open and prompts view command', async () => {
      await createPendingHandoff({
        consultantId: TEST_CONSULTANT,
        issueThreadId: 'thread-snooze',
        groupId: TEST_GROUP,
        shortCode: 'Q-20260608-0100-A1',
        customerQuestion: '登入問題',
      });
      const replies = await handleSnoozeHandoff(TEST_CONSULTANT);
      expect(replies[0].text).toMatch(/稍後處理/);
      expect(replies[0].text).toMatch(/查看待處理問題/);

      const open = await getOpenPendingHandoffs(TEST_CONSULTANT);
      expect(open).toHaveLength(1);
      expect(open[0].status).toBe(PendingHandoffStatus.OPEN);
      expect(open[0].snoozed).toBe(true);
    });

    it('view pending handoffs lists snoozed items with metadata', async () => {
      await updateGroupFlags(TEST_GROUP, { groupName: '測試群組' });
      await createPendingHandoff({
        consultantId: TEST_CONSULTANT,
        issueThreadId: 'thread-list',
        groupId: TEST_GROUP,
        shortCode: 'Q-20260608-0200-B2',
        customerQuestion: '儲值卡設定問題',
      });
      await handleSnoozeHandoff(TEST_CONSULTANT);

      const replies = await handleViewPendingHandoffs(TEST_CONSULTANT);
      const text = replies[0].text;
      expect(text).toMatch(/待處理問題清單/);
      expect(text).toMatch(/測試群組/);
      expect(text).toMatch(/Q-20260608-0200-B2/);
      expect(text).toMatch(/儲值卡設定問題/);
      expect(text).toMatch(/稍後處理/);
      expect(text).toMatch(/指定短碼代回/);
      expect(text).toMatch(/整理成知識卡草稿/);
    });
  });

  describe('reply-to-group confirmation and knowledge draft', () => {
    beforeEach(async () => {
      await handleServiceIntroduction(TEST_GROUP, TEST_CONSULTANT);
    });

    it('reply confirmation includes group, short code, question and reply preview', async () => {
      await createPendingHandoff({
        consultantId: TEST_CONSULTANT,
        issueThreadId: 'thread-reply',
        groupId: TEST_GROUP,
        shortCode: 'Q-20260608-0300-C3',
        customerQuestion: '登入不了',
      });
      const replies = await handleConsultantNaturalLanguage({
        userId: TEST_CONSULTANT,
        text: 'Q-20260608-0300-C3 請試試重設密碼',
        isGroup: false,
      });
      expect(replies?.[0].text).toMatch(/【代回群組確認】/);
      expect(replies?.[0].text).toMatch(/問題短碼：Q-20260608-0300-C3/);
      expect(replies?.[0].text).toMatch(/登入不了/);
      expect(replies?.[0].text).toMatch(/請試試重設密碼/);
      expect(replies?.[0].text).toMatch(/逐字轉貼/);
    });

    it('REPLY_TO_GROUP sends verbatim text to group', async () => {
      const thread = await createIssueThread(TEST_GROUP, '登入問題');
      const handoff = await createPendingHandoff({
        consultantId: TEST_CONSULTANT,
        issueThreadId: thread.issueThreadId,
        groupId: TEST_GROUP,
        shortCode: 'Q-20260608-0400-D4',
        customerQuestion: '登入問題',
      });
      const replyText = '請到登入頁重設密碼，不要改寫這句。';
      const result = await executeReplyToGroup({
        consultantId: TEST_CONSULTANT,
        replyText,
        shortCode: handoff.shortCode,
      });
      expect(result.success).toBe(true);
      expect(result.replies.some(
        (r) => r.type === 'push' && r.userId === TEST_GROUP && r.text?.includes(replyText)
      )).toBe(true);
    });

    it('successful reply prompts organize knowledge card draft', async () => {
      const thread = await createIssueThread(TEST_GROUP, '儲值問題');
      const handoff = await createPendingHandoff({
        consultantId: TEST_CONSULTANT,
        issueThreadId: thread.issueThreadId,
        groupId: TEST_GROUP,
        shortCode: 'Q-20260608-0500-E5',
        customerQuestion: '怎麼儲值',
      });
      const result = await executeReplyToGroup({
        consultantId: TEST_CONSULTANT,
        replyText: '到票券管理新增儲值卡。',
        shortCode: handoff.shortCode,
      });
      expect(result.replies.some((r) => r.text?.includes('把剛剛代回整理成知識卡'))).toBe(true);
    });

    it('把剛剛代回整理成知識卡 only creates draft without writing DB', async () => {
      const beforeCount = await getRepos().knowledgeCards.count();
      storeHandoffReplyContext(TEST_CONSULTANT, {
        groupId: TEST_GROUP,
        groupName: '測試群組',
        shortCode: 'Q-20260608-0600-F6',
        customerQuestion: '怎麼儲值',
        replyText: '到票券管理新增儲值卡。',
      });
      setLlmClient({
        complete: jest.fn().mockResolvedValue(JSON.stringify(billingTutorialCard)),
      });
      await handleDmSessionPrivateMessage({
        userId: TEST_CONSULTANT,
        text: '把剛剛代回整理成知識卡',
      });
      const afterCount = await getRepos().knowledgeCards.count();
      expect(afterCount).toBe(beforeCount);
      const session = await getRepos().dmSessions.findActiveByUserId(TEST_CONSULTANT);
      expect(session?.draftData?.card).toBeDefined();
    });
  });

  describe('knowledge card search and human readable results', () => {
    beforeEach(async () => {
      await seedStoredValueCard();
    });

    it.each([
      '查詢知識卡 儲值設定',
      '找跟儲值相關的知識卡',
      '搜尋儲值',
      '有沒有儲值的知識卡',
    ])('finds stored-value card via "%s"', async (query) => {
      expect(parseKnowledgeSearchQuery(query)).toBeTruthy();
      const replies = await handleKnowledgeCardCommand({
        userId: TEST_CONSULTANT,
        text: query,
      });
      expect(replies?.[0].text).toMatch(/儲值卡設定/);
      expect(replies?.[0].text).toMatch(/建議回答：/);
    });

    it('consultant search excludes paused cards', async () => {
      await getRepos().knowledgeCards.setStatus('stored-value-setup', 'paused', {
        updatedBy: TEST_ADMIN,
        confirmedBy: TEST_ADMIN,
        confirmedAt: new Date().toISOString(),
      });
      const replies = await handleKnowledgeCardCommand({
        userId: TEST_CONSULTANT,
        text: '搜尋儲值',
      });
      expect(replies?.[0].text).toMatch(/找不到相關知識卡/);
    });

    it('admin search includes paused cards', async () => {
      await getRepos().knowledgeCards.setStatus('stored-value-setup', 'paused', {
        updatedBy: TEST_ADMIN,
        confirmedBy: TEST_ADMIN,
        confirmedAt: new Date().toISOString(),
      });
      const replies = await handleKnowledgeCardCommand({
        userId: TEST_ADMIN,
        text: '搜尋儲值',
      });
      expect(replies?.[0].text).toMatch(/儲值卡設定/);
    });

    it('list all uses human readable format without audit fields for consultant', async () => {
      const replies = await handleViewCommand(TEST_CONSULTANT, 'all');
      expect(replies[0].text).toMatch(/【知識卡】/);
      expect(replies[0].text).toMatch(/建議回答：/);
      expect(replies[0].text).toMatch(/不適用情況：/);
      expect(replies[0].text).toMatch(/需要導入教練協助：/);
      expect(replies[0].text).not.toMatch(/created_by=/);
      expect(replies[0].text).not.toMatch(/risk=/);
      expect(replies[0].text).not.toMatch(/status=/);
    });

    it('admin can export raw JSON for audit fields', async () => {
      expect(parseExportCommand('匯出所有知識卡')).toBe('all');
      const result = await exportKnowledgeCards(TEST_ADMIN, 'all');
      expect(result.replies[0].text).toMatch(/"card_id"/);
      expect(result.replies[0].text).toMatch(/created_by/);
    });

    it('finds a knowledge card by full card_id through 查詢知識卡', async () => {
      await seedKnowledgeCard(quickCheckoutCard);

      const replies = await handleKnowledgeCardCommand({
        userId: TEST_CONSULTANT,
        text: '查詢知識卡 kc-20260609-002',
      });

      expect(replies?.[0].text).toMatch(/快速結帳功能常見問題/);
      expect(replies?.[0].text).toMatch(/知識卡編號：kc-20260609-002/);
      expect(replies?.[0].text).toMatch(/修改知識卡 kc-20260609-002/);
    });

    it('searches by relevant keyword instead of broad single-token checkout matches', async () => {
      await seedKnowledgeCard(quickCheckoutCard);
      await seedKnowledgeCard(regularCheckoutCard);

      const replies = await handleKnowledgeCardCommand({
        userId: TEST_CONSULTANT,
        text: '搜尋 快速結帳',
      });

      expect(replies?.[0].text).toMatch(/快速結帳功能常見問題/);
      expect(replies?.[0].text).not.toMatch(/一般結帳流程/);
    });
  });

  describe('active dm draft confirmation wording', () => {
    it('treats 對，幫我整理成知識卡 as confirm submit instead of regenerating', async () => {
      await seedActiveSessionForTest({
        userId: TEST_CONSULTANT,
        card: quickCheckoutCard,
        draftText: formatHumanReadableKnowledgeCard(quickCheckoutCard, { draftMode: 'create' }),
      });

      const replies = await handleDmSessionPrivateMessage({
        userId: TEST_CONSULTANT,
        text: '對，幫我整理成知識卡',
      });

      expect(replies?.[0].text).toMatch(/已送出草稿給 admin 審核/);
      expect(await getRepos().dmSessions.findActiveByUserId(TEST_CONSULTANT)).toBeNull();
      expect(await getRepos().pendingKnowledgeReviews.listPending()).toHaveLength(1);
    });
  });

  describe('group public answer for stored-value tutorial card', () => {
    beforeEach(async () => {
      await seedStoredValueCard();
    });

    it('publicly answers 請問要怎麼儲值 with standard_answer', async () => {
      const action = await routeQuestion('請問要怎麼儲值');
      expect(action.type).toBe('public_answer');
      if (action.type === 'public_answer') {
        expect(action.card.standard_answer).toContain('票券管理');
      }
    });
  });
});
