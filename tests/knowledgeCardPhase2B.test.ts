import * as fs from 'fs';
import * as path from 'path';
import { EventType, RiskLevel } from '../src/types';
import { getRepos } from '../src/repositories';
import { processMessage } from '../src/handlers/lineWebhookHandler';
import {
  hasMinimumDraftInput,
  INSUFFICIENT_DRAFT_INPUT_MESSAGE,
  setLlmClient,
} from '../src/services/knowledgeCardDraftService';
import {
  handleConsultantConfirmSubmit,
  handleConsultantConfirmUpdateAttempt,
  handleConfirmUpdate,
  getUserDraft,
  setForceSubmitFailureForTest,
  storeUserDraft,
} from '../src/services/knowledgeCardWriteService';
import {
  expireStaleSessionIfNeeded,
  handleDmSessionPrivateMessage,
  seedActiveSessionForTest,
  EXISTING_SESSION_PROMPT,
  EXPIRED_SESSION_MESSAGE,
  INACTIVE_DRAFT_MESSAGE,
} from '../src/services/dmSessionService';
import {
  consumePrivateFallbackHint,
  clearPrivateFallbackState,
} from '../src/services/privateFallbackHintService';
import { handleConsultantNaturalLanguage } from '../src/services/consultantActionService';
import { registerAdmin, registerInviteCode, requestConsultantJoin, approveConsultant } from '../src/services/consultantWhitelist';
import { KnowledgeCard } from '../src/schemas/knowledgeCardSchema';
import { TEST_ADMIN, TEST_CONSULTANT } from './helpers/testSetup';
import * as writeGate from '../src/services/knowledgeCardWriteGate';

const sampleCard: KnowledgeCard = {
  card_id: 'phase2b-card',
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
};

function mockLlmReturning(card: KnowledgeCard): jest.Mock {
  return jest.fn().mockResolvedValue(JSON.stringify(card));
}

async function setupRoles(): Promise<void> {
  await registerAdmin(TEST_ADMIN, 'Admin');
  await registerInviteCode('CODE2B', TEST_ADMIN);
  await requestConsultantJoin(TEST_CONSULTANT, 'CODE2B', 'Consultant');
  await approveConsultant(TEST_ADMIN, TEST_CONSULTANT);
}

async function startSessionWithContent(
  userId: string = TEST_CONSULTANT,
  content = '店家遇到登入不了，建議先確認帳號權限'
): Promise<void> {
  setLlmClient({ complete: mockLlmReturning(sampleCard) });
  await handleDmSessionPrivateMessage({ userId, text: '幫我整理知識卡' });
  await handleDmSessionPrivateMessage({ userId, text: content });
}

