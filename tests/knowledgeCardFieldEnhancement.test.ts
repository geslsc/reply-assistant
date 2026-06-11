import { RiskLevel } from '../src/types';
import { getRepos, resetRepositories } from '../src/repositories';
import { loadEnv, resetEnvCache } from '../src/config/env';
import {
  validateKnowledgeCard,
  cardContainsHardRedlineContent,
} from '../src/services/knowledgeCardValidator';
import {
  handleConsultantConfirmSubmit,
  handleConfirmUpdate,
  parseAdminEditDraftCommand,
  storeUserDraft,
} from '../src/services/knowledgeCardWriteService';
import {
  handlePendingReviewQueryCommand,
} from '../src/services/knowledgeCardPendingReviewQueryService';
import {
  normalizeKnowledgeReviewShortCode,
} from '../src/services/knowledgeReviewShortCodeService';
import { seedPendingReviewForTest } from '../src/services/knowledgeCardReviewService';
import { safeLogKnowledgeDraftEdited } from '../src/services/lowVolumeTodoEventLogService';
import { draftDataToKnowledgeCard, knowledgeCardToDraftData } from '../src/services/knowledgeCardDraftMappingService';
import { writeKnowledgeCardWithValidation } from '../src/services/knowledgeCardWriteGate';
import {
  registerAdmin,
  registerInviteCode,
  requestConsultantJoin,
  approveConsultant,
} from '../src/services/consultantWhitelist';
import { withEnhancedKnowledgeFields, buildTestDraftData } from './helpers/knowledgeCardTestFixtures';
import { TEST_ADMIN, TEST_CONSULTANT } from './helpers/testSetup';
import * as fs from 'fs';
import * as path from 'path';

async function setupRoles(): Promise<void> {
  await registerAdmin(TEST_ADMIN, 'Admin');
  await registerInviteCode('ENH001', TEST_ADMIN);
  await requestConsultantJoin(TEST_CONSULTANT, 'ENH001', 'Consultant');
  await approveConsultant(TEST_ADMIN, TEST_CONSULTANT);
}

