import * as fs from 'fs';
import * as path from 'path';
import { EventType, RiskLevel } from '../src/types';
import { getRepos } from '../src/repositories';
import { processMessage } from '../src/handlers/lineWebhookHandler';
import {
  ADMIN_USAGE_GUIDE,
  CONSULTANT_USAGE_GUIDE,
  GROUP_USAGE_GUIDE,
} from '../src/services/knowledgeCardUsageGuideService';
import { handlePrivateUsageGuide } from '../src/services/knowledgeCardUsageGuideHandler';
import { buildIdentityReply } from '../src/services/consultantIdentityService';
import {
  hasMinimumDraftInput,
  hasProblemClue,
  hasSolutionClue,
  INSUFFICIENT_DRAFT_INPUT_MESSAGE,
  setLlmClient,
} from '../src/services/knowledgeCardDraftService';
import {
  handleConsultantConfirmSubmit,
  handleConsultantConfirmUpdateAttempt,
  handleConfirmUpdate,
  handleAdminRevisionFeedback,
  storeUserDraft,
  getUserDraft,
} from '../src/services/knowledgeCardWriteService';
import { handleKnowledgeCardCommand } from '../src/services/knowledgeCardCommandService';
import { handleDmSessionPrivateMessage } from '../src/services/dmSessionService';
import { handleViewCommand } from '../src/services/knowledgeCardViewService';
import { deliverBotReplies } from '../src/services/lineMessageService';
import { seedPendingReviewForTest } from '../src/services/knowledgeCardReviewService';
import * as writeGate from '../src/services/knowledgeCardWriteGate';
import { registerAdmin, registerInviteCode, requestConsultantJoin, approveConsultant } from '../src/services/consultantWhitelist';
import { KnowledgeCard } from '../src/schemas/knowledgeCardSchema';
import { TEST_ADMIN, TEST_CONSULTANT } from './helpers/testSetup';

const sampleCard: KnowledgeCard = {
  card_id: 'remediation-card',
  title: '登入問題',
  patterns: ['怎麼登入'],
  risk_level: RiskLevel.LOW,
  can_public_reply: true,
  standard_answer: '請至後台登入',
  not_applicable: [],
  escalate_to_consultant: [],
  status: '可用',
};

const updatedCard: KnowledgeCard = {
  ...sampleCard,
  title: '登入問題（補充版）',
  standard_answer: '請先至後台登入頁完成登入',
};

async function setupRoles(): Promise<void> {
  await registerAdmin(TEST_ADMIN, 'Admin');
  await registerInviteCode('CODE2AR', TEST_ADMIN);
  await requestConsultantJoin(TEST_CONSULTANT, 'CODE2AR', 'Consultant');
  await approveConsultant(TEST_ADMIN, TEST_CONSULTANT);
}

function mockLlmReturning(card: KnowledgeCard): jest.Mock {
  return jest.fn().mockResolvedValue(JSON.stringify(card));
}

async function seedConsultantDraft(card: KnowledgeCard = sampleCard): Promise<void> {
  setLlmClient({ complete: mockLlmReturning(card) });
  await handleDmSessionPrivateMessage({
    userId: TEST_CONSULTANT,
    text: '整理知識卡：店家遇到登入不了',
  });
}

