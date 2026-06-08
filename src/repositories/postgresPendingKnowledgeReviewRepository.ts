import { Pool } from 'pg';
import {
  InsertPendingKnowledgeReviewParams,
  PendingKnowledgeReviewRepository,
  PendingKnowledgeReviewStatus,
} from './pendingKnowledgeReviewTypes';
import { mapPendingKnowledgeReviewRow } from './memoryPendingKnowledgeReviewRepository';

export function createPostgresPendingKnowledgeReviewRepository(
  pool: Pool
): PendingKnowledgeReviewRepository {
  return {
    async insert(params: InsertPendingKnowledgeReviewParams) {
      await pool.query(
        `INSERT INTO pending_knowledge_reviews (
          review_id, card_data, submitted_by, submitted_at, status
        ) VALUES ($1, $2::jsonb, $3, $4, 'pending')`,
        [params.reviewId, JSON.stringify(params.cardData), params.submittedBy, params.submittedAt]
      );
      const result = await pool.query('SELECT * FROM pending_knowledge_reviews WHERE review_id = $1', [
        params.reviewId,
      ]);
      return mapPendingKnowledgeReviewRow(result.rows[0]);
    },

    async findById(reviewId) {
      const result = await pool.query('SELECT * FROM pending_knowledge_reviews WHERE review_id = $1', [
        reviewId,
      ]);
      return result.rows[0] ? mapPendingKnowledgeReviewRow(result.rows[0]) : null;
    },

    async findByStatus(status: PendingKnowledgeReviewStatus) {
      const result = await pool.query(
        `SELECT * FROM pending_knowledge_reviews WHERE status = $1 ORDER BY submitted_at ASC`,
        [status]
      );
      return result.rows.map(mapPendingKnowledgeReviewRow);
    },

    async listPending() {
      return this.findByStatus('pending');
    },

    async findByBotMessageId(botMessageId) {
      const result = await pool.query(
        `SELECT * FROM pending_knowledge_reviews WHERE bot_message_id = $1 LIMIT 1`,
        [botMessageId]
      );
      return result.rows[0] ? mapPendingKnowledgeReviewRow(result.rows[0]) : null;
    },

    async updateBotMessageId(reviewId, botMessageId) {
      await pool.query(
        `UPDATE pending_knowledge_reviews SET bot_message_id = $2 WHERE review_id = $1`,
        [reviewId, botMessageId]
      );
    },

    async updateAdminResponse(reviewId, adminResponse) {
      await pool.query(
        `UPDATE pending_knowledge_reviews SET admin_response = $2 WHERE review_id = $1`,
        [reviewId, adminResponse]
      );
    },

    async markApproved(reviewId, resolvedBy, resolvedAt) {
      await pool.query(
        `UPDATE pending_knowledge_reviews
         SET status = 'approved', resolved_by = $2, resolved_at = $3
         WHERE review_id = $1`,
        [reviewId, resolvedBy, resolvedAt]
      );
    },

    async markRejected(reviewId, resolvedBy, resolvedAt, adminResponse = null) {
      await pool.query(
        `UPDATE pending_knowledge_reviews
         SET status = 'rejected', resolved_by = $2, resolved_at = $3, admin_response = $4
         WHERE review_id = $1`,
        [reviewId, resolvedBy, resolvedAt, adminResponse]
      );
    },

    async clear() {
      await pool.query('DELETE FROM pending_knowledge_reviews');
    },
  };
}
