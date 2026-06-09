import { Actor, EventType } from '../types';
import { createEvent } from './eventLogService';

export async function logConsultantManagementEvent(params: {
  action: string;
  actorUserId: string;
  payload: Record<string, unknown>;
}): Promise<void> {
  await createEvent({
    event_type: EventType.CONSULTANT_OVERRIDE,
    actor: Actor.CONSULTANT,
    actor_user_id: params.actorUserId,
    detail: JSON.stringify({
      action: params.action,
      ...params.payload,
    }),
  });
}
