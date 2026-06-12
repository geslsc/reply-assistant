import { GroupMetadata } from '../types';
import { updateGroupFlags, getGroupFlags } from './groupFlags';
import {
  GROUP_FIRST_INTRO_MESSAGE,
  GROUP_FOLLOWUP_INTRO_MESSAGE,
} from './groupReplyCopyService';

function parseGroupMetadata(flags: { metadataJson?: GroupMetadata | null }): GroupMetadata {
  return flags.metadataJson ?? {};
}

export async function isGroupIntroShown(groupId: string): Promise<boolean> {
  const flags = await getGroupFlags(groupId);
  return parseGroupMetadata(flags).intro_shown === true;
}

export async function markGroupIntroShown(groupId: string, _actorUserId?: string | null): Promise<void> {
  const flags = await getGroupFlags(groupId);
  const metadata: GroupMetadata = {
    ...parseGroupMetadata(flags),
    intro_shown: true,
  };
  await updateGroupFlags(groupId, { metadataJson: metadata });
}

export async function resolveGroupIntroMessage(groupId: string): Promise<{
  message: string;
  isFirstIntro: boolean;
}> {
  if (await isGroupIntroShown(groupId)) {
    return { message: GROUP_FOLLOWUP_INTRO_MESSAGE, isFirstIntro: false };
  }
  return { message: GROUP_FIRST_INTRO_MESSAGE, isFirstIntro: true };
}
