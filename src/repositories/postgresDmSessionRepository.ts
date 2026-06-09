import { Pool, PoolClient } from 'pg';
import {
  CreateDmSessionParams,
  DmSessionDraftData,
  DmSessionRecord,
  DmSessionRepository,
} from './dmSessionTypes';
import { KnowledgeCard } from '../schemas/knowledgeCardSchema';
import { mapDmSessionRow } from './memoryDmSessionRepository';

function mapRow(row: Record<string, unknown>): DmSessionRecord {
  return mapDmSessionRow(row);
}

async function findActiveByUserIdWithClient(
  client: Pool | PoolClient,
  userId: string
): Promise<DmSessionRecord | null> {
  const result = await client.query(
    `SELECT * FROM dm_sessions WHERE user_id = $1 AND status = 'active' LIMIT 1`,
    [userId]
  );
  return result.rows[0] ? mapRow(result.rows[0]) : null;
}

export function createPostgresDmSessionRepository(pool: Pool): DmSessionRepository {
  return {
    async create(params: CreateDmSessionParams) {
      const existing = await findActiveByUserIdWithClient(pool, params.userId);
      if (existing) {
        throw new Error('ACTIVE_SESSION_EXISTS');
      }
      await pool.query(
        `INSERT INTO dm_sessions (
          session_id, user_id, session_type, status, draft_data, created_at, updated_at
        ) VALUES ($1, $2, $3, 'active', $4::jsonb, $5, $6)`,
        [
          params.sessionId,
          params.userId,
          params.sessionType,
          params.draftData ? JSON.stringify(params.draftData) : null,
          params.createdAt,
          params.updatedAt,
        ]
      );
      const result = await pool.query('SELECT * FROM dm_sessions WHERE session_id = $1', [
        params.sessionId,
      ]);
      return mapRow(result.rows[0]);
    },

    async findById(sessionId) {
      const result = await pool.query('SELECT * FROM dm_sessions WHERE session_id = $1', [sessionId]);
      return result.rows[0] ? mapRow(result.rows[0]) : null;
    },

    async findActiveByUserId(userId) {
      return findActiveByUserIdWithClient(pool, userId);
    },

    async updateDraftData(sessionId, draftData, updatedAt) {
      const result = await pool.query(
        `UPDATE dm_sessions
         SET draft_data = $2::jsonb, updated_at = $3
         WHERE session_id = $1 AND status = 'active'
         RETURNING *`,
        [sessionId, draftData ? JSON.stringify(draftData) : null, updatedAt]
      );
      return result.rows[0] ? mapRow(result.rows[0]) : null;
    },

    async markSubmitted(sessionId, updatedAt) {
      const result = await pool.query(
        `UPDATE dm_sessions SET status = 'submitted', updated_at = $2 WHERE session_id = $1 RETURNING *`,
        [sessionId, updatedAt]
      );
      return result.rows[0] ? mapRow(result.rows[0]) : null;
    },

    async markCompleted(sessionId, updatedAt) {
      const result = await pool.query(
        `UPDATE dm_sessions SET status = 'completed', updated_at = $2 WHERE session_id = $1 RETURNING *`,
        [sessionId, updatedAt]
      );
      return result.rows[0] ? mapRow(result.rows[0]) : null;
    },

    async markCancelled(sessionId, updatedAt) {
      const result = await pool.query(
        `UPDATE dm_sessions SET status = 'cancelled', updated_at = $2 WHERE session_id = $1 RETURNING *`,
        [sessionId, updatedAt]
      );
      return result.rows[0] ? mapRow(result.rows[0]) : null;
    },

    async cancelAllActiveForUser(userId, updatedAt) {
      const result = await pool.query(
        `UPDATE dm_sessions SET status = 'cancelled', updated_at = $2
         WHERE user_id = $1 AND status = 'active'`,
        [userId, updatedAt]
      );
      return result.rowCount ?? 0;
    },

    async markExpired(sessionId, updatedAt, expiredAt) {
      const result = await pool.query(
        `UPDATE dm_sessions
         SET status = 'expired', updated_at = $2, expired_at = $3
         WHERE session_id = $1 RETURNING *`,
        [sessionId, updatedAt, expiredAt]
      );
      return result.rows[0] ? mapRow(result.rows[0]) : null;
    },

    async submitDraftAtomically(params) {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        const active = await findActiveByUserIdWithClient(client, params.userId);
        if (!active) {
          throw new Error('NO_ACTIVE_SESSION');
        }
        await client.query(
          `INSERT INTO pending_knowledge_reviews (
            review_id, card_data, submitted_by, submitted_at, status
          ) VALUES ($1, $2::jsonb, $3, $4, 'pending')`,
          [
            params.reviewId,
            JSON.stringify(params.cardData),
            params.userId,
            params.submittedAt,
          ]
        );
        const updated = await client.query(
          `UPDATE dm_sessions SET status = 'submitted', updated_at = $2 WHERE session_id = $1 RETURNING *`,
          [active.sessionId, params.submittedAt]
        );
        await client.query('COMMIT');
        return { session: mapRow(updated.rows[0]), reviewId: params.reviewId };
      } catch (error) {
        await client.query('ROLLBACK');
        throw error;
      } finally {
        client.release();
      }
    },

    async clear() {
      await pool.query('DELETE FROM dm_sessions');
    },
  };
}
