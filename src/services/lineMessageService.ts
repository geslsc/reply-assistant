import { messagingApi } from '@line/bot-sdk';
import { getEnv } from '../config/env';
import { logger } from '../config/logger';
import { BotReply } from '../types';
import { getActiveAdmins, getActiveConsultants } from './consultantWhitelist';

export interface LineMessageClient {
  replyText(replyToken: string, text: string): Promise<void>;
  pushText(userId: string, text: string): Promise<void>;
}

let lineClient: LineMessageClient | null = null;

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
      await client.replyMessage({
        replyToken,
        messages: [{ type: 'text', text }],
      });
    },
    async pushText(userId, text) {
      await client.pushMessage({
        to: userId,
        messages: [{ type: 'text', text }],
      });
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

export async function pushText(userId: string, text: string): Promise<void> {
  try {
    await getLineMessageClient().pushText(userId, text);
  } catch (error) {
    logger.error('LINE pushMessage failed', {
      userId,
      error: error instanceof Error ? error.message : String(error),
    });
  }
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

export async function deliverBotReplies(
  replies: BotReply[],
  replyToken?: string
): Promise<void> {
  const mergedGroupText = mergeGroupReplies(replies);
  if (replyToken && mergedGroupText.length > 0) {
    await replyText(replyToken, mergedGroupText);
  }

  for (const reply of replies) {
    if (reply.type === 'push' && reply.userId) {
      await pushText(reply.userId, reply.text);
    }
  }
}
