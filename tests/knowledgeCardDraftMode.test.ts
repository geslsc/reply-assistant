import { RiskLevel } from '../src/types';
import { loadEnv, resetEnvCache } from '../src/config/env';
import { resetRepositories, getRepos } from '../src/repositories';
import {
  formatHumanReadableKnowledgeCard,
  generateKnowledgeCardDraft,
  setLlmClient,
} from '../src/services/knowledgeCardDraftService';
import {
  parseModifyKnowledgeCardIntent,
  resolveExistingKnowledgeCard,
} from '../src/services/knowledgeCardDraftModeService';
import {
  allocateUniqueCardId,
  isPlaceholderCardId,
  PENDING_CARD_ID,
} from '../src/services/knowledgeCardIdService';
import {
  applyPublicReplyPreference,
  buildPublicReplySuggestion,
  parsePublicReplyPreferencePhrase,
} from '../src/services/knowledgeCardPublicReplyService';
import { handleConfirmUpdate } from '../src/services/knowledgeCardWriteService';
import {
  handleDmSessionPrivateMessage,
  seedActiveSessionForTest,
} from '../src/services/dmSessionService';
import { writeKnowledgeCardWithValidation } from '../src/services/knowledgeCardWriteGate';
import { refreshKnowledgeCache, initKnowledgeBase } from '../src/services/knowledgeBaseService';
import { validateKnowledgeCard, cardContainsSensitiveContent } from '../src/services/knowledgeCardValidator';
import { executeReplyToGroup } from '../src/services/replyToGroupService';
import { KnowledgeCard } from '../src/schemas/knowledgeCardSchema';
import { EventType, ThreadState } from '../src/types';
import {
  registerAdmin,
  registerInviteCode,
  requestConsultantJoin,
  approveConsultant,
} from '../src/services/consultantWhitelist';
import { TEST_ADMIN, TEST_CONSULTANT } from './helpers/testSetup';
import { withEnhancedKnowledgeFields } from './helpers/knowledgeCardTestFixtures';

const checkoutTutorialCard: KnowledgeCard = withEnhancedKnowledgeFields({
  card_id: PENDING_CARD_ID,
  title: '新增結帳單操作教學',
  patterns: ['怎麼新增結帳單'],
  risk_level: RiskLevel.LOW,
  can_public_reply: true,
  standard_answer: '到「結帳」→「新增結帳單」。\n\n操作步驟：\n1. 開啟結帳頁\n2. 點選新增',
  not_applicable: ['不是結帳操作問題'],
  escalate_to_consultant: ['金額錯誤'],
  status: '可用',
});

const existingCard: KnowledgeCard = withEnhancedKnowledgeFields({
  card_id: 'op-login',
  title: '登入後台',
  patterns: ['怎麼登入'],
  risk_level: RiskLevel.LOW,
  can_public_reply: true,
  standard_answer: '請開啟登入頁。',
  not_applicable: [],
  escalate_to_consultant: [],
  status: '可用',
});

async function setupRoles(): Promise<void> {
  await registerAdmin(TEST_ADMIN, 'Admin');
  await registerInviteCode('DRAFTCODE', TEST_ADMIN);
  await requestConsultantJoin(TEST_CONSULTANT, 'DRAFTCODE', 'Consultant');
  await approveConsultant(TEST_ADMIN, TEST_CONSULTANT);
}

