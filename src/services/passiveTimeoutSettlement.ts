import { Actor, ThreadState, TIMEOUT_MS } from '../types';
import { logStateTransition } from './eventLogService';
import {
  clearWaitingFlag,
  getGroupFlags,
  getAllGroups,
  isServiceExpired,
} from './groupFlags';
import {
  getThreadsByGroup,
  transitionThreadState,
  updateIssueThread,
} from './issueThreadService';

export interface SettlementResult {
  groupId: string;
  settledThreads: Array<{
    issueThreadId: string;
    fromState: ThreadState;
    toState: ThreadState;
    reason: string;
  }>;
  groupFlagChanges: string[];
}

function msSince(isoTimestamp: string, now: Date): number {
  return now.getTime() - new Date(isoTimestamp).getTime();
}

export async function settleGroupTimeouts(
  groupId: string,
  now: Date = new Date()
): Promise<SettlementResult> {
  const result: SettlementResult = {
    groupId,
    settledThreads: [],
    groupFlagChanges: [],
  };

  const flags = await getGroupFlags(groupId);

  if (
    flags.waitingFlag &&
    flags.waitingFlagSetAt &&
    msSince(flags.waitingFlagSetAt, now) > TIMEOUT_MS.WAITING_FLAG
  ) {
    await clearWaitingFlag(groupId);
    result.groupFlagChanges.push('waitingFlag_cleared_timeout');
    await logStateTransition({
      group_id: groupId,
      issue_thread_id: flags.activeIssueThreadId ?? 'group-level',
      from_state: ThreadState.IDLE,
      to_state: ThreadState.IDLE,
      actor: Actor.SYSTEM,
      detail: 'stale: waitingFlag timeout cleared',
    });
  }

  if (await isServiceExpired(groupId, now)) {
    const expiredThreads = await getThreadsByGroup(groupId);
    for (const thread of expiredThreads) {
      if (
        thread.state !== ThreadState.OUT_OF_SERVICE_PERIOD &&
        thread.state !== ThreadState.IDLE
      ) {
        const fromState = thread.state;
        await transitionThreadState(thread.groupId, thread.issueThreadId, ThreadState.OUT_OF_SERVICE_PERIOD);
        await logStateTransition({
          group_id: groupId,
          issue_thread_id: thread.issueThreadId,
          from_state: fromState,
          to_state: ThreadState.OUT_OF_SERVICE_PERIOD,
          actor: Actor.SYSTEM,
          detail: 'stale: service period expired',
        });
        result.settledThreads.push({
          issueThreadId: thread.issueThreadId,
          fromState,
          toState: ThreadState.OUT_OF_SERVICE_PERIOD,
          reason: 'service_expired',
        });
      }
    }
  }

  const threads = await getThreadsByGroup(groupId);
  for (const thread of threads) {
    const elapsed = msSince(thread.lastStateChangeAt, now);
    const fromState = thread.state;
    let toState: ThreadState | null = null;
    let reason = '';

    switch (thread.state) {
      case ThreadState.AI_CLARIFYING:
        if (elapsed > TIMEOUT_MS.AI_CLARIFYING) {
          toState = ThreadState.IDLE;
          reason = 'stale: AI_CLARIFYING timeout';
        }
        break;
      case ThreadState.AI_ANSWERING:
        if (elapsed > TIMEOUT_MS.AI_ANSWERING) {
          toState = ThreadState.IDLE;
          reason = 'stale: AI_ANSWERING timeout - no longer same follow-up';
        }
        break;
      case ThreadState.CONSULTANT_HANDOFF:
        if (elapsed > TIMEOUT_MS.CONSULTANT_HANDOFF) {
          toState = ThreadState.IDLE;
          reason = 'stale: CONSULTANT_HANDOFF window ended';
        }
        break;
      default:
        break;
    }

    if (toState) {
      await transitionThreadState(thread.groupId, thread.issueThreadId, toState);
      await updateIssueThread(thread.groupId, thread.issueThreadId, { clarifyRound: 0 });
      await logStateTransition({
        group_id: groupId,
        issue_thread_id: thread.issueThreadId,
        from_state: fromState,
        to_state: toState,
        actor: Actor.SYSTEM,
        detail: reason,
      });
      result.settledThreads.push({
        issueThreadId: thread.issueThreadId,
        fromState,
        toState,
        reason,
      });
    }
  }

  return result;
}

export async function settleAllGroupsTimeouts(now: Date = new Date()): Promise<SettlementResult[]> {
  const groups = await getAllGroups();
  const results: SettlementResult[] = [];
  for (const g of groups) {
    results.push(await settleGroupTimeouts(g.groupId, now));
  }
  return results;
}
