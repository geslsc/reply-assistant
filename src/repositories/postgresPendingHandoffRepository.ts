import { Pool } from 'pg';
import { v4 as uuidv4 } from 'uuid';
import {
  ACTIONABLE_HANDOFF_STATUSES,
  CreatePendingHandoffParams,
  PendingHandoff,
  PendingHandoffInvalidReason,
  PendingHandoffRepository,
  PendingHandoffStatus,
  UpdateHandoffStatusParams,
} from './pendingHandoffTypes';

const ACTIONABLE_STATUS_SQL = ACTIONABLE_HANDOFF_STATUSES.map((s) => `'${s}'`).join(', ');

function mapPendingHandoffRow(row: Record<string, unknown>): PendingHandoff {
  return {
    id: String(row.id),
    consultantId: String(row.consultant_id),
    issueThreadId: String(row.issue_thread_id),
    groupId: String(row.group_id),
    shortCode: String(row.short_code),
    status: row.status as PendingHandoffStatus,
    statusUpdatedBy: row.status_updated_by ? String(row.status_updated_by) : null,
    statusUpdatedAt: row.status_updated_at
      ? new Date(row.status_updated_at as string | Date).toISOString()
      : null,
    reason: row.reason ? String(row.reason) : null,
    customerQuestion: row.customer_question ? String(row.customer_question) : null,
    snoozed: Boolean(row.snoozed),
    acknowledgedAt: row.acknowledged_at
      ? new Date(row.acknowledged_at as string | Date).toISOString()
      : null,
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
          status, customer_question, created_at, updated_at,
          status_updated_by, status_updated_at
        ) VALUES ($1, $2, $3, $4, $5, 'pending', $6, $7, $7, 'system', $7)`,
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

    async findActionableByConsultant(consultantId) {
      const result = await pool.query(
        `SELECT * FROM pending_handoffs
         WHERE consultant_id = $1 AND status IN (${ACTIONABLE_STATUS_SQL})
         ORDER BY created_at DESC`,
        [consultantId]
      );
      return result.rows.map(mapPendingHandoffRow);
    },

    async findOpenByConsultant(consultantId) {
      return this.findActionableByConsultant(consultantId);
    },

    async findActionableByConsultantAndShortCode(consultantId, shortCode) {
      const result = await pool.query(
        `SELECT * FROM pending_handoffs
         WHERE consultant_id = $1 AND short_code = $2 AND status IN (${ACTIONABLE_STATUS_SQL})
         LIMIT 1`,
        [consultantId, shortCode]
      );
      return result.rows[0] ? mapPendingHandoffRow(result.rows[0]) : null;
    },

    async findOpenByConsultantAndShortCode(consultantId, shortCode) {
      return this.findActionableByConsultantAndShortCode(consultantId, shortCode);
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

    async findById(id) {
      const result = await pool.query('SELECT * FROM pending_handoffs WHERE id = $1', [id]);
      return result.rows[0] ? mapPendingHandoffRow(result.rows[0]) : null;
    },

    async findActionableByGroup(groupId) {
      const result = await pool.query(
        `SELECT * FROM pending_handoffs
         WHERE group_id = $1 AND status IN (${ACTIONABLE_STATUS_SQL})
         ORDER BY created_at DESC`,
        [groupId]
      );
      return result.rows.map(mapPendingHandoffRow);
    },

    async findActionableByThread(groupId, issueThreadId) {
      const result = await pool.query(
        `SELECT * FROM pending_handoffs
         WHERE group_id = $1 AND issue_thread_id = $2 AND status IN (${ACTIONABLE_STATUS_SQL})
         ORDER BY created_at DESC`,
        [groupId, issueThreadId]
      );
      return result.rows.map(mapPendingHandoffRow);
    },

    async updateStatus(params: UpdateHandoffStatusParams) {
      const now = new Date().toISOString();
      const reason =
        params.status === PendingHandoffStatus.IGNORED ? (params.reason ?? null) : null;
      const closedAt = params.status === PendingHandoffStatus.RESOLVED ? now : null;
      await pool.query(
        `UPDATE pending_handoffs
         SET status = $2, status_updated_by = $3, status_updated_at = $4,
             reason = $5, updated_at = $4, closed_at = COALESCE($6, closed_at)
         WHERE id = $1`,
        [params.id, params.status, params.updatedBy, now, reason, closedAt]
      );
      const result = await pool.query('SELECT * FROM pending_handoffs WHERE id = $1', [params.id]);
      return result.rows[0] ? mapPendingHandoffRow(result.rows[0]) : null;
    },

    async markClosed(id) {
      return this.updateStatus({
        id,
        status: PendingHandoffStatus.RESOLVED,
        updatedBy: 'system',
      });
    },

    async markInvalid(id, reason) {
      return this.updateStatus({
        id,
        status: PendingHandoffStatus.IGNORED,
        updatedBy: 'system',
        reason,
      });
    },

    async markInvalidByGroup(groupId, reason) {
      const now = new Date().toISOString();
      const result = await pool.query(
        `UPDATE pending_handoffs
         SET status = 'ignored', reason = $2, status_updated_by = 'system',
             status_updated_at = $3, updated_at = $3
         WHERE group_id = $1 AND status IN (${ACTIONABLE_STATUS_SQL})`,
        [groupId, reason, now]
      );
      return result.rowCount ?? 0;
    },

    async markInvalidByThread(groupId, issueThreadId, reason) {
      const now = new Date().toISOString();
      const result = await pool.query(
        `UPDATE pending_handoffs
         SET status = 'ignored', reason = $2, status_updated_by = 'system',
             status_updated_at = $3, updated_at = $3
         WHERE group_id = $1 AND issue_thread_id = $4 AND status IN (${ACTIONABLE_STATUS_SQL})`,
        [groupId, reason, now, issueThreadId]
      );
      return result.rowCount ?? 0;
    },

    async markSnoozed(id) {
      const now = new Date().toISOString();
      await pool.query(
        `UPDATE pending_handoffs
         SET snoozed = TRUE, acknowledged_at = $2, updated_at = $2,
             status = 'in_progress', status_updated_by = consultant_id,
             status_updated_at = $2
         WHERE id = $1 AND status IN (${ACTIONABLE_STATUS_SQL})`,
        [id, now]
      );
      const result = await pool.query('SELECT * FROM pending_handoffs WHERE id = $1', [id]);
      return result.rows[0] ? mapPendingHandoffRow(result.rows[0]) : null;
    },

    async findActionableByConsultantAndGroup(consultantId, groupId) {
      const result = await pool.query(
        `SELECT * FROM pending_handoffs
         WHERE consultant_id = $1 AND group_id = $2 AND status IN (${ACTIONABLE_STATUS_SQL})
         ORDER BY created_at DESC`,
        [consultantId, groupId]
      );
      return result.rows.map(mapPendingHandoffRow);
    },

    async findOpenByConsultantAndGroup(consultantId, groupId) {
      return this.findActionableByConsultantAndGroup(consultantId, groupId);
    },

    async transferActionableHandoffs({ fromConsultantId, toConsultantId, groupId }) {
      const now = new Date().toISOString();
      const result = await pool.query(
        `UPDATE pending_handoffs
         SET consultant_id = $3, updated_at = $4
         WHERE consultant_id = $1 AND group_id = $2 AND status IN (${ACTIONABLE_STATUS_SQL})`,
        [fromConsultantId, groupId, toConsultantId, now]
      );
      return result.rowCount ?? 0;
    },

    async transferOpenHandoffs(params) {
      return this.transferActionableHandoffs(params);
    },

    async clear() {
      await pool.query('DELETE FROM pending_handoffs');
    },
  };
}
