import { EventType, RiskLevel } from '../src/types';
import { getRepos } from '../src/repositories';
import { processMessage } from '../src/handlers/lineWebhookHandler';
import {
  ADMIN_USAGE_GUIDE,
  CONSULTANT_USAGE_GUIDE,
  GROUP_USAGE_GUIDE,
} from '../src/services/knowledgeCardUsageGuideService';
import { handlePrivateUsageGuide } from '../src/services/knowledgeCardUsageGuideHandler';
import { handleViewCommand } from '../src/services/knowledgeCardViewService';
import {
  handleConsultantConfirmSubmit,
  storeUserDraft,
} from '../src/services/knowledgeCardWriteService';
import { handleConfirmUpdate, handleAdminRejectDraft } from '../src/services/knowledgeCardWriteService';
import { handleDmSessionPrivateMessage } from '../src/services/dmSessionService';
import { buildIdentityReply } from '../src/services/consultantIdentityService';
import {
  consumePrivateFallbackHint,
  clearPrivateFallbackState,
} from '../src/services/privateFallbackHintService';
import { registerAdmin, registerInviteCode, requestConsultantJoin, approveConsultant } from '../src/services/consultantWhitelist';
import { KnowledgeCard } from '../src/schemas/knowledgeCardSchema';
import { TEST_ADMIN, TEST_CONSULTANT } from './helpers/testSetup';
import { setLlmClient, INSUFFICIENT_DRAFT_INPUT_MESSAGE } from '../src/services/knowledgeCardDraftService';

const sampleCard: KnowledgeCard = {
  card_id: 'phase2a-card',
  title: '登入問題',
  patterns: ['怎麼登入'],
  risk_level: RiskLevel.LOW,
  can_public_reply: true,
  standard_answer: '請至後台登入',
  not_applicable: [],
  escalate_to_consultant: [],
  status: '可用',
};

async function setupRoles(): Promise<void> {
  await registerAdmin(TEST_ADMIN, 'Admin');
  await registerInviteCode('CODE2A', TEST_ADMIN);
  await requestConsultantJoin(TEST_CONSULTANT, 'CODE2A', 'Consultant');
  await approveConsultant(TEST_ADMIN, TEST_CONSULTANT);
}

