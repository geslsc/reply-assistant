import {
  IssueThread,
  IssueThreadStatus,
  ThreadState,
} from '../types';
import { getRepos } from '../repositories';
import { updateGroupFlags } from './groupFlags';

export async function createIssueThread(
  groupId: string,
  customerQuestion?: string
): Promise<IssueThread> {
  return getRepos().threads.create(groupId, customerQuestion);
}

export async function getIssueThread(
  groupId: string,
  issueThreadId: string
): Promise<IssueThread | undefined> {
  const thread = await getRepos().threads.findById(groupId, issueThreadId);
  return thread ?? undefined;
}

export async function getActiveIssueThread(groupId: string): Promise<IssueThread | undefined> {
  const thread = await getRepos().threads.findActiveByGroup(groupId);
  return thread ?? undefined;
}

export async function getThreadsByGroup(groupId: string): Promise<IssueThread[]> {
  return getRepos().threads.findByGroup(groupId);
}

export async function updateIssueThread(
  groupId: string,
  issueThreadId: string,
  patch: Partial<IssueThread>
): Promise<IssueThread | undefined> {
  const thread = await getRepos().threads.update(groupId, issueThreadId, patch);
  return thread ?? undefined;
}

export async function transitionThreadState(
  groupId: string,
  issueThreadId: string,
  newState: ThreadState
): Promise<IssueThread | undefined> {
  const thread = await getIssueThread(groupId, issueThreadId);
  if (!thread) {
    return undefined;
  }
  const now = new Date().toISOString();
  const patch: Partial<IssueThread> = {
    state: newState,
    lastStateChangeAt: now,
  };
  if (newState === ThreadState.AI_ANSWERING) {
    patch.hasSubstantiveAnswer = true;
  }
  return updateIssueThread(groupId, issueThreadId, patch);
}

export async function markConsultantAnswered(
  groupId: string,
  issueThreadId: string
): Promise<void> {
  const thread = await getIssueThread(groupId, issueThreadId);
  if (thread) {
    await updateIssueThread(groupId, issueThreadId, {
      consultantAnswered: true,
      hasSubstantiveAnswer: true,
    });
  }
}

export async function resolveThread(
  groupId: string,
  issueThreadId: string
): Promise<IssueThread | undefined> {
  const thread = await getIssueThread(groupId, issueThreadId);
  if (!thread) {
    return undefined;
  }
  await updateIssueThread(groupId, issueThreadId, {
    status: IssueThreadStatus.RESOLVED,
    state: ThreadState.IDLE,
  });
  await updateGroupFlags(groupId, { activeIssueThreadId: null });
  return getIssueThread(groupId, issueThreadId);
}

export async function reopenThread(
  groupId: string,
  issueThreadId: string
): Promise<IssueThread | undefined> {
  const thread = await getIssueThread(groupId, issueThreadId);
  if (!thread) {
    return undefined;
  }
  const now = new Date().toISOString();
  await updateIssueThread(groupId, issueThreadId, {
    status: IssueThreadStatus.ACTIVE,
    state: ThreadState.IDLE,
    lastStateChangeAt: now,
  });
  await updateGroupFlags(groupId, { activeIssueThreadId: issueThreadId });
  return getIssueThread(groupId, issueThreadId);
}

export async function markThreadWaiting(
  groupId: string,
  issueThreadId: string
): Promise<void> {
  await updateIssueThread(groupId, issueThreadId, { status: IssueThreadStatus.WAITING });
}

export function hasSubstantiveAnswer(thread: IssueThread): boolean {
  return (
    thread.hasSubstantiveAnswer ||
    (thread.state === ThreadState.CONSULTANT_HANDOFF && thread.consultantAnswered)
  );
}

export async function clearAllThreads(): Promise<void> {
  await getRepos().threads.clear();
}
