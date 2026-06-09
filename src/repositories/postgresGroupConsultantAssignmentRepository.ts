import { Pool } from 'pg';
import {
  GroupConsultantAssignmentRecord,
  GroupConsultantAssignmentRepository,
} from './groupConsultantAssignmentTypes';

function mapRow(row: Record<string, unknown>): GroupConsultantAssignmentRecord {
  return {
    id: Number(row.id),
    groupId: String(row.group_id),
    groupCode: String(row.group_code),
    groupName: row.group_name ? String(row.group_name) : null,
    primaryConsultantUserId: row.primary_consultant_user_id
      ? String(row.primary_consultant_user_id)
      : null,
    secondaryConsultantUserId: row.secondary_consultant_user_id
      ? String(row.secondary_consultant_user_id)
      : null,
    status: row.status as GroupConsultantAssignmentRecord['status'],
    createdAt: new Date(row.created_at as string | Date).toISOString(),
    updatedAt: new Date(row.updated_at as string | Date).toISOString(),
    updatedBy: row.updated_by ? String(row.updated_by) : null,
    lastConsultantActionAt: row.last_consultant_action_at
      ? new Date(row.last_consultant_action_at as string | Date).toISOString()
      : null,
    lastCustomerMessageAt: row.last_customer_message_at
      ? new Date(row.last_customer_message_at as string | Date).toISOString()
      : null,
  };
}

export function createPostgresGroupConsultantAssignmentRepository(
  pool: Pool
): GroupConsultantAssignmentRepository {
  return {
    async create(params) {
      const now = new Date().toISOString();
      const result = await pool.query(
        `INSERT INTO group_consultant_assignments (
          group_id, group_code, group_name, status, created_at, updated_at, updated_by
        ) VALUES ($1, $2, $3, 'active', $4, $4, $5)
        RETURNING *`,
        [params.groupId, params.groupCode, params.groupName, now, params.updatedBy]
      );
      return mapRow(result.rows[0]);
    },
    async findByGroupId(groupId) {
      const result = await pool.query(
        'SELECT * FROM group_consultant_assignments WHERE group_id = $1',
        [groupId]
      );
      return result.rows[0] ? mapRow(result.rows[0]) : null;
    },
    async findByGroupCode(groupCode) {
      const result = await pool.query(
        'SELECT * FROM group_consultant_assignments WHERE group_code = $1',
        [groupCode]
      );
      return result.rows[0] ? mapRow(result.rows[0]) : null;
    },
    async findByGroupName(groupName) {
      const result = await pool.query(
        'SELECT * FROM group_consultant_assignments WHERE group_name = $1',
        [groupName]
      );
      return result.rows.map(mapRow);
    },
    async listAll() {
      const result = await pool.query(
        'SELECT * FROM group_consultant_assignments ORDER BY group_code ASC'
      );
      return result.rows.map(mapRow);
    },
    async listAllGroupCodes() {
      const result = await pool.query('SELECT group_code FROM group_consultant_assignments');
      return result.rows.map((row) => String(row.group_code));
    },
    async findByConsultantUserId(userId) {
      const result = await pool.query(
        `SELECT * FROM group_consultant_assignments
         WHERE primary_consultant_user_id = $1 OR secondary_consultant_user_id = $1
         ORDER BY group_code ASC`,
        [userId]
      );
      return result.rows.map(mapRow);
    },
    async findGroupsWherePrimary(userId) {
      const result = await pool.query(
        `SELECT * FROM group_consultant_assignments
         WHERE primary_consultant_user_id = $1
         ORDER BY group_code ASC`,
        [userId]
      );
      return result.rows.map(mapRow);
    },
    async update(groupId, patch) {
      const fields: string[] = [];
      const values: unknown[] = [];
      let idx = 1;

      const mapping: Record<string, string> = {
        groupName: 'group_name',
        primaryConsultantUserId: 'primary_consultant_user_id',
        secondaryConsultantUserId: 'secondary_consultant_user_id',
        status: 'status',
        updatedBy: 'updated_by',
        lastConsultantActionAt: 'last_consultant_action_at',
        lastCustomerMessageAt: 'last_customer_message_at',
      };

      for (const [key, column] of Object.entries(mapping)) {
        const value = patch[key as keyof typeof patch];
        if (value !== undefined) {
          fields.push(`${column} = $${idx++}`);
          values.push(value);
        }
      }

      if (fields.length === 0) {
        return this.findByGroupId(groupId);
      }

      fields.push(`updated_at = $${idx++}`);
      values.push(new Date().toISOString());
      values.push(groupId);

      const result = await pool.query(
        `UPDATE group_consultant_assignments SET ${fields.join(', ')}
         WHERE group_id = $${idx}
         RETURNING *`,
        values
      );
      return result.rows[0] ? mapRow(result.rows[0]) : null;
    },
    async clear() {
      await pool.query('DELETE FROM group_consultant_assignments');
    },
  };
}
