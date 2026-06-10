import crypto from 'crypto';
import express from 'express';
import request from 'supertest';
import { loadEnv, resetEnvCache } from '../src/config/env';
import { resetRepositories } from '../src/repositories';
import { handleLineWebhook } from '../src/routes/lineWebhook';
import { setLlmClient } from '../src/services/knowledgeCardDraftService';
import { setLineMessageClient } from '../src/services/lineMessageService';
import {
  registerAdmin,
  registerInviteCode,
  requestConsultantJoin,
  approveConsultant,
} from '../src/services/consultantWhitelist';
import { handleServiceIntroduction } from '../src/services/servicePeriodService';
import { initKnowledgeBase } from '../src/services/knowledgeBaseService';
import { processMessage } from '../src/handlers/lineWebhookHandler';
import * as dmSessionImageService from '../src/services/dmSessionImageService';
import { seedActiveSessionForTest } from '../src/services/dmSessionService';
import { KnowledgeCard } from '../src/schemas/knowledgeCardSchema';
import { RiskLevel } from '../src/types';
import { TEST_ADMIN, TEST_CONSULTANT, TEST_CUSTOMER, TEST_GROUP } from './helpers/testSetup';

const SECRET = 'test-channel-secret';

const sampleCard: KnowledgeCard = {
  card_id: 'webhook-dedup-card',
  title: '快速結帳功能常見問題',
  patterns: ['快速結帳'],
  risk_level: RiskLevel.LOW,
  can_public_reply: true,
  standard_answer: '請依照快速結帳流程操作。',
  not_applicable: [],
  escalate_to_consultant: [],
  status: '可用',
};

function sign(body: string): string {
  return crypto.createHmac('sha256', SECRET).update(body).digest('base64');
}

function buildWebhookBody(events: unknown[]): string {
  return JSON.stringify({ events });
}

