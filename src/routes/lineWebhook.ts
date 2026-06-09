import crypto from 'crypto';
import { Request, Response } from 'express';
import { getEnv } from '../config/env';
import { logger } from '../config/logger';
import { processMessage, IncomingMessage } from '../handlers/lineWebhookHandler';
import { deliverBotReplies } from '../services/lineMessageService';
import { handleBotLeaveGroup } from '../services/botLeaveGroupService';
import { handleBotJoinGroup } from '../services/botJoinGroupService';
import { handlePrivateImageMessage } from '../services/dmSessionImageService';
import {
  classifyConsultantIntent,
  isConsultantPrivateAiIntent,
} from '../services/consultantIntentClassifier';

interface LineWebhookEvent {
  type: string;
  source: {
    type: string;
    userId?: string;
    groupId?: string;
  };
  message?: {
    type: string;
    id?: string;
    text?: string;
    quotedMessageId?: string;
  };
  replyToken?: string;
  timestamp?: number;
}

interface LineWebhookBody {
  events: LineWebhookEvent[];
}

export interface IncomingImageMessage {
  kind: 'image';
  userId: string;
  messageId: string;
  isGroup: boolean;
  replyToken?: string;
}

export type MappedLineEvent = IncomingMessage | IncomingImageMessage | 'non_text' | null;

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

function isIncomingImageMessage(
  mapped: IncomingMessage | IncomingImageMessage
): mapped is IncomingImageMessage {
  return 'kind' in mapped && mapped.kind === 'image';
}

export function mapJoinEvent(event: LineWebhookEvent): { groupId: string } | null {
  if (event.type !== 'join') {
    return null;
  }
  if (event.source.type !== 'group' || !event.source.groupId) {
    return null;
  }
  return { groupId: event.source.groupId };
}

export function mapLeaveEvent(event: LineWebhookEvent): { groupId: string } | null {
  if (event.type !== 'leave') {
    return null;
  }
  if (event.source.type !== 'group' || !event.source.groupId) {
    return null;
  }
  return { groupId: event.source.groupId };
}

export function mapLineEvent(event: LineWebhookEvent): MappedLineEvent {
  if (event.type !== 'message') {
    return null;
  }
  const userId = event.source.userId;
  if (!userId) {
    return null;
  }

  if (event.message?.type === 'image') {
    if (!event.message.id) {
      return 'non_text';
    }
    return {
      kind: 'image',
      userId,
      messageId: event.message.id,
      isGroup: event.source.type === 'group',
      replyToken: event.replyToken,
    };
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
    quotedMessageId: event.message.quotedMessageId,
    timestamp: event.timestamp ? String(event.timestamp) : undefined,
    sourceType: event.source.type === 'group' ? 'group' : 'user',
  };
}

function shouldHandleInBackground(message: IncomingMessage): boolean {
  if (message.isGroup) {
    return false;
  }
  const { intent } = classifyConsultantIntent(message.text);
  return isConsultantPrivateAiIntent(intent);
}

function shouldHandleImageInBackground(message: IncomingImageMessage): boolean {
  return !message.isGroup;
}

async function processAndPush(message: IncomingMessage): Promise<void> {
  const result = await processMessage(message);
  await deliverBotReplies(result.replies, undefined);
}

async function processImageAndPush(message: IncomingImageMessage): Promise<void> {
  const replies = await handlePrivateImageMessage({
    userId: message.userId,
    messageId: message.messageId,
  });
  if (replies.length > 0) {
    await deliverBotReplies(replies, undefined);
  }
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
      const leave = mapLeaveEvent(event);
      if (leave) {
        void handleBotLeaveGroup(leave.groupId)
          .then((replies) => deliverBotReplies(replies, undefined))
          .catch((error) => {
            logger.error('LINE leave event handling failed', {
              error: error instanceof Error ? error.message : String(error),
              groupId: leave.groupId,
            });
          });
        continue;
      }

      const join = mapJoinEvent(event);
      if (join) {
        void handleBotJoinGroup(join.groupId).catch((error) => {
          logger.error('LINE join event handling failed', {
            error: error instanceof Error ? error.message : String(error),
            groupId: join.groupId,
          });
        });
        continue;
      }

      const mapped = mapLineEvent(event);
      if (mapped === null) {
        continue;
      }

      if (mapped === 'non_text') {
        if (event.source.type === 'group') {
          continue;
        }
        if (event.replyToken) {
          await deliverBotReplies(
            [{ type: 'group', text: '請用文字描述問題,顧問比較好協助喔。' }],
            event.replyToken
          );
        }
        continue;
      }

      if (isIncomingImageMessage(mapped)) {
        if (mapped.isGroup) {
          continue;
        }

        logger.info('LINE private image message received', {
          userId: mapped.userId,
          messageId: mapped.messageId,
        });

        if (shouldHandleImageInBackground(mapped)) {
          void processImageAndPush(mapped).catch((error) => {
            logger.error('Background LINE image assist failed', {
              error: error instanceof Error ? error.message : String(error),
              userId: mapped.userId,
            });
          });
          continue;
        }

        const replies = await handlePrivateImageMessage({
          userId: mapped.userId,
          messageId: mapped.messageId,
        });
        await deliverBotReplies(replies, mapped.replyToken);
        continue;
      }

      const textMessage: IncomingMessage = mapped;

      logger.info('LINE message event', {
        userId: textMessage.userId,
        groupId: textMessage.groupId,
        sourceType: textMessage.sourceType,
      });

      if (shouldHandleInBackground(textMessage)) {
        void processAndPush(textMessage).catch((error) => {
          logger.error('Background LINE AI assist failed', {
            error: error instanceof Error ? error.message : String(error),
            userId: textMessage.userId,
          });
        });
        continue;
      }

      const result = await processMessage(textMessage);
      await deliverBotReplies(result.replies, textMessage.replyToken);
    }
    res.status(200).json({ ok: true });
  } catch (error) {
    logger.error('Webhook processing failed', {
      error: error instanceof Error ? error.message : String(error),
    });
    res.status(200).json({ ok: false });
  }
}
