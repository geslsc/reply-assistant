import { messagingApi } from '@line/bot-sdk';
import { getEnv } from '../config/env';
import { logger } from '../config/logger';
import { getGroupFlags, updateGroupFlags } from './groupFlags';

export interface LineGroupSummaryClient {
  getGroupSummary(groupId: string): Promise<{ groupName: string } | null>;
}

function createRealLineGroupSummaryClient(): LineGroupSummaryClient {
  const token = getEnv().LINE_CHANNEL_ACCESS_TOKEN;
  if (!token) {
    throw new Error('LINE_CHANNEL_ACCESS_TOKEN is not configured');
  }
  const client = new messagingApi.MessagingApiClient({
    channelAccessToken: token,
  });

  return {
    async getGroupSummary(groupId: string): Promise<{ groupName: string } | null> {
      try {
        const summary = await client.getGroupSummary(groupId);
        const groupName = summary.groupName?.trim();
        if (!groupName) {
          return null;
        }
        return { groupName };
      } catch (error) {
        logger.error('LINE group summary API failed', {
          groupId,
          error: error instanceof Error ? error.message : String(error),
        });
        return null;
      }
    },
  };
}

let lineGroupSummaryClient: LineGroupSummaryClient | null = null;
let lineGroupSummaryClientExplicitlySet = false;

export function setLineGroupSummaryClient(client: LineGroupSummaryClient | null): void {
  lineGroupSummaryClient = client;
  lineGroupSummaryClientExplicitlySet = true;
}

export function getLineGroupSummaryClient(): LineGroupSummaryClient | null {
  if (lineGroupSummaryClientExplicitlySet) {
    return lineGroupSummaryClient;
  }
  if (lineGroupSummaryClient === null && getEnv().LINE_CHANNEL_ACCESS_TOKEN) {
    try {
      lineGroupSummaryClient = createRealLineGroupSummaryClient();
    } catch {
      lineGroupSummaryClient = null;
    }
  }
  return lineGroupSummaryClient;
}

export async function fetchLineGroupName(groupId: string): Promise<string | null> {
  const client = getLineGroupSummaryClient();
  if (!client) {
    return null;
  }
  const summary = await client.getGroupSummary(groupId);
  return summary?.groupName ?? null;
}

export async function refreshGroupNameIfNeeded(groupId: string): Promise<string | null> {
  const flags = await getGroupFlags(groupId);
  if (flags.groupName) {
    return flags.groupName;
  }
  const groupName = await fetchLineGroupName(groupId);
  if (groupName) {
    await updateGroupFlags(groupId, { groupName });
    return groupName;
  }
  return null;
}

export async function getGroupDisplayName(groupId: string): Promise<string | null> {
  const flags = await getGroupFlags(groupId);
  return flags.groupName;
}
