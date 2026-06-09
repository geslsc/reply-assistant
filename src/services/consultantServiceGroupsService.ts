import { BotReply } from '../types';
import { getRepos } from '../repositories';
import {
  isActiveConsultantOrAdmin,
  isDisabledConsultant,
} from './consultantWhitelist';
import { isInServicePeriod } from './groupFlags';
import { formatAssignmentGroupLabel } from './groupConsultantAssignmentService';

export const MY_SERVICE_GROUPS_PHRASE = '我的服務群組';

export async function handleMyServiceGroups(userId: string): Promise<BotReply[] | null> {
  if (await isDisabledConsultant(userId)) {
    return [
      {
        type: 'push',
        userId,
        text: '您目前已被停用，無法查詢服務群組。',
      },
    ];
  }

  if (!(await isActiveConsultantOrAdmin(userId))) {
    return [
      {
        type: 'push',
        userId,
        text: '您目前不是 active 顧問或 admin，無法查詢服務群組。',
      },
    ];
  }

  const assignments = await getRepos().groupConsultantAssignments.findByConsultantUserId(userId);
  if (assignments.length === 0) {
    return [{ type: 'push', userId, text: '目前沒有與您相關的服務群組紀錄。' }];
  }

  const lines: string[] = ['【我的服務群組】'];
  for (const assignment of assignments) {
    const flags = await getRepos().groups.getOrCreate(assignment.groupId);
    const inService = await isInServicePeriod(assignment.groupId);
    const role =
      assignment.primaryConsultantUserId === userId
        ? '主負責'
        : assignment.secondaryConsultantUserId === userId
          ? '副手'
          : '—';
    const status = flags.mute ? '已暫停' : flags.botLeftAt ? '小助手已離群' : assignment.status;
    lines.push(
      [
        `群組：${formatAssignmentGroupLabel(assignment)}`,
        `group_code：${assignment.groupCode}`,
        `角色：${role}`,
        `服務開始：${flags.serviceStartAt?.slice(0, 10) ?? '—'}`,
        `服務結束：${flags.serviceEndAt?.slice(0, 10) ?? '—'}`,
        `狀態：${status}`,
        `最近店家訊息：${assignment.lastCustomerMessageAt?.slice(0, 19).replace('T', ' ') ?? '—'}`,
      ].join('\n')
    );
    if (!inService && !flags.botLeftAt) {
      lines[lines.length - 1] += '\n（目前不在服務期內）';
    }
  }

  if (lines.length === 1) {
    return [{ type: 'push', userId, text: '目前沒有與您相關的服務群組紀錄。' }];
  }

  return [{ type: 'push', userId, text: lines.join('\n\n') }];
}
