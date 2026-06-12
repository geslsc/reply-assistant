import { messagingApi } from '@line/bot-sdk';
import { getEnv } from '../config/env';
import { logger } from '../config/logger';
import { BotReply } from '../types';
import { getRepos } from '../repositories';
import { getActiveAdmins, getActiveConsultants } from './consultantWhitelist';

import { registerReviewMessageMapping } from './knowledgeCardReviewService';

export interface LineMessageClient {
  replyText(replyToken: string, text: string): Promise<void>;
  pushText(userId: string, text: string): Promise<string | null>;
}

let lineClient: LineMessageClient | null = null;
const LINE_TEXT_LIMIT = 4500;
const LINE_MAX_MESSAGES_PER_REQUEST = 5;

export function splitLineText(text: string, limit = LINE_TEXT_LIMIT): string[] {
  if (text.length <= limit) {
    return [text];
  }

  const chunks: string[] = [];
  let remaining = text;
  while (remaining.length > limit) {
    const window = remaining.slice(0, limit + 1);
    const breakAt = Math.max(
      window.lastIndexOf('\n\n'),
      window.lastIndexOf('\n'),
      window.lastIndexOf('。'),
      window.lastIndexOf('，')
    );
    const cutAt = breakAt > Math.floor(limit * 0.6) ? breakAt + 1 : limit;
    chunks.push(remaining.slice(0, cutAt).trimEnd());
    remaining = remaining.slice(cutAt).trimStart();
  }
  if (remaining.length > 0) {
    chunks.push(remaining);
  }
  return chunks;
}

function toTextMessages(text: string): { type: 'text'; text: string }[] {
  return splitLineText(text).map((chunk, index, all) => ({
    type: 'text' as const,
    text: all.length > 1 ? `(${index + 1}/${all.length})\n${chunk}` : chunk,
  }));
}

function chunkMessages<T>(items: T[], size: number): T[][] {
  const chunks: T[][] = [];
  for (let i = 0; i < items.length; i += size) {
    chunks.push(items.slice(i, i + size));
  }
  return chunks;
}

function createRealClient(): LineMessageClient {
  const env = getEnv();
  if (!env.LINE_CHANNEL_ACCESS_TOKEN) {
    throw new Error('LINE_CHANNEL_ACCESS_TOKEN is not configured');
  }
  const client = new messagingApi.MessagingApiClient({
    channelAccessToken: env.LINE_CHANNEL_ACCESS_TOKEN,
  });

  return {
    async replyText(replyToken, text) {
      const messages = toTextMessages(text).slice(0, LINE_MAX_MESSAGES_PER_REQUEST);
      await client.replyMessage({
        replyToken,
        messages,
      });
    },
    async pushText(userId, text) {
      let firstMessageId: string | null = null;
      for (const messages of chunkMessages(toTextMessages(text), LINE_MAX_MESSAGES_PER_REQUEST)) {
        const response = await client.pushMessage({
          to: userId,
          messages,
        });
        firstMessageId ??= response.sentMessages?.[0]?.id ?? null;
      }
      return firstMessageId;
    },
  };
}

export function setLineMessageClient(client: LineMessageClient | null): void {
  lineClient = client;
}

export function getLineMessageClient(): LineMessageClient {
  if (!lineClient) {
    lineClient = createRealClient();
  }
  return lineClient;
}

export function mergeGroupReplies(replies: BotReply[]): string {
  return replies
    .filter((reply) => reply.type === 'group')
    .map((reply) => reply.text)
    .join('\n\n');
}

