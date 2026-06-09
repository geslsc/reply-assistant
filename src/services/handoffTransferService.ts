import { BotReply } from '../types';
import { getRepos } from '../repositories';
import { ConsultantRecord } from '../types';
import { logConsultantManagementEvent } from './consultantEventLogService';
import {
  getFallbackAdminUserId,
  isActiveAssignee,
} from './groupConsultantAssignmentService';
import {
  buildHandoffShortReminder,
  buildHandoffPrivateCard,
} from './pendingHandoffService';
import { getGroupDisplayName } from './lineGroupSummaryService';
import { getActiveSession } from './dmSessionService';
import { PendingHandoff } from '../repositories/pendingHandoffTypes';

export async function transferOpenHandoffsOnDisable(
  consultant: ConsultantRecord
): Promise<{ replies: BotReply[]; transferredCount: number }> {
  const primaryGroups = await getRepos().groupConsultantAssignments.findGroupsWherePrimary(
    consultant.userId
  );
  const replies: BotReply[] = [];
  let transferredCount = 0;

  for (const assignment of primaryGroups) {
    const openHandoffs = await getRepos().pendingHandoffs.findOpenByConsultantAndGroup(
      consultant.userId,
      assignment.groupId
    );
    if (openHandoffs.length === 0) {
      continue;
    }

    let target: { userId: string; targetRole: 'secondary' | 'fallback_admin' } | null = null;
    if (
      assignment.secondaryConsultantUserId &&
      (await isActiveAssignee(assignment.secondaryConsultantUserId))
    ) {
      target = {
        userId: assignment.secondaryConsultantUserId,
        targetRole: 'secondary',
      };
    } else {
      const fallbackId = await getFallbackAdminUserId();
      if (fallbackId) {
        target = {
          userId: fallbackId,
          targetRole: 'fallback_admin',
        };
      }
    }

    if (!target) {
      continue;
    }

    const count = await getRepos().pendingHandoffs.transferOpenHandoffs({
      fromConsultantId: consultant.userId,
      toConsultantId: target.userId,
      groupId: assignment.groupId,
    });
    if (count === 0) {
      continue;
    }

    transferredCount += count;

    await logConsultantManagementEvent({
      action: 'handoff_transferred_on_disable',
      actorUserId: 'system',
      payload: {
        from_consultant: consultant.userId,
        to_target: target.userId,
        target_role: target.targetRole,
        group_id: assignment.groupId,
        count,
      },
    });

    const groupName = await getGroupDisplayName(assignment.groupId);
    const notifyReplies = await buildHandoffTransferNotifications(
      target.userId,
      openHandoffs,
      assignment.groupId,
      groupName
    );
    replies.push(...notifyReplies);
  }

  return { replies, transferredCount };
}

async function buildHandoffTransferNotifications(
  recipientId: string,
  handoffs: PendingHandoff[],
  groupId: string,
  groupName: string | null
): Promise<BotReply[]> {
  const activeSession = await getActiveSession(recipientId);
  const replies: BotReply[] = [];

  for (const handoff of handoffs) {
    const text = activeSession
      ? buildHandoffShortReminder({ groupId, groupName, shortCode: handoff.shortCode })
      : buildHandoffPrivateCard({
          groupId,
          groupName,
          shortCode: handoff.shortCode,
          customerQuestion: handoff.customerQuestion ?? '（無摘要）',
        });
    replies.push({ type: 'push', userId: recipientId, text });
  }

  if (handoffs.length > 0) {
    replies.push({
      type: 'push',
      userId: recipientId,
      text: `【handoff 轉移】原主負責顧問已停用，${handoffs.length} 筆待處理問題已轉交給您。`,
    });
  }

  return replies;
}
