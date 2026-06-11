import { RiskLevel } from '../src/types';
import { deriveCanPublicReply, KnowledgeCard } from '../src/schemas/knowledgeCardSchema';
import { SourceConsultantInput } from '../src/schemas/knowledgeCardDraftSchema';
import { validateKnowledgeCard } from '../src/services/knowledgeCardValidator';
import { validateStandardAnswerProvenance } from '../src/services/knowledgeCardProvenanceValidator';
import { withEnhancedKnowledgeFields } from './helpers/knowledgeCardTestFixtures';

function buildCard(params: {
  source: SourceConsultantInput;
  standardAnswer: string;
  patterns?: string[];
  title?: string;
  riskLevel?: RiskLevel;
  canPublicReply?: boolean;
}): KnowledgeCard {
  const title = params.title ?? params.source.customer_question;
  return withEnhancedKnowledgeFields({
    card_id: 'prov-test',
    title,
    patterns: params.patterns ?? [title],
    standard_answer: params.standardAnswer,
    risk_level: params.riskLevel ?? RiskLevel.LOW,
    can_public_reply:
      params.canPublicReply ?? deriveCanPublicReply(params.riskLevel ?? RiskLevel.LOW),
    source_consultant_input: params.source,
  });
}

describe('Knowledge card provenance validator', () => {
  it('1. blocks invented menu entrance not present in source', () => {
    const source: SourceConsultantInput = {
      customer_question: '如何設定儲值卡',
      consultant_reply: '可以到後台設定儲值卡。',
    };
    const card = buildCard({
      source,
      standardAnswer: '請到後台 > 會員管理 > 儲值卡設定。',
    });
    expect(validateStandardAnswerProvenance(card.standard_answer, source).length).toBeGreaterThan(0);
    expect(validateKnowledgeCard(card).valid).toBe(false);
  });

  it('2. blocks invented operation steps not present in source', () => {
    const source: SourceConsultantInput = {
      customer_question: '如何設定儲值卡',
      consultant_reply: '可以請店家手動設定儲值卡。',
    };
    const card = buildCard({
      source,
      standardAnswer: '請先點新增方案，再輸入金額，最後按儲存。',
    });
    expect(validateKnowledgeCard(card).valid).toBe(false);
  });

  it('3. blocks invented capability not present in source', () => {
    const source: SourceConsultantInput = {
      customer_question: '會員資料',
      consultant_reply: '目前建議請店家手動處理。',
    };
    const card = buildCard({
      source,
      standardAnswer: '系統可以自動同步會員儲值資料。',
    });
    expect(validateKnowledgeCard(card).valid).toBe(false);
  });

  it('4. blocks invented payment / integration details not present in source', () => {
    const source: SourceConsultantInput = {
      customer_question: '儲值卡設定',
      consultant_reply: '這題請先引導店家確認儲值卡設定。',
    };
    const card = buildCard({
      source,
      standardAnswer: '系統支援第三方金流串接，付款完成後會自動入帳。',
    });
    expect(validateKnowledgeCard(card).valid).toBe(false);
  });

  it('5. allows reorganizing explicit entrance provided in source', () => {
    const source: SourceConsultantInput = {
      customer_question: '儲值卡在哪',
      consultant_reply: '請店家到後台 > 會員管理 > 儲值卡設定查看。',
    };
    const card = buildCard({
      source,
      standardAnswer: '你可以到後台 > 會員管理 > 儲值卡設定查看。',
      riskLevel: RiskLevel.LOW,
      canPublicReply: true,
    });
    expect(validateKnowledgeCard(card).valid).toBe(true);
    expect(validateKnowledgeCard(card).normalized?.can_public_reply).toBe(true);
  });

  it('6. allows reorganizing explicit steps provided in source', () => {
    const source: SourceConsultantInput = {
      customer_question: '如何設定方案',
      consultant_reply: '先新增方案，再輸入金額，最後按儲存。',
    };
    const card = buildCard({
      source,
      standardAnswer: '操作方式是先新增方案，再輸入金額，最後按儲存。',
    });
    expect(validateKnowledgeCard(card).valid).toBe(true);
  });

  it('7. blocks rewriting manual handling into automatic completion', () => {
    const source: SourceConsultantInput = {
      customer_question: '設定問題',
      consultant_reply: '目前需要店家手動設定。',
    };
    const card = buildCard({
      source,
      standardAnswer: '系統會自動完成設定。',
    });
    expect(validateKnowledgeCard(card).valid).toBe(false);
  });

  it('8. allows stored-value tutorial with explicit entrance to stay public', () => {
    const source: SourceConsultantInput = {
      customer_question: '儲值卡在哪',
      consultant_reply: '請店家到後台 > 會員管理 > 儲值卡設定查看。',
    };
    const card = buildCard({
      source,
      standardAnswer: '你可以到後台 > 會員管理 > 儲值卡設定查看。',
      title: '儲值卡設定',
      patterns: ['如何設定儲值卡', '儲值卡功能在哪裡'],
      riskLevel: RiskLevel.LOW,
      canPublicReply: true,
    });
    const result = validateKnowledgeCard(card);
    expect(result.valid).toBe(true);
    expect(result.normalized?.risk_level).toBe(RiskLevel.LOW);
    expect(result.normalized?.can_public_reply).toBe(true);
  });

  it('9. keeps billing / refund / transaction content non-public', () => {
    for (const pattern of ['這筆儲值有沒有入帳', '退款狀態怎麼查', '會員儲值紀錄可以查嗎']) {
      const result = validateKnowledgeCard(
        buildCard({
          source: {
            customer_question: pattern,
            consultant_reply: '請聯絡教練協助確認。',
          },
          standardAnswer: '請聯絡教練協助確認。',
          patterns: [pattern],
          riskLevel: RiskLevel.LOW,
          canPublicReply: true,
        })
      );
      expect(result.valid).toBe(false);
    }
  });
});

