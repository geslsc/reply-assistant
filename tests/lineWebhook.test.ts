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
import { processMessage } from '../src/handlers/lineWebhookHandler';
import { TEST_ADMIN, TEST_CONSULTANT, TEST_CUSTOMER, TEST_GROUP } from './helpers/testSetup';

const SECRET = 'test-channel-secret';

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
      LINE_CHANNEL_SECRET: SECRET,
    });
    await resetRepositories('memory');
    setLlmClient(null);
    setLineMessageClient(null);

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

  it('handles private AI draft in background and pushes the result', async () => {
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

    const pushed = new Promise<string>((resolve) => {
      setLineMessageClient({
        async replyText() {
          throw new Error('private AI draft should not use replyMessage');
        },
        async pushText(_userId, text) {
          resolve(text);
        },
      });
    });

    const body = buildWebhookBody([
      {
        type: 'message',
        source: { type: 'user', userId: TEST_ADMIN },
        message: { type: 'text', text: '整理知識卡：測試登入卡' },
        replyToken: 'reply-token-private-ai',
      },
    ]);

    await request(app)
      .post('/webhook/line')
      .set('Content-Type', 'application/json')
      .set('x-line-signature', sign(body))
      .send(body)
      .expect(200);

    await expect(pushed).resolves.toContain('【可直接貼入 JSON 的單卡草稿】');
  });
});
