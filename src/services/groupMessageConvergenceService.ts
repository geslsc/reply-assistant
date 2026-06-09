import { v4 as uuidv4 } from 'uuid';
import { getEnv } from '../config/env';
import { logger } from '../config/logger';
import { getRepos } from '../repositories';
import { GroupMessageBuffer } from '../repositories/groupMessageBufferTypes';
import { BotReply, ThreadState } from '../types';
import { createIssueThread, getActiveIssueThread, getIssueThread } from './issueThreadService';
import {
  combineBufferMessages,
  hasSubstantiveConvergedContent,
  isNonSubstantiveCustomerMessage,
} from './groupMessageFilterService';
import { isHighRiskCustomerMessage } from './groupHighRiskService';
import {
  applyClarifyFollowUp,
  applyConvergedQuestion,
} from './groupConvergenceActionService';

const debounceTimers = new Map<string, NodeJS.Timeout>();
const processingBuffers = new Set<string>();

type AsyncReplyDeliverer = (replies: BotReply[], groupId: string) => Promise<void>;

let asyncReplyDeliverer: AsyncReplyDeliverer | null = null;

export function setAsyncConvergenceReplyDeliverer(
  deliverer: AsyncReplyDeliverer | null
): void {
  asyncReplyDeliverer = deliverer;
}

export function clearConvergenceTimersForTest(): void {
  for (const timer of debounceTimers.values()) {
    clearTimeout(timer);
  }
  debounceTimers.clear();
  processingBuffers.clear();
}

function getDebounceMs(): number {
  return Math.max(0, getEnv().DEBOUNCE_SECONDS) * 1000;
}

function getDebounceCutoffIso(now = new Date()): string {
  return new Date(now.getTime() - getDebounceMs()).toISOString();
}

async function deliverAsyncReplies(replies: BotReply[], groupId: string): Promise<void> {
  if (replies.length === 0) {
    return;
  }
  if (asyncReplyDeliverer) {
    await asyncReplyDeliverer(replies, groupId);
    return;
  }
  logger.warn('Async convergence replies produced but no deliverer configured', {
    groupId,
    replyCount: replies.length,
  });
}

function cancelDebounceTimer(bufferId: string): void {
  const existing = debounceTimers.get(bufferId);
  if (existing) {
    clearTimeout(existing);
    debounceTimers.delete(bufferId);
  }
}

async function markBufferResolved(bufferId: string): Promise<void> {
  cancelDebounceTimer(bufferId);
  await getRepos().groupMessageBuffers.updateStatus(bufferId, 'resolved');
}

async function processBuffer(
  buffer: GroupMessageBuffer,
  options?: { useAsyncDelivery?: boolean }
): Promise<BotReply[]> {
  if (processingBuffers.has(buffer.bufferId)) {
    return [];
  }
  if (buffer.status !== 'collecting') {
    return [];
  }

  processingBuffers.add(buffer.bufferId);
  try {
    const question = combineBufferMessages(buffer.messages);
    if (!hasSubstantiveConvergedContent(question)) {
      await markBufferResolved(buffer.bufferId);
      return [];
    }

    const thread =
      (await getIssueThread(buffer.groupId, buffer.issueThreadId)) ??
      (await getActiveIssueThread(buffer.groupId));
    if (!thread) {
      await markBufferResolved(buffer.bufferId);
      return [];
    }

    let replies: BotReply[];
    if (isHighRiskCustomerMessage(question)) {
      replies = await applyConvergedQuestion({
        groupId: buffer.groupId,
        issueThreadId: buffer.issueThreadId,
        customerUserId: buffer.customerUserId,
        question,
        options: { forceHighRiskHandoff: true, highRiskText: question },
      });
    } else {
      replies = await applyConvergedQuestion({
        groupId: buffer.groupId,
        issueThreadId: buffer.issueThreadId,
        customerUserId: buffer.customerUserId,
        question,
      });
    }

    await markBufferResolved(buffer.bufferId);

    if (options?.useAsyncDelivery) {
      await deliverAsyncReplies(replies, buffer.groupId);
      return [];
    }
    return replies;
  } finally {
    processingBuffers.delete(buffer.bufferId);
  }
}

