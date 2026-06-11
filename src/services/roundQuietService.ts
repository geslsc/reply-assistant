import { getRepos } from '../repositories';
import { getActiveIssueThread, updateIssueThread } from './issueThreadService';

export const ROUND_QUIET_PHRASE = '本輪安靜';

export function isRoundQuietPhrase(text: string): boolean {
  return text.trim() === ROUND_QUIET_PHRASE;
}

/** 僅作用於當前 issueThread；不寫 event_log、不改 ThreadState */
export async function enableRoundQuietForGroup(groupId: string): Promise<boolean> {
  const thread = await getActiveIssueThread(groupId);
  if (!thread) {
    return false;
  }
  await updateIssueThread(groupId, thread.issueThreadId, {
    autoReplyBlocked: true,
  });
  return true;
}

export async function isRoundQuietActive(groupId: string): Promise<boolean> {
  const thread = await getActiveIssueThread(groupId);
  return Boolean(thread?.autoReplyBlocked);
}

/** 新 thread 建立時自動失效（由 issueThreadService 在 create 時不帶 flag） */
export function shouldSkipAutoReplyForThread(thread: {
  autoReplyBlocked?: boolean;
}): boolean {
  return Boolean(thread.autoReplyBlocked);
}
