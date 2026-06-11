import { RiskLevel } from '../types';
import {
  DbKnowledgeCardRecord,
  DbKnowledgeCardStatus,
  mapDbRowToRecord,
} from '../schemas/knowledgeCardDbSchema';
import {
  KnowledgeCardInsertParams,
  KnowledgeCardRepository,
  KnowledgeCardUpdateParams,
} from './knowledgeCardTypes';
import { knowledgeCardMatchesQuery } from '../utils/knowledgeCardSearchMatch';

function rowFromParams(params: KnowledgeCardInsertParams): DbKnowledgeCardRecord {
  return {
    cardId: params.cardId,
    title: params.title,
    patterns: params.patterns,
    riskLevel: params.riskLevel,
    canPublicReply: params.canPublicReply,
    standardAnswer: params.standardAnswer,
    notApplicable: params.notApplicable,
    escalateToConsultant: params.escalateToConsultant,
    status: params.status,
    createdBy: params.createdBy,
    createdAt: params.createdAt,
    updatedBy: params.updatedBy ?? null,
    updatedAt: params.updatedAt ?? null,
    confirmedBy: params.confirmedBy,
    confirmedAt: params.confirmedAt,
    coreQuestion: params.coreQuestion ?? null,
    matchFeatures: params.matchFeatures ?? null,
    applicabilityRules: params.applicabilityRules ?? null,
    exclusionRules: params.exclusionRules ?? null,
    reasoning: params.reasoning ?? null,
    handoffConditions: params.handoffConditions ?? null,
    sourceConsultantInput: params.sourceConsultantInput ?? null,
  };
}

export function createMemoryKnowledgeCardRepository(): KnowledgeCardRepository {
  const cards = new Map<string, DbKnowledgeCardRecord>();

  return {
    async findAll() {
      return Array.from(cards.values()).map((c) => ({ ...c, patterns: [...c.patterns] }));
    },
    async findById(cardId) {
      const card = cards.get(cardId);
      return card ? { ...card, patterns: [...card.patterns] } : null;
    },
    async findByStatus(status) {
      return (await this.findAll()).filter((c) => c.status === status);
    },
    async findByRiskLevel(riskLevel) {
      return (await this.findAll()).filter((c) => c.riskLevel === riskLevel);
    },
    async search(query) {
      return (await this.findAll()).filter((card) => knowledgeCardMatchesQuery(card, query));
    },
    async insert(params) {
      const record = rowFromParams(params);
      cards.set(record.cardId, record);
      return { ...record, patterns: [...record.patterns] };
    },
    async update(cardId, params) {
      const existing = cards.get(cardId);
      if (!existing) {
        return null;
      }
      const updated: DbKnowledgeCardRecord = {
        ...existing,
        title: params.title,
        patterns: params.patterns,
        riskLevel: params.riskLevel,
        canPublicReply: params.canPublicReply,
        standardAnswer: params.standardAnswer,
        notApplicable: params.notApplicable,
        escalateToConsultant: params.escalateToConsultant,
        status: params.status,
        updatedBy: params.updatedBy,
        updatedAt: params.updatedAt,
        confirmedBy: params.confirmedBy,
        confirmedAt: params.confirmedAt,
        coreQuestion: params.coreQuestion ?? null,
        matchFeatures: params.matchFeatures ?? null,
        applicabilityRules: params.applicabilityRules ?? null,
        exclusionRules: params.exclusionRules ?? null,
        reasoning: params.reasoning ?? null,
        handoffConditions: params.handoffConditions ?? null,
        sourceConsultantInput: params.sourceConsultantInput ?? null,
      };
      cards.set(cardId, updated);
      return { ...updated, patterns: [...updated.patterns] };
    },
    async setStatus(cardId, status, audit) {
      const existing = cards.get(cardId);
      if (!existing) {
        return null;
      }
      const updated: DbKnowledgeCardRecord = {
        ...existing,
        status,
        updatedBy: audit.updatedBy,
        updatedAt: audit.confirmedAt,
        confirmedBy: audit.confirmedBy,
        confirmedAt: audit.confirmedAt,
      };
      cards.set(cardId, updated);
      return { ...updated, patterns: [...updated.patterns] };
    },
    async count() {
      return cards.size;
    },
    async clear() {
      cards.clear();
    },
  };
}

export function mapPgRowToRecord(row: Record<string, unknown>): DbKnowledgeCardRecord {
  return mapDbRowToRecord(row);
}
