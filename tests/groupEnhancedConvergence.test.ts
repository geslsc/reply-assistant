import {
  CUSTOMER_HANDOFF_BUFFER_MESSAGE,
  RiskLevel,
  ThreadState,
} from '../src/types';
import { loadEnv, resetEnvCache } from '../src/config/env';
import { getRepos, resetRepositories } from '../src/repositories';
import { processMessage } from '../src/handlers/lineWebhookHandler';
import { buildPublicAnswer } from '../src/services/riskRouter';
import {
  getCardById,
  refreshKnowledgeCache,
  initKnowledgeBase,
  resetKnowledgeBase,
} from '../src/services/knowledgeBaseService';
import { clearConvergenceTimersForTest } from '../src/services/groupMessageConvergenceService';
import { getActiveIssueThread } from '../src/services/issueThreadService';
import { getPendingHandoffs } from '../src/services/pendingHandoffService';
import { handleServiceIntroduction } from '../src/services/servicePeriodService';
import {
  registerAdmin,
  registerInviteCode,
  requestConsultantJoin,
  approveConsultant,
} from '../src/services/consultantWhitelist';
import { TEST_ADMIN, TEST_CONSULTANT, TEST_CUSTOMER, TEST_GROUP } from './helpers/testSetup';
import { withEnhancedKnowledgeFields } from './helpers/knowledgeCardTestFixtures';
import { KnowledgeCard } from '../src/schemas/knowledgeCardSchema';

const BOOKING_CARDS: KnowledgeCard[] = [
  withEnhancedKnowledgeFields({
    card_id: 'op-group-class-booking',
    title: '團體課程人員帳號設定',
    patterns: ['團體課預約', '團課可以同時約'],
    core_question: '如何設定團體課的預約人數',
    match_features: ['團體課', '團課', '同時服務組數', '人員帳號'],
    applicability_rules: ['詢問團體課預約設定'],
    exclusion_rules: ['一般一對一預約'],
    risk_level: RiskLevel.LOW,
    can_public_reply: true,
    standard_answer: '團體課建議新增專用人員帳號，並在進階功能設定同時服務組數。',
  }),
  withEnhancedKnowledgeFields({
    card_id: 'op-add-appointment',
    title: '新增預約操作',
    patterns: ['新增預約', '怎麼新增預約'],
    core_question: '如何在行事曆新增預約',
    match_features: ['新增預約', '行事曆', '加號按鈕'],
    applicability_rules: ['詢問新增預約入口'],
    exclusion_rules: ['團體課設定'],
    risk_level: RiskLevel.LOW,
    can_public_reply: true,
    standard_answer: '到行事曆畫面按加號，再選新增預約即可。',
  }),
  withEnhancedKnowledgeFields({
    card_id: 'op-online-booking',
    title: '線上預約設定',
    patterns: ['線上預約', '網站預約設定'],
    core_question: '如何設定線上預約功能',
    match_features: ['線上預約', '線上網站設定', '開放預約'],
    applicability_rules: ['詢問線上預約功能'],
    exclusion_rules: ['現場新增預約'],
    risk_level: RiskLevel.LOW,
    can_public_reply: true,
    standard_answer: '到線上網站設定開啟線上預約功能。',
  }),
];

async function seedBookingCards(): Promise<void> {
  for (const card of BOOKING_CARDS) {
    await getRepos().knowledgeCards.insert({
      cardId: card.card_id,
      title: card.title,
      patterns: card.patterns,
      riskLevel: card.risk_level,
      canPublicReply: card.can_public_reply,
      standardAnswer: card.standard_answer,
      notApplicable: card.not_applicable ?? [],
      escalateToConsultant: card.escalate_to_consultant ?? [],
      status: 'active',
      coreQuestion: card.core_question ?? null,
      matchFeatures: card.match_features ?? [],
      applicabilityRules: card.applicability_rules ?? [],
      exclusionRules: card.exclusion_rules ?? [],
      createdBy: TEST_ADMIN,
      createdAt: new Date().toISOString(),
      confirmedBy: TEST_ADMIN,
      confirmedAt: new Date().toISOString(),
    });
  }
  await refreshKnowledgeCache();
}

