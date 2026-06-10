import { Pool } from 'pg';
import { v4 as uuidv4 } from 'uuid';
import {
  Actor,
  ConsultantRecord,
  ConsultantRole,
  ConsultantStatus,
  EventLogEntry,
  EventType,
  GroupFlags,
  IssueThread,
  IssueThreadStatus,
  RiskLevel,
  ThreadState,
} from '../types';
import { CreateEventParams } from './interfaces';
import { getPool } from '../db/client';
import {
  ConsultantRepository,
  EventLogRepository,
  GroupRepository,
  IssueThreadRepository,
  KnowledgeOverride,
  KnowledgeOverrideRepository,
  Repositories,
} from './interfaces';
import { createPostgresPendingHandoffRepository } from './postgresPendingHandoffRepository';
import { createPostgresPendingKnowledgeReviewRepository } from './postgresPendingKnowledgeReviewRepository';
import { createPostgresDmSessionRepository } from './postgresDmSessionRepository';
import { createPostgresKnowledgeCardRepository } from './postgresKnowledgeCardRepository';
import { createPostgresConsultantApplicationRepository } from './postgresConsultantApplicationRepository';
import { createPostgresGroupMessageBufferRepository } from './postgresGroupMessageBufferRepository';
import { createPostgresGroupConsultantAssignmentRepository } from './postgresGroupConsultantAssignmentRepository';
import { createPostgresLineEventDedupRepository } from './postgresLineEventDedupRepository';
import {
  mapConsultantRow,
  mapGroupRow,
  mapOverrideRow,
  mapThreadRow,
  threadToMetadata,
} from './mappers';

const VALID_EVENT_TYPES = new Set(Object.values(EventType));
const VALID_ACTORS = new Set(Object.values(Actor));
const VALID_RISK_LEVELS = new Set(Object.values(RiskLevel));

function defaultGroupFlags(groupId: string): GroupFlags {
  return {
    groupId,
    groupName: null,
    waitingFlag: false,
    waitingFlagSetAt: null,
    mute: false,
    muteUntil: null,
    serviceStartAt: null,
    serviceEndAt: null,
    activeIssueThreadId: null,
    serviceReactivationPending: false,
    botLeftAt: null,
    servicePeriodEndNotified: false,
  };
}

function createGroupRepository(pool: Pool): GroupRepository {
  return {
    async getOrCreate(groupId) {
      const existing = await pool.query('SELECT * FROM group_flags WHERE group_id = $1', [groupId]);
      if (existing.rows[0]) {
        return mapGroupRow(existing.rows[0]);
      }
      await pool.query(
        `INSERT INTO group_flags (group_id) VALUES ($1) ON CONFLICT (group_id) DO NOTHING`,
        [groupId]
      );
      const inserted = await pool.query('SELECT * FROM group_flags WHERE group_id = $1', [groupId]);
      return inserted.rows[0] ? mapGroupRow(inserted.rows[0]) : defaultGroupFlags(groupId);
    },
    async update(groupId, patch) {
      await this.getOrCreate(groupId);
      const current = await this.getOrCreate(groupId);
      const next = { ...current, ...patch };
      await pool.query(
        `UPDATE group_flags SET
          group_name = $2,
          waiting_flag = $3,
          waiting_flag_set_at = $4,
          mute = $5,
          mute_until = $6,
          service_start_at = $7,
          service_end_at = $8,
          active_issue_thread_id = $9,
          service_reactivation_pending = $10,
          bot_left_at = $11,
          service_period_end_notified = $12,
          updated_at = NOW()
        WHERE group_id = $1`,
        [
          groupId,
          next.groupName,
          next.waitingFlag,
          next.waitingFlagSetAt,
          next.mute,
          next.muteUntil,
          next.serviceStartAt,
          next.serviceEndAt,
          next.activeIssueThreadId,
          next.serviceReactivationPending,
          next.botLeftAt,
          next.servicePeriodEndNotified,
        ]
      );
      return this.getOrCreate(groupId);
    },
    async findAll() {
      const result = await pool.query('SELECT * FROM group_flags');
      return result.rows.map(mapGroupRow);
    },
    async clear() {
      await pool.query('DELETE FROM group_flags');
    },
  };
}