describe('Knowledge card pending review silent notifications', () => {
  it('admin revision and reject handlers do not push consultants', async () => {
    const { handleAdminRevisionFeedback, handleAdminRejectDraft } = await import(
      '../src/services/knowledgeCardWriteService'
    );
    const { seedPendingReviewForTest } = await import('../src/services/knowledgeCardReviewService');
    const { resetRepositories } = await import('../src/repositories');
    const { loadEnv, resetEnvCache } = await import('../src/config/env');
    const {
      registerAdmin,
      registerInviteCode,
      requestConsultantJoin,
      approveConsultant,
    } = await import('../src/services/consultantWhitelist');
    const { TEST_ADMIN, TEST_CONSULTANT } = await import('./helpers/testSetup');

    resetEnvCache();
    loadEnv({ USE_MEMORY_REPOS: true });
    await resetRepositories('memory');
    await registerAdmin(TEST_ADMIN, 'Admin');
    await registerInviteCode('SIL001', TEST_ADMIN);
    await requestConsultantJoin(TEST_CONSULTANT, 'SIL001', 'Consultant');
    await approveConsultant(TEST_ADMIN, TEST_CONSULTANT);

    const card = withEnhancedKnowledgeFields({
      card_id: '__pending__',
      title: '待審',
      patterns: ['問題'],
      standard_answer: '回覆',
    });

    await seedPendingReviewForTest({
      consultantId: TEST_CONSULTANT,
      consultantName: 'Consultant',
      card,
      draftText: 'draft',
      shortCode: 'K-20260611-SIL1',
    });

    const revisionReplies = await handleAdminRevisionFeedback({
      userId: TEST_ADMIN,
      text: '需要修改 K-20260611-SIL1：請補充',
    });
    expect(revisionReplies.every((reply) => reply.userId !== TEST_CONSULTANT)).toBe(true);

    await seedPendingReviewForTest({
      consultantId: TEST_CONSULTANT,
      consultantName: 'Consultant',
      card,
      draftText: 'draft',
      shortCode: 'K-20260611-SIL2',
    });

    const rejectReplies = await handleAdminRejectDraft({
      userId: TEST_ADMIN,
      text: '退回 K-20260611-SIL2',
    });
    expect(rejectReplies.every((reply) => reply.userId !== TEST_CONSULTANT)).toBe(true);
  });
});
