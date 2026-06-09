import { Pool } from 'pg';
import {
  ConsultantApplicationRecord,
  ConsultantApplicationRepository,
} from './consultantApplicationTypes';

function mapApplicationRow(row: Record<string, unknown>): ConsultantApplicationRecord {
  return {
    applicationId: String(row.application_id),
    applicationCode: String(row.application_code),
    userId: String(row.user_id),
    displayName: row.display_name ? String(row.display_name) : null,
    status: row.status as ConsultantApplicationRecord['status'],
    appliedAt: new Date(String(row.applied_at)).toISOString(),
    resolvedAt: row.resolved_at ? new Date(String(row.resolved_at)).toISOString() : null,
    resolvedBy: row.resolved_by ? String(row.resolved_by) : null,
    adminResponse: row.admin_response ? String(row.admin_response) : null,
  };
}

export function createPostgresConsultantApplicationRepository(
  pool: Pool
): ConsultantApplicationRepository {
  return {
    async create(params) {
      await pool.query(
        `INSERT INTO consultant_applications (
          application_id, application_code, user_id, display_name, status, applied_at
        ) VALUES ($1, $2, $3, $4, 'pending', $5)`,
        [
          params.applicationId,
          params.applicationCode,
          params.userId,
          params.displayName,
          params.appliedAt,
        ]
      );
      return (await this.findByCode(params.applicationCode))!;
    },
    async findByCode(applicationCode) {
      const result = await pool.query(
        'SELECT * FROM consultant_applications WHERE application_code = $1',
        [applicationCode]
      );
      return result.rows[0] ? mapApplicationRow(result.rows[0]) : null;
    },
    async findPendingByUserId(userId) {
      const result = await pool.query(
        `SELECT * FROM consultant_applications WHERE user_id = $1 AND status = 'pending' ORDER BY applied_at DESC LIMIT 1`,
        [userId]
      );
      return result.rows[0] ? mapApplicationRow(result.rows[0]) : null;
    },
    async listPending() {
      const result = await pool.query(
        `SELECT * FROM consultant_applications WHERE status = 'pending' ORDER BY applied_at ASC`
      );
      return result.rows.map(mapApplicationRow);
    },
    async listAllCodes() {
      const result = await pool.query('SELECT application_code FROM consultant_applications');
      return result.rows.map((row) => String(row.application_code));
    },
    async approve(params) {
      const result = await pool.query(
        `UPDATE consultant_applications
         SET status = 'approved', resolved_at = $2, resolved_by = $3
         WHERE application_code = $1 AND status = 'pending'
         RETURNING *`,
        [params.applicationCode, params.resolvedAt, params.resolvedBy]
      );
      return result.rows[0] ? mapApplicationRow(result.rows[0]) : null;
    },
    async reject(params) {
      const result = await pool.query(
        `UPDATE consultant_applications
         SET status = 'rejected', resolved_at = $2, resolved_by = $3, admin_response = $4
         WHERE application_code = $1 AND status = 'pending'
         RETURNING *`,
        [
          params.applicationCode,
          params.resolvedAt,
          params.resolvedBy,
          params.adminResponse ?? null,
        ]
      );
      return result.rows[0] ? mapApplicationRow(result.rows[0]) : null;
    },
    async clear() {
      await pool.query('DELETE FROM consultant_applications');
    },
  };
}