function scheduleBufferProcessing(buffer: GroupMessageBuffer): void {
  cancelDebounceTimer(buffer.bufferId);
  const ms = getDebounceMs();
  if (ms <= 0) {
    void processBuffer(buffer, { useAsyncDelivery: false }).catch((error) => {
      logger.error('Immediate convergence processing failed', {
        error: error instanceof Error ? error.message : String(error),
      });
    });
    return;
  }
  const timer = setTimeout(() => {
    debounceTimers.delete(buffer.bufferId);
    void processBuffer(buffer, { useAsyncDelivery: true }).catch((error) => {
      logger.error('Debounced convergence processing failed', {
        error: error instanceof Error ? error.message : String(error),
      });
    });
  }, ms);
  debounceTimers.set(buffer.bufferId, timer);
}

async function appendToBuffer(params: {
  groupId: string;
  customerUserId: string;
  text: string;
  messageId?: string;
  timestamp?: string;
}): Promise<{ buffer: GroupMessageBuffer; replies: BotReply[] }> {
  const repos = getRepos().groupMessageBuffers;
  const message = {
    message_id: params.messageId ?? uuidv4(),
    text: params.text,
    timestamp: params.timestamp ?? new Date().toISOString(),
    sequence: 0,
  };

  let buffer = await repos.findCollectingByGroupAndCustomer(
    params.groupId,
    params.customerUserId
  );

  if (!buffer) {
    const thread = await createIssueThread(params.groupId, params.text);
    message.sequence = 1;
    buffer = await repos.create({
      groupId: params.groupId,
      customerUserId: params.customerUserId,
      issueThreadId: thread.issueThreadId,
      message,
    });
    return { buffer, replies: [] };
  }

  message.sequence = buffer.messages.length + 1;
  const updated = await repos.appendMessage(buffer.bufferId, message);
  return { buffer: updated ?? buffer, replies: [] };
}

export async function handleIncomingCustomerGroupMessage(params: {
  groupId: string;
  customerUserId: string;
  text: string;
  messageId?: string;
  timestamp?: string;
}): Promise<BotReply[]> {
  if (isNonSubstantiveCustomerMessage(params.text)) {
    return [];
  }

  const activeThread = await getActiveIssueThread(params.groupId);
  if (activeThread?.state === ThreadState.AI_CLARIFYING) {
    return applyClarifyFollowUp({
      groupId: params.groupId,
      issueThreadId: activeThread.issueThreadId,
      customerUserId: params.customerUserId,
      previousQuestion: activeThread.customerQuestion ?? '',
      followUpText: params.text,
    });
  }

  const { buffer } = await appendToBuffer(params);

  if (isHighRiskCustomerMessage(params.text)) {
    cancelDebounceTimer(buffer.bufferId);
    return processBuffer(buffer);
  }

  const ms = getDebounceMs();
  if (ms <= 0) {
    cancelDebounceTimer(buffer.bufferId);
    return processBuffer(buffer);
  }

  scheduleBufferProcessing(buffer);
  return [];
}

export async function settleExpiredGroupBuffers(
  groupId: string,
  now = new Date()
): Promise<BotReply[]> {
  const cutoff = getDebounceCutoffIso(now);
  const expiredInGroup = (await getRepos().groupMessageBuffers.findCollectingByGroup(groupId)).filter(
    (buffer) => buffer.updatedAt <= cutoff
  );

  const replies: BotReply[] = [];
  for (const buffer of expiredInGroup) {
    cancelDebounceTimer(buffer.bufferId);
    replies.push(...(await processBuffer(buffer)));
  }
  return replies;
}

export async function flushCollectingBuffersForGroup(groupId: string): Promise<BotReply[]> {
  const buffers = await getRepos().groupMessageBuffers.findCollectingByGroup(groupId);
  const replies: BotReply[] = [];
  for (const buffer of buffers) {
    cancelDebounceTimer(buffer.bufferId);
    replies.push(...(await processBuffer(buffer)));
  }
  return replies;
}

export async function processBufferByIdForTest(bufferId: string): Promise<BotReply[]> {
  const buffer = await getRepos().groupMessageBuffers.findById(bufferId);
  if (!buffer) {
    return [];
  }
  cancelDebounceTimer(bufferId);
  return processBuffer(buffer);
}

export async function runPendingConvergenceTimersForTest(): Promise<BotReply[]> {
  const pending = [...debounceTimers.keys()];
  const allReplies: BotReply[] = [];
  for (const bufferId of pending) {
    cancelDebounceTimer(bufferId);
    const buffer = await getRepos().groupMessageBuffers.findById(bufferId);
    if (buffer && buffer.status === 'collecting') {
      allReplies.push(...(await processBuffer(buffer)));
    }
  }
  return allReplies;
}
