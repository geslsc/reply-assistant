import { ThreadState, TIMEOUT_MS } from '../src/types';
import { deriveShortCode } from '../src/services/shortCodeService';
import {
  createPendingHandoff,
  getOpenPendingHandoffs,
  getPendingHandoffs,
} from '../src/services/pendingHandoffService';
import { executeReplyToGroup } from '../src/services/replyToGroupService';
import { createIssueThread, updateIssueThread } from '../src/services/issueThreadService';
import { handleConsultantMute } from '../src/services/consultantGroupControlService';
import { settleGroupTimeouts } from '../src/services/passiveTimeoutSettlement';
import { handleServiceIntroduction } from '../src/services/servicePeriodService';
import { updateGroupFlags } from '../src/services/groupFlags';
import { PendingHandoffInvalidReason, PendingHandoffStatus } from '../src/repositories/pendingHandoffTypes';
import {
  registerAdmin,
  approveConsultant,
  registerInviteCode,
  requestConsultantJoin,
} from '../src/services/consultantWhitelist';
import {
  resetTestState,
  TEST_ADMIN,
  TEST_CONSULTANT,
  TEST_GROUP,
} from './helpers/testSetup';

async function setupConsultant(): Promise<void> {
  await registerAdmin(TEST_ADMIN);
  await registerInviteCode('TESTCODE', TEST_ADMIN);
  await requestConsultantJoin(TEST_CONSULTANT, 'TESTCODE');
  await approveConsultant(TEST_ADMIN, TEST_CONSULTANT);
  await handleServiceIntroduction(TEST_GROUP, TEST_CONSULTANT);
}

function assertNoOpenPending(consultantId: string): Promise<void> {
  return getOpenPendingHandoffs(consultantId).then((open) => {
    expect(open.length).toBe(0);
  });
}

describe('Pending Handoffs Close Paths', () => {
  beforeEach(async () => {
    await resetTestState();
    await setupConsultant();
  });

  it('closes pending after successful consultant reply without hard delete', async () => {
    const thread = await createIssueThread(TEST_GROUP, 'Q');
    const shortCode = deriveShortCode(thread.issueThreadId, thread.createdAt);
    const handoff = await createPendingHandoff({
      consultantId: TEST_CONSULTANT,
      issueThreadId: thread.issueThreadId,
      groupId: TEST_GROUP,
      shortCode,
      customerQuestion: 'Q',
    });

    await executeReplyToGroup({
      consultantId: TEST_CONSULTANT,
      replyText: '逐字回覆',
      shortCode,
    });

    await assertNoOpenPending(TEST_CONSULTANT);
    const all = await getPendingHandoffs(TEST_CONSULTANT);
    const updated = all.find((h) => h.id === handoff.id);
    expect(updated?.status).toBe(PendingHandoffStatus.RESOLVED);
    expect(updated?.closedAt).not.toBeNull();
  });

  it('invalidates on passive timeout with passive_timeout reason', async () => {
    const thread = await createIssueThread(TEST_GROUP, 'Q');
    const shortCode = deriveShortCode(thread.issueThreadId, thread.createdAt);
    const handoff = await createPendingHandoff({
      consultantId: TEST_CONSULTANT,
      issueThreadId: thread.issueThreadId,
      groupId: TEST_GROUP,
      shortCode,
      customerQuestion: 'Q',
    });
    await updateIssueThread(TEST_GROUP, thread.issueThreadId, {
      state: ThreadState.CONSULTANT_HANDOFF,
      lastStateChangeAt: new Date(Date.now() - TIMEOUT_MS.CONSULTANT_HANDOFF - 1000).toISOString(),
    });
    await settleGroupTimeouts(TEST_GROUP);

    await assertNoOpenPending(TEST_CONSULTANT);
    const updated = (await getPendingHandoffs(TEST_CONSULTANT)).find((h) => h.id === handoff.id);
    expect(updated?.status).toBe(PendingHandoffStatus.IGNORED);
    expect(updated?.reason).toBe(PendingHandoffInvalidReason.PASSIVE_TIMEOUT);
  });

  it('invalidates on group mute with group_muted reason', async () => {
    const thread = await createIssueThread(TEST_GROUP, 'Q');
    const shortCode = deriveShortCode(thread.issueThreadId, thread.createdAt);
    const handoff = await createPendingHandoff({
      consultantId: TEST_CONSULTANT,
      issueThreadId: thread.issueThreadId,
      groupId: TEST_GROUP,
      shortCode,
      customerQuestion: 'Q',
    });

    await handleConsultantMute(TEST_GROUP, TEST_CONSULTANT, true);

    await assertNoOpenPending(TEST_CONSULTANT);
    const updated = (await getPendingHandoffs(TEST_CONSULTANT)).find((h) => h.id === handoff.id);
    expect(updated?.status).toBe(PendingHandoffStatus.IGNORED);
    expect(updated?.reason).toBe(PendingHandoffInvalidReason.GROUP_MUTED);
  });

  it('invalidates on service period end with service_ended reason', async () => {
    const thread = await createIssueThread(TEST_GROUP, 'Q');
    const shortCode = deriveShortCode(thread.issueThreadId, thread.createdAt);
    const handoff = await createPendingHandoff({
      consultantId: TEST_CONSULTANT,
      issueThreadId: thread.issueThreadId,
      groupId: TEST_GROUP,
      shortCode,
      customerQuestion: 'Q',
    });

    await updateGroupFlags(TEST_GROUP, {
      serviceEndAt: new Date(Date.now() - 60_000).toISOString(),
    });
    await settleGroupTimeouts(TEST_GROUP);

    await assertNoOpenPending(TEST_CONSULTANT);
    const updated = (await getPendingHandoffs(TEST_CONSULTANT)).find((h) => h.id === handoff.id);
    expect(updated?.status).toBe(PendingHandoffStatus.IGNORED);
    expect(updated?.reason).toBe(PendingHandoffInvalidReason.SERVICE_ENDED);
  });

  it('invalidates per thread on OUT_OF_SERVICE_PERIOD with out_of_service reason', async () => {
    const thread = await createIssueThread(TEST_GROUP, 'Q');
    const shortCode = deriveShortCode(thread.issueThreadId, thread.createdAt);
    const handoff = await createPendingHandoff({
      consultantId: TEST_CONSULTANT,
      issueThreadId: thread.issueThreadId,
      groupId: TEST_GROUP,
      shortCode,
      customerQuestion: 'Q',
    });

    await updateIssueThread(TEST_GROUP, thread.issueThreadId, {
      state: ThreadState.AI_ANSWERING,
      lastStateChangeAt: new Date().toISOString(),
    });
    await updateGroupFlags(TEST_GROUP, {
      serviceEndAt: new Date(Date.now() - 60_000).toISOString(),
    });
    await settleGroupTimeouts(TEST_GROUP);

    await assertNoOpenPending(TEST_CONSULTANT);
    const updated = (await getPendingHandoffs(TEST_CONSULTANT)).find((h) => h.id === handoff.id);
    expect(updated?.status).toBe(PendingHandoffStatus.IGNORED);
    expect(updated?.reason).toBe(PendingHandoffInvalidReason.OUT_OF_SERVICE);
  });
});