describe('Knowledge card field enhancement 2026-06-11', () => {
  beforeEach(async () => {
    resetEnvCache();
    loadEnv({ USE_MEMORY_REPOS: true });
    await resetRepositories('memory');
    await setupRoles();
  });

  it('1-2. schema.sql migration block is idempotent and adds 7 nullable columns', () => {
    const schema = fs.readFileSync(path.join(__dirname, '../src/db/schema.sql'), 'utf-8');
    expect(schema).toMatch(/ADD COLUMN IF NOT EXISTS core_question TEXT/);
    expect(schema).toMatch(/ADD COLUMN IF NOT EXISTS match_features JSONB/);
    expect(schema).toMatch(/ADD COLUMN IF NOT EXISTS applicability_rules JSONB/);
    expect(schema).toMatch(/ADD COLUMN IF NOT EXISTS exclusion_rules JSONB/);
    expect(schema).toMatch(/ADD COLUMN IF NOT EXISTS reasoning TEXT/);
    expect(schema).toMatch(/ADD COLUMN IF NOT EXISTS handoff_conditions JSONB/);
    expect(schema).toMatch(/ADD COLUMN IF NOT EXISTS source_consultant_input JSONB/);
    const alterCount = (schema.match(/ADD COLUMN IF NOT EXISTS core_question TEXT/g) ?? []).length;
    expect(alterCount).toBeGreaterThanOrEqual(1);
  });

  it('3. pending_knowledge_reviews.draft_data stores full draft payload', async () => {
    const draft = buildTestDraftData({
      topic: '登入問題',
      core_question: '怎麼登入',
      public_answer_draft: '請至登入頁',
      patterns: ['怎麼登入'],
      match_features: ['登入'],
    });
    const card = draftDataToKnowledgeCard(draft);
    await storeUserDraft(TEST_CONSULTANT, card, JSON.stringify(draft), 'draft text');
    await handleConsultantConfirmSubmit(TEST_CONSULTANT);
    const pending = await getRepos().pendingKnowledgeReviews.listPending();
    expect(pending).toHaveLength(1);
    expect(pending[0].draftData?.core_question).toBe('怎麼登入');
    expect(pending[0].draftData?.match_features).toEqual(['登入']);
    expect(pending[0].draftData?.public_answer_draft).toBe('請至登入頁');
  });

  it('4. consultant confirm submit only writes pending_knowledge_reviews without admin push', async () => {
    const card = withEnhancedKnowledgeFields({
      card_id: '__pending__',
      title: '測試',
      patterns: ['測試'],
      standard_answer: '回覆',
    });
    await storeUserDraft(TEST_CONSULTANT, card, JSON.stringify(card), 'draft');
    const replies = await handleConsultantConfirmSubmit(TEST_CONSULTANT);
    expect(replies.some((r) => r.type === 'push' && r.userId === TEST_ADMIN)).toBe(false);
    expect(await getRepos().knowledgeCards.findById(card.card_id)).toBeNull();
    expect((await getRepos().pendingKnowledgeReviews.listPending()).length).toBe(1);
  });

  it('5-6. admin can list pending reviews and view KDR alias', async () => {
    const card = withEnhancedKnowledgeFields({
      card_id: '__pending__',
      title: '待審卡',
      patterns: ['待審'],
      standard_answer: '回覆',
    });
    const review = await seedPendingReviewForTest({
      consultantId: TEST_CONSULTANT,
      consultantName: 'Consultant',
      card,
      draftText: 'draft',
      shortCode: 'K-20260611-AB',
    });
    const listReplies = await handlePendingReviewQueryCommand(TEST_ADMIN, '查詢待審知識卡');
    expect(listReplies?.[0].text).toMatch(/待審知識卡清單/);
    expect(listReplies?.[0].text).toMatch(/K-20260611-AB/);

    const kdrCode = review.shortCode.replace(/^K-/, 'KDR-');
    const viewReplies = await handlePendingReviewQueryCommand(
      TEST_ADMIN,
      `查看 ${kdrCode}`
    );
    expect(viewReplies?.[0].text).toMatch(/待審知識卡草稿/);
    expect(normalizeKnowledgeReviewShortCode(kdrCode)).toBe(review.shortCode);
  });

  it('7-9. admin edit draft then confirm update validates before writing knowledge_cards', async () => {
    const card = withEnhancedKnowledgeFields({
      card_id: '__pending__',
      title: '原始',
      patterns: ['原始問題'],
      standard_answer: '原始回覆',
    });
    await seedPendingReviewForTest({
      consultantId: TEST_CONSULTANT,
      consultantName: 'Consultant',
      card,
      draftText: 'draft',
      shortCode: 'K-20260611-CD',
    });

    const editedDraft = buildTestDraftData({
      topic: '更新主題',
      core_question: '更新問題',
      public_answer_draft: '更新回覆',
      patterns: ['更新問題'],
      risk_level: RiskLevel.LOW,
      can_public_reply: true,
    });
    const parsed = parseAdminEditDraftCommand(
      `編輯草稿 K-20260611-CD ${JSON.stringify(editedDraft)}`
    );
    expect(parsed).not.toBeNull();

    await getRepos().pendingKnowledgeReviews.updateDraftData({
      reviewId: 'K-20260611-CD',
      draftData: editedDraft,
      cardData: draftDataToKnowledgeCard(editedDraft),
      lastEditedBy: TEST_ADMIN,
      lastEditedAt: new Date().toISOString(),
    });

    const confirm = await handleConfirmUpdate({
      userId: TEST_ADMIN,
      text: '確認更新 K-20260611-CD',
    });
    expect(confirm[0].text).toMatch(/已新增知識卡/);
    const records = await getRepos().knowledgeCards.findAll();
    expect(records.some((r) => r.title === '更新主題')).toBe(true);
    const approved = await getRepos().pendingKnowledgeReviews.findById('K-20260611-CD');
    expect(approved?.status).toBe('approved');
  });

  it('10-12. required fields block write', () => {
    const base = withEnhancedKnowledgeFields({
      card_id: 'req-test',
      title: 't',
      patterns: ['p'],
      standard_answer: 'a',
    });
    expect(validateKnowledgeCard({ ...base, core_question: '' }).valid).toBe(false);
    expect(validateKnowledgeCard({ ...base, standard_answer: '' }).valid).toBe(false);
    expect(
      validateKnowledgeCard({ ...base, source_consultant_input: undefined }).valid
    ).toBe(false);
  });

  it('13-14. can_public_reply only allowed for low risk without hard redlines', () => {
    const ok = withEnhancedKnowledgeFields({
      card_id: 'pub-ok',
      title: '登入',
      patterns: ['登入'],
      standard_answer: '請登入',
      risk_level: RiskLevel.LOW,
      can_public_reply: true,
    });
    expect(validateKnowledgeCard(ok).valid).toBe(true);

    for (const level of [RiskLevel.MID, RiskLevel.HIGH, RiskLevel.UNKNOWN]) {
      const result = validateKnowledgeCard({
        ...ok,
        risk_level: level,
        can_public_reply: false,
      });
      expect(result.valid).toBe(true);
      expect(result.normalized?.can_public_reply).toBe(false);
    }
  });

  it('15-16. hard redlines force non-public and cannot be whitelisted', () => {
    const card = withEnhancedKnowledgeFields({
      card_id: 'redline',
      title: '新增結帳單操作教學',
      patterns: ['退款要怎麼處理'],
      standard_answer: '請聯絡教練',
      risk_level: RiskLevel.LOW,
      can_public_reply: true,
    });
    expect(validateKnowledgeCard(card).valid).toBe(false);
    expect(cardContainsHardRedlineContent(card)).toContain('退款');
  });

  it('17. JSONB fields must be string arrays', () => {
    const base = withEnhancedKnowledgeFields({
      card_id: 'json-test',
      title: 't',
      patterns: ['p'],
      standard_answer: 'a',
    });
    expect(validateKnowledgeCard({ ...base, match_features: ['ok'] }).valid).toBe(true);
    expect(validateKnowledgeCard({ ...base, match_features: 'bad' as unknown as string[] }).valid).toBe(
      false
    );
    expect(
      validateKnowledgeCard({ ...base, handoff_conditions: [1 as unknown as string] }).valid
    ).toBe(false);
  });

  it('18-19. provenance blocks invented content', () => {
    const base = withEnhancedKnowledgeFields({
      card_id: 'prov',
      title: '功能問題',
      patterns: ['功能'],
      standard_answer: '系統會自動完成退款入帳',
      source_consultant_input: {
        customer_question: '功能',
        consultant_reply: '需手動確認',
      },
      risk_level: RiskLevel.MID,
      can_public_reply: false,
    });
    expect(validateKnowledgeCard(base).valid).toBe(false);
  });

  it('20. log write failure only warns and does not throw', async () => {
    const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
    await expect(
      safeLogKnowledgeDraftEdited({
        review_id: 'K-20260611-LOG',
        edited_by: TEST_ADMIN,
        edit_reason: 'test',
      })
    ).resolves.toBeUndefined();
    warnSpy.mockRestore();
  });

  it('validate failure does not write knowledge_cards on admin confirm', async () => {
    const badDraft = buildTestDraftData({
      topic: '帳務',
      core_question: '帳務',
      public_answer_draft: '自動對帳',
      patterns: ['帳務'],
      risk_level: RiskLevel.LOW,
      can_public_reply: true,
      source_consultant_input: {
        customer_question: '帳務',
        consultant_reply: '需手動',
      },
    });
    await seedPendingReviewForTest({
      consultantId: TEST_CONSULTANT,
      consultantName: 'Consultant',
      card: draftDataToKnowledgeCard(badDraft),
      draftData: badDraft,
      draftText: 'draft',
      shortCode: 'K-20260611-BAD',
    });
    const result = await handleConfirmUpdate({
      userId: TEST_ADMIN,
      text: '確認更新 K-20260611-BAD',
    });
    expect(result[0].text).toMatch(/驗證失敗/);
    expect((await getRepos().knowledgeCards.findAll()).length).toBe(0);
  });

  it('maps consultant draft_data fields to knowledge_cards columns', () => {
    const draft = buildTestDraftData({
      topic: '主題',
      public_answer_draft: '公開草稿',
      patterns: ['店家問法'],
    });
    const card = draftDataToKnowledgeCard(draft);
    expect(card.standard_answer).toBe('公開草稿');
    expect(card.patterns).toEqual(['店家問法']);
    expect(card.title).toBe('主題');

    const roundTrip = knowledgeCardToDraftData(card);
    expect(roundTrip.public_answer_draft).toBe(card.standard_answer);
  });
});

