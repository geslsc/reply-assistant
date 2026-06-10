import { deliverBotReplies, mergeGroupReplies, setLineMessageClient } from '../src/services/lineMessageService';
import {
  registerAdmin,
  registerInviteCode,
  requestConsultantJoin,
  approveConsultant,
} from '../src/services/consultantWhitelist';
import { processMessage } from '../src/handlers/lineWebhookHandler';
import { handleServiceIntroduction } from '../src/services/servicePeriodService';
import { TEST_ADMIN, TEST_CONSULTANT, TEST_CUSTOMER, TEST_GROUP } from './helpers/testSetup';

describe('LINE Reply / Push Tests', () => {
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

  it('uses pushMessage for consultant handoff', async () => {
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

    expect(pushText).toHaveBeenCalled();
    expect(result.replies.some((r) => r.type === 'push')).toBe(true);
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
});
