import { Pool } from 'pg';
import { v4 as uuidv4 } from 'uuid';
import {
  CreatePendingHandoffParams,
  PendingHandoff,
  PendingHandoffInvalidReason,
  PendingHandoffRepository,
  PendingHandoffStatus,
} from './pendingHandoffTypes';

function mapPendingHandoffRow(row: Record<string, unknown>): PendingHandoff {
  return {
    id: String(row.id),
    consultantId: String(row.consultant_id),
    issueThreadId: String(row.issue_thread_id),
    groupId: String(row.group_id),
    shortCode: String(row.short_code),
    status: row.status as PendingHandoffStatus,
    invalidReason: (row.invalid_reason as PendingHandoffInvalidReason | null) ?? null,
    customerQuestion: row.customer_question ? String(row.customer_question) : null,
    createdAt: new Date(row.created_at as string | Date).toISOString(),
    updatedAt: new Date(row.updated_at as string | Date).toISOString(),
    closedAt: row.closed_at ? new Date(row.closed_at as string | Date).toISOString() : null,
  };
}

export function createPostgresPendingHandoffRepository(pool: Pool): PendingHandoffRepository {
  return {
    async create(params: CreatePendingHandoffParams) {
      const id = uuidv4();
      const now = new Date().toISOString();
      await pool.query(
        `INSERT INTO pending_handoffs (
          id, consultant_id, issue_thread_id, group_id, short_code,
          status, customer_question, created_at, updated_at
        ) VALUES ($1, $2, $3, $4, $5, 'open', $6, $7, $7)`,
        [
          id,
          params.consultantId,
          params.issueThreadId,
          params.groupId,
          params.shortCode,
          params.customerQuestion,
          now,
        ]
      );
      const result = await pool.query('SELECT * FROM pending_handoffs WHERE id = $1', [id]);
      return mapPendingHandoffRow(result.rows[0]);
    },

    async findOpenByConsultant(consultantId) {
      const result = await pool.query(
        `SELECT * FROM pending_handoffs
         WHERE consultant_id = $1 AND status = 'open'
         ORDER BY created_at DESC`,
        [consultantId]
      );
      return result.rows.map(mapPendingHandoffRow);
    },

    async findOpenByConsultantAndShortCode(consultantId, shortCode) {
      const result = await pool.query(
        `SELECT * FROM pending_handoffs
         WHERE consultant_id = $1 AND short_code = $2 AND status = 'open'
         LIMIT 1`,
        [consultantId, shortCode]
      );
      return result.rows[0] ? mapPendingHandoffRow(result.rows[0]) : null;
    },

    async findByConsultant(consultantId) {
      const result = await pool.query(
        `SELECT * FROM pending_handoffs
         WHERE consultant_id = $1
         ORDER BY created_at DESC`,
        [consultantId]
      );
      return result.rows.map(mapPendingHandoffRow);
    },

    async markClosed(id) {
      const now = new Date().toISOString();
      await pool.query(
        `UPDATE pending_handoffs
         SET status = 'closed', updated_at = $2, closed_at = $2
         WHERE id = $1`,
        [id, now]
      );
      const result = await pool.query('SELECT * FROM pending_handoffs WHERE id = $1', [id]);
      return result.rows[0] ? mapPendingHandoffRow(result.rows[0]) : null;
    },

    async markInvalid(id, reason) {
      const now = new Date().toISOString();
      await pool.query(
        `UPDATE pending_handoffs
         SET status = 'invalid', invalid_reason = $2, updated_at = $3
         WHERE id = $1`,
        [id, reason, now]
      );
      const result = await pool.query('SELECT * FROM pending_handoffs WHERE id = $1', [id]);
      return result.rows[0] ? mapPendingHandoffRow(result.rows[0]) : null;
    },

    async markInvalidByGroup(groupId, reason) {
      const now = new Date().toISOString();
      const result = await pool.query(
        `UPDATE pending_handoffs
         SET status = 'invalid', invalid_reason = $2, updated_at = $3
         WHERE group_id = $1 AND status = 'open'`,
        [groupId, reason, now]
      );
      return result.rowCount ?? 0;
    },

    async markInvalidByThread(groupId, issueThreadId, reason) {
      const now = new Date().toISOString();
      const result = await pool.query(
        `UPDATE pending_handoffs
         SET status = 'invalid', invalid_reason = $2, updated_at = $3
         WHERE group_id = $1 AND issue_thread_id = $4 AND status = 'open'`,
        [groupId, reason, now, issueThreadId]
      );
      return result.rowCount ?? 0;
    },

    async clear() {
      await pool.query('DELETE FROM pending_handoffs');
    },
  };
}
