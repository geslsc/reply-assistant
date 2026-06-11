import { logger } from '../config/logger';
import { getRepos } from '../repositories';
import {
  PendingHandoffInvalidReason,
  PendingHandoffStatus,
  UpdateHandoffStatusParams,
} from '../repositories/pendingHandoffTypes';
import {
  HandoffStatusChangedLogPayload,
  logHandoffStatusChanged,
} from './lowVolumeTodoEventLogService';

export interface UpdateHandoffStatusOptions {
  source?: string;
}

async function safeLogHandoffStatusChanged(payload: HandoffStatusChangedLogPayload): Promise<void> {
  try {
    await logHandoffStatusChanged(payload);
  } catch (error) {
    logger.warn('Failed to write handoff_status_changed event', {
      handoff_id: payload.handoff_id,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

export async function updateHandoffStatus(
  params: UpdateHandoffStatusParams,
  options?: UpdateHandoffStatusOptions
) {
  const existing = await getRepos().pendingHandoffs.findById(params.id);
  const updated = await getRepos().pendingHandoffs.updateStatus(params);
  if (updated) {
    await safeLogHandoffStatusChanged({
      handoff_id: updated.id,
      from_status: existing?.status ?? null,
      to_status: updated.status,
      reason: updated.reason,
      updated_by: params.updatedBy,
      updated_at: updated.statusUpdatedAt ?? new Date().toISOString(),
      ...(options?.source ? { source: options.source } : {}),
    });
  }
  return updated;
}

export async function markHandoffResolved(id: string, updatedBy: string) {
  return updateHandoffStatus({
    id,
    status: PendingHandoffStatus.RESOLVED,
    updatedBy,
  });
}

export async function markHandoffIgnored(
  id: string,
  updatedBy: string,
  reason: string,
  options?: UpdateHandoffStatusOptions
) {
  return updateHandoffStatus(
    {
      id,
      status: PendingHandoffStatus.IGNORED,
      updatedBy,
      reason,
    },
    options
  );
}

export async function markHandoffsIgnoredByGroup(
  groupId: string,
  reason: PendingHandoffInvalidReason
): Promise<number> {
  const handoffs = await getRepos().pendingHandoffs.findActionableByGroup(groupId);
  let count = 0;
  for (const handoff of handoffs) {
    const updated = await markHandoffIgnored(handoff.id, 'system', reason, {
      source: 'system_batch_ignore',
    });
    if (updated) {
      count++;
    }
  }
  return count;
}

export async function markHandoffsIgnoredByThread(
  groupId: string,
  issueThreadId: string,
  reason: PendingHandoffInvalidReason
): Promise<number> {
  const handoffs = await getRepos().pendingHandoffs.findActionableByThread(groupId, issueThreadId);
  let count = 0;
  for (const handoff of handoffs) {
    const updated = await markHandoffIgnored(handoff.id, 'system', reason, {
      source: 'system_batch_ignore',
    });
    if (updated) {
      count++;
    }
  }
  return count;
}
