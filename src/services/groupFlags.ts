import { GroupFlags } from '../types';
import { getRepos } from '../repositories';

function defaultFlags(groupId: string): GroupFlags {
  return {
    groupId,
    groupName: null,
    waitingFlag: false,
    waitingFlagSetAt: null,
    mute: false,
    muteUntil: null,
    serviceStartAt: null,
    serviceEndAt: null,
    activeIssueThreadId: null,
    serviceReactivationPending: false,
    botLeftAt: null,
    servicePeriodEndNotified: false,
    metadataJson: null,
  };
}

export async function getGroupFlags(groupId: string): Promise<GroupFlags> {
  return getRepos().groups.getOrCreate(groupId);
}

export async function updateGroupFlags(
  groupId: string,
  patch: Partial<Omit<GroupFlags, 'groupId'>>
): Promise<GroupFlags> {
  return getRepos().groups.update(groupId, patch);
}

export async function setWaitingFlag(groupId: string, value: boolean): Promise<GroupFlags> {
  return updateGroupFlags(groupId, {
    waitingFlag: value,
    waitingFlagSetAt: value ? new Date().toISOString() : null,
  });
}

export async function clearWaitingFlag(groupId: string): Promise<GroupFlags> {
  return setWaitingFlag(groupId, false);
}

export async function setMute(groupId: string, muted: boolean): Promise<GroupFlags> {
  const patch: Partial<GroupFlags> = {
    mute: muted,
    muteUntil: muted ? 'until_consultant_clears' : null,
  };
  if (muted) {
    patch.waitingFlag = false;
    patch.waitingFlagSetAt = null;
  }
  return updateGroupFlags(groupId, patch);
}

export async function isMuted(groupId: string): Promise<boolean> {
  const flags = await getGroupFlags(groupId);
  return flags.mute === true;
}

export async function isInServicePeriod(groupId: string, now = new Date()): Promise<boolean> {
  const flags = await getGroupFlags(groupId);
  if (!flags.serviceStartAt || !flags.serviceEndAt) {
    return false;
  }
  const start = new Date(flags.serviceStartAt);
  const end = new Date(flags.serviceEndAt);
  return now >= start && now <= end;
}

export async function isServiceExpired(groupId: string, now = new Date()): Promise<boolean> {
  const flags = await getGroupFlags(groupId);
  if (!flags.serviceEndAt) {
    return false;
  }
  return now > new Date(flags.serviceEndAt);
}

export async function clearAllGroups(): Promise<void> {
  await getRepos().groups.clear();
}

export async function getAllGroups(): Promise<GroupFlags[]> {
  return getRepos().groups.findAll();
}

export { defaultFlags };
