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
      text: mute
        ? '好的，有需要的話可以隨時叫我回來🙂'
        : '好的，我隨時待命🙂',
    },
  ];
}
