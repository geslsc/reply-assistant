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
