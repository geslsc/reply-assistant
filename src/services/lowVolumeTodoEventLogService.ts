import { logger } from '../config/logger';
import { Actor, EventType } from '../types';
import { PendingHandoffStatus } from '../repositories/pendingHandoffTypes';
import { createEvent } from './eventLogService';

/** handoff_status_changed 僅記必要狀態欄位，禁止塞入聊天全文或完整物件 */
export interface HandoffStatusChangedLogPayload {
  handoff_id: string;
  from_status: PendingHandoffStatus | null;
  to_status: PendingHandoffStatus;
  reason: string | null;
  updated_by: string;
  updated_at: string;
  source?: string;
}

export async function logHandoffStatusChanged(payload: HandoffStatusChangedLogPayload): Promise<void> {
  await createEvent({
    event_type: EventType.CONSULTANT_OVERRIDE,
    actor: Actor.SYSTEM,
    detail: JSON.stringify({
      action: 'handoff_status_changed',
      handoff_id: payload.handoff_id,
      from_status: payload.from_status,
      to_status: payload.to_status,
      reason: payload.reason,
      updated_by: payload.updated_by,
      updated_at: payload.updated_at,
      ...(payload.source ? { source: payload.source } : {}),
    }),
  });
}

export async function logKnowledgeDraftEdited(payload: Record<string, unknown>): Promise<void> {
  await createEvent({
    event_type: EventType.CONSULTANT_OVERRIDE,
    actor: Actor.CONSULTANT,
    actor_user_id: String(payload.edited_by ?? ''),
    detail: JSON.stringify({
      action: 'knowledge_draft_edited',
      review_id: payload.review_id,
      edited_by: payload.edited_by,
      edit_reason: payload.edit_reason ?? null,
    }),
  });
}

export async function safeLogKnowledgeDraftEdited(payload: Record<string, unknown>): Promise<void> {
  try {
    await logKnowledgeDraftEdited(payload);
  } catch (error) {
    logger.warn('Failed to write knowledge_draft_edited event', {
      review_id: payload.review_id,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}
