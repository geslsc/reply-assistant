import { getRepos } from '../repositories';
import { logConsultantManagementEvent } from './consultantEventLogService';
import {
  getFallbackAdminUserId,
  isActiveAssignee,
} from './groupConsultantAssignmentService';

export type HandoffTargetRole = 'primary' | 'secondary' | 'fallback_admin';

export type HandoffTargetReason =
  | 'active_primary'
  | 'primary_inactive_secondary_active'
  | 'no_active_assignee';

export interface HandoffTarget {
  userId: string;
  targetRole: HandoffTargetRole;
  reason: HandoffTargetReason;
}

/** handoff 路由單一入口：主負責 → 副手 → fallback admin */
export async function resolveHandoffTarget(groupId: string): Promise<HandoffTarget | null> {
  const assignment = await getRepos().groupConsultantAssignments.findByGroupId(groupId);

  if (assignment?.primaryConsultantUserId) {
    if (await isActiveAssignee(assignment.primaryConsultantUserId)) {
      return {
        userId: assignment.primaryConsultantUserId,
        targetRole: 'primary',
        reason: 'active_primary',
      };
    }
  }

  if (assignment?.secondaryConsultantUserId) {
    if (await isActiveAssignee(assignment.secondaryConsultantUserId)) {
      return {
        userId: assignment.secondaryConsultantUserId,
        targetRole: 'secondary',
        reason: 'primary_inactive_secondary_active',
      };
    }
  }

  const fallbackAdminId = await getFallbackAdminUserId();
  if (!fallbackAdminId) {
    return null;
  }

  return {
    userId: fallbackAdminId,
    targetRole: 'fallback_admin',
    reason: 'no_active_assignee',
  };
}

export async function logHandoffRouted(params: {
  groupId: string;
  target: HandoffTarget;
}): Promise<void> {
  await logConsultantManagementEvent({
    action: 'handoff_routed',
    actorUserId: 'system',
    payload: {
      group_id: params.groupId,
      handoff_target: params.target.userId,
      target_role: params.target.targetRole,
      reason: params.target.reason,
    },
  });
}
