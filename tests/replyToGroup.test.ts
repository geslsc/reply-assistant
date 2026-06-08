import { EventType, ThreadState, TIMEOUT_MS } from '../src/types';
import { deriveShortCode } from '../src/services/shortCodeService';
import {
  buildHandoffPrivateCard,
  createPendingHandoff,
  getOpenPendingHandoffs,
  getPendingHandoffs,
} from '../src/services/pendingHandoffService';
import { executeReplyToGroup } from '../src/services/replyToGroupService';
import { createIssueThread, resolveThread, updateIssueThread } from '../src/services/issueThreadService';
import { getEventsByType } from '../src/services/eventLogService';
import { handleConsultantMute } from '../src/services/consultantGroupControlService';
import { settleGroupTimeouts } from '../src/services/passiveTimeoutSettlement';
import { handleServiceIntroduction, isOutOfService } from '../src/services/servicePeriodService';
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
  TEST_CUSTOMER,
  TEST_GROUP,
  TEST_GROUP_B,
} from './helpers/testSetup';

async function setupConsultant(): Promise<void> {
  await registerAdmin(TEST_ADMIN);
  await registerInviteCode('TESTCODE', TEST_ADMIN);
  await requestConsultantJoin(TEST_CONSULTANT, 'TESTCODE');
  await approveConsultant(TEST_ADMIN, TEST_CONSULTANT);
  await handleServiceIntroduction(TEST_GROUP, TEST_CONSULTANT);
  await handleServiceIntroduction(TEST_GROUP_B, TEST_CONSULTANT);
}

