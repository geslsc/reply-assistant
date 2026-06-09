import { RiskLevel } from '../src/types';
import {
  deriveCanPublicReply,
  KnowledgeCard,
} from '../src/schemas/knowledgeCardSchema';
import {
  cardContainsSensitiveContent,
  enforceKnowledgeCardRules,
  validateKnowledgeCard,
} from '../src/services/knowledgeCardValidator';
import {
  formatDraftReply,
  generateKnowledgeCardDraft,
  setLlmClient,
} from '../src/services/knowledgeCardDraftService';

describe('Knowledge Card Validator', () => {
  const baseCard: KnowledgeCard = {
    card_id: 'op-login',
    title: '登入後台',
    patterns: ['怎麼登入'],
    risk_level: RiskLevel.LOW,
    can_public_reply: true,
    standard_answer: '請開啟登入頁。',
    not_applicable: [],
    escalate_to_consultant: [],
    status: '可用',
  };

  it('forces can_public_reply false for mid/high/unknown', () => {
    for (const level of [RiskLevel.MID, RiskLevel.HIGH, RiskLevel.UNKNOWN]) {
      const result = validateKnowledgeCard({
        ...baseCard,
        risk_level: level,
        can_public_reply: false,
      });
      expect(result.valid).toBe(true);
      expect(result.normalized?.can_public_reply).toBe(false);
    }
  });

  it('rejects LLM self-set can_public_reply on low risk card with sensitive keywords', () => {
    const result = validateKnowledgeCard({
      ...baseCard,
      title: '金流設定問題',
      can_public_reply: true,
    });
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.field === 'risk_level')).toBe(true);
  });

  it('rejects forbidden fields version/updated_reason/source', () => {
    const result = validateKnowledgeCard({
      ...baseCard,
      version: 1,
    });
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.field === 'version')).toBe(true);
  });

  it('enforceKnowledgeCardRules derives can_public_reply from risk_level', () => {
    const result = enforceKnowledgeCardRules({
      ...baseCard,
      can_public_reply: true,
      risk_level: RiskLevel.MID,
    });
    expect(result.valid).toBe(true);
    expect(result.normalized?.can_public_reply).toBe(false);
  });

  it('detects sensitive categories in patterns and standard_answer', () => {
    expect(
      cardContainsSensitiveContent({
        patterns: ['帳務對帳問題'],
      })
    ).toContain('帳務');
    expect(deriveCanPublicReply(RiskLevel.LOW)).toBe(true);
    expect(deriveCanPublicReply(RiskLevel.MID)).toBe(false);
  });

  it('allows checkout operation tutorial as low risk', () => {
    const card = {
      ...baseCard,
      card_id: 'checkout-tutorial',
      title: '新增結帳單操作教學',
      patterns: ['怎麼新增結帳單', '快速結帳單在哪'],
      standard_answer: '到「結帳」→「新增結帳單」按鈕即可建立。',
      risk_level: RiskLevel.LOW,
      can_public_reply: true,
    };
    const result = validateKnowledgeCard(card);
    expect(result.valid).toBe(true);
    expect(result.normalized?.can_public_reply).toBe(true);
  });

  it('allows stored-value card setup tutorial as low risk', () => {
    const card = {
      ...baseCard,
      card_id: 'stored-value-setup',
      title: '儲值卡設定',
      patterns: ['儲值卡在哪裡設定', '如何建立儲值卡'],
      standard_answer: '到「設定」→「票券管理」中新增儲值卡。',
      not_applicable: ['儲值金額錯誤'],
      escalate_to_consultant: ['餘額異常', '扣抵異常'],
      risk_level: RiskLevel.LOW,
      can_public_reply: true,
    };
    const result = validateKnowledgeCard(card);
    expect(result.valid).toBe(true);
    expect(result.normalized?.can_public_reply).toBe(true);
  });

  it('blocks stored-value amount errors', () => {
    const result = validateKnowledgeCard({
      ...baseCard,
      card_id: 'billing-error',
      title: '儲值金額錯誤',
      patterns: ['儲值金額錯誤怎麼辦'],
      standard_answer: '請聯繫導入教練協助。',
      risk_level: RiskLevel.LOW,
      can_public_reply: true,
    });
    expect(result.valid).toBe(false);
  });

  it('blocks balance anomaly and payment/refund/reconciliation topics', () => {
    for (const title of ['餘額異常', '付款失敗', '退款問題', '對帳問題']) {
      const result = validateKnowledgeCard({
        ...baseCard,
        card_id: `sensitive-${title}`,
        title,
        patterns: [title],
        standard_answer: '請聯繫導入教練協助。',
        risk_level: RiskLevel.LOW,
        can_public_reply: true,
      });
      expect(result.valid).toBe(false);
    }
  });

  it('does not treat negation phrases as billing sensitive', () => {
    expect(
      cardContainsSensitiveContent({
        title: '新增結帳單操作教學',
        patterns: ['修改：這張知識卡主要是教店家怎麼新增結帳單的操作，並沒有真的涉及帳務問題。'],
        standard_answer: '到結帳頁按新增結帳單即可，沒有涉及帳務，只是操作教學。',
      })
    ).toHaveLength(0);
  });
});

describe('Knowledge Card Draft Service', () => {
  it('does not auto-write JSON when LLM is unavailable', async () => {
    setLlmClient(null);
    const result = await generateKnowledgeCardDraft({
      operation: 'create',
      consultantRequest: '整理知識卡：店家遇到登入不了',
    });
    expect(result.kind).toBe('single_card');
    if (result.kind === 'single_card') {
      expect(result.draftJson).toBeNull();
    }
    const text = formatDraftReply(result);
    expect(text).toContain('AI 草稿整理尚未啟用');
  });

  it('split/merge only returns suggestion text', async () => {
    const split = await generateKnowledgeCardDraft({
      operation: 'split',
      consultantRequest: '拆分登入卡',
    });
    expect(split.kind).toBe('suggestion_only');
    if (split.kind === 'suggestion_only') {
      expect(split.text).not.toMatch(/\[\s*\{/);
    }
  });

  it('validates LLM output through enforce rules', async () => {
    setLlmClient({
      async complete() {
        return JSON.stringify({
          card_id: 'bad-payment',
          title: '金流設定',
          patterns: ['金流'],
          risk_level: 'low',
          can_public_reply: true,
          standard_answer: '請設定金流',
          not_applicable: [],
          escalate_to_consultant: [],
          status: '可用',
        });
      },
    });
    const result = await generateKnowledgeCardDraft({
      operation: 'create',
      consultantRequest: '新增金流卡',
    });
    expect(result.kind).toBe('single_card');
    if (result.kind === 'single_card') {
      expect(result.validation.valid).toBe(false);
      expect(result.draftJson).toBeNull();
    }
  });
});
