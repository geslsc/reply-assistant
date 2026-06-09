import { getRepos } from '../repositories';
import { ensureGroupAssignment } from './groupConsultantAssignmentService';

/** Bot 加入群組或重新加入時建立 / 恢復 assignment */
export async function handleBotJoinGroup(groupId: string): Promise<void> {
  await ensureGroupAssignment(groupId, { reactivateIfLeft: true });
  const flags = await getRepos().groups.getOrCreate(groupId);
  if (flags.botLeftAt) {
    await getRepos().groups.update(groupId, { botLeftAt: null });
  }
}
