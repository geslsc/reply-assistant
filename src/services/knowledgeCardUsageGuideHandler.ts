import { BotReply } from '../types';
import { ConsultantRole } from '../types';
import { isActiveAdmin, isActiveConsultantOrAdmin, getConsultant } from './consultantWhitelist';
import { buildIdentityReply } from './consultantIdentityService';
import {
  ADMIN_USAGE_GUIDE,
  CONSULTANT_USAGE_GUIDE,
  GROUP_USAGE_GUIDE,
  matchUsageGuideTrigger,
} from './knowledgeCardUsageGuideService';

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

export function handleGroupUsageGuide(): BotReply[] {
  return [{ type: 'group', text: GROUP_USAGE_GUIDE }];
}

export function isUsageGuideRequest(text: string): boolean {
  return matchUsageGuideTrigger(text);
}
