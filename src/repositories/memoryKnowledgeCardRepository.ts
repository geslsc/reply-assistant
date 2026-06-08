import { RiskLevel } from '../types';
import {
  DbKnowledgeCardRecord,
  DbKnowledgeCardStatus,
} from '../schemas/knowledgeCardDbSchema';
import {
  KnowledgeCardInsertParams,
  KnowledgeCardRepository,
  KnowledgeCardUpdateParams,
} from './knowledgeCardTypes';

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
  };
}

function normalizeQuery(text: string): string {
  return text.toLowerCase().replace(/\s+/g, '').trim();
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
      const q = normalizeQuery(query);
      return (await this.findAll()).filter((card) => {
        const haystack = normalizeQuery(
          [card.title, card.standardAnswer, ...card.patterns].join(' ')
        );
        return haystack.includes(q);
      });
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
  };
}