function createIssueThreadRepository(pool: Pool, groups: GroupRepository): IssueThreadRepository {
  return {
    async create(groupId, customerQuestion) {
      const issueThreadId = uuidv4();
      const now = new Date().toISOString();
      const metadata = threadToMetadata({ customerQuestion: customerQuestion ?? null });
      await pool.query(
        `INSERT INTO issue_threads (
          issue_thread_id, group_id, status, state, clarify_count, has_substantive_answer,
          last_message_at, metadata_json
        ) VALUES ($1, $2, $3, $4, 0, FALSE, $5, $6::jsonb)`,
        [
          issueThreadId,
          groupId,
          IssueThreadStatus.ACTIVE,
          ThreadState.IDLE,
          now,
          JSON.stringify(metadata),
        ]
      );
      await groups.update(groupId, { activeIssueThreadId: issueThreadId });
      return (await this.findById(groupId, issueThreadId))!;
    },
    async findById(groupId, issueThreadId) {
      const result = await pool.query(
        'SELECT * FROM issue_threads WHERE group_id = $1 AND issue_thread_id = $2',
        [groupId, issueThreadId]
      );
      return result.rows[0] ? mapThreadRow(result.rows[0]) : null;
    },
    async findActiveByGroup(groupId) {
      const flags = await groups.getOrCreate(groupId);
      if (!flags.activeIssueThreadId) {
        return null;
      }
      const thread = await this.findById(groupId, flags.activeIssueThreadId);
      if (thread && thread.status === IssueThreadStatus.ACTIVE) {
        return thread;
      }
      return null;
    },
    async findByGroup(groupId) {
      const result = await pool.query(
        'SELECT * FROM issue_threads WHERE group_id = $1 ORDER BY created_at ASC',
        [groupId]
      );
      return result.rows.map(mapThreadRow);
    },
    async update(groupId, issueThreadId, patch) {
      const current = await this.findById(groupId, issueThreadId);
      if (!current) {
        return null;
      }
      const next = { ...current, ...patch };
      const metadata = threadToMetadata(next);
      await pool.query(
        `UPDATE issue_threads SET
          status = $3,
          state = $4,
          knowledge_card_id = $5,
          has_substantive_answer = $6,
          clarify_count = $7,
          last_message_at = $8,
          resolved_at = $9,
          metadata_json = $10::jsonb,
          updated_at = NOW()
        WHERE group_id = $1 AND issue_thread_id = $2`,
        [
          groupId,
          issueThreadId,
          next.status,
          next.state,
          next.lastKnowledgeCardId,
          next.hasSubstantiveAnswer,
          next.clarifyRound,
          next.lastStateChangeAt ?? new Date().toISOString(),
          next.status === IssueThreadStatus.RESOLVED ? new Date().toISOString() : null,
          JSON.stringify(metadata),
        ]
      );
      return this.findById(groupId, issueThreadId);
    },
    async clear() {
      await pool.query('DELETE FROM issue_threads');
    },
  };
}

