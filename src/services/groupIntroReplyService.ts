import { BotReply } from '../types';
import { isGroupIntroShown, markGroupIntroShown, resolveGroupIntroMessage } from './groupMetadataService';
import { isIntroFollowUpQuestion } from './groupReplyCopyService';

export async function handleGroupIntroQuestion(
  groupId: string,
  actorUserId?: string | null
): Promise<BotReply[]> {
  const { message, isFirstIntro } = await resolveGroupIntroMessage(groupId);
  if (isFirstIntro) {
    await markGroupIntroShown(groupId, actorUserId);
  }
  return [{ type: 'group', text: message }];
}

export function isGroupIntroFollowUpRequest(text: string, introAlreadyShown: boolean): boolean {
  return introAlreadyShown && isIntroFollowUpQuestion(text);
}

export async function shouldHandleCustomerIntroRequest(
  groupId: string,
  text: string
): Promise<boolean> {
  return isIntroFollowUpQuestion(text) || !(await isGroupIntroShown(groupId));
}