describe('Knowledge card Phase 2-B dm_sessions flow', () => {
  beforeEach(async () => {
    await setupRoles();
    setForceSubmitFailureForTest(false);
  });

  it('1. 幫我整理知識卡 without active session creates session and prompts', async () => {
    const replies = await handleDmSessionPrivateMessage({
      userId: TEST_CONSULTANT,
      text: '幫我整理知識卡',
    });
    expect(replies?.[0].text).toMatch(/請用下面格式提供內容/);
    expect(replies?.[0].text).toMatch(/店家問題：/);
    const session = await getRepos().dmSessions.findActiveByUserId(TEST_CONSULTANT);
    expect(session?.sessionType).toBe('knowledge_draft');
    expect(session?.status).toBe('active');
  });

  it('2. 幫我整理知識卡 with existing active session prompts continue or cancel', async () => {
    await handleDmSessionPrivateMessage({ userId: TEST_CONSULTANT, text: '幫我整理知識卡' });
    const replies = await handleDmSessionPrivateMessage({
      userId: TEST_CONSULTANT,
      text: '幫我整理知識卡',
    });
    expect(replies?.[0].text).toBe(EXISTING_SESSION_PROMPT);
    expect((await getRepos().dmSessions.findActiveByUserId(TEST_CONSULTANT))?.status).toBe('active');
  });

  it('3. content with problem and solution stores draft_data', async () => {
    await startSessionWithContent();
    const session = await getRepos().dmSessions.findActiveByUserId(TEST_CONSULTANT);
    expect(session?.draftData?.card?.card_id).toBe('phase2b-card');
    expect(session?.draftData?.humanReadableDraft).toMatch(/登入問題/);
  });

  it('4. insufficient content asks for more without storing draft_data', async () => {
    await handleDmSessionPrivateMessage({ userId: TEST_CONSULTANT, text: '幫我整理知識卡' });
    const replies = await handleDmSessionPrivateMessage({
      userId: TEST_CONSULTANT,
      text: '這是一段普通文字沒有重點',
    });
    expect(replies?.[0].text).toBe(INSUFFICIENT_DRAFT_INPUT_MESSAGE);
    expect((await getRepos().dmSessions.findActiveByUserId(TEST_CONSULTANT))?.draftData?.card).toBeUndefined();
  });

  it('5. 補充 updates draft_data', async () => {
    await startSessionWithContent();
    setLlmClient({ complete: mockLlmReturning(updatedCard) });
    const replies = await handleDmSessionPrivateMessage({
      userId: TEST_CONSULTANT,
      text: '補充：請加上後台登入步驟',
    });
    expect(replies?.[0].text).toMatch(/【知識卡草稿｜/);
    expect((await getUserDraft(TEST_CONSULTANT))?.card.title).toContain('補充版');
  });

  it('6. 修改 updates draft_data', async () => {
    await startSessionWithContent();
    setLlmClient({ complete: mockLlmReturning({ ...sampleCard, title: '修改後標題' }) });
    const replies = await handleDmSessionPrivateMessage({
      userId: TEST_CONSULTANT,
      text: '修改：標題改成修改後標題',
    });
    expect((await getUserDraft(TEST_CONSULTANT))?.card.title).toBe('修改後標題');
    expect(replies?.[0].text).toMatch(/【知識卡草稿｜/);
  });

  it('7. 重新整理 regenerates human readable draft from draft_data', async () => {
    await startSessionWithContent();
    const replies = await handleDmSessionPrivateMessage({
      userId: TEST_CONSULTANT,
      text: '重新整理',
    });
    expect(replies?.[0].text).toMatch(/【知識卡草稿｜/);
    expect(replies?.[0].text).toMatch(/登入問題/);
  });

  it('8. 轉成 JSON validates and returns 9-field JSON', async () => {
    await startSessionWithContent();
    const replies = await handleDmSessionPrivateMessage({
      userId: TEST_CONSULTANT,
      text: '轉成 JSON',
    });
    expect(replies?.[0].text).toMatch(/【JSON 草稿】/);
    expect(replies?.[0].text).toMatch(/phase2b-card/);
  });

  it('9. consultant 確認送出 atomically submits session and pending review', async () => {
    await startSessionWithContent();
    const activeBefore = await getRepos().dmSessions.findActiveByUserId(TEST_CONSULTANT);
    expect(activeBefore?.status).toBe('active');
    await handleConsultantConfirmSubmit(TEST_CONSULTANT);
    const submittedSession = await getRepos().dmSessions.findById(activeBefore!.sessionId);
    expect(submittedSession?.status).toBe('submitted');
    expect(await getRepos().dmSessions.findActiveByUserId(TEST_CONSULTANT)).toBeNull();
    const pending = await getRepos().pendingKnowledgeReviews.listPending();
    expect(pending).toHaveLength(1);
    expect(pending[0].status).toBe('pending');
    expect(pending[0].submittedBy).toBe(TEST_CONSULTANT);
  });

  it('10. consultant 確認送出 transaction failure keeps session active', async () => {
    await startSessionWithContent();
    setForceSubmitFailureForTest(true);
    const replies = await handleConsultantConfirmSubmit(TEST_CONSULTANT);
    expect(replies[0].text).toMatch(/錯誤/);
    expect(await getRepos().pendingKnowledgeReviews.listPending()).toHaveLength(0);
    expect((await getRepos().dmSessions.findActiveByUserId(TEST_CONSULTANT))?.status).toBe('active');
  });

  it('11. consultant 確認更新 is rejected', async () => {
    await startSessionWithContent();
    const replies = await handleConsultantConfirmUpdateAttempt({
      userId: TEST_CONSULTANT,
      text: '確認更新',
    });
    expect(replies[0].text).toMatch(/只有 active admin 可確認更新/);
  });

  it('12. admin 確認更新 writes knowledge_cards and completes session', async () => {
    await startSessionWithContent(TEST_ADMIN);
    const eventCountBefore = (await getRepos().events.findByType(EventType.CONSULTANT_OVERRIDE)).length;
    const spy = jest.spyOn(writeGate, 'writeKnowledgeCardWithValidation');
    const replies = await handleConfirmUpdate({ userId: TEST_ADMIN, text: '確認更新' });
    expect(replies[0].text).toMatch(/已新增知識卡|已更新知識卡/);
    expect(spy).toHaveBeenCalled();
    expect(await getRepos().dmSessions.findActiveByUserId(TEST_ADMIN)).toBeNull();
    const events = await getRepos().events.findByType(EventType.CONSULTANT_OVERRIDE);
    expect(events.length).toBeGreaterThan(eventCountBefore);
    expect(events.some((e) => e.knowledge_card_id === 'phase2b-card')).toBe(true);
    spy.mockRestore();
  });

  it('13. admin 確認更新 validator failure keeps session active without event_log', async () => {
    const invalidCard: KnowledgeCard = {
      ...sampleCard,
      card_id: 'invalid-2b',
      risk_level: RiskLevel.MID,
      can_public_reply: true,
    };
    await storeUserDraft(TEST_ADMIN, invalidCard, JSON.stringify(invalidCard), 'bad');
    const sessionBefore = await getRepos().dmSessions.findActiveByUserId(TEST_ADMIN);
    const cardCountBefore = await getRepos().knowledgeCards.count();
    const eventCountBefore = (await getRepos().events.findByType(EventType.CONSULTANT_OVERRIDE)).length;
    const replies = await handleConfirmUpdate({ userId: TEST_ADMIN, text: '確認更新' });
    expect(replies[0].text).toMatch(/驗證失敗/);
    expect(replies[0].text).toMatch(/尚未寫入知識庫/);
    expect(replies[0].text).toMatch(/修改：/);
    expect(replies[0].text).toMatch(/確認更新/);
    expect((await getRepos().dmSessions.findActiveByUserId(TEST_ADMIN))?.status).toBe('active');
    expect((await getRepos().dmSessions.findById(sessionBefore!.sessionId))?.draftData?.card?.card_id).toBe(
      'invalid-2b'
    );
    expect(await getRepos().knowledgeCards.findById('invalid-2b')).toBeNull();
    expect((await getRepos().knowledgeCards.count())).toBe(cardCountBefore);
    expect((await getRepos().events.findByType(EventType.CONSULTANT_OVERRIDE)).length).toBe(
      eventCountBefore
    );
  });

  it('14. 取消 marks session cancelled and retains data', async () => {
    await startSessionWithContent();
    const sessionBefore = await getRepos().dmSessions.findActiveByUserId(TEST_CONSULTANT);
    await handleDmSessionPrivateMessage({ userId: TEST_CONSULTANT, text: '取消' });
    expect(await getRepos().dmSessions.findActiveByUserId(TEST_CONSULTANT)).toBeNull();
    const cancelled = await getRepos().dmSessions.findById(sessionBefore!.sessionId);
    expect(cancelled?.status).toBe('cancelled');
    expect(cancelled?.draftData?.card).toBeDefined();
  });

  it('15. 完成 marks session completed', async () => {
    await startSessionWithContent();
    const sessionBefore = await getRepos().dmSessions.findActiveByUserId(TEST_CONSULTANT);
    await handleDmSessionPrivateMessage({ userId: TEST_CONSULTANT, text: '完成' });
    expect(await getRepos().dmSessions.findActiveByUserId(TEST_CONSULTANT)).toBeNull();
    const completed = await getRepos().dmSessions.findById(sessionBefore!.sessionId);
    expect(completed?.status).toBe('completed');
  });

  it('16. second active session for same user is blocked', async () => {
    await handleDmSessionPrivateMessage({ userId: TEST_CONSULTANT, text: '幫我整理知識卡' });
    await expect(
      getRepos().dmSessions.create({
        sessionId: 'dup-session',
        userId: TEST_CONSULTANT,
        sessionType: 'knowledge_draft',
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      })
    ).rejects.toThrow('ACTIVE_SESSION_EXISTS');
  });

  it('17. stale session expires passively on next private message', async () => {
    const staleTime = new Date(Date.now() - 25 * 60 * 60 * 1000).toISOString();
    await seedActiveSessionForTest({
      userId: TEST_CONSULTANT,
      card: sampleCard,
      updatedAt: staleTime,
    });
    const replies = await expireStaleSessionIfNeeded(TEST_CONSULTANT);
    expect(replies?.[0].text).toBe(EXPIRED_SESSION_MESSAGE);
    expect(await getRepos().dmSessions.findActiveByUserId(TEST_CONSULTANT)).toBeNull();
  });

  it('18. ambiguous ack with active session does not update draft', async () => {
    await startSessionWithContent();
    const before = (await getRepos().dmSessions.findActiveByUserId(TEST_CONSULTANT))?.updatedAt;
    const replies = await handleDmSessionPrivateMessage({ userId: TEST_CONSULTANT, text: '謝謝' });
    expect(replies?.[0].text).toMatch(/草稿已暫停/);
    expect((await getRepos().dmSessions.findActiveByUserId(TEST_CONSULTANT))?.updatedAt).toBe(before);
  });

  it('19. unrelated content with active session does not append to draft_data', async () => {
    await startSessionWithContent();
    const cardBefore = (await getUserDraft(TEST_CONSULTANT))?.card.title;
    await handleDmSessionPrivateMessage({
      userId: TEST_CONSULTANT,
      text: '今天天氣真好',
    });
    expect((await getUserDraft(TEST_CONSULTANT))?.card.title).toBe(cardBefore);
  });

  it('20. no active session ambiguous input fires fallback at most once', async () => {
    clearPrivateFallbackState();
    const result = await processMessage({
      userId: TEST_ADMIN,
      text: '隨便說一句',
      isGroup: false,
    });
    expect(result.replies.some((r) => r.text?.includes('使用說明'))).toBe(true);
    const again = await processMessage({
      userId: TEST_ADMIN,
      text: '又一句',
      isGroup: false,
    });
    expect(again.replies.some((r) => r.text?.includes('使用說明'))).toBe(false);
    expect(consumePrivateFallbackHint(TEST_ADMIN)).toBe(false);
  });

  it('21. consultant cannot see cancelled or expired sessions', async () => {
    const staleTime = new Date(Date.now() - 25 * 60 * 60 * 1000).toISOString();
    const session = await seedActiveSessionForTest({
      userId: TEST_CONSULTANT,
      card: sampleCard,
      updatedAt: staleTime,
    });
    await getRepos().dmSessions.markExpired(session.sessionId, nowIso(), nowIso());
    expect(await getRepos().dmSessions.findActiveByUserId(TEST_CONSULTANT)).toBeNull();
    const replies = await handleDmSessionPrivateMessage({
      userId: TEST_CONSULTANT,
      text: '查詢已取消草稿',
    });
    expect(replies).toBeNull();
  });

  it('22. inactive user cannot enter draft flow', async () => {
    const replies = await handleDmSessionPrivateMessage({
      userId: 'inactive-user',
      text: '幫我整理知識卡',
    });
    expect(replies?.[0].text).toBe(INACTIVE_DRAFT_MESSAGE);
  });

  it('23. 2-A simplified memory draft path is replaced by dm_sessions', async () => {
    const actionReplies = await handleConsultantNaturalLanguage({
      userId: TEST_CONSULTANT,
      text: '整理知識卡：店家遇到登入不了',
      isGroup: false,
    });
    expect(actionReplies?.[0].text).toMatch(/幫我整理知識卡/);
    expect(await getRepos().dmSessions.findActiveByUserId(TEST_CONSULTANT)).toBeNull();
  });

  it('schema defines dm_sessions status CHECK and one active per user', () => {
    const schema = fs.readFileSync(path.join(__dirname, '../src/db/schema.sql'), 'utf-8');
    expect(schema).toMatch(/dm_sessions_status_check/);
    expect(schema).toMatch(/idx_dm_sessions_one_active_per_user/);
  });
});

function nowIso(): string {
  return new Date().toISOString();
}

describe('Phase 2-B input gate', () => {
  it('hasMinimumDraftInput requires problem or solution clue', () => {
    expect(hasMinimumDraftInput('好')).toBe(false);
    expect(hasMinimumDraftInput('店家遇到登入不了')).toBe(true);
  });
});
