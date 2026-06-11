import { KnowledgeCard, KnowledgeCardStatus } from './knowledgeCardSchema';
import { SourceConsultantInput } from './knowledgeCardDraftSchema';
import { RiskLevel } from '../types';

export type DbKnowledgeCardStatus = 'active' | 'paused';

export interface DbKnowledgeCardRecord {
  cardId: string;
  title: string;
  patterns: string[];
  riskLevel: RiskLevel;
  canPublicReply: boolean;
  standardAnswer: string;
  notApplicable: string[];
  escalateToConsultant: string[];
  status: DbKnowledgeCardStatus;
  createdBy: string;
  createdAt: string;
  updatedBy: string | null;
  updatedAt: string | null;
  confirmedBy: string;
  confirmedAt: string;
  coreQuestion: string | null;
  matchFeatures: string[] | null;
  applicabilityRules: string[] | null;
  exclusionRules: string[] | null;
  reasoning: string | null;
  handoffConditions: string[] | null;
  sourceConsultantInput: SourceConsultantInput | null;
}

export const TRACKING_FIELDS = [
  'created_by',
  'created_at',
  'updated_by',
  'updated_at',
  'confirmed_by',
  'confirmed_at',
] as const;

export function appStatusToDb(status: KnowledgeCardStatus): DbKnowledgeCardStatus {
  return status === '可用' ? 'active' : 'paused';
}

export function dbStatusToApp(status: DbKnowledgeCardStatus): KnowledgeCardStatus {
  return status === 'active' ? '可用' : '暫停';
}

function parseStringArray(value: unknown): string[] | null {
  if (value === null || value === undefined) {
    return null;
  }
  if (Array.isArray(value)) {
    return value.filter((item): item is string => typeof item === 'string');
  }
  return null;
}

function parseSourceInput(value: unknown): SourceConsultantInput | null {
  if (!value || typeof value !== 'object') {
    return null;
  }
  const obj = value as Record<string, unknown>;
  if (typeof obj.customer_question !== 'string' || typeof obj.consultant_reply !== 'string') {
    return null;
  }
  return {
    customer_question: obj.customer_question,
    consultant_reply: obj.consultant_reply,
    raw_input: typeof obj.raw_input === 'string' ? obj.raw_input : undefined,
  };
}

export function dbRecordToKnowledgeCard(record: DbKnowledgeCardRecord): KnowledgeCard {
  return {
    card_id: record.cardId,
    title: record.title,
    patterns: record.patterns,
    risk_level: record.riskLevel,
    can_public_reply: record.canPublicReply,
    standard_answer: record.standardAnswer,
    not_applicable: record.notApplicable,
    escalate_to_consultant: record.escalateToConsultant,
    status: dbStatusToApp(record.status),
    core_question: record.coreQuestion,
    match_features: record.matchFeatures,
    applicability_rules: record.applicabilityRules,
    exclusion_rules: record.exclusionRules,
    reasoning: record.reasoning,
    handoff_conditions: record.handoffConditions,
    source_consultant_input: record.sourceConsultantInput,
  };
}

export function knowledgeCardToDbFields(
  card: KnowledgeCard
): Pick<
  DbKnowledgeCardRecord,
  | 'cardId'
  | 'title'
  | 'patterns'
  | 'riskLevel'
  | 'canPublicReply'
  | 'standardAnswer'
  | 'notApplicable'
  | 'escalateToConsultant'
  | 'status'
  | 'coreQuestion'
  | 'matchFeatures'
  | 'applicabilityRules'
  | 'exclusionRules'
  | 'reasoning'
  | 'handoffConditions'
  | 'sourceConsultantInput'
> {
  return {
    cardId: card.card_id,
    title: card.title,
    patterns: card.patterns,
    riskLevel: card.risk_level,
    canPublicReply: card.can_public_reply,
    standardAnswer: card.standard_answer,
    notApplicable: card.not_applicable,
    escalateToConsultant: card.escalate_to_consultant,
    status: appStatusToDb(card.status),
    coreQuestion: card.core_question ?? null,
    matchFeatures: card.match_features ?? null,
    applicabilityRules: card.applicability_rules ?? null,
    exclusionRules: card.exclusion_rules ?? null,
    reasoning: card.reasoning ?? null,
    handoffConditions: card.handoff_conditions ?? null,
    sourceConsultantInput: card.source_consultant_input ?? null,
  };
}

export function mapDbRowToRecord(row: Record<string, unknown>): DbKnowledgeCardRecord {
  return {
    cardId: String(row.card_id),
    title: String(row.title),
    patterns: (row.patterns as string[]) ?? [],
    riskLevel: row.risk_level as RiskLevel,
    canPublicReply: Boolean(row.can_public_reply),
    standardAnswer: String(row.standard_answer),
    notApplicable: (row.not_applicable as string[]) ?? [],
    escalateToConsultant: (row.escalate_to_consultant as string[]) ?? [],
    status: row.status as DbKnowledgeCardStatus,
    createdBy: String(row.created_by),
    createdAt: new Date(row.created_at as string | Date).toISOString(),
    updatedBy: row.updated_by ? String(row.updated_by) : null,
    updatedAt: row.updated_at ? new Date(row.updated_at as string | Date).toISOString() : null,
    confirmedBy: String(row.confirmed_by),
    confirmedAt: new Date(row.confirmed_at as string | Date).toISOString(),
    coreQuestion: row.core_question ? String(row.core_question) : null,
    matchFeatures: parseStringArray(row.match_features),
    applicabilityRules: parseStringArray(row.applicability_rules),
    exclusionRules: parseStringArray(row.exclusion_rules),
    reasoning: row.reasoning ? String(row.reasoning) : null,
    handoffConditions: parseStringArray(row.handoff_conditions),
    sourceConsultantInput: parseSourceInput(row.source_consultant_input),
  };
}

export function dbRecordToExportJson(record: DbKnowledgeCardRecord): Record<string, unknown> {
  return {
    card_id: record.cardId,
    title: record.title,
    patterns: record.patterns,
    risk_level: record.riskLevel,
    can_public_reply: record.canPublicReply,
    standard_answer: record.standardAnswer,
    not_applicable: record.notApplicable,
    escalate_to_consultant: record.escalateToConsultant,
    status: record.status,
    core_question: record.coreQuestion,
    match_features: record.matchFeatures,
    applicability_rules: record.applicabilityRules,
    exclusion_rules: record.exclusionRules,
    reasoning: record.reasoning,
    handoff_conditions: record.handoffConditions,
    source_consultant_input: record.sourceConsultantInput,
    created_by: record.createdBy,
    created_at: record.createdAt,
    updated_by: record.updatedBy,
    updated_at: record.updatedAt,
    confirmed_by: record.confirmedBy,
    confirmed_at: record.confirmedAt,
  };
}
