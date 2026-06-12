import {
  deliverBotReplies,
  mergeGroupReplies,
  setLineMessageClient,
  splitLineText,
} from '../src/services/lineMessageService';
import {
  registerAdmin,
  registerInviteCode,
  requestConsultantJoin,
  approveConsultant,
} from '../src/services/consultantWhitelist';
import { processMessage } from '../src/handlers/lineWebhookHandler';
import { handleServiceIntroduction } from '../src/services/servicePeriodService';
import { getRepos } from '../src/repositories';
import { handleViewPendingHandoffs } from '../src/services/pendingHandoffService';
import { CUSTOMER_HANDOFF_BUFFER_MESSAGE } from '../src/services/groupReplyCopyService';
import { TEST_ADMIN, TEST_CONSULTANT, TEST_CUSTOMER, TEST_GROUP } from './helpers/testSetup';

describe('LINE Reply / Push Tests', () => {
  it('splits long text into LINE-safe chunks', () => {
    const chunks = splitLineText(['第一段', '第二段'.repeat(3000)].join('\n\n'), 1000);

    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks.every((chunk) => chunk.length <= 1000)).toBe(true);
    expect(chunks.join('').replace(/\s/g, '')).toContain('第一段第二段');
  });

  it('uses replyMessage for low-risk public answer', async () => {
    const replyText = jest.fn().mockResolvedValue(undefined);
    const pushText = jest.fn().mockResolvedValue(null);
    setLineMessageClient({ replyText, pushText });

    await registerAdmin(TEST_ADMIN);
    await registerInviteCode('TESTCODE', TEST_ADMIN);
    await requestConsultantJoin(TEST_CONSULTANT, 'TESTCODE');
    await approveConsultant(TEST_ADMIN, TEST_CONSULTANT);
    await handleServiceIntroduction(TEST_GROUP, TEST_CONSULTANT);

    const result = await processMessage({
      userId: TEST_CUSTOMER,
      groupId: TEST_GROUP,
      text: '怎麼登入後台',
      isGroup: true,
    });
    await deliverBotReplies(result.replies, 'reply-token');

    expect(replyText).toHaveBeenCalled();
    expect(result.replies.some((r) => r.type === 'group')).toBe(true);
  });

  it('does not push consultant handoff notifications from group replies', async () => {
    const replyText = jest.fn().mockResolvedValue(undefined);
    const pushText = jest.fn().mockResolvedValue(null);
    setLineMessageClient({ replyText, pushText });

    await registerAdmin(TEST_ADMIN);
    await registerInviteCode('TESTCODE', TEST_ADMIN);
    await requestConsultantJoin(TEST_CONSULTANT, 'TESTCODE');
    await approveConsultant(TEST_ADMIN, TEST_CONSULTANT);
    await handleServiceIntroduction(TEST_GROUP, TEST_CONSULTANT);

    const result = await processMessage({
      userId: TEST_CUSTOMER,
      groupId: TEST_GROUP,
      text: '畫面一片空白',
      isGroup: true,
    });
    await deliverBotReplies(result.replies, 'reply-token');

    expect(pushText).not.toHaveBeenCalled();
    expect(result.replies.some((r) => r.type === 'push')).toBe(false);
  });

  it('notifies admin after consultant join pending', async () => {
    await registerAdmin(TEST_ADMIN);
    await registerInviteCode('TESTCODE', TEST_ADMIN);

    const result = await processMessage({
      userId: 'U-new-consultant',
      text: '加入顧問 TESTCODE',
      isGroup: false,
    });

    expect(result.replies.some((r) => r.type === 'push' && r.userId === TEST_ADMIN)).toBe(true);
  });

  it('merges multiple group replies into one replyMessage call', async () => {
    const replyText = jest.fn().mockResolvedValue(undefined);
    const pushText = jest.fn().mockResolvedValue(null);
    setLineMessageClient({ replyText, pushText });

    const replies = [
      { type: 'group' as const, text: '第一段公開回覆' },
      { type: 'group' as const, text: '第二段公開回覆' },
      { type: 'push' as const, userId: 'admin-001', text: '私訊顧問' },
    ];

    expect(mergeGroupReplies(replies)).toBe('第一段公開回覆\n\n第二段公開回覆');
    await deliverBotReplies(replies, 'reply-token');

    expect(replyText).toHaveBeenCalledTimes(1);
    expect(replyText).toHaveBeenCalledWith('reply-token', '第一段公開回覆\n\n第二段公開回覆');
    expect(pushText).toHaveBeenCalledTimes(1);
  });

  it('does not crash webhook delivery when LINE API errors', async () => {
    setLineMessageClient({
      replyText: jest.fn().mockRejectedValue(new Error('LINE API error')),
      pushText: jest.fn().mockRejectedValue(new Error('LINE API error')),
    });

    await expect(
      deliverBotReplies([{ type: 'group', text: 'test' }], 'reply-token')
    ).resolves.toBeUndefined();
  });

  it('uses replyMessage for private replies to the triggering user', async () => {
    const replyText = jest.fn().mockResolvedValue(undefined);
    const pushText = jest.fn().mockResolvedValue(null);
    setLineMessageClient({ replyText, pushText });

    await deliverBotReplies(
      [{ type: 'push', userId: TEST_ADMIN, text: '使用說明內容' }],
      'reply-token-private',
      TEST_ADMIN
    );

    expect(replyText).toHaveBeenCalledWith('reply-token-private', '使用說明內容');
    expect(pushText).not.toHaveBeenCalled();
  });

  it('keeps pushing private replies that target other users', async () => {
    const replyText = jest.fn().mockResolvedValue(undefined);
    const pushText = jest.fn().mockResolvedValue('mock-id');
    setLineMessageClient({ replyText, pushText });

    await deliverBotReplies(
      [
        { type: 'push', userId: TEST_ADMIN, text: '已核准' },
        { type: 'push', userId: TEST_CONSULTANT, text: '您已核准' },
      ],
      'reply-token-private',
      TEST_ADMIN
    );

    expect(replyText).toHaveBeenCalledWith('reply-token-private', '已核准');
    expect(pushText).toHaveBeenCalledWith(TEST_CONSULTANT, '您已核准');
  });

  it('notifies fallback users when push delivery fails', async () => {
    const replyText = jest.fn().mockResolvedValue(undefined);
    const pushText = jest
      .fn()
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce('fallback-message-id');
    setLineMessageClient({ replyText, pushText });
    await registerAdmin(TEST_ADMIN);
    await registerInviteCode('TESTCODE', TEST_ADMIN);
    await requestConsultantJoin(TEST_CONSULTANT, 'TESTCODE');
    await approveConsultant(TEST_ADMIN, TEST_CONSULTANT);

    await deliverBotReplies([
      {
        type: 'push',
        userId: TEST_CONSULTANT,
        text: '問題收斂卡',
        trackDeliveryHealthUserId: TEST_CONSULTANT,
        deliveryFailureFallbackUserIds: [TEST_ADMIN],
        deliveryFailureText: 'handoff 私訊投遞失敗',
      },
    ]);

    expect(pushText).toHaveBeenNthCalledWith(1, TEST_CONSULTANT, '問題收斂卡');
    expect(pushText).toHaveBeenNthCalledWith(2, TEST_ADMIN, 'handoff 私訊投遞失敗');
    expect((await getRepos().consultants.findById(TEST_CONSULTANT))?.pushFailureCount).toBe(1);
  });

  it('clears tracked push failures after successful delivery', async () => {
    const replyText = jest.fn().mockResolvedValue(undefined);
    const pushText = jest.fn().mockResolvedValue('message-id');
    setLineMessageClient({ replyText, pushText });
    await registerAdmin(TEST_ADMIN);
    await registerInviteCode('TESTCODE', TEST_ADMIN);
    await requestConsultantJoin(TEST_CONSULTANT, 'TESTCODE');
    await approveConsultant(TEST_ADMIN, TEST_CONSULTANT);
    await getRepos().consultants.recordPushFailure(TEST_CONSULTANT, new Date().toISOString());

    await deliverBotReplies([
      {
        type: 'push',
        userId: TEST_CONSULTANT,
        text: '問題收斂卡',
        trackDeliveryHealthUserId: TEST_CONSULTANT,
      },
    ]);

    expect((await getRepos().consultants.findById(TEST_CONSULTANT))?.pushFailureCount).toBe(0);
  });

  it('transfers pending handoff to fallback recipient when primary push fails', async () => {
    const replyText = jest.fn().mockResolvedValue(undefined);
    const pushText = jest
      .fn()
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce('fallback-message-id');
    setLineMessageClient({ replyText, pushText });
    await registerAdmin(TEST_ADMIN);
    await registerInviteCode('TESTCODE', TEST_ADMIN);
    await requestConsultantJoin(TEST_CONSULTANT, 'TESTCODE');
    await approveConsultant(TEST_ADMIN, TEST_CONSULTANT);
    await getRepos().pendingHandoffs.create({
      consultantId: TEST_CONSULTANT,
      issueThreadId: 'thread-001',
      groupId: TEST_GROUP,
      shortCode: 'H-01',
      customerQuestion: '店家問題',
    });

    await deliverBotReplies([
      {
        type: 'push',
        userId: TEST_CONSULTANT,
        text: '問題收斂卡',
        trackDeliveryHealthUserId: TEST_CONSULTANT,
        deliveryFailureHandoffTransfer: {
          groupId: TEST_GROUP,
          fromUserId: TEST_CONSULTANT,
          toUserId: TEST_ADMIN,
          transferText: 'handoff 已自動轉交給您',
        },
      },
    ]);

    expect(pushText).toHaveBeenNthCalledWith(1, TEST_CONSULTANT, '問題收斂卡');
    expect(pushText).toHaveBeenNthCalledWith(2, TEST_ADMIN, 'handoff 已自動轉交給您');
    expect(await getRepos().pendingHandoffs.findOpenByConsultant(TEST_CONSULTANT)).toHaveLength(0);
    expect(await getRepos().pendingHandoffs.findOpenByConsultant(TEST_ADMIN)).toHaveLength(1);
  });

  it('keeps admin handoff retrievable when sole admin private push is rate limited', async () => {
    const replyText = jest.fn().mockResolvedValue(undefined);
    const pushText = jest.fn().mockResolvedValue(null);
    setLineMessageClient({ replyText, pushText });

    await registerAdmin(TEST_ADMIN);
    await handleServiceIntroduction(TEST_GROUP, TEST_ADMIN);

    const result = await processMessage({
      userId: TEST_CUSTOMER,
      groupId: TEST_GROUP,
      text: '儲值餘額異常怎麼辦',
      isGroup: true,
    });
    await deliverBotReplies(result.replies, 'reply-token');

    expect(replyText).toHaveBeenCalledWith('reply-token', CUSTOMER_HANDOFF_BUFFER_MESSAGE);
    expect(replyText).not.toHaveBeenCalledWith(
      'reply-token',
      expect.stringContaining('查看待處理問題')
    );
    expect(replyText).not.toHaveBeenCalledWith('reply-token', expect.stringContaining('私訊'));
    expect(pushText).not.toHaveBeenCalled();
    expect(await getRepos().pendingHandoffs.findOpenByConsultant(TEST_ADMIN)).toHaveLength(1);

    const fallback = await handleViewPendingHandoffs(TEST_ADMIN);
    expect(fallback[0].text).toContain('【待處理問題清單】');
    expect(fallback[0].text).toContain('儲值餘額異常');
  });
});
