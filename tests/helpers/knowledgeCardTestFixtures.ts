import { KnowledgeCard, deriveCanPublicReply } from '../../src/schemas/knowledgeCardSchema';
import { KnowledgeCardDraftData } from '../../src/schemas/knowledgeCardDraftSchema';
import { RiskLevel } from '../../src/types';

export function withEnhancedKnowledgeFields(
  card: Partial<KnowledgeCard>
): KnowledgeCard {
  const title = card.title ?? '測試主題';
  const standardAnswer = card.standard_answer ?? '測試回覆';
  return {
    card_id: card.card_id ?? 'test-card',
    title,
    patterns: card.patterns ?? ['測試問題'],
    risk_level: card.risk_level ?? RiskLevel.LOW,
    can_public_reply: card.can_public_reply ?? deriveCanPublicReply(card.risk_level ?? RiskLevel.LOW),
    standard_answer: standardAnswer,
    not_applicable: card.not_applicable ?? [],
    escalate_to_consultant: card.escalate_to_consultant ?? [],
    status: card.status ?? '可用',
    core_question: card.core_question ?? title,
    match_features: card.match_features ?? [],
    applicability_rules: card.applicability_rules ?? [],
    exclusion_rules: card.exclusion_rules ?? [],
    reasoning: card.reasoning ?? null,
    handoff_conditions: card.handoff_conditions ?? [],
    source_consultant_input:
      card.source_consultant_input ?? {
        customer_question: card.core_question ?? title,
        consultant_reply: standardAnswer,
      },
  };
}

export function buildTestDraftData(
  overrides: Partial<KnowledgeCardDraftData> = {}
): KnowledgeCardDraftData {
  const topic = overrides.topic ?? '測試主題';
  const publicAnswer = overrides.public_answer_draft ?? '測試回覆';
  return {
    topic,
    core_question: overrides.core_question ?? topic,
    public_answer_draft: publicAnswer,
    patterns: overrides.patterns ?? ['測試問題'],
    match_features: overrides.match_features ?? [],
    applicability_rules: overrides.applicability_rules ?? [],
    exclusion_rules: overrides.exclusion_rules ?? [],
    reasoning: overrides.reasoning ?? '',
    handoff_conditions: overrides.handoff_conditions ?? [],
    risk_level: overrides.risk_level ?? RiskLevel.LOW,
    can_public_reply:
      overrides.can_public_reply ??
      deriveCanPublicReply(overrides.risk_level ?? RiskLevel.LOW),
    source_consultant_input: overrides.source_consultant_input ?? {
      customer_question: overrides.core_question ?? topic,
      consultant_reply: publicAnswer,
    },
    ...overrides,
  };
}
