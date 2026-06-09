import { Pool } from 'pg';
import { v4 as uuidv4 } from 'uuid';
import {
  AppendGroupMessageBufferParams,
  GroupMessageBuffer,
  GroupMessageBufferEntry,
  GroupMessageBufferRepository,
  GroupMessageBufferStatus,
} from './groupMessageBufferTypes';

function mapRow(row: Record<string, unknown>): GroupMessageBuffer {
  return {
    bufferId: row.buffer_id as string,
    groupId: row.group_id as string,
    customerUserId: row.customer_user_id as string,
    issueThreadId: row.issue_thread_id as string,
    messages: row.messages_json as GroupMessageBufferEntry[],
    status: row.status as GroupMessageBufferStatus,
    createdAt: (row.created_at as Date).toISOString(),
    updatedAt: (row.updated_at as Date).toISOString(),
  };
}

export function createPostgresGroupMessageBufferRepository(
  pool: Pool
): GroupMessageBufferRepository {
  return {
    async create(params) {
      const bufferId = uuidv4();
      const now = new Date().toISOString();
      await pool.query(
        `INSERT INTO group_message_buffers (
          buffer_id, group_id, customer_user_id, issue_thread_id,
          messages_json, status, created_at, updated_at
        ) VALUES ($1, $2, $3, $4, $5, 'collecting', $6, $6)`,
        [
          bufferId,
          params.groupId,
          params.customerUserId,
          params.issueThreadId,
          JSON.stringify([params.message]),
          now,
        ]
      );
      return (await this.findById(bufferId))!;
    },

    async findById(bufferId) {
      const result = await pool.query(
        'SELECT * FROM group_message_buffers WHERE buffer_id = $1',
        [bufferId]
      );
      return result.rows[0] ? mapRow(result.rows[0]) : null;
    },

    async findCollectingByGroupAndCustomer(groupId, customerUserId) {
      const result = await pool.query(
        `SELECT * FROM group_message_buffers
         WHERE group_id = $1 AND customer_user_id = $2 AND status = 'collecting'
         ORDER BY updated_at DESC LIMIT 1`,
        [groupId, customerUserId]
      );
      return result.rows[0] ? mapRow(result.rows[0]) : null;
    },

    async findCollectingByGroup(groupId) {
      const result = await pool.query(
        `SELECT * FROM group_message_buffers
         WHERE group_id = $1 AND status = 'collecting'
         ORDER BY updated_at ASC`,
        [groupId]
      );
      return result.rows.map(mapRow);
    },

    async findExpiredCollecting(cutoffIso) {
      const result = await pool.query(
        `SELECT * FROM group_message_buffers
         WHERE status = 'collecting' AND updated_at <= $1
         ORDER BY updated_at ASC`,
        [cutoffIso]
      );
      return result.rows.map(mapRow);
    },

    async appendMessage(bufferId, message) {
      const existing = await this.findById(bufferId);
      if (!existing || existing.status !== 'collecting') {
        return null;
      }
      const messages = [...existing.messages, message];
      const now = new Date().toISOString();
      await pool.query(
        `UPDATE group_message_buffers
         SET messages_json = $2, updated_at = $3
         WHERE buffer_id = $1`,
        [bufferId, JSON.stringify(messages), now]
      );
      return this.findById(bufferId);
    },

    async updateStatus(bufferId, status) {
      const now = new Date().toISOString();
      await pool.query(
        `UPDATE group_message_buffers SET status = $2, updated_at = $3 WHERE buffer_id = $1`,
        [bufferId, status, now]
      );
      return this.findById(bufferId);
    },

    async clear() {
      await pool.query('DELETE FROM group_message_buffers');
    },
  };
}