function createEventLogRepository(pool: Pool): EventLogRepository {
  return {
    async create(params) {
      if (!VALID_EVENT_TYPES.has(params.event_type)) {
        throw new Error(`Invalid event_type: ${params.event_type}`);
      }
      if (params.actor && !VALID_ACTORS.has(params.actor)) {
        throw new Error(`Invalid actor: ${params.actor}`);
      }
      if (params.risk_level && !VALID_RISK_LEVELS.has(params.risk_level)) {
        throw new Error(`Invalid risk_level: ${params.risk_level}`);
      }
      const entry: EventLogEntry = {
        event_id: uuidv4(),
        timestamp: params.timestamp ?? new Date().toISOString(),
        event_type: params.event_type,
        group_id: params.group_id ?? null,
        issue_thread_id: params.issue_thread_id ?? null,
        actor: params.actor ?? Actor.SYSTEM,
        actor_user_id: params.actor_user_id ?? null,
        risk_level: params.risk_level ?? null,
        from_state: params.from_state ?? null,
        to_state: params.to_state ?? null,
        knowledge_card_id: params.knowledge_card_id ?? null,
        detail: params.detail ?? null,
        service_day: params.service_day ?? null,
      };
      await pool.query(
        `INSERT INTO event_logs (
          event_id, timestamp, event_type, group_id, issue_thread_id, actor, actor_user_id,
          risk_level, from_state, to_state, knowledge_card_id, detail, service_day
        ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`,
        [
          entry.event_id,
          entry.timestamp,
          entry.event_type,
          entry.group_id,
          entry.issue_thread_id,
          entry.actor,
          entry.actor_user_id,
          entry.risk_level,
          entry.from_state,
          entry.to_state,
          entry.knowledge_card_id,
          entry.detail,
          entry.service_day,
        ]
      );
      return entry;
    },
    async findAll() {
      const result = await pool.query('SELECT * FROM event_logs ORDER BY timestamp ASC');
      return result.rows.map((row) => ({
        event_id: String(row.event_id),
        timestamp: new Date(String(row.timestamp)).toISOString(),
        event_type: row.event_type as EventType,
        group_id: row.group_id ? String(row.group_id) : null,
        issue_thread_id: row.issue_thread_id ? String(row.issue_thread_id) : null,
        actor: row.actor as Actor,
        actor_user_id: row.actor_user_id ? String(row.actor_user_id) : null,
        risk_level: row.risk_level as RiskLevel | null,
        from_state: row.from_state as ThreadState | null,
        to_state: row.to_state as ThreadState | null,
        knowledge_card_id: row.knowledge_card_id ? String(row.knowledge_card_id) : null,
        detail: row.detail ? String(row.detail) : null,
        service_day: row.service_day !== null ? Number(row.service_day) : null,
      }));
    },
    async findByGroup(groupId) {
      const all = await this.findAll();
      return all.filter((e) => e.group_id === groupId);
    },
    async findByType(eventType) {
      const all = await this.findAll();
      return all.filter((e) => e.event_type === eventType);
    },
    async clear() {
      await pool.query('DELETE FROM event_logs');
    },
  };
}