describe('Knowledge card Phase 2-A', () => {
  beforeEach(async () => {
    await setupRoles();
  });

  it('admin private usage guide returns Admin text', async () => {
    const replies = await handlePrivateUsageGuide(TEST_ADMIN);
    expect(replies[0].text).toBe(ADMIN_USAGE_GUIDE);
  });

  it('consultant private usage guide returns Consultant text', async () => {
    const replies = await handlePrivateUsageGuide(TEST_CONSULTANT);
    expect(replies[0].text).toBe(CONSULTANT_USAGE_GUIDE);
  });

  it('inactive user usage guide returns identity instead of manual', async () => {
    const replies = await handlePrivateUsageGuide('unknown-user');
    expect(replies[0].text).toBe(await buildIdentityReply('unknown-user'));
    expect(replies[0].text).not.toContain('【小助手使用說明');
  });

  it('admin list all includes paused cards with audit fields', async () => {
    await getRepos().knowledgeCards.setStatus('op-login', 'paused', {
      updatedBy: TEST_ADMIN,
      confirmedBy: TEST_ADMIN,
      confirmedAt: new Date().toISOString(),
    });
    const replies = await handleViewCommand(TEST_ADMIN, 'all');
    expect(replies[0].text).toMatch(/知識卡清單/);
    expect(replies[0].text).toMatch(/op-login/);
    expect(replies[0].text).toMatch(/created_by=/);
    expect(replies[0].text).not.toMatch(/"card_id"/);
  });

  it('consultant list all shows active only without audit fields', async () => {
    await getRepos().knowledgeCards.setStatus('op-login', 'paused', {
      updatedBy: TEST_ADMIN,
      confirmedBy: TEST_ADMIN,
      confirmedAt: new Date().toISOString(),
    });
    const replies = await handleViewCommand(TEST_CONSULTANT, 'all');
    expect(replies[0].text).toMatch(/active/);
    expect(replies[0].text).not.toMatch(/created_by=/);
    expect(replies[0].text).not.toMatch(/op-login/);
  });

  it('consultant login search returns active cards only', async () => {
    const replies = await handleViewCommand(TEST_CONSULTANT, 'login');
    expect(replies[0].text).toMatch(/登入/);
    expect(replies[0].text).not.toMatch(/created_by=/);
  });

  it('inactive user cannot search knowledge cards', async () => {
    const replies = await handleViewCommand('unknown-user', 'login');
    expect(replies[0].text).toMatch(/不可查看知識庫/);
  });

  it('group admin usage guide returns group text', async () => {
    const result = await processMessage({
      userId: TEST_ADMIN,
      groupId: 'group-2a',
      text: '使用說明',
      isGroup: true,
    });
    expect(result.replies[0].text).toBe(GROUP_USAGE_GUIDE);
  });

  it('customer group usage guide does not reply', async () => {
    const result = await processMessage({
      userId: 'customer-001',
      groupId: 'group-2a',
      text: '使用說明',
      isGroup: true,
    });
    expect(result.replies.some((r) => r.text?.includes('使用說明'))).toBe(false);
  });

  it('bare organize request prompts for content', async () => {
    const replies = await handleDmSessionPrivateMessage({
      userId: TEST_CONSULTANT,
      text: '幫我整理知識卡',
    });
    expect(replies?.[0].text).toMatch(/請提供以下資訊/);
    const session = await getRepos().dmSessions.findActiveByUserId(TEST_CONSULTANT);
    expect(session?.status).toBe('active');
  });

  it('insufficient content does not auto fabricate draft', async () => {
    setLlmClient({
      complete: jest.fn().mockResolvedValue(JSON.stringify(sampleCard)),
    });
    const replies = await handleDmSessionPrivateMessage({
      userId: TEST_CONSULTANT,
      text: '整理知識卡：好',
    });
    expect(replies?.[0].text).toBe(INSUFFICIENT_DRAFT_INPUT_MESSAGE);
  });

  it('confirm submit writes pending_knowledge_reviews with pending status', async () => {
    await storeUserDraft(TEST_CONSULTANT, sampleCard, JSON.stringify(sampleCard), 'draft text');
    await handleConsultantConfirmSubmit(TEST_CONSULTANT);
    const pending = await getRepos().pendingKnowledgeReviews.listPending();
    expect(pending.length).toBe(1);
    expect(pending[0].status).toBe('pending');
    expect(pending[0].submittedBy).toBe(TEST_CONSULTANT);
    expect(pending[0].cardData.card_id).toBe('phase2a-card');
  });

  it('admin confirm marks pending review approved', async () => {
    await storeUserDraft(TEST_CONSULTANT, sampleCard, JSON.stringify(sampleCard), 'draft text');
    const submitReplies = await handleConsultantConfirmSubmit(TEST_CONSULTANT);
    const shortCode = submitReplies.find((r) => r.userId === TEST_ADMIN)?.text?.match(/K-\d{8}-[A-Z0-9]{2,}/)?.[0];
    expect(shortCode).toBeDefined();
    await handleConfirmUpdate({ userId: TEST_ADMIN, text: `確認更新 ${shortCode}` });
    const record = await getRepos().pendingKnowledgeReviews.findById(shortCode!);
    expect(record?.status).toBe('approved');
    expect(record?.resolvedBy).toBe(TEST_ADMIN);
    const events = await getRepos().events.findByType(EventType.CONSULTANT_OVERRIDE);
    expect(events.some((e) => e.knowledge_card_id === 'phase2a-card')).toBe(true);
  });

  it('admin reject marks pending review rejected', async () => {
    await storeUserDraft(TEST_CONSULTANT, sampleCard, JSON.stringify(sampleCard), 'draft text');
    const submitReplies = await handleConsultantConfirmSubmit(TEST_CONSULTANT);
    const shortCode = submitReplies.find((r) => r.userId === TEST_ADMIN)?.text?.match(/K-\d{8}-[A-Z0-9]{2,}/)?.[0];
    await handleAdminRejectDraft({ userId: TEST_ADMIN, text: `退回 ${shortCode}` });
    const record = await getRepos().pendingKnowledgeReviews.findById(shortCode!);
    expect(record?.status).toBe('rejected');
  });

  it('private fallback hint fires at most once', () => {
    clearPrivateFallbackState();
    expect(consumePrivateFallbackHint(TEST_ADMIN)).toBe(true);
    expect(consumePrivateFallbackHint(TEST_ADMIN)).toBe(false);
  });
});
