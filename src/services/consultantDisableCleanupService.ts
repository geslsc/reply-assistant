import { BotReply, ConsultantRecord } from '../types';
import { getRepos } from '../repositories';
import { getActiveAdmins } from './consultantWhitelist';
import { buildConsultantDisableFallbackMessage } from './fixedMessageTemplates';
import { isInServicePeriod } from './groupFlags';
import { setMute } from './groupFlags';
import { transferOpenHandoffsOnDisable } from './handoffTransferService';

export interface ConsultantDisableCleanupResult {
  cancelledDraftsCount: number;
  preservedReviewsCount: number;
  preservedReviewCodes: string[];
  suspendedGroupsCount: number;
  botLeftGroupsCount: number;
  expiredServiceGroupsCount: number;
  transferredHandoffsCount: number;
  summaryText: string;
  adminPushReplies: BotReply[];
}

async function getConsultantRelatedGroupIds(consultantId: string): Promise<string[]> {
  const assignments = await getRepos().groupConsultantAssignments.findByConsultantUserId(
    consultantId
  );
  return assignments.map((item) => item.groupId);
}

export async function runConsultantDisableCleanup(
  consultant: ConsultantRecord
): Promise<ConsultantDisableCleanupResult> {
  const now = new Date().toISOString();
  const cancelledDraftsCount = await getRepos().dmSessions.cancelAllActiveForUser(
    consultant.userId,
    now
  );

  const pendingReviews = (await getRepos().pendingKnowledgeReviews.listPending()).filter(
    (item) => item.submittedBy === consultant.userId
  );
  const preservedReviewsCount = pendingReviews.length;
  const preservedReviewCodes = pendingReviews.map((item) => item.reviewId);

  const groupIds = await getConsultantRelatedGroupIds(consultant.userId);
  let suspendedGroupsCount = 0;
  let botLeftGroupsCount = 0;
  let expiredServiceGroupsCount = 0;
  const adminPushReplies: BotReply[] = [];
  const fallbackMessage = buildConsultantDisableFallbackMessage();

  const handoffTransfer = await transferOpenHandoffsOnDisable(consultant);
  adminPushReplies.push(...handoffTransfer.replies);
  const transferredHandoffsCount = handoffTransfer.transferredCount;

  for (const groupId of groupIds) {
    const flags = await getRepos().groups.getOrCreate(groupId);
    if (flags.botLeftAt) {
      botLeftGroupsCount += 1;
      continue;
    }

    const inService = await isInServicePeriod(groupId);
    if (!inService) {
      expiredServiceGroupsCount += 1;
      continue;
    }

    await setMute(groupId, true);
    suspendedGroupsCount += 1;
    adminPushReplies.push({ type: 'push', userId: groupId, text: fallbackMessage });
  }

  const display = consultant.displayName ?? consultant.userId;
  const code = consultant.consultantCode ?? '（無短碼）';
  const summaryLines = [
    `已停用顧問 ${display}（${code}）。`,
    `- 取消整理中草稿 ${cancelledDraftsCount} 筆`,
    `- 保留待您審核草稿 ${preservedReviewsCount} 筆${
      preservedReviewCodes.length > 0 ? `（${preservedReviewCodes.join('、')}）` : ''
    }`,
    `- 轉移 open handoff ${transferredHandoffsCount} 筆`,
    `- ${suspendedGroupsCount} 個服務中群組已暫停並通知店家官方客服資訊`,
    `- ${botLeftGroupsCount} 個群組小助手已移出，無需處理`,
    '請依代號處理待審草稿，並為暫停群組指派新負責人。',
  ];

  if (suspendedGroupsCount > 0) {
    for (const admin of await getActiveAdmins()) {
      adminPushReplies.push({
        type: 'push',
        userId: admin.userId,
        text: `【顧問停用】${display}（${code}）相關 ${suspendedGroupsCount} 個服務中群組已暫停並發送兜底話術。`,
      });
    }
  }

  return {
    cancelledDraftsCount,
    preservedReviewsCount,
    preservedReviewCodes,
    suspendedGroupsCount,
    botLeftGroupsCount,
    expiredServiceGroupsCount,
    transferredHandoffsCount,
    summaryText: summaryLines.join('\n'),
    adminPushReplies,
  };
}