function createConsultantRepository(pool: Pool): ConsultantRepository {
  return {
    async upsertAdmin(userId, displayName) {
      await pool.query(
        `INSERT INTO consultants (line_user_id, role, status, display_name)
         VALUES ($1, $2, $3, $4)
         ON CONFLICT (line_user_id) DO UPDATE SET
           role = EXCLUDED.role,
           status = EXCLUDED.status,
           display_name = COALESCE(EXCLUDED.display_name, consultants.display_name),
           updated_at = NOW()`,
        [userId, ConsultantRole.ADMIN, ConsultantStatus.ACTIVE, displayName ?? null]
      );
      return (await this.findById(userId))!;
    },
    async registerInviteCode(code, createdByAdminId) {
      await pool.query(
        `INSERT INTO invite_codes (code, created_by) VALUES ($1, $2)
         ON CONFLICT (code) DO NOTHING`,
        [code.toUpperCase(), createdByAdminId]
      );
    },
    async isValidInviteCode(code) {
      const result = await pool.query('SELECT 1 FROM invite_codes WHERE code = $1', [
        code.toUpperCase(),
      ]);
      return result.rowCount !== null && result.rowCount > 0;
    },
    async requestJoin(userId, inviteCode, displayName) {
      await pool.query(
        `INSERT INTO consultants (line_user_id, role, status, invite_code, display_name)
         VALUES ($1, $2, $3, $4, $5)
         ON CONFLICT (line_user_id) DO UPDATE SET
           role = EXCLUDED.role,
           invite_code = EXCLUDED.invite_code,
           display_name = COALESCE(EXCLUDED.display_name, consultants.display_name),
           updated_at = NOW()`,
        [
          userId,
          ConsultantRole.CONSULTANT,
          ConsultantStatus.DISABLED,
          inviteCode.toUpperCase(),
          displayName ?? null,
        ]
      );
      return (await this.findById(userId))!;
    },
    async approve(adminUserId, targetUserId) {
      const admin = await this.findById(adminUserId);
      if (!admin || admin.status !== ConsultantStatus.ACTIVE || admin.role !== ConsultantRole.ADMIN) {
        return { success: false, message: '只有 active admin 可核准' };
      }
      const target = await this.findById(targetUserId);
      if (!target) {
        return { success: false, message: '找不到顧問' };
      }
      const consultantCode =
        target.consultantCode ?? `C-legacy-${targetUserId.slice(-4)}`;
      await pool.query(
        `UPDATE consultants SET status = $2, approved_by = $3, approved_at = NOW(),
         consultant_code = COALESCE(consultant_code, $4), updated_at = NOW()
         WHERE line_user_id = $1`,
        [targetUserId, ConsultantStatus.ACTIVE, adminUserId, consultantCode]
      );
      return { success: true, message: '已核准' };
    },
    async disable(adminUserId, targetUserId, disabledBy) {
      const admin = await this.findById(adminUserId);
      if (!admin || admin.status !== ConsultantStatus.ACTIVE || admin.role !== ConsultantRole.ADMIN) {
        return { success: false, message: '只有 active admin 可停用' };
      }
      const target = await this.findById(targetUserId);
      if (!target) {
        return { success: false, message: '找不到顧問' };
      }
      await pool.query(
        `UPDATE consultants SET status = $2, disabled_by = $3, disabled_at = NOW(), updated_at = NOW()
         WHERE line_user_id = $1`,
        [targetUserId, ConsultantStatus.DISABLED, disabledBy ?? adminUserId]
      );
      return { success: true, message: '已停用' };
    },
    async enable(adminUserId, targetUserId) {
      const admin = await this.findById(adminUserId);
      if (!admin || admin.status !== ConsultantStatus.ACTIVE || admin.role !== ConsultantRole.ADMIN) {
        return { success: false, message: '只有 active admin 可啟用' };
      }
      const target = await this.findById(targetUserId);
      if (!target) {
        return { success: false, message: '找不到顧問' };
      }
      await pool.query(
        `UPDATE consultants SET status = $2, disabled_by = NULL, disabled_at = NULL, updated_at = NOW()
         WHERE line_user_id = $1`,
        [targetUserId, ConsultantStatus.ACTIVE]
      );
      return { success: true, message: '已啟用' };
    },
    async upsertApprovedConsultant(params) {
      await pool.query(
        `INSERT INTO consultants (
          line_user_id, role, status, display_name, consultant_code, approved_by, approved_at
        ) VALUES ($1, $2, $3, $4, $5, $6, $7)
        ON CONFLICT (line_user_id) DO UPDATE SET
          role = EXCLUDED.role,
          status = EXCLUDED.status,
          display_name = EXCLUDED.display_name,
          consultant_code = EXCLUDED.consultant_code,
          approved_by = EXCLUDED.approved_by,
          approved_at = EXCLUDED.approved_at,
          disabled_by = NULL,
          disabled_at = NULL,
          push_failure_count = 0,
          last_push_failed_at = NULL,
          updated_at = NOW()`,
        [
          params.userId,
          ConsultantRole.CONSULTANT,
          ConsultantStatus.ACTIVE,
          params.displayName,
          params.consultantCode,
          params.approvedBy,
          params.approvedAt,
        ]
      );
      return (await this.findById(params.userId))!;
    },
    async findById(userId) {
      const result = await pool.query('SELECT * FROM consultants WHERE line_user_id = $1', [userId]);
      return result.rows[0] ? mapConsultantRow(result.rows[0]) : null;
    },
    async findByConsultantCode(consultantCode) {
      const result = await pool.query(
        'SELECT * FROM consultants WHERE consultant_code = $1',
        [consultantCode]
      );
      return result.rows[0] ? mapConsultantRow(result.rows[0]) : null;
    },
    async findAll() {
      const result = await pool.query('SELECT * FROM consultants ORDER BY created_at ASC');
      return result.rows.map(mapConsultantRow);
    },
    async findActive() {
      const result = await pool.query(
        `SELECT * FROM consultants WHERE status = $1 AND role IN ($2, $3)`,
        [ConsultantStatus.ACTIVE, ConsultantRole.CONSULTANT, ConsultantRole.ADMIN]
      );
      return result.rows.map(mapConsultantRow);
    },
    async findPending() {
      return [];
    },
    async findActiveAdmins() {
      const result = await pool.query(
        'SELECT * FROM consultants WHERE status = $1 AND role = $2',
        [ConsultantStatus.ACTIVE, ConsultantRole.ADMIN]
      );
      return result.rows.map(mapConsultantRow);
    },
    async recordPushSuccess(userId, succeededAt) {
      await pool.query(
        `UPDATE consultants
         SET push_failure_count = 0,
             last_push_succeeded_at = $2,
             updated_at = NOW()
         WHERE line_user_id = $1`,
        [userId, succeededAt]
      );
    },
    async recordPushFailure(userId, failedAt) {
      await pool.query(
        `UPDATE consultants
         SET push_failure_count = push_failure_count + 1,
             last_push_failed_at = $2,
             updated_at = NOW()
         WHERE line_user_id = $1`,
        [userId, failedAt]
      );
    },
    async setLastKnowledgeExportAt(userId, exportedAt) {
      await pool.query(
        `UPDATE consultants SET last_knowledge_export_at = $2, updated_at = NOW()
         WHERE line_user_id = $1`,
        [userId, exportedAt]
      );
    },
    async getLastKnowledgeExportAt(userId) {
      const record = await this.findById(userId);
      return record?.lastKnowledgeExportAt ?? null;
    },
    async clear() {
      await pool.query('DELETE FROM consultants');
      await pool.query('DELETE FROM invite_codes');
    },
  };
}