describe('Draft input gate remediation', () => {
  beforeEach(async () => {
    await setupRoles();
  });

  it('rejects very short input without clues', async () => {
    const complete = mockLlmReturning(sampleCard);
    setLlmClient({ complete });
    const replies = await handleDmSessionPrivateMessage({
      userId: TEST_CONSULTANT,
      text: '整理知識卡：好',
    });
    expect(replies?.[0].text).toBe(INSUFFICIENT_DRAFT_INPUT_MESSAGE);
    expect(complete).not.toHaveBeenCalled();
    expect(await getUserDraft(TEST_CONSULTANT)).toBeUndefined();
  });

  it('rejects long text without problem or solution clues', async () => {
    expect(hasMinimumDraftInput('這是一段普通文字沒有重點')).toBe(false);
    const complete = mockLlmReturning(sampleCard);
    setLlmClient({ complete });
    const replies = await handleDmSessionPrivateMessage({
      userId: TEST_CONSULTANT,
      text: '整理知識卡：這是一段普通文字沒有重點',
    });
    expect(replies?.[0].text).toBe(INSUFFICIENT_DRAFT_INPUT_MESSAGE);
    expect(complete).not.toHaveBeenCalled();
  });

  it('accepts problem-only clue', async () => {
    expect(hasProblemClue('店家遇到登入不了')).toBe(true);
    const complete = mockLlmReturning(sampleCard);
    setLlmClient({ complete });
    const replies = await handleDmSessionPrivateMessage({
      userId: TEST_CONSULTANT,
      text: '整理知識卡：店家遇到登入不了',
    });
    expect(replies?.[0].text).toMatch(/【草稿內容】/);
    expect(complete).toHaveBeenCalled();
  });

  it('accepts solution-only clue', async () => {
    expect(hasSolutionClue('建議先請店家重新登入並確認帳號權限')).toBe(true);
    const complete = mockLlmReturning(sampleCard);
    setLlmClient({ complete });
    const replies = await handleDmSessionPrivateMessage({
      userId: TEST_CONSULTANT,
      text: '整理知識卡：建議先請店家重新登入並確認帳號權限',
    });
    expect(replies?.[0].text).toMatch(/【草稿內容】/);
    expect(complete).toHaveBeenCalled();
  });

  it('accepts problem and solution clues together', async () => {
    const complete = mockLlmReturning(sampleCard);
    setLlmClient({ complete });
    const replies = await handleDmSessionPrivateMessage({
      userId: TEST_CONSULTANT,
      text: '整理知識卡：店家問登入不了，建議先確認帳號權限',
    });
    expect(replies?.[0].text).toMatch(/【草稿內容】/);
    expect(complete).toHaveBeenCalled();
  });

  it('does not write pending or knowledge_cards when input insufficient', async () => {
    setLlmClient({ complete: mockLlmReturning(sampleCard) });
    await handleDmSessionPrivateMessage({
      userId: TEST_CONSULTANT,
      text: '整理知識卡：這是一段普通文字沒有重點',
    });
    await handleConsultantConfirmSubmit(TEST_CONSULTANT);
    expect(await getRepos().pendingKnowledgeReviews.listPending()).toHaveLength(0);
    expect(await getRepos().knowledgeCards.findById('remediation-card')).toBeNull();
  });
});

