import { BotReply } from '../types';
import { getRepos } from '../repositories';
import { getActiveAdmins } from './consultantWhitelist';
import { logConsultantManagementEvent } from './consultantEventLogService';
import { logger } from '../config/logger';
import { markGroupAssignmentLeft } from './groupConsultantAssignmentService';

export async function handleBotLeaveGroup(groupId: string): Promise<BotReply[]> {
  try {
    const flags = await getRepos().groups.getOrCreate(groupId);
    const now = new Date().toISOString();
    await getRepos().groups.update(groupId, { botLeftAt: now });
    await markGroupAssignmentLeft(groupId);

    await logConsultantManagementEvent({
      action: 'bot_left_group',
      actorUserId: 'system',
      payload: {
        group_id: groupId,
        group_name: flags.groupName ?? groupId,
      },
    });

    const groupLabel = flags.groupName ?? groupId;
    const replies: BotReply[] = [];
    for (const admin of await getActiveAdmins()) {
      replies.push({
        type: 'push',
        userId: admin.userId,
        text: `小助手已被移出群組 ${groupLabel}（${groupId}）。`,
      });
    }
    return replies;
  } catch (error) {
    logger.error('Bot leave group handling failed', {
      groupId,
      error: error instanceof Error ? error.message : String(error),
    });
    return [];
  }
}
