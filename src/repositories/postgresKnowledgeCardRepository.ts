import { Pool } from 'pg';
import { RiskLevel } from '../types';
import {
  KnowledgeCardInsertParams,
  KnowledgeCardRepository,
  KnowledgeCardUpdateParams,
} from './knowledgeCardTypes';
import { mapPgRowToRecord } from './memoryKnowledgeCardRepository';
import { DbKnowledgeCardStatus } from '../schemas/knowledgeCardDbSchema';

export function createPostgresKnowledgeCardRepository(pool: Pool): KnowledgeCardRepository {
  return {
    async findAll() {
      const result = await pool.query('SELECT * FROM knowledge_cards ORDER BY card_id');
      return result.rows.map(mapPgRowToRecord);
    },
    async findById(cardId) {
      const result = await pool.query('SELECT * FROM knowledge_cards WHERE card_id = $1', [
        cardId,
      ]);
      return result.rows[0] ? mapPgRowToRecord(result.rows[0]) : null;
    },
    async findByStatus(status) {
      const result = await pool.query('SELECT * FROM knowledge_cards WHERE status = $1 ORDER BY card_id', [
        status,
      ]);
      return result.rows.map(mapPgRowToRecord);
    },
    async findByRiskLevel(riskLevel) {
      const result = await pool.query(
        'SELECT * FROM knowledge_cards WHERE risk_level = $1 ORDER BY card_id',
        [riskLevel]
      );
      return result.rows.map(mapPgRowToRecord);
    },
    async search(query) {
      const pattern = `%${query.replace(/\s+/g, '%')}%`;
      const result = await pool.query(
        `SELECT * FROM knowledge_cards
         WHERE title ILIKE $1
            OR standard_answer ILIKE $1
            OR EXISTS (SELECT 1 FROM unnest(patterns) p WHERE p ILIKE $1)
            OR EXISTS (SELECT 1 FROM unnest(not_applicable) p WHERE p ILIKE $1)
            OR EXISTS (SELECT 1 FROM unnest(escalate_to_consultant) p WHERE p ILIKE $1)
         ORDER BY card_id`,
        [pattern]
      );
      return result.rows.map(mapPgRowToRecord);
    },
    async insert(params: KnowledgeCardInsertParams) {
      const result = await pool.query(
        `INSERT INTO knowledge_cards (
          card_id, title, patterns, risk_level, can_public_reply, standard_answer,
          not_applicable, escalate_to_consultant, status,
          created_by, created_at, updated_by, updated_at, confirmed_by, confirmed_at,
          core_question, match_features, applicability_rules, exclusion_rules,
          reasoning, handoff_conditions, source_consultant_input
        ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22)
        RETURNING *`,
        [
          params.cardId,
          params.title,
          params.patterns,
          params.riskLevel,
          params.canPublicReply,
          params.standardAnswer,
          params.notApplicable,
          params.escalateToConsultant,
          params.status,
          params.createdBy,
          params.createdAt,
          params.updatedBy ?? null,
          params.updatedAt ?? null,
          params.confirmedBy,
          params.confirmedAt,
          params.coreQuestion ?? null,
          params.matchFeatures ? JSON.stringify(params.matchFeatures) : null,
          params.applicabilityRules ? JSON.stringify(params.applicabilityRules) : null,
          params.exclusionRules ? JSON.stringify(params.exclusionRules) : null,
          params.reasoning ?? null,
          params.handoffConditions ? JSON.stringify(params.handoffConditions) : null,
          params.sourceConsultantInput ? JSON.stringify(params.sourceConsultantInput) : null,
        ]
      );
      return mapPgRowToRecord(result.rows[0]);
    },
    async update(cardId, params: KnowledgeCardUpdateParams) {
      const result = await pool.query(
        `UPDATE knowledge_cards SET
          title = $2,
          patterns = $3,
          risk_level = $4,
          can_public_reply = $5,
          standard_answer = $6,
          not_applicable = $7,
          escalate_to_consultant = $8,
          status = $9,
          updated_by = $10,
          updated_at = $11,
          confirmed_by = $12,
          confirmed_at = $13,
          core_question = $14,
          match_features = $15,
          applicability_rules = $16,
          exclusion_rules = $17,
          reasoning = $18,
          handoff_conditions = $19,
          source_consultant_input = $20
         WHERE card_id = $1
         RETURNING *`,
        [
          cardId,
          params.title,
          params.patterns,
          params.riskLevel,
          params.canPublicReply,
          params.standardAnswer,
          params.notApplicable,
          params.escalateToConsultant,
          params.status,
          params.updatedBy,
          params.updatedAt,
          params.confirmedBy,
          params.confirmedAt,
          params.coreQuestion ?? null,
          params.matchFeatures ? JSON.stringify(params.matchFeatures) : null,
          params.applicabilityRules ? JSON.stringify(params.applicabilityRules) : null,
          params.exclusionRules ? JSON.stringify(params.exclusionRules) : null,
          params.reasoning ?? null,
          params.handoffConditions ? JSON.stringify(params.handoffConditions) : null,
          params.sourceConsultantInput ? JSON.stringify(params.sourceConsultantInput) : null,
        ]
      );
      return result.rows[0] ? mapPgRowToRecord(result.rows[0]) : null;
    },
    async setStatus(cardId, status: DbKnowledgeCardStatus, audit) {
      const result = await pool.query(
        `UPDATE knowledge_cards SET
          status = $2,
          updated_by = $3,
          updated_at = $4,
          confirmed_by = $5,
          confirmed_at = $6
         WHERE card_id = $1
         RETURNING *`,
        [cardId, status, audit.updatedBy, audit.confirmedAt, audit.confirmedBy, audit.confirmedAt]
      );
      return result.rows[0] ? mapPgRowToRecord(result.rows[0]) : null;
    },
    async count() {
      const result = await pool.query('SELECT COUNT(*)::int AS count FROM knowledge_cards');
      return Number(result.rows[0].count);
    },
    async clear() {
      await pool.query('DELETE FROM knowledge_cards');
    },
  };
}