describe('Pending Handoffs and Reply To Group', () => {
  beforeEach(async () => {
    await resetTestState();
    await setupConsultant();
  });

  it('derives short code from issueThreadId and createdAt', () => {
    const code = deriveShortCode('a7b3d0d9-ed10-4a46-8db6-a36da98623f2', '2026-06-08T01:33:00.000Z');
    expect(code).toBe('Q-20260608-0133-A3');
  });

  it('shows groupId label when group name unavailable in handoff card', () => {
    const card = buildHandoffPrivateCard({
      groupId: TEST_GROUP,
      shortCode: 'Q-20260608-0100-A1',
      customerQuestion: '登入問題',
    });
    expect(card).toContain('尚未取得群組名稱');
    expect(card).toContain(`groupId: ${TEST_GROUP}`);
  });

  it('rejects reply when multiple pending without short code', async () => {
    await createPendingHandoff({
      consultantId: TEST_CONSULTANT,
      issueThreadId: 'thread-1',
      groupId: TEST_GROUP,
      shortCode: 'Q-20260608-0100-A1',
      customerQuestion: 'Q1',
    });
    await createPendingHandoff({
      consultantId: TEST_CONSULTANT,
      issueThreadId: 'thread-2',
      groupId: TEST_GROUP,
      shortCode: 'Q-20260608-0200-B2',
      customerQuestion: 'Q2',
    });

    const result = await executeReplyToGroup({
      consultantId: TEST_CONSULTANT,
      replyText: '請試試看',
    });
    expect(result.success).toBe(false);
    expect(result.replies[0].text).toContain('指定問題短碼');
  });

  it('routes short code to correct group among multi-group pending', async () => {
    const threadA = await createIssueThread(TEST_GROUP, '群組A問題');
    const threadB = await createIssueThread(TEST_GROUP_B, '群組B問題');
    const codeA = deriveShortCode(threadA.issueThreadId, threadA.createdAt);
    const codeB = deriveShortCode(threadB.issueThreadId, threadB.createdAt);
    await createPendingHandoff({
      consultantId: TEST_CONSULTANT,
      issueThreadId: threadA.issueThreadId,
      groupId: TEST_GROUP,
      shortCode: codeA,
      customerQuestion: '群組A問題',
    });
    await createPendingHandoff({
      consultantId: TEST_CONSULTANT,
      issueThreadId: threadB.issueThreadId,
      groupId: TEST_GROUP_B,
      shortCode: codeB,
      customerQuestion: '群組B問題',
    });

    const result = await executeReplyToGroup({
      consultantId: TEST_CONSULTANT,
      replyText: 'B群組專用回覆',
      shortCode: codeB,
    });
    expect(result.success).toBe(true);
    const groupPush = result.replies.find((r) => r.type === 'push' && r.userId === TEST_GROUP_B);
    expect(groupPush?.text).toBe('B群組專用回覆');
    expect(result.replies.some((r) => r.userId === TEST_GROUP && r.text === 'B群組專用回覆')).toBe(false);
  });

  it('allows single pending alias and uses pushMessage target', async () => {
    const thread = await createIssueThread(TEST_GROUP, '登入問題');
    const shortCode = deriveShortCode(thread.issueThreadId, thread.createdAt);
    await createPendingHandoff({
      consultantId: TEST_CONSULTANT,
      issueThreadId: thread.issueThreadId,
      groupId: TEST_GROUP,
      shortCode,
      customerQuestion: '登入問題',
    });

    const result = await executeReplyToGroup({
      consultantId: TEST_CONSULTANT,
      replyText: '請清除快取後再試',
    });
    expect(result.success).toBe(true);
    expect(result.replies.every((r) => r.type === 'push')).toBe(true);
    const groupPush = result.replies.find((r) => r.type === 'push' && r.userId === TEST_GROUP);
    expect(groupPush?.text).toBe('請清除快取後再試');

    const open = await getOpenPendingHandoffs(TEST_CONSULTANT);
    expect(open.length).toBe(0);
  });

  it('logs consultant_override with intent=REPLY_TO_GROUP', async () => {
    const thread = await createIssueThread(TEST_GROUP, 'Q');
    const shortCode = deriveShortCode(thread.issueThreadId, thread.createdAt);
    await createPendingHandoff({
      consultantId: TEST_CONSULTANT,
      issueThreadId: thread.issueThreadId,
      groupId: TEST_GROUP,
      shortCode,
      customerQuestion: 'Q',
    });

    await executeReplyToGroup({
      consultantId: TEST_CONSULTANT,
      replyText: '逐字回覆',
    });

    const events = await getEventsByType(EventType.CONSULTANT_OVERRIDE);
    expect(events.some((e) => e.detail?.includes('intent=REPLY_TO_GROUP'))).toBe(true);
  });

  it('rejects reply for resolved thread via check two', async () => {
    const thread = await createIssueThread(TEST_GROUP, 'Q');
    const shortCode = deriveShortCode(thread.issueThreadId, thread.createdAt);
    await createPendingHandoff({
      consultantId: TEST_CONSULTANT,
      issueThreadId: thread.issueThreadId,
      groupId: TEST_GROUP,
      shortCode,
      customerQuestion: 'Q',
    });
    await resolveThread(TEST_GROUP, thread.issueThreadId);

    const result = await executeReplyToGroup({
      consultantId: TEST_CONSULTANT,
      replyText: 'test',
      shortCode,
    });
    expect(result.success).toBe(false);
    expect(result.replies[0].text).toContain('已結案');
  });

  it('rejects reply when group muted', async () => {
    const thread = await createIssueThread(TEST_GROUP, 'Q');
    const shortCode = deriveShortCode(thread.issueThreadId, thread.createdAt);
    await createPendingHandoff({
      consultantId: TEST_CONSULTANT,
      issueThreadId: thread.issueThreadId,
      groupId: TEST_GROUP,
      shortCode,
      customerQuestion: 'Q',
    });
    await handleConsultantMute(TEST_GROUP, TEST_CONSULTANT, true);

    const result = await executeReplyToGroup({
      consultantId: TEST_CONSULTANT,
      replyText: 'test',
      shortCode,
    });
    expect(result.success).toBe(false);
    expect(result.replies[0].text).toContain('mute');
  });

  it('rejects reply when service period ended', async () => {
    const thread = await createIssueThread(TEST_GROUP, 'Q');
    const shortCode = deriveShortCode(thread.issueThreadId, thread.createdAt);
    await createPendingHandoff({
      consultantId: TEST_CONSULTANT,
      issueThreadId: thread.issueThreadId,
      groupId: TEST_GROUP,
      shortCode,
      customerQuestion: 'Q',
    });
    await updateGroupFlags(TEST_GROUP, {
      serviceEndAt: new Date(Date.now() - 60_000).toISOString(),
    });
    expect(await isOutOfService(TEST_GROUP)).toBe(true);

    const result = await executeReplyToGroup({
      consultantId: TEST_CONSULTANT,
      replyText: 'test',
      shortCode,
    });
    expect(result.success).toBe(false);
    expect(result.replies[0].text).toContain('教學協助期已結束');
  });

  it('rejects reply for OUT_OF_SERVICE_PERIOD thread state', async () => {
    const thread = await createIssueThread(TEST_GROUP, 'Q');
    const shortCode = deriveShortCode(thread.issueThreadId, thread.createdAt);
    await createPendingHandoff({
      consultantId: TEST_CONSULTANT,
      issueThreadId: thread.issueThreadId,
      groupId: TEST_GROUP,
      shortCode,
      customerQuestion: 'Q',
    });
    await updateIssueThread(TEST_GROUP, thread.issueThreadId, {
      state: ThreadState.OUT_OF_SERVICE_PERIOD,
    });

    const result = await executeReplyToGroup({
      consultantId: TEST_CONSULTANT,
      replyText: 'test',
      shortCode,
    });
    expect(result.success).toBe(false);
    expect(result.replies[0].text).toContain('OUT_OF_SERVICE_PERIOD');
  });

  it('rejects reply for unauthorized user', async () => {
    const thread = await createIssueThread(TEST_GROUP, 'Q');
    const shortCode = deriveShortCode(thread.issueThreadId, thread.createdAt);
    await createPendingHandoff({
      consultantId: TEST_CONSULTANT,
      issueThreadId: thread.issueThreadId,
      groupId: TEST_GROUP,
      shortCode,
      customerQuestion: 'Q',
    });

    const result = await executeReplyToGroup({
      consultantId: TEST_CUSTOMER,
      replyText: 'hack',
      shortCode,
    });
    expect(result.success).toBe(false);
    expect(result.replies[0].text).toContain('權限不足');
  });

  it('invalidates pending on mute and passive timeout without hard delete', async () => {
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
    const afterMute = await getPendingHandoffs(TEST_CONSULTANT);
    expect(afterMute.find((h) => h.id === handoff.id)?.status).toBe(PendingHandoffStatus.INVALID);
    expect(afterMute.find((h) => h.id === handoff.id)?.invalidReason).toBe(
      PendingHandoffInvalidReason.GROUP_MUTED
    );

    const handoff2 = await createPendingHandoff({
      consultantId: TEST_CONSULTANT,
      issueThreadId: thread.issueThreadId,
      groupId: TEST_GROUP,
      shortCode: `${shortCode}-2`,
      customerQuestion: 'Q2',
    });
    await updateIssueThread(TEST_GROUP, thread.issueThreadId, {
      state: ThreadState.CONSULTANT_HANDOFF,
      lastStateChangeAt: new Date(Date.now() - TIMEOUT_MS.CONSULTANT_HANDOFF - 1000).toISOString(),
    });
    await settleGroupTimeouts(TEST_GROUP);

    const afterStale = await getPendingHandoffs(TEST_CONSULTANT);
    expect(afterStale.find((h) => h.id === handoff2.id)?.status).toBe(PendingHandoffStatus.INVALID);
  });
});

describe('Event type red lines', () => {
  it('still uses only 10 event types', () => {
    expect(Object.values(EventType).length).toBe(10);
    expect(Object.values(ThreadState).length).toBe(5);
  });
});
