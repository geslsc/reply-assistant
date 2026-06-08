import crypto from 'crypto';
import { Request, Response } from 'express';
import { getEnv } from '../config/env';
import { logger } from '../config/logger';
import { processMessage, IncomingMessage } from '../handlers/lineWebhookHandler';
import { deliverBotReplies } from '../services/lineMessageService';

interface LineWebhookEvent {
  type: string;
  source: {
    type: string;
    userId?: string;
    groupId?: string;
  };
  message?: {
    type: string;
    text?: string;
  };
  replyToken?: string;
  timestamp?: number;
}

interface LineWebhookBody {
  events: LineWebhookEvent[];
}

export function validateLineSignature(body: Buffer, signature: string | undefined): boolean {
  const secret = getEnv().LINE_CHANNEL_SECRET;
  if (!secret) {
    return process.env.NODE_ENV === 'test';
  }
  if (!signature) {
    return false;
  }
  const digest = crypto.createHmac('sha256', secret).update(body).digest('base64');
  return digest === signature;
}

function mapLineEvent(event: LineWebhookEvent): IncomingMessage | 'non_text' | null {
  if (event.type !== 'message') {
    return null;
  }
  const userId = event.source.userId;
  if (!userId) {
    return null;
  }
  if (event.message?.type !== 'text') {
    return 'non_text';
  }
  return {
    userId,
    groupId: event.source.groupId,
    text: event.message.text ?? '',
    isGroup: event.source.type === 'group',
    isBotMentioned: false,
    replyToken: event.replyToken,
    timestamp: event.timestamp ? String(event.timestamp) : undefined,
    sourceType: event.source.type === 'group' ? 'group' : 'user',
  };
}

export async function handleLineWebhook(req: Request, res: Response): Promise<void> {
  const rawBody = req.body as Buffer;
  const signature = req.headers['x-line-signature'] as string | undefined;

  if (!validateLineSignature(rawBody, signature)) {
    res.status(401).json({ error: 'invalid signature' });
    return;
  }

  let body: LineWebhookBody;
  try {
    body = JSON.parse(rawBody.toString('utf-8')) as LineWebhookBody;
  } catch {
    res.status(400).json({ error: 'invalid json' });
    return;
  }

  try {
    for (const event of body.events ?? []) {
      const mapped = mapLineEvent(event);
      if (mapped === null) {
        continue;
      }
      if (mapped === 'non_text') {
        if (event.replyToken) {
          await deliverBotReplies(
            [{ type: 'group', text: '請用文字描述問題,顧問比較好協助喔。' }],
            event.replyToken
          );
        }
        continue;
      }

      logger.info('LINE message event', {
        userId: mapped.userId,
        groupId: mapped.groupId,
        sourceType: mapped.sourceType,
      });

      const result = await processMessage(mapped);
      await deliverBotReplies(result.replies, mapped.replyToken);
    }
    res.status(200).json({ ok: true });
  } catch (error) {
    logger.error('Webhook processing failed', {
      error: error instanceof Error ? error.message : String(error),
    });
    res.status(200).json({ ok: false });
  }
}
