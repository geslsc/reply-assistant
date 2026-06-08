import { EventType, ThreadState, TIMEOUT_MS } from '../src/types';
import { settleGroupTimeouts } from '../src/services/passiveTimeoutSettlement';
import { createIssueThread, getIssueThread, updateIssueThread } from '../src/services/issueThreadService';
import { getEventsByType } from '../src/services/eventLogService';
import { TEST_GROUP, TEST_GROUP_B } from './helpers/testSetup';

describe('Memory Passive Settlement Tests', () => {
  it('settles multiple stale threads in same group with state_transition each', async () => {
    const t1 = await createIssueThread(TEST_GROUP, 'q1');
    const t2 = await createIssueThread(TEST_GROUP, 'q2');

    await updateIssueThread(TEST_GROUP, t1.issueThreadId, {
      state: ThreadState.AI_CLARIFYING,
      lastStateChangeAt: new Date(Date.now() - TIMEOUT_MS.AI_CLARIFYING - 1000).toISOString(),
    });
    await updateIssueThread(TEST_GROUP, t2.issueThreadId, {
      state: ThreadState.CONSULTANT_HANDOFF,
      lastStateChangeAt: new Date(Date.now() - TIMEOUT_MS.CONSULTANT_HANDOFF - 1000).toISOString(),
    });

    const result = await settleGroupTimeouts(TEST_GROUP, new Date());
    expect(result.settledThreads.length).toBe(2);

    const transitions = (await getEventsByType(EventType.STATE_TRANSITION)).filter((e) =>
      e.detail?.startsWith('stale:')
    );
    expect(transitions.length).toBeGreaterThanOrEqual(2);
  });

  it('does not settle threads from other groups', async () => {
    const other = await createIssueThread(TEST_GROUP_B, 'other');
    await updateIssueThread(TEST_GROUP_B, other.issueThreadId, {
      state: ThreadState.AI_CLARIFYING,
      lastStateChangeAt: new Date(Date.now() - TIMEOUT_MS.AI_CLARIFYING - 1000).toISOString(),
    });

    await settleGroupTimeouts(TEST_GROUP, new Date());
    expect((await getIssueThread(TEST_GROUP_B, other.issueThreadId))!.state).toBe(
      ThreadState.AI_CLARIFYING
    );
  });
});