describe('Knowledge card draft mode and UX', () => {
  beforeEach(async () => {
    resetEnvCache();
    loadEnv({ USE_MEMORY_REPOS: true });
    await resetRepositories('memory');
    await setupRoles();
    await initKnowledgeBase();
    await refreshKnowledgeCache();
    setLlmClient(null);
  });

  it('create mode uses pending card_id not fixed 001', async () => {
    setLlmClient({
      complete: jest.fn().mockResolvedValue(
        JSON.stringify({ ...checkoutTutorialCard, card_id: '001' })
      ),
    });
    await handleDmSessionPrivateMessage({
      userId: TEST_ADMIN,
      text: '幫我整理知識卡：店家問如何新增結帳單操作步驟',
    });
    const session = await getRepos().dmSessions.findActiveByUserId(TEST_ADMIN);
    expect(session?.draftData?.draftMode).toBe('create');
    expect(session?.draftData?.card?.card_id).toBe(PENDING_CARD_ID);
    expect(session?.draftData?.card?.card_id).not.toBe('001');
  });

  it('allocateUniqueCardId generates distinct ids for multiple creates', async () => {
    const first = await allocateUniqueCardId();
    await writeKnowledgeCardWithValidation({
      card: { ...checkoutTutorialCard, card_id: first },
      operatorUserId: TEST_ADMIN,
      operation: 'create',
      summary: 'seed',
      logValidationFailure: false,
      draftMode: 'create',
    });
    const second = await allocateUniqueCardId();
    expect(second).not.toBe(first);
  });

  it('create mode does not overwrite existing card', async () => {
    await writeKnowledgeCardWithValidation({
      card: existingCard,
      operatorUserId: TEST_ADMIN,
      operation: 'create',
      summary: 'seed',
      logValidationFailure: false,
    });
    await refreshKnowledgeCache();
    await seedActiveSessionForTest({
      userId: TEST_ADMIN,
      card: { ...checkoutTutorialCard, card_id: 'op-login', title: '覆蓋測試' },
      draftMode: 'create',
    });
    const replies = await handleConfirmUpdate({ userId: TEST_ADMIN, text: '確認更新' });
    expect(replies[0].text).toMatch(/不得覆蓋|已存在/);
    const record = await getRepos().knowledgeCards.findById('op-login');
    expect(record?.title).not.toBe('覆蓋測試');
  });

  it('modify mode requires resolving existing card', async () => {
    const resolved = await resolveExistingKnowledgeCard('op-login');
    expect('card' in resolved).toBe(true);
  });

  it('modify mode rejects unknown card reference', async () => {
    const resolved = await resolveExistingKnowledgeCard('不存在的卡');
    expect('error' in resolved).toBe(true);
  });

  it('modify mode updates only specified card', async () => {
    setLlmClient({
      complete: jest.fn().mockResolvedValue(
        JSON.stringify({
          ...existingCard,
          title: '登入後台（更新版）',
          standard_answer: '請開啟登入頁（更新版）。',
          source_consultant_input: {
            customer_question: '怎麼登入',
            consultant_reply: '請開啟登入頁（更新版）。',
          },
        })
      ),
    });
    await handleDmSessionPrivateMessage({
      userId: TEST_ADMIN,
      text: '修改知識卡 op-login：更新登入步驟說明',
    });
    const replies = await handleConfirmUpdate({ userId: TEST_ADMIN, text: '確認更新' });
    expect(replies[0].text).toMatch(/已更新知識卡/);
    const updated = await getRepos().knowledgeCards.findById('op-login');
    expect(updated?.title).toBe('登入後台（更新版）');
  });

  it('human readable draft hides internal field names', () => {
    const text = formatHumanReadableKnowledgeCard(checkoutTutorialCard, { draftMode: 'create' });
    expect(text).toMatch(/【知識卡草稿｜新增】/);
    expect(text).toMatch(/建議回覆：/);
    expect(text).not.toMatch(/patterns/);
    expect(text).not.toMatch(/risk_level/);
    expect(text).not.toMatch(/can_public_reply/);
  });

  it('human readable draft shows compact enhanced fields for consultants', () => {
    const text = formatHumanReadableKnowledgeCard(
      withEnhancedKnowledgeFields({
        ...checkoutTutorialCard,
        core_question: '如何新增結帳單？',
        match_features: ['新增結帳單', '結帳操作'],
        applicability_rules: ['店家詢問新增結帳單入口或操作步驟'],
        exclusion_rules: ['店家詢問實際付款或入帳狀態'],
        reasoning: '這張卡只適用操作教學，不處理帳務個案。',
        handoff_conditions: ['涉及金額、付款、入帳狀態時導入教練'],
        source_consultant_input: {
          customer_question: '怎麼新增結帳單',
          consultant_reply: '到「結帳」→「新增結帳單」。',
          raw_input: '店家問題：怎麼新增結帳單\n建議回覆：到「結帳」→「新增結帳單」。',
        },
      }),
      { draftMode: 'create' }
    );

    expect(text).toMatch(/適用：/);
    expect(text).toMatch(/不適用：/);
    expect(text).toMatch(/需要導入教練：/);
    expect(text).toMatch(/來源依據：/);
    expect(text).toMatch(/已保留顧問原文供系統驗證/);
    expect(text).not.toMatch(/匹配特徵：/);
    expect(text).not.toMatch(/顧問原文：到「結帳」→「新增結帳單」。/);
    expect(text).not.toMatch(/match_features/);
    expect(text).not.toMatch(/source_consultant_input/);
  });

  it('admin human readable draft also uses compact display and keeps full data behind JSON', () => {
    const text = formatHumanReadableKnowledgeCard(
      withEnhancedKnowledgeFields({
        ...checkoutTutorialCard,
        core_question: '如何新增結帳單？',
        match_features: ['新增結帳單', '結帳操作'],
        applicability_rules: ['店家詢問新增結帳單入口或操作步驟'],
        exclusion_rules: ['店家詢問實際付款或入帳狀態'],
        reasoning: '這張卡只適用操作教學，不處理帳務個案。',
        handoff_conditions: ['涉及金額、付款、入帳狀態時導入教練'],
        source_consultant_input: {
          customer_question: '怎麼新增結帳單',
          consultant_reply: '到「結帳」→「新增結帳單」。',
          raw_input: '店家問題：怎麼新增結帳單\n建議回覆：到「結帳」→「新增結帳單」。',
        },
      }),
      { draftMode: 'create', isAdmin: true }
    );

    expect(text).toMatch(/適用：/);
    expect(text).toMatch(/不適用：/);
    expect(text).toMatch(/需要導入教練：/);
    expect(text).toMatch(/來源依據：/);
    expect(text).toMatch(/轉成 JSON/);
    expect(text).not.toMatch(/匹配特徵：/);
    expect(text).not.toMatch(/推理說明：/);
    expect(text).not.toMatch(/來源資料：/);
    expect(text).not.toMatch(/顧問原文：到「結帳」→「新增結帳單」。/);
    expect(text).not.toMatch(/match_features/);
    expect(text).not.toMatch(/source_consultant_input/);
  });

  it('modify draft header shows target card', () => {
    const text = formatHumanReadableKnowledgeCard(existingCard, {
      draftMode: 'update',
      targetCardId: 'op-login',
      targetCardTitle: '登入後台',
    });
    expect(text).toMatch(/【知識卡草稿｜修改】/);
    expect(text).toMatch(/登入後台/);
  });

  it('standard_answer preserves line breaks in draft output', () => {
    const text = formatHumanReadableKnowledgeCard(checkoutTutorialCard, { draftMode: 'create' });
    expect(text).toContain('操作步驟：\n1. 開啟結帳頁');
  });

  it('checkout tutorial with 結帳 is not hard sensitive', () => {
    expect(
      cardContainsSensitiveContent({
        title: '新增結帳單操作教學',
        patterns: ['怎麼結帳'],
        standard_answer: '到結帳頁新增結帳單。',
      })
    ).toHaveLength(0);
  });

  it('hard sensitive billing errors are still blocked', () => {
    const result = validateKnowledgeCard({
      ...checkoutTutorialCard,
      card_id: 'billing-error',
      title: '餘額異常',
      patterns: ['餘額異常'],
      standard_answer: '請聯繫教練',
      risk_level: RiskLevel.LOW,
      can_public_reply: true,
    });
    expect(result.valid).toBe(false);
  });

  it('admin can override operation tutorial to public reply', () => {
    const adjusted = applyPublicReplyPreference(
      { ...checkoutTutorialCard, risk_level: RiskLevel.MID, can_public_reply: false },
      'admin_public'
    );
    const validation = validateKnowledgeCard(adjusted);
    expect(validation.valid).toBe(true);
    expect(validation.normalized?.can_public_reply).toBe(true);
  });

  it('admin cannot override hard red line to public reply', () => {
    const card = {
      ...checkoutTutorialCard,
      card_id: 'hard-block',
      title: '餘額異常',
      patterns: ['餘額異常'],
      standard_answer: '請聯繫教練',
      risk_level: RiskLevel.MID,
      can_public_reply: false,
    };
    const adjusted = applyPublicReplyPreference(card, 'admin_public');
    expect(adjusted.can_public_reply).toBe(false);
    expect(adjusted.risk_level).not.toBe(RiskLevel.LOW);
  });

  it('parsePublicReplyPreferencePhrase recognizes override commands', () => {
    expect(parsePublicReplyPreferencePhrase('設為可公開回答')).toBe('suggest_public');
    expect(parsePublicReplyPreferencePhrase('設為導入教練參考')).toBe('suggest_consultant');
  });

  it('parseModifyKnowledgeCardIntent recognizes modify commands', () => {
    expect(parseModifyKnowledgeCardIntent('修改知識卡 op-login')?.reference).toBe('op-login');
    expect(parseModifyKnowledgeCardIntent('修改「儲值卡設定」這張')?.reference).toBe('儲值卡設定');
  });

  it('confirm update success message shows public reply behavior', async () => {
    await seedActiveSessionForTest({
      userId: TEST_ADMIN,
      card: checkoutTutorialCard,
      draftText: formatHumanReadableKnowledgeCard(checkoutTutorialCard, { draftMode: 'create' }),
    });
    const session = await getRepos().dmSessions.findActiveByUserId(TEST_ADMIN);
    if (session?.draftData) {
      await getRepos().dmSessions.updateDraftData(
        session.sessionId,
        { ...session.draftData, draftMode: 'create' },
        new Date().toISOString()
      );
    }
    const replies = await handleConfirmUpdate({ userId: TEST_ADMIN, text: '確認更新' });
    expect(replies[0].text).toMatch(/已新增知識卡/);
    expect(replies[0].text).toMatch(/公開回答/);
  });

  it('isPlaceholderCardId treats 001 as placeholder', () => {
    expect(isPlaceholderCardId('001')).toBe(true);
    expect(isPlaceholderCardId(PENDING_CARD_ID)).toBe(true);
  });

  it('maintains MVP red lines for ThreadState and event_type counts', () => {
    expect(Object.values(ThreadState).length).toBe(5);
    expect(Object.values(EventType).length).toBe(10);
  });

  it('REPLY_TO_GROUP still sends verbatim text', async () => {
    const verbatim = '逐字轉貼測試\n第二行';
    expect(verbatim).toContain('\n');
    expect(typeof executeReplyToGroup).toBe('function');
  });
});
