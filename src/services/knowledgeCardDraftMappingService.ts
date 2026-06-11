import { KnowledgeCard } from '../schemas/knowledgeCardSchema';
import {
  KnowledgeCardDraftData,
  SourceConsultantInput,
} from '../schemas/knowledgeCardDraftSchema';
import { RiskLevel } from '../types';
import { PENDING_CARD_ID } from './knowledgeCardIdService';

export function sourceConsultantInputToText(source: SourceConsultantInput | null | undefined): string {
  if (!source) {
    return '';
  }
  return [source.customer_question, source.consultant_reply, source.raw_input]
    .filter(Boolean)
    .join('\n');
}

export function draftDataToKnowledgeCard(draft: KnowledgeCardDraftData): KnowledgeCard {
  return {
    card_id: draft.card_id ?? PENDING_CARD_ID,
    title: draft.topic || draft.title || draft.core_question,
    patterns: draft.patterns,
    risk_level: draft.risk_level,
    can_public_reply: draft.can_public_reply,
    standard_answer: draft.public_answer_draft,
    not_applicable: draft.not_applicable ?? draft.exclusion_rules ?? [],
    escalate_to_consultant: draft.escalate_to_consultant ?? draft.handoff_conditions ?? [],
    status: draft.status ?? '可用',
    core_question: draft.core_question,
    match_features: draft.match_features ?? [],
    applicability_rules: draft.applicability_rules ?? [],
    exclusion_rules: draft.exclusion_rules ?? [],
    reasoning: draft.reasoning ?? null,
    handoff_conditions: draft.handoff_conditions ?? [],
    source_consultant_input: draft.source_consultant_input,
  };
}

export function knowledgeCardToDraftData(
  card: KnowledgeCard,
  source?: SourceConsultantInput | null
): KnowledgeCardDraftData {
  const resolvedSource =
    source ??
    card.source_consultant_input ?? {
      customer_question: card.core_question ?? card.title,
      consultant_reply: card.standard_answer,
    };

  return {
    topic: card.title,
    core_question: card.core_question ?? card.title,
    public_answer_draft: card.standard_answer,
    patterns: card.patterns,
    match_features: card.match_features ?? [],
    applicability_rules: card.applicability_rules ?? [],
    exclusion_rules: card.exclusion_rules ?? card.not_applicable ?? [],
    reasoning: card.reasoning ?? '',
    handoff_conditions: card.handoff_conditions ?? card.escalate_to_consultant ?? [],
    risk_level: card.risk_level,
    can_public_reply: card.can_public_reply,
    source_consultant_input: resolvedSource,
    card_id: card.card_id,
    status: card.status,
    title: card.title,
    not_applicable: card.not_applicable,
    escalate_to_consultant: card.escalate_to_consultant,
  };
}

export function buildDraftDataFromConsultantInput(params: {
  customerQuestion: string;
  consultantReply: string;
  rawInput: string;
  card?: KnowledgeCard | null;
}): KnowledgeCardDraftData {
  const source: SourceConsultantInput = {
    customer_question: params.customerQuestion.trim(),
    consultant_reply: params.consultantReply.trim(),
    raw_input: params.rawInput.trim(),
  };

  if (params.card) {
    return knowledgeCardToDraftData(params.card, source);
  }

  return {
    topic: params.customerQuestion.trim(),
    core_question: params.customerQuestion.trim(),
    public_answer_draft: params.consultantReply.trim(),
    patterns: [params.customerQuestion.trim()],
    match_features: [],
    applicability_rules: [],
    exclusion_rules: [],
    reasoning: '',
    handoff_conditions: [],
    risk_level: RiskLevel.UNKNOWN,
    can_public_reply: false,
    source_consultant_input: source,
    card_id: PENDING_CARD_ID,
    status: '可用',
  };
}
