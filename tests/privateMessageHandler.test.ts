import { EventType } from '../src/types';
import { processMessage } from '../src/handlers/lineWebhookHandler';
import { setPendingConfirmation } from '../src/services/consultantConfirmationService';
import { ConsultantIntent } from '../src/services/consultantIntentClassifier';
import { createPendingHandoff } from '../src/services/pendingHandoffService';
import { createIssueThread } from '../src/services/issueThreadService';
import { deriveShortCode } from '../src/services/shortCodeService';
import { handleServiceIntroduction } from '../src/services/servicePeriodService';
import { getLlmClient, setLlmClient } from '../src/services/knowledgeCardDraftService';
import { getEventsByType } from '../src/services/eventLogService';
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
} from './helpers/testSetup';

async function setupActiveConsultant(): Promise<void> {
  await registerAdmin(TEST_ADMIN);
  await registerInviteCode('TESTCODE', TEST_ADMIN);
  await requestConsultantJoin(TEST_CONSULTANT, 'TESTCODE');
  await approveConsultant(TEST_ADMIN, TEST_CONSULTANT);
}

function privateMsg(userId: string, text: string) {
  return processMessage({ userId, text, isGroup: false });
}

describe('Private message handler entry order', () => {
  beforeEach(async () => {
    await resetTestState();
    setLlmClient(null);
  });

  it('active admin private AI draft does not return userId-only reply', async () => {
    await registerAdmin(TEST_ADMIN);
    const result = await privateMsg(TEST_ADMIN, '整理知識卡：測試問題');
    expect(result.replies[0].text).toContain('AI 草稿整理尚未啟用');
    expect(result.replies[0].text).not.toMatch(/^您目前是 active admin/);
  });

  it('active admin private summarize does not return userId-only reply', async () => {
    await registerAdmin(TEST_ADMIN);
    const result = await privateMsg(TEST_ADMIN, '摘要店家問題');
    expect(result.replies[0].text).toContain('AI 草稿整理尚未啟用');
  });

  it('active admin private reply-to-group enters confirmation flow', async () => {
    await registerAdmin(TEST_ADMIN);
    await handleServiceIntroduction(TEST_GROUP, TEST_ADMIN);
    const thread = await createIssueThread(TEST_GROUP, 'Q');
    const shortCode = deriveShortCode(thread.issueThreadId, thread.createdAt);
    await createPendingHandoff({
      consultantId: TEST_ADMIN,
      issueThreadId: thread.issueThreadId,
      groupId: TEST_GROUP,
      shortCode,
      customerQuestion: 'Q',
    });

    const result = await privateMsg(TEST_ADMIN, '代回群組：逐字內容');
    expect(result.replies[0].text).toContain('確認代回');
    expect(result.replies[0].text).not.toContain('您的 LINE userId');
  });

  it('active admin confirm reply executes REPLY_TO_GROUP via pushMessage', async () => {
    await registerAdmin(TEST_ADMIN);
    await handleServiceIntroduction(TEST_GROUP, TEST_ADMIN);
    const thread = await createIssueThread(TEST_GROUP, 'Q');
    const shortCode = deriveShortCode(thread.issueThreadId, thread.createdAt);
    await createPendingHandoff({
      consultantId: TEST_ADMIN,
      issueThreadId: thread.issueThreadId,
      groupId: TEST_GROUP,
      shortCode,
      customerQuestion: 'Q',
    });
    setPendingConfirmation(TEST_ADMIN, {
      intent: ConsultantIntent.REPLY_TO_GROUP,
      payload: '逐字代回內容',
      shortCode,
    });

    const complete = jest.fn();
    setLlmClient({ complete });

    const result = await privateMsg(TEST_ADMIN, '確認代回');
    const groupPush = result.replies.find((r) => r.type === 'push' && r.userId === TEST_GROUP);
    expect(groupPush?.text).toContain('逐字代回內容');
    expect(complete).not.toHaveBeenCalled();

    const events = await getEventsByType(EventType.CONSULTANT_OVERRIDE);
    expect(events.some((e) => e.detail?.includes('intent=REPLY_TO_GROUP'))).toBe(true);
  });

  it('active consultant private AI draft does not return userId-only reply', async () => {
    await setupActiveConsultant();
    const result = await privateMsg(TEST_CONSULTANT, '整理知識卡：測試問題');
    expect(result.replies[0].text).toContain('AI 草稿整理尚未啟用');
  });

  it('active consultant private reply-to-group enters confirmation flow', async () => {
    await setupActiveConsultant();
    await handleServiceIntroduction(TEST_GROUP, TEST_CONSULTANT);
    const thread = await createIssueThread(TEST_GROUP, 'Q');
    const shortCode = deriveShortCode(thread.issueThreadId, thread.createdAt);
    await createPendingHandoff({
      consultantId: TEST_CONSULTANT,
      issueThreadId: thread.issueThreadId,
      groupId: TEST_GROUP,
      shortCode,
      customerQuestion: 'Q',
    });

    const result = await privateMsg(TEST_CONSULTANT, '代回群組：測試');
    expect(result.replies[0].text).toContain('確認代回');
  });

  it('identity query returns role status and capabilities', async () => {
    await registerAdmin(TEST_ADMIN);
    const result = await privateMsg(TEST_ADMIN, '我的層級');
    expect(result.replies[0].text).toContain(`LINE userId: ${TEST_ADMIN}`);
    expect(result.replies[0].text).toContain('role: admin');
    expect(result.replies[0].text).toContain('status: active');
    expect(result.replies[0].text).toContain('代回群組：是');
    expect(result.replies[0].text).toContain('AI 草稿整理：是');
  });

  it('active admin general private message returns hint not userId-only', async () => {
    await registerAdmin(TEST_ADMIN);
    const result = await privateMsg(TEST_ADMIN, 'hello');
    expect(result.replies[0].text).toContain('已收到');
    expect(result.replies[0].text).toContain('我的層級');
    expect(result.replies[0].text).not.toMatch(/^您目前是 active admin/);
    expect(getLlmClient()).toBeNull();
  });

  it('pending consultant cannot enter workflow commands', async () => {
    await registerAdmin(TEST_ADMIN);
    await registerInviteCode('PEND', TEST_ADMIN);
    await requestConsultantJoin(TEST_CUSTOMER, 'PEND');

    const draft = await privateMsg(TEST_CUSTOMER, '整理知識卡：測試問題');
    expect(draft.replies[0].text).toContain('不可使用');

    const reply = await privateMsg(TEST_CUSTOMER, '代回群組：xxx');
    expect(reply.replies[0].text).toContain('不可使用');

    const confirm = await privateMsg(TEST_CUSTOMER, '確認代回');
    expect(confirm.replies[0].text).toContain('不可使用');
  });
});
