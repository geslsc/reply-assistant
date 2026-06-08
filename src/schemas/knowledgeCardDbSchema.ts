import { KnowledgeCard, KnowledgeCardStatus } from './knowledgeCardSchema';
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
    created_by: record.createdBy,
    created_at: record.createdAt,
    updated_by: record.updatedBy,
    updated_at: record.updatedAt,
    confirmed_by: record.confirmedBy,
    confirmed_at: record.confirmedAt,
  };
}