export async function replyText(replyToken: string, text: string): Promise<void> {
  try {
    await getLineMessageClient().replyText(replyToken, text);
  } catch (error) {
    logger.error('LINE replyMessage failed', {
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

export async function pushText(userId: string, text: string): Promise<string | null> {
  try {
    return await getLineMessageClient().pushText(userId, text);
  } catch (error) {
    logger.error('LINE pushMessage failed', {
      userId,
      error: error instanceof Error ? error.message : String(error),
    });
    return null;
  }
}

export async function pushGroupText(groupId: string, text: string): Promise<string | null> {
  return pushText(groupId, text);
}

export async function pushToAdmins(text: string): Promise<void> {
  const admins = await getActiveAdmins();
  for (const admin of admins) {
    await pushText(admin.userId, text);
  }
}

export async function pushToConsultants(text: string): Promise<void> {
  const consultants = await getActiveConsultants();
  for (const consultant of consultants) {
    await pushText(consultant.userId, text);
  }
}

async function notifyPushDeliveryFailure(reply: BotReply): Promise<void> {
  if (reply.deliveryFailureHandoffTransfer) {
    const transfer = reply.deliveryFailureHandoffTransfer;
    await getRepos().pendingHandoffs.transferOpenHandoffs({
      fromConsultantId: transfer.fromUserId,
      toConsultantId: transfer.toUserId,
      groupId: transfer.groupId,
    });

    const transferMessageId = await pushText(transfer.toUserId, transfer.transferText);
    if (transferMessageId) {
      return;
    }

    const admins = await getActiveAdmins();
    const adminFallbackUserIds = admins
      .map((admin) => admin.userId)
      .filter((userId) => userId !== transfer.fromUserId && userId !== transfer.toUserId);
    const text = [
      reply.deliveryFailureText ?? '【handoff 私訊投遞失敗】',
      '',
      `轉交對象 ${transfer.toUserId} 也投遞失敗，請 admin 立即進群處理。`,
    ].join('\n');
    for (const userId of adminFallbackUserIds) {
      await pushText(userId, text);
    }
    return;
  }

  const fallbackUserIds = [...new Set(reply.deliveryFailureFallbackUserIds ?? [])].filter(
    (userId) => userId && userId !== reply.userId
  );
  if (fallbackUserIds.length === 0) {
    return;
  }

  const text =
    reply.deliveryFailureText ??
    [
      '【私訊投遞失敗】',
      `原收件人：${reply.userId ?? '未知'}`,
      '小助手無法將訊息推送給原收件人，請協助確認。',
    ].join('\n');

  for (const userId of fallbackUserIds) {
    await pushText(userId, text);
  }
}

async function recordTrackedPushDelivery(reply: BotReply, messageId: string | null): Promise<void> {
  if (!reply.trackDeliveryHealthUserId) {
    return;
  }
  const now = new Date().toISOString();
  try {
    if (messageId) {
      await getRepos().consultants.recordPushSuccess(reply.trackDeliveryHealthUserId, now);
      return;
    }
    await getRepos().consultants.recordPushFailure(reply.trackDeliveryHealthUserId, now);
  } catch (error) {
    logger.warn('Failed to record push delivery health; continuing', {
      userId: reply.trackDeliveryHealthUserId,
      delivered: Boolean(messageId),
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

export async function deliverBotReplies(
  replies: BotReply[],
  replyToken?: string,
  replyUserId?: string
): Promise<void> {
  const mergedGroupText = mergeGroupReplies(replies);
  if (replyToken && mergedGroupText.length > 0) {
    await replyText(replyToken, mergedGroupText);
  } else if (mergedGroupText.length > 0) {
    logger.warn('Group replies without replyToken cannot be delivered inline');
  }

  const inlinePrivateReplies =
    replyToken && !mergedGroupText && replyUserId
      ? replies.filter((reply) => reply.type === 'push' && reply.userId === replyUserId)
      : [];

  if (inlinePrivateReplies.length > 0 && replyToken) {
    await replyText(replyToken, inlinePrivateReplies.map((reply) => reply.text).join('\n\n'));
  }

  for (const reply of replies) {
    if (reply.type === 'push' && reply.userId) {
      if (inlinePrivateReplies.includes(reply)) {
        continue;
      }
      const messageId = await pushText(reply.userId, reply.text);
      await recordTrackedPushDelivery(reply, messageId);
      if (!messageId) {
        await notifyPushDeliveryFailure(reply);
      }
      if (reply.trackReviewId && messageId) {
        await registerReviewMessageMapping(reply.trackReviewId, messageId);
      }
    }
  }
}

export async function deliverDeferredGroupReplies(
  replies: BotReply[],
  groupId: string
): Promise<void> {
  const mergedGroupText = mergeGroupReplies(replies);
  if (mergedGroupText.length > 0) {
    await pushGroupText(groupId, mergedGroupText);
  }

  for (const reply of replies) {
    if (reply.type === 'push' && reply.userId) {
      const messageId = await pushText(reply.userId, reply.text);
      await recordTrackedPushDelivery(reply, messageId);
      if (!messageId) {
        await notifyPushDeliveryFailure(reply);
      }
      if (reply.trackReviewId && messageId) {
        await registerReviewMessageMapping(reply.trackReviewId, messageId);
      }
    }
  }
}
