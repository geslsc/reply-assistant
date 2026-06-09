import { BotReply, ConsultantStatus } from '../types';
import { getActiveAdmins, getConsultant } from './consultantWhitelist';
import { startsWithAssistantPrefix } from './groupAssistantCommandService';
import { logConsultantManagementEvent } from './consultantEventLogService';

export async function handleDisabledConsultantGroupCommand(params: {
  userId: string;
  groupId: string;
  text: string;
}): Promise<BotReply[] | null> {
  if (!startsWithAssistantPrefix(params.text)) {
    return null;
  }

  const record = await getConsultant(params.userId);
  if (!record || record.status !== ConsultantStatus.DISABLED) {
    return null;
  }

  await logConsultantManagementEvent({
    action: 'disabled_consultant_attempted_command',
    actorUserId: params.userId,
    payload: {
      user_id: params.userId,
      group_id: params.groupId,
      attempted_command: params.text.trim(),
    },
  });

  const replies: BotReply[] = [];
  const display = record.displayName ?? params.userId;
  const code = record.consultantCode ?? params.userId;
  for (const admin of await getActiveAdmins()) {
    replies.push({
      type: 'push',
      userId: admin.userId,
      text: `已停用顧問 ${display}（${code}）嘗試在群組 ${params.groupId} 使用顧問指令，系統已拒絕。`,
    });
  }
  return replies;
}