describe('LINE Webhook Tests', () => {
  let app: express.Application;

  beforeEach(async () => {
    resetEnvCache();
    loadEnv({
      NODE_ENV: 'test',
      USE_MEMORY_REPOS: true,
      DEBOUNCE_SECONDS: 0,
      LINE_CHANNEL_SECRET: SECRET,
    });
    await resetRepositories('memory');
    setLlmClient(null);
    setLineMessageClient(null);
    await initKnowledgeBase();

    app = express();
    app.post('/webhook/line', express.raw({ type: '*/*' }), (req, res) => {
      void handleLineWebhook(req, res);
    });
  });

  it('returns 401 when signature validation fails', async () => {
    const body = buildWebhookBody([]);
    await request(app)
      .post('/webhook/line')
      .set('Content-Type', 'application/json')
      .set('x-line-signature', 'invalid')
      .send(body)
      .expect(401);
  });

  it('processes message event when signature is valid', async () => {
    await registerAdmin(TEST_ADMIN);
    await registerInviteCode('TESTCODE', TEST_ADMIN);
    await requestConsultantJoin(TEST_CONSULTANT, 'TESTCODE');
    await approveConsultant(TEST_ADMIN, TEST_CONSULTANT);
    await handleServiceIntroduction(TEST_GROUP, TEST_CONSULTANT);

    const body = buildWebhookBody([
      {
        type: 'message',
        source: { type: 'group', userId: TEST_CUSTOMER, groupId: TEST_GROUP },
        message: { type: 'text', text: '怎麼登入後台' },
        replyToken: 'reply-token-1',
      },
    ]);

    await request(app)
      .post('/webhook/line')
      .set('Content-Type', 'application/json')
      .set('x-line-signature', sign(body))
      .send(body)
      .expect(200);
  });

  it('routes group text message into existing handler', async () => {
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
    expect(result.replies.some((r) => r.type === 'group')).toBe(true);
  });

  it('private message includes userId guidance', async () => {
    const result = await processMessage({
      userId: 'U123456',
      text: 'hello',
      isGroup: false,
    });
    expect(result.replies[0].text).toContain('U123456');
  });

  it('does not process non-text message as completion signal', async () => {
    const body = buildWebhookBody([
      {
        type: 'message',
        source: { type: 'group', userId: TEST_CUSTOMER, groupId: TEST_GROUP },
        message: { type: 'sticker' },
        replyToken: 'reply-token-2',
      },
    ]);

    await request(app)
      .post('/webhook/line')
      .set('Content-Type', 'application/json')
      .set('x-line-signature', sign(body))
      .send(body)
      .expect(200);
  });

  it('handles private AI draft with replyMessage to avoid push rate limits', async () => {
    await registerAdmin(TEST_ADMIN);
    setLlmClient({
      async complete() {
        return JSON.stringify({
          card_id: 'op-test',
          title: '測試知識卡',
          patterns: ['測試登入卡'],
          risk_level: 'low',
          can_public_reply: true,
          standard_answer: '請依照測試步驟操作。',
          not_applicable: [],
          escalate_to_consultant: [],
          status: '可用',
        });
      },
    });

    const replyText = jest.fn().mockResolvedValue(undefined);
    const pushText = jest.fn().mockResolvedValue('mock-push-id');
    setLineMessageClient({ replyText, pushText });

    const body = buildWebhookBody([
      {
        type: 'message',
        source: { type: 'user', userId: TEST_ADMIN },
        message: { type: 'text', text: '整理知識卡：店家遇到登入不了' },
        replyToken: 'reply-token-private-ai',
      },
    ]);

    await request(app)
      .post('/webhook/line')
      .set('Content-Type', 'application/json')
      .set('x-line-signature', sign(body))
      .send(body)
      .expect(200);

    expect(replyText).toHaveBeenCalledWith(
      'reply-token-private-ai',
      expect.stringContaining('【知識卡草稿｜')
    );
    expect(pushText).not.toHaveBeenCalled();
  });

  it('handles bare organize command with replyMessage to avoid push rate limits', async () => {
    await registerAdmin(TEST_ADMIN);
    const replyText = jest.fn().mockResolvedValue(undefined);
    const pushText = jest.fn().mockResolvedValue('mock-push-id');
    setLineMessageClient({ replyText, pushText });

    const body = buildWebhookBody([
      {
        type: 'message',
        source: { type: 'user', userId: TEST_ADMIN },
        message: { type: 'text', text: '幫我整理知識卡' },
        replyToken: 'reply-token-organize-start',
      },
    ]);

    await request(app)
      .post('/webhook/line')
      .set('Content-Type', 'application/json')
      .set('x-line-signature', sign(body))
      .send(body)
      .expect(200);

    expect(replyText).toHaveBeenCalledWith(
      'reply-token-organize-start',
      expect.stringContaining('請用下面格式提供內容')
    );
    expect(pushText).not.toHaveBeenCalled();
  });

  it('handles group customer questions with replyMessage even when debounce is configured', async () => {
    resetEnvCache();
    loadEnv({
      NODE_ENV: 'test',
      USE_MEMORY_REPOS: true,
      DEBOUNCE_SECONDS: 60,
      LINE_CHANNEL_SECRET: SECRET,
    });
    await resetRepositories('memory');
    await initKnowledgeBase();
    await registerAdmin(TEST_ADMIN);
    await registerInviteCode('TESTCODE', TEST_ADMIN);
    await requestConsultantJoin(TEST_CONSULTANT, 'TESTCODE');
    await approveConsultant(TEST_ADMIN, TEST_CONSULTANT);
    await handleServiceIntroduction(TEST_GROUP, TEST_CONSULTANT);

    const replyText = jest.fn().mockResolvedValue(undefined);
    const pushText = jest.fn().mockResolvedValue('mock-push-id');
    setLineMessageClient({ replyText, pushText });

    const body = buildWebhookBody([
      {
        type: 'message',
        source: { type: 'group', userId: TEST_CUSTOMER, groupId: TEST_GROUP },
        message: { type: 'text', text: '怎麼登入後台' },
        replyToken: 'reply-token-group-question',
      },
    ]);

    await request(app)
      .post('/webhook/line')
      .set('Content-Type', 'application/json')
      .set('x-line-signature', sign(body))
      .send(body)
      .expect(200);

    expect(replyText).toHaveBeenCalledWith(
      'reply-token-group-question',
      expect.stringContaining('登入')
    );
    expect(pushText).not.toHaveBeenCalled();
  });

  it('routes private image event to handlePrivateImageMessage in background', async () => {
    await registerAdmin(TEST_ADMIN);
    const handlerSpy = jest
      .spyOn(dmSessionImageService, 'handlePrivateImageMessage')
      .mockResolvedValue([{ type: 'push', userId: TEST_ADMIN, text: 'mock vision draft reply' }]);

    const pushed = new Promise<string>((resolve) => {
      setLineMessageClient({
        async replyText() {
          throw new Error('private image should not use replyMessage');
        },
        async pushText(_userId, text) {
          resolve(text);
          return 'mock-push-image-id';
        },
      });
    });

    const body = buildWebhookBody([
      {
        type: 'message',
        source: { type: 'user', userId: TEST_ADMIN },
        message: { type: 'image', id: 'private-image-msg-001' },
        replyToken: 'reply-token-private-image',
      },
    ]);

    await request(app)
      .post('/webhook/line')
      .set('Content-Type', 'application/json')
      .set('x-line-signature', sign(body))
      .send(body)
      .expect(200);

    await expect(pushed).resolves.toBe('mock vision draft reply');
    expect(handlerSpy).toHaveBeenCalledWith({
      userId: TEST_ADMIN,
      messageId: 'private-image-msg-001',
    });
    handlerSpy.mockRestore();
  });

  it('does not route group image event to screenshot vision flow', async () => {
    const handlerSpy = jest.spyOn(dmSessionImageService, 'handlePrivateImageMessage');
    let repliedText = '';
    setLineMessageClient({
      async replyText(_token, text) {
        repliedText = text;
      },
      async pushText() {
        throw new Error('group image should not push');
      },
    });

    const body = buildWebhookBody([
      {
        type: 'message',
        source: { type: 'group', userId: TEST_CONSULTANT, groupId: TEST_GROUP },
        message: { type: 'image', id: 'group-image-msg-001' },
        replyToken: 'reply-token-group-image',
      },
    ]);

    await request(app)
      .post('/webhook/line')
      .set('Content-Type', 'application/json')
      .set('x-line-signature', sign(body))
      .send(body)
      .expect(200);

    expect(handlerSpy).not.toHaveBeenCalled();
    expect(repliedText).toBe('');
    handlerSpy.mockRestore();
  });

  it('deduplicates repeated LINE message events before they can double-cancel a draft', async () => {
    await registerAdmin(TEST_ADMIN);
    await registerInviteCode('TESTCODE', TEST_ADMIN);
    await requestConsultantJoin(TEST_CONSULTANT, 'TESTCODE');
    await approveConsultant(TEST_ADMIN, TEST_CONSULTANT);
    await seedActiveSessionForTest({ userId: TEST_CONSULTANT, card: sampleCard });

    const repliedTexts: string[] = [];
    const pushedTexts: string[] = [];
    setLineMessageClient({
      async replyText(_replyToken, text) {
        repliedTexts.push(text);
      },
      async pushText(_userId, text) {
        pushedTexts.push(text);
        return `mock-push-${pushedTexts.length}`;
      },
    });

    const cancelEvent = {
      type: 'message',
      source: { type: 'user', userId: TEST_CONSULTANT },
      message: { type: 'text', id: 'cancel-msg-001', text: '取消' },
      replyToken: 'reply-token-cancel-1',
    };
    const body = buildWebhookBody([
      cancelEvent,
      {
        ...cancelEvent,
        replyToken: 'reply-token-cancel-2',
        deliveryContext: { isRedelivery: true },
      },
    ]);

    await request(app)
      .post('/webhook/line')
      .set('Content-Type', 'application/json')
      .set('x-line-signature', sign(body))
      .send(body)
      .expect(200);

    expect(repliedTexts).toEqual(['已取消目前知識卡整理流程，草稿資料已保留。']);
    expect(pushedTexts).toEqual([]);
  });
});