function createKnowledgeOverrideRepository(pool: Pool): KnowledgeOverrideRepository {
  return {
    async setPaused(cardId, updatedBy, reason) {
      await pool.query(
        `INSERT INTO knowledge_overrides (knowledge_card_id, status_override, reason, updated_by, updated_at)
         VALUES ($1, $2, $3, $4, NOW())
         ON CONFLICT (knowledge_card_id) DO UPDATE SET
           status_override = EXCLUDED.status_override,
           reason = EXCLUDED.reason,
           updated_by = EXCLUDED.updated_by,
           updated_at = NOW()`,
        [cardId, '暫停', reason ?? null, updatedBy]
      );
      return (await this.findByCardId(cardId))!;
    },
    async findByCardId(cardId) {
      const result = await pool.query(
        'SELECT * FROM knowledge_overrides WHERE knowledge_card_id = $1',
        [cardId]
      );
      return result.rows[0] ? mapOverrideRow(result.rows[0]) : null;
    },
    async findAll() {
      const result = await pool.query('SELECT * FROM knowledge_overrides');
      return result.rows.map(mapOverrideRow);
    },
    async clear() {
      await pool.query('DELETE FROM knowledge_overrides');
    },
  };
}

export function createPostgresRepositories(pool: Pool = getPool()): Repositories {
  const groups = createGroupRepository(pool);
  const threads = createIssueThreadRepository(pool, groups);
  return {
    groups,
    threads,
    events: createEventLogRepository(pool),
    consultants: createConsultantRepository(pool),
    knowledgeOverrides: createKnowledgeOverrideRepository(pool),
    knowledgeCards: createPostgresKnowledgeCardRepository(pool),
    pendingHandoffs: createPostgresPendingHandoffRepository(pool),
    pendingKnowledgeReviews: createPostgresPendingKnowledgeReviewRepository(pool),
    dmSessions: createPostgresDmSessionRepository(pool),
    groupMessageBuffers: createPostgresGroupMessageBufferRepository(pool),
    consultantApplications: createPostgresConsultantApplicationRepository(pool),
    groupConsultantAssignments: createPostgresGroupConsultantAssignmentRepository(pool),
    lineEventDedup: createPostgresLineEventDedupRepository(pool),
  };
}
