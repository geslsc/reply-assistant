import { messagingApi } from '@line/bot-sdk';
import { Readable } from 'stream';
import { getEnv } from '../config/env';

export interface DownloadedLineImage {
  buffer: Buffer;
  contentType: string;
}

export interface LineImageContentClient {
  getMessageContent(messageId: string): Promise<DownloadedLineImage>;
}

async function readableToBuffer(stream: Readable): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}

function createRealLineImageContentClient(): LineImageContentClient {
  const token = getEnv().LINE_CHANNEL_ACCESS_TOKEN;
  if (!token) {
    throw new Error('LINE_CHANNEL_ACCESS_TOKEN is not configured');
  }
  const client = new messagingApi.MessagingApiBlobClient({
    channelAccessToken: token,
  });

  return {
    async getMessageContent(messageId: string): Promise<DownloadedLineImage> {
      const stream = await client.getMessageContent(messageId);
      const buffer = await readableToBuffer(stream as Readable);
      return {
        buffer,
        contentType: 'image/jpeg',
      };
    },
  };
}

let lineImageContentClient: LineImageContentClient | null = null;

export function setLineImageContentClient(client: LineImageContentClient | null): void {
  lineImageContentClient = client;
}

export function getLineImageContentClient(): LineImageContentClient {
  if (!lineImageContentClient) {
    lineImageContentClient = createRealLineImageContentClient();
  }
  return lineImageContentClient;
}

export async function downloadLineMessageImage(messageId: string): Promise<DownloadedLineImage> {
  return getLineImageContentClient().getMessageContent(messageId);
}
