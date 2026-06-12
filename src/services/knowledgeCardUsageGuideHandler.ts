import { BotReply, ConsultantRole } from '../types';
import { isActiveAdmin, isActiveConsultantOrAdmin, getConsultant } from './consultantWhitelist';
import { buildIdentityReply } from './consultantIdentityService';
import {
  ADMIN_USAGE_GUIDE,
  CONSULTANT_USAGE_GUIDE,
  matchUsageGuideTrigger,
} from './knowledgeCardUsageGuideService';
import { handleGroupIntroQuestion } from './groupIntroReplyService';

export { matchUsageGuideTrigger } from './knowledgeCardUsageGuideService';

export async function handlePrivateUsageGuide(userId: string): Promise<BotReply[]> {
  if (await isActiveAdmin(userId)) {
    return [{ type: 'push', userId, text: ADMIN_USAGE_GUIDE }];
  }

  const record = await getConsultant(userId);
  if (record?.status === 'active' && record.role === ConsultantRole.CONSULTANT) {
    return [{ type: 'push', userId, text: CONSULTANT_USAGE_GUIDE }];
  }

  if (await isActiveConsultantOrAdmin(userId)) {
    return [{ type: 'push', userId, text: ADMIN_USAGE_GUIDE }];
  }

  return [
    {
      type: 'push',
      userId,
      text: await buildIdentityReply(userId),
    },
  ];
}

export async function handleGroupUsageGuide(
  groupId: string,
  actorUserId?: string | null
): Promise<BotReply[]> {
  return handleGroupIntroQuestion(groupId, actorUserId);
}

export function isUsageGuideRequest(text: string): boolean {
  return matchUsageGuideTrigger(text);
}