describe('Phase 2-A remediation acceptance tests', () => {
  beforeEach(async () => {
    await setupRoles();
  });

  it('consultant group usage guide returns group text without customer Q&A', async () => {
    const result = await processMessage({
      userId: TEST_CONSULTANT,
      groupId: 'group-remediation',
      text: 'help',
      isGroup: true,
    });
    expect(result.replies[0].text).toBe(GROUP_USAGE_GUIDE);
    expect(result.replies.every((r) => r.type !== 'group' || !r.text?.includes('standard_answer'))).toBe(
      true
    );
  });

  it('supplement updates draft without DB write or admin push', async () => {
    await seedConsultantDraft();
    setLlmClient({ complete: mockLlmReturning(updatedCard) });
    const replies = await handleDmSessionPrivateMessage({
      userId: TEST_CONSULTANT,
      text: '補充：請加上後台登入步驟說明',
    });
    expect(replies?.[0].text).toMatch(/【草稿內容】/);
    expect((await getUserDraft(TEST_CONSULTANT))?.card.title).toContain('補充版');
    expect(await getRepos().pendingKnowledgeReviews.listPending()).toHaveLength(0);
    expect(await getRepos().knowledgeCards.findById('remediation-card')).toBeNull();
  });

  it('modify updates draft without DB write or admin push', async () => {
    await seedConsultantDraft();
    setLlmClient({ complete: mockLlmReturning({ ...sampleCard, title: '修改後標題' }) });
    const replies = await handleDmSessionPrivateMessage({
      userId: TEST_CONSULTANT,
      text: '修改：標題改成修改後標題',
    });
    expect(replies?.[0].text).toMatch(/【草稿內容】/);
    expect((await getUserDraft(TEST_CONSULTANT))?.card.title).toBe('修改後標題');
    expect(await getRepos().pendingKnowledgeReviews.listPending()).toHaveLength(0);
  });

  it('export draft json returns preview without persisting', async () => {
    await seedConsultantDraft();
    const replies = await handleDmSessionPrivateMessage({
      userId: TEST_CONSULTANT,
      text: '轉成 JSON',
    });
    expect(replies?.[0].text).toMatch(/【JSON 草稿】/);
    expect(replies?.[0].text).toMatch(/remediation-card/);
    expect(await getRepos().pendingKnowledgeReviews.listPending()).toHaveLength(0);
    expect(await getRepos().knowledgeCards.findById('remediation-card')).toBeNull();
  });

  it('admin revision writes admin_response and keeps pending', async () => {
    await seedPendingReviewForTest({
      consultantId: TEST_CONSULTANT,
      consultantName: 'Consultant',
      card: sampleCard,
      draftText: 'draft',
      shortCode: 'K-20260608-REV1',
    });
    const replies = await handleAdminRevisionFeedback({
      userId: TEST_ADMIN,
      text: '需要修改 K-20260608-REV1：請補適用情境',
    });
    expect(replies[0].text).toMatch(/已將修改意見推回顧問/);
    const record = await getRepos().pendingKnowledgeReviews.findById('K-20260608-REV1');
    expect(record?.status).toBe('pending');
    expect(record?.adminResponse).toBe('請補適用情境');
    expect(await getRepos().knowledgeCards.findById('remediation-card')).toBeNull();
    expect(replies.some((r) => r.userId === TEST_CONSULTANT && r.text?.includes('請補適用情境'))).toBe(
      true
    );
  });

  it('validator failure does not mark pending approved', async () => {
    const invalidCard: KnowledgeCard = {
      ...sampleCard,
      card_id: 'invalid-remediation',
      risk_level: RiskLevel.MID,
      can_public_reply: true,
    };
    await seedPendingReviewForTest({
      consultantId: TEST_CONSULTANT,
      consultantName: 'Consultant',
      card: invalidCard,
      draftText: 'bad draft',
      shortCode: 'K-20260608-INV1',
    });
    const replies = await handleConfirmUpdate({
      userId: TEST_ADMIN,
      text: '確認更新 K-20260608-INV1',
    });
    expect(replies[0].text).toMatch(/驗證失敗/);
    const record = await getRepos().pendingKnowledgeReviews.findById('K-20260608-INV1');
    expect(record?.status).toBe('pending');
    expect(await getRepos().knowledgeCards.findById('invalid-remediation')).toBeNull();
    const events = await getRepos().events.findByType(EventType.CONSULTANT_OVERRIDE);
    expect(events.some((e) => e.detail?.includes('validation_failed'))).toBe(true);
  });

  it('writes bot_message_id after admin push', async () => {
    await storeUserDraft(TEST_CONSULTANT, sampleCard, JSON.stringify(sampleCard), 'draft text');
    const replies = await handleConsultantConfirmSubmit(TEST_CONSULTANT);
    const adminPush = replies.find((r) => r.type === 'push' && r.userId === TEST_ADMIN);
    expect(adminPush?.trackReviewId).toBeDefined();
    await deliverBotReplies([adminPush!]);
    const record = await getRepos().pendingKnowledgeReviews.findById(adminPush!.trackReviewId!);
    expect(record?.botMessageId).toMatch(/^mock-msg-/);
  });

  it('resolves pending by quotedMessageId', async () => {
    await seedPendingReviewForTest(
      {
        consultantId: TEST_CONSULTANT,
        consultantName: 'Consultant',
        card: sampleCard,
        draftText: 'draft',
        shortCode: 'K-20260608-QM1',
      },
      'quoted-review-msg-001'
    );
    const replies = await handleConfirmUpdate({
      userId: TEST_ADMIN,
      text: '確認更新',
      quotedMessageId: 'quoted-review-msg-001',
    });
    expect(replies[0].text).toMatch(/已確認更新/);
    expect((await getRepos().pendingKnowledgeReviews.findById('K-20260608-QM1'))?.status).toBe(
      'approved'
    );
  });

  it('prefers short code over quotedMessageId on conflict', async () => {
    await seedPendingReviewForTest(
      {
        consultantId: TEST_CONSULTANT,
        consultantName: 'C1',
        card: sampleCard,
        draftText: 'draft-a',
        shortCode: 'K-20260608-QA1',
      },
      'quoted-msg-a'
    );
    await seedPendingReviewForTest({
      consultantId: 'consultant-002',
      consultantName: 'C2',
      card: { ...sampleCard, card_id: 'conflict-card-b' },
      draftText: 'draft-b',
      shortCode: 'K-20260608-QB2',
    });
    const replies = await handleConfirmUpdate({
      userId: TEST_ADMIN,
      text: '確認更新 K-20260608-QB2',
      quotedMessageId: 'quoted-msg-a',
    });
    expect(replies[0].text).toMatch(/conflict-card-b/);
    expect((await getRepos().pendingKnowledgeReviews.findById('K-20260608-QA1'))?.status).toBe(
      'pending'
    );
    expect((await getRepos().pendingKnowledgeReviews.findById('K-20260608-QB2'))?.status).toBe(
      'approved'
    );
  });

  it('rejects consultant confirm update attempts', async () => {
    await seedPendingReviewForTest({
      consultantId: TEST_CONSULTANT,
      consultantName: 'Consultant',
      card: sampleCard,
      draftText: 'draft',
      shortCode: 'K-20260608-CC1',
    });
    const bare = await handleConsultantConfirmUpdateAttempt({
      userId: TEST_CONSULTANT,
      text: '確認更新',
    });
    expect(bare[0].text).toMatch(/只有 active admin 可確認更新/);
    const withCode = await handleConsultantConfirmUpdateAttempt({
      userId: TEST_CONSULTANT,
      text: '確認更新 K-20260608-CC1',
    });
    expect(withCode[0].text).toMatch(/只有 active admin 可確認更新/);
    expect((await getRepos().pendingKnowledgeReviews.findById('K-20260608-CC1'))?.status).toBe(
      'pending'
    );
    expect(await getRepos().knowledgeCards.findById('remediation-card')).toBeNull();
  });

  it('admin self-organize confirm path still writes via shared gate', async () => {
    const spy = jest.spyOn(writeGate, 'writeKnowledgeCardWithValidation');
    await storeUserDraft(TEST_ADMIN, sampleCard, JSON.stringify(sampleCard), 'admin draft');
    const replies = await handleConfirmUpdate({ userId: TEST_ADMIN, text: '確認更新' });
    expect(replies[0].text).toMatch(/已確認更新/);
    expect(spy).toHaveBeenCalled();
    spy.mockRestore();
  });

  it('consultant submit and admin confirm both use writeKnowledgeCardWithValidation', async () => {
    const spy = jest.spyOn(writeGate, 'writeKnowledgeCardWithValidation');
    await seedConsultantDraft();
    const submitReplies = await handleConsultantConfirmSubmit(TEST_CONSULTANT);
    const shortCode = submitReplies
      .find((r) => r.userId === TEST_ADMIN)
      ?.text?.match(/K-\d{8}-[A-Z0-9]{2,}/)?.[0];
    spy.mockClear();
    await handleConfirmUpdate({ userId: TEST_ADMIN, text: `確認更新 ${shortCode}` });
    expect(spy).toHaveBeenCalled();
    spy.mockRestore();
  });

  it('schema defines pending_knowledge_reviews status CHECK', () => {
    const schema = fs.readFileSync(
      path.join(__dirname, '../src/db/schema.sql'),
      'utf-8'
    );
    expect(schema).toMatch(/pending_knowledge_reviews_status_check/);
    expect(schema).toMatch(/pending.*approved.*rejected.*expired/s);
  });

  it('view results are human readable and consultant cannot see paused cards', async () => {
    await getRepos().knowledgeCards.setStatus('op-login', 'paused', {
      updatedBy: TEST_ADMIN,
      confirmedBy: TEST_ADMIN,
      confirmedAt: new Date().toISOString(),
    });
    const adminReplies = await handleViewCommand(TEST_ADMIN, 'all');
    const consultantReplies = await handleViewCommand(TEST_CONSULTANT, 'all');
    expect(adminReplies[0].text).not.toMatch(/^\s*\{/);
    expect(adminReplies[0].text).toMatch(/op-login/);
    expect(consultantReplies[0].text).not.toMatch(/op-login/);
    expect(consultantReplies[0].text).not.toMatch(/created_by=/);
  });

  it('usage guide permission routing regression', async () => {
    expect((await handlePrivateUsageGuide(TEST_ADMIN))[0].text).toBe(ADMIN_USAGE_GUIDE);
    expect((await handlePrivateUsageGuide(TEST_CONSULTANT))[0].text).toBe(CONSULTANT_USAGE_GUIDE);
    const inactive = await handlePrivateUsageGuide('unknown-user-2a');
    expect(inactive[0].text).toBe(await buildIdentityReply('unknown-user-2a'));
    expect(inactive[0].text).not.toContain('【小助手使用說明');

    const identity = await processMessage({
      userId: TEST_ADMIN,
      text: '我的層級',
      isGroup: false,
    });
    expect(identity.replies[0].text).toMatch(/role:/);
    expect(identity.replies[0].text).not.toBe(ADMIN_USAGE_GUIDE);
  });
});
