import { RiskLevel } from '../types';
import { DbKnowledgeCardRecord, DbKnowledgeCardStatus } from '../schemas/knowledgeCardDbSchema';
import { SourceConsultantInput } from '../schemas/knowledgeCardDraftSchema';

export interface KnowledgeCardEnhancedFields {
  coreQuestion?: string | null;
  matchFeatures?: string[] | null;
  applicabilityRules?: string[] | null;
  exclusionRules?: string[] | null;
  reasoning?: string | null;
  handoffConditions?: string[] | null;
  sourceConsultantInput?: SourceConsultantInput | null;
}

export interface KnowledgeCardInsertParams extends KnowledgeCardEnhancedFields {
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
  updatedBy?: string | null;
  updatedAt?: string | null;
  confirmedBy: string;
  confirmedAt: string;
}

export interface KnowledgeCardUpdateParams extends KnowledgeCardEnhancedFields {
  title: string;
  patterns: string[];
  riskLevel: RiskLevel;
  canPublicReply: boolean;
  standardAnswer: string;
  notApplicable: string[];
  escalateToConsultant: string[];
  status: DbKnowledgeCardStatus;
  updatedBy: string;
  updatedAt: string;
  confirmedBy: string;
  confirmedAt: string;
}

export interface KnowledgeCardRepository {
  findAll(): Promise<DbKnowledgeCardRecord[]>;
  findById(cardId: string): Promise<DbKnowledgeCardRecord | null>;
  findByStatus(status: DbKnowledgeCardStatus): Promise<DbKnowledgeCardRecord[]>;
  findByRiskLevel(riskLevel: RiskLevel): Promise<DbKnowledgeCardRecord[]>;
  search(query: string): Promise<DbKnowledgeCardRecord[]>;
  insert(params: KnowledgeCardInsertParams): Promise<DbKnowledgeCardRecord>;
  update(cardId: string, params: KnowledgeCardUpdateParams): Promise<DbKnowledgeCardRecord | null>;
  setStatus(
    cardId: string,
    status: DbKnowledgeCardStatus,
    audit: { updatedBy: string; confirmedBy: string; confirmedAt: string }
  ): Promise<DbKnowledgeCardRecord | null>;
  count(): Promise<number>;
  clear(): Promise<void>;
}
