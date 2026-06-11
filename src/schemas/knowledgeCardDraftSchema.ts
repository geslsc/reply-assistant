import { RiskLevel } from '../types';
import { KnowledgeCardStatus } from './knowledgeCardSchema';

/** 顧問原文溯源；寫入 knowledge_cards.source_consultant_input */
export interface SourceConsultantInput {
  customer_question: string;
  consultant_reply: string;
  raw_input?: string;
}

/** pending_knowledge_reviews.draft_data 結構（直接覆寫，無版本表） */
export interface KnowledgeCardDraftData {
  topic: string;
  core_question: string;
  public_answer_draft: string;
  patterns: string[];
  match_features: string[];
  applicability_rules: string[];
  exclusion_rules: string[];
  reasoning: string;
  handoff_conditions: string[];
  risk_level: RiskLevel;
  can_public_reply: boolean;
  source_consultant_input: SourceConsultantInput;
  card_id?: string;
  status?: KnowledgeCardStatus;
  title?: string;
  not_applicable?: string[];
  escalate_to_consultant?: string[];
}

export const KNOWLEDGE_CARD_DRAFT_FIELDS = [
  'topic',
  'core_question',
  'public_answer_draft',
  'patterns',
  'match_features',
  'applicability_rules',
  'exclusion_rules',
  'reasoning',
  'handoff_conditions',
  'risk_level',
  'can_public_reply',
  'source_consultant_input',
] as const;