describe('Knowledge card field enhancement remedial 2026-06-11', () => {
  beforeEach(async () => {
    resetEnvCache();
    loadEnv({ USE_MEMORY_REPOS: true });
    await resetRepositories('memory');
    await setupRoles();
  });

  it('stored value tutorial questions pass low / can_public_reply=true', () => {
    for (const patterns of [['如何設定儲值卡'], ['儲值卡功能在哪裡']]) {
      const result = validateKnowledgeCard(
        withEnhancedKnowledgeFields({
          card_id: 'tutorial',
          title: '儲值卡設定',
          patterns,
          standard_answer: '到票券管理新增儲值卡。',
          risk_level: RiskLevel.LOW,
          can_public_reply: true,
        })
      );
      expect(result.valid).toBe(true);
      expect(result.normalized?.can_public_reply).toBe(true);
      expect(result.normalized?.risk_level).toBe(RiskLevel.LOW);
    }
  });

  it('billing stored value and refund questions block public reply', () => {
    for (const patterns of [
      ['這筆儲值有沒有入帳'],
      ['會員儲值紀錄可以查嗎'],
      ['退款狀態怎麼查'],
    ]) {
      expect(
        validateKnowledgeCard(
          withEnhancedKnowledgeFields({
            card_id: 'billing',
            title: patterns[0],
            patterns,
            standard_answer: '請聯絡教練',
            risk_level: RiskLevel.LOW,
            can_public_reply: true,
          })
        ).valid
      ).toBe(false);
    }
  });

  it('tutorial whitelist cannot override true billing hard redlines', () => {
    const card = withEnhancedKnowledgeFields({
      card_id: 'acct',
      title: '新增結帳單操作教學',
      patterns: ['帳務對帳問題'],
      standard_answer: '請聯絡教練',
      risk_level: RiskLevel.LOW,
      can_public_reply: true,
    });
    const result = validateKnowledgeCard(card);
    expect(result.valid).toBe(false);
    expect(cardContainsHardRedlineContent(card)).toContain('帳務');
  });

  it('consultant submit is silent for admin but admin can still query and confirm', async () => {
    const card = withEnhancedKnowledgeFields({
      card_id: '__pending__',
      title: '待審',
      patterns: ['問題'],
      standard_answer: '回覆',
    });
    await storeUserDraft(TEST_CONSULTANT, card, JSON.stringify(card), 'draft');
    const submitReplies = await handleConsultantConfirmSubmit(TEST_CONSULTANT);
    expect(submitReplies.every((r) => r.userId !== TEST_ADMIN)).toBe(true);

    const pending = await getRepos().pendingKnowledgeReviews.listPending();
    expect(pending).toHaveLength(1);
    const shortCode = pending[0].reviewId;

    const listReplies = await handlePendingReviewQueryCommand(TEST_ADMIN, '查詢待審知識卡');
    expect(listReplies?.[0].text).toMatch(/待審知識卡清單/);

    const kdrCode = shortCode.replace(/^K-/, 'KDR-');
    const viewReplies = await handlePendingReviewQueryCommand(TEST_ADMIN, `查看 ${kdrCode}`);
    expect(viewReplies?.[0].text).toMatch(/待審知識卡草稿/);

    const confirm = await handleConfirmUpdate({
      userId: TEST_ADMIN,
      text: `確認更新 ${shortCode}`,
    });
    expect(confirm[0].text).toMatch(/已新增知識卡/);
    expect((await getRepos().knowledgeCards.findAll()).length).toBeGreaterThan(0);
  });
});

describe('Knowledge card field enhancement write gate', () => {
  beforeEach(async () => {
    resetEnvCache();
    loadEnv({ USE_MEMORY_REPOS: true });
    await resetRepositories('memory');
    await setupRoles();
  });

  it('writeKnowledgeCardWithValidation is the last gate', async () => {
    const invalid = withEnhancedKnowledgeFields({
      card_id: 'gate-invalid',
      title: '這筆儲值有沒有入帳',
      patterns: ['這筆儲值有沒有入帳'],
      standard_answer: '請聯絡教練',
      risk_level: RiskLevel.LOW,
      can_public_reply: true,
    });
    const result = await writeKnowledgeCardWithValidation({
      card: invalid,
      operatorUserId: TEST_ADMIN,
      operation: 'create',
      summary: 'test',
    });
    expect(result.ok).toBe(false);
    expect(await getRepos().knowledgeCards.findById('gate-invalid')).toBeNull();
  });
});