async function setup(): Promise<void> {
  resetEnvCache();
  loadEnv({ USE_MEMORY_REPOS: true, DEBOUNCE_SECONDS: 0 });
  await resetRepositories('memory');
  clearConvergenceTimersForTest();
  await initKnowledgeBase();
  await registerAdmin(TEST_ADMIN, 'Admin');
  await registerInviteCode('ENH001', TEST_ADMIN);
  await requestConsultantJoin(TEST_CONSULTANT, 'ENH001', 'Consultant');
  await approveConsultant(TEST_ADMIN, TEST_CONSULTANT);
  await handleServiceIntroduction(TEST_GROUP, TEST_CONSULTANT);
  await seedBookingCards();
}

function groupMsg(userId: string, text: string) {
  return { userId, groupId: TEST_GROUP, text, isGroup: true };
}

describe('Enhanced knowledge card convergence', () => {
  beforeEach(async () => {
    await setup();
  });

  it('does not directly reply with group class card for vague booking question', async () => {
    const result = await processMessage(groupMsg(TEST_CUSTOMER, '我不知道怎麼幫客人預約'));
    const groupText = result.replies.find((r) => r.type === 'group')?.text ?? '';
    expect(groupText).not.toContain('團體課建議新增專用人員帳號');
    expect(groupText).not.toBe(
      buildPublicAnswer(getCardById('op-group-class-booking')!.standard_answer)
    );
    expect((await getActiveIssueThread(TEST_GROUP))?.state).toBe(ThreadState.AI_CLARIFYING);
    expect((await getActiveIssueThread(TEST_GROUP))?.clarifyRound).toBe(1);
  });

  it('shows 2-4 options in round 2 and each option maps to an existing card', async () => {
    await processMessage(groupMsg(TEST_CUSTOMER, '我不知道怎麼幫客人預約'));
    const round2 = await processMessage(groupMsg(TEST_CUSTOMER, '就是預約相關'));
    const groupText = round2.replies.find((r) => r.type === 'group')?.text ?? '';
    expect(groupText).toMatch(/^1\./m);
    expect(groupText).toMatch(/^2\./m);
    const thread = await getActiveIssueThread(TEST_GROUP);
    expect(thread?.clarifyRound).toBe(2);
    for (const option of thread?.convergenceState?.round2Options ?? []) {
      expect(getCardById(option.cardId)).toBeTruthy();
    }
    expect((thread?.convergenceState?.round2Options?.length ?? 0)).toBeGreaterThanOrEqual(2);
    expect((thread?.convergenceState?.round2Options?.length ?? 0)).toBeLessThanOrEqual(4);
  });

  it('applies verbatim standard_answer when customer selects a low/public option number in round 2', async () => {
    await processMessage(groupMsg(TEST_CUSTOMER, '我不知道怎麼幫客人預約'));
    await processMessage(groupMsg(TEST_CUSTOMER, '就是預約相關'));
    const thread = await getActiveIssueThread(TEST_GROUP);
    const target =
      thread?.convergenceState?.round2Options?.find((item) => item.cardId === 'op-add-appointment') ??
      thread?.convergenceState?.round2Options?.[0];
    expect(target).toBeTruthy();

    const selected = await processMessage(groupMsg(TEST_CUSTOMER, String(target!.index)));
    const card = getCardById(target!.cardId)!;
    expect(selected.replies.find((r) => r.type === 'group')?.text).toBe(
      buildPublicAnswer(card.standard_answer)
    );
    expect((await getActiveIssueThread(TEST_GROUP))?.state).toBe(ThreadState.AI_ANSWERING);
    expect((await getActiveIssueThread(TEST_GROUP))?.clarifyRound).toBe(2);
  });

  it('does not treat round 2 number selection as round 3', async () => {
    await processMessage(groupMsg(TEST_CUSTOMER, '我不知道怎麼幫客人預約'));
    await processMessage(groupMsg(TEST_CUSTOMER, '就是預約相關'));
    const thread = await getActiveIssueThread(TEST_GROUP);
    const target = thread?.convergenceState?.round2Options?.[0];
    await processMessage(groupMsg(TEST_CUSTOMER, String(target!.index)));
    expect(thread?.convergenceState?.round3Options).toBeUndefined();
  });

  it('enters round 3 only when candidate set narrows after descriptive follow-up', async () => {
    await processMessage(groupMsg(TEST_CUSTOMER, '我不知道怎麼幫客人預約'));
    await processMessage(groupMsg(TEST_CUSTOMER, '就是預約相關'));
    const round3 = await processMessage(
      groupMsg(TEST_CUSTOMER, '我想問的是新增預約操作，或是線上預約設定')
    );
    const groupText = round3.replies.find((r) => r.type === 'group')?.text ?? '';
    expect(groupText).toMatch(/^1\./m);
    expect((await getActiveIssueThread(TEST_GROUP))?.clarifyRound).toBe(3);
    expect(
      (await getActiveIssueThread(TEST_GROUP))?.convergenceState?.round3Options?.length
    ).toBeGreaterThanOrEqual(2);
  });

  it('handoffs when round 2 descriptive follow-up has no new information', async () => {
    await processMessage(groupMsg(TEST_CUSTOMER, '我不知道怎麼幫客人預約'));
    await processMessage(groupMsg(TEST_CUSTOMER, '就是預約相關'));
    const result = await processMessage(groupMsg(TEST_CUSTOMER, '不知道'));
    expect(result.replies.find((r) => r.type === 'group')?.text).toBe(
      CUSTOMER_HANDOFF_BUFFER_MESSAGE
    );
    expect(await getPendingHandoffs(TEST_ADMIN)).toHaveLength(1);
  });

  it('handoffs after round 3 when still unclear and does not ask again', async () => {
    await processMessage(groupMsg(TEST_CUSTOMER, '我不知道怎麼幫客人預約'));
    await processMessage(groupMsg(TEST_CUSTOMER, '就是預約相關'));
    await processMessage(
      groupMsg(TEST_CUSTOMER, '我想問的是新增預約操作，或是線上預約設定')
    );
    const result = await processMessage(groupMsg(TEST_CUSTOMER, '還是不清楚'));
    expect(result.replies.find((r) => r.type === 'group')?.text).toBe(
      CUSTOMER_HANDOFF_BUFFER_MESSAGE
    );
    expect((await getActiveIssueThread(TEST_GROUP))?.clarifyRound).toBe(3);
  });

  it('does not over-clarify a clear low-risk single-card question', async () => {
    const result = await processMessage(groupMsg(TEST_CUSTOMER, '怎麼登入後台'));
    const card = getCardById('op-login')!;
    expect(result.replies.find((r) => r.type === 'group')?.text).toBe(
      buildPublicAnswer(card.standard_answer)
    );
    expect((await getActiveIssueThread(TEST_GROUP))?.state).toBe(ThreadState.AI_ANSWERING);
  });

  it('still handoffs immediately for high-risk messages', async () => {
    const result = await processMessage(groupMsg(TEST_CUSTOMER, '儲值餘額異常怎麼辦'));
    expect(result.replies.find((r) => r.type === 'group')?.text).toBe(
      CUSTOMER_HANDOFF_BUFFER_MESSAGE
    );
  });

  it('handoffs for mid-risk non-public card even when explicitly matched', async () => {
    resetKnowledgeBase([
      ...BOOKING_CARDS,
      withEnhancedKnowledgeFields({
        card_id: 'op-payment-settings',
        title: '付款方式設定',
        patterns: ['金流怎麼設定', '如何設定付款方式'],
        core_question: '如何設定付款方式',
        match_features: ['付款方式', '金流'],
        risk_level: RiskLevel.MID,
        can_public_reply: false,
        standard_answer: '進入商店設定付款方式後再儲存。',
      }),
    ]);
    await refreshKnowledgeCache();

    const result = await processMessage(groupMsg(TEST_CUSTOMER, '如何設定付款方式'));
    expect(result.replies.find((r) => r.type === 'group')?.text).toBe(
      CUSTOMER_HANDOFF_BUFFER_MESSAGE
    );
  });
});

describe('Enhanced convergence regression guards', () => {
  beforeEach(async () => {
    await setup();
  });

  it('does not add new push notifications during convergence', async () => {
    const result = await processMessage(groupMsg(TEST_CUSTOMER, '我不知道怎麼幫客人預約'));
    expect(result.replies.filter((reply) => reply.type === 'push')).toHaveLength(0);
  });
});
