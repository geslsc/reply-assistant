import { Actor, BotReply, EventType } from '../types';
import { createEvent } from './eventLogService';
import { setMute } from './groupFlags';
import { invalidatePendingHandoffsByGroup } from './pendingHandoffService';
import { PendingHandoffInvalidReason } from '../repositories/pendingHandoffTypes';

export async function handleConsultantMute(
  groupId: string,
  userId: string,
  mute: boolean
): Promise<BotReply[]> {
  await setMute(groupId, mute);
  if (mute) {
    await invalidatePendingHandoffsByGroup(groupId, PendingHandoffInvalidReason.GROUP_MUTED);
  }
  await createEvent({
    event_type: EventType.CONSULTANT_MUTE,
    group_id: groupId,
    issue_thread_id: null,
    actor: Actor.CONSULTANT,
    actor_user_id: userId,
    detail: mute ? 'muted until consultant clears' : 'unmuted',
  });
  return [
    {
      type: 'group',
      text: mute ? '小助手先休息中,有需要請顧問喚醒。' : '小助手回來了,有需要可以再詢問。',
    },
  ];
}
