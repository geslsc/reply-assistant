import { Actor, ThreadState } from '../types';
import { logStateTransition } from './eventLogService';
import {
  getIssueThread,
  transitionThreadState,
  updateIssueThread,
} from './issueThreadService';

export interface StateTransitionResult {
  success: boolean;
  fromState: ThreadState;
  toState: ThreadState;
  threadId: string;
}

const VALID_TRANSITIONS: Record<ThreadState, ThreadState[]> = {
  [ThreadState.IDLE]: [
    ThreadState.AI_CLARIFYING,
    ThreadState.AI_ANSWERING,
    ThreadState.CONSULTANT_HANDOFF,
    ThreadState.OUT_OF_SERVICE_PERIOD,
  ],
  [ThreadState.AI_CLARIFYING]: [
    ThreadState.AI_ANSWERING,
    ThreadState.CONSULTANT_HANDOFF,
    ThreadState.IDLE,
  ],
  [ThreadState.AI_ANSWERING]: [
    ThreadState.IDLE,
    ThreadState.CONSULTANT_HANDOFF,
    ThreadState.AI_CLARIFYING,
  ],
  [ThreadState.CONSULTANT_HANDOFF]: [ThreadState.IDLE, ThreadState.AI_ANSWERING],
  [ThreadState.OUT_OF_SERVICE_PERIOD]: [ThreadState.IDLE],
};

export function canTransition(from: ThreadState, to: ThreadState): boolean {
  if (from === to) {
    return true;
  }
  return VALID_TRANSITIONS[from]?.includes(to) ?? false;
}

export async function transitionState(params: {
  groupId: string;
  issueThreadId: string;
  toState: ThreadState;
  actor?: Actor;
  actorUserId?: string | null;
  detail?: string | null;
  force?: boolean;
}): Promise<StateTransitionResult | null> {
  const thread = await getIssueThread(params.groupId, params.issueThreadId);
  if (!thread) {
    return null;
  }

  const fromState = thread.state;
  const toState = params.toState;

  if (!params.force && !canTransition(fromState, toState)) {
    return null;
  }

  await transitionThreadState(params.groupId, params.issueThreadId, toState);
  await logStateTransition({
    group_id: params.groupId,
    issue_thread_id: params.issueThreadId,
    from_state: fromState,
    to_state: toState,
    actor: params.actor,
    actor_user_id: params.actorUserId ?? null,
    detail: params.detail ?? null,
  });

  return {
    success: true,
    fromState,
    toState,
    threadId: params.issueThreadId,
  };
}

export async function incrementClarifyRound(
  groupId: string,
  issueThreadId: string
): Promise<number> {
  const thread = await getIssueThread(groupId, issueThreadId);
  if (!thread) {
    return 0;
  }
  const next = thread.clarifyRound + 1;
  await updateIssueThread(groupId, issueThreadId, { clarifyRound: next });
  return next;
}

export async function getClarifyRound(
  groupId: string,
  issueThreadId: string
): Promise<number> {
  const thread = await getIssueThread(groupId, issueThreadId);
  return thread?.clarifyRound ?? 0;
}

export async function resetClarifyRound(
  groupId: string,
  issueThreadId: string
): Promise<void> {
  await updateIssueThread(groupId, issueThreadId, { clarifyRound: 0 });
}
