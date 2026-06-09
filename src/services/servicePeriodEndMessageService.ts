import { BotReply } from '../types';
import { getEnv } from '../config/env';
import { getRepos } from '../repositories';
import { getGroupFlags, isServiceExpired } from './groupFlags';
import { buildServicePeriodEndedMessage } from './fixedMessageTemplates';
import { logConsultantManagementEvent } from './consultantEventLogService';

export async function maybeSendServicePeriodEndedMessage(
  groupId: string
): Promise<BotReply[]> {
  const flags = await getGroupFlags(groupId);
  if (!flags.serviceEndAt || flags.servicePeriodEndNotified) {
    return [];
  }
  if (!(await isServiceExpired(groupId))) {
    return [];
  }

  const message = buildServicePeriodEndedMessage();
  await getRepos().groups.update(groupId, { servicePeriodEndNotified: true });

  await logConsultantManagementEvent({
    action: 'service_period_ended',
    actorUserId: 'system',
    payload: {
      group_id: groupId,
      official_line_url_present: Boolean(getEnv().OFFICIAL_LINE_URL?.trim()),
    },
  });

  return [{ type: 'group', text: message }];
}
