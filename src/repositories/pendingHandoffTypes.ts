export enum PendingHandoffStatus {
  PENDING = 'pending',
  IN_PROGRESS = 'in_progress',
  RESOLVED = 'resolved',
  IGNORED = 'ignored',
}

/** @deprecated 系統忽略時改寫入 reason；保留型別供舊路徑對照 */
export enum PendingHandoffInvalidReason {
  PASSIVE_TIMEOUT = 'passive_timeout',
  GROUP_MUTED = 'group_muted',
  SERVICE_ENDED = 'service_ended',
  OUT_OF_SERVICE = 'out_of_service',
}

export const VALID_PENDING_HANDOFF_INVALID_REASONS = [
  PendingHandoffInvalidReason.PASSIVE_TIMEOUT,
  PendingHandoffInvalidReason.GROUP_MUTED,
  PendingHandoffInvalidReason.SERVICE_ENDED,
  PendingHandoffInvalidReason.OUT_OF_SERVICE,
] as const;

export const ACTIONABLE_HANDOFF_STATUSES = [
  PendingHandoffStatus.PENDING,
  PendingHandoffStatus.IN_PROGRESS,
] as const;

export interface PendingHandoff {
  id: string;
  consultantId: string;
  issueThreadId: string;
  groupId: string;
  shortCode: string;
  status: PendingHandoffStatus;
  statusUpdatedBy: string | null;
  statusUpdatedAt: string | null;
  reason: string | null;
  customerQuestion: string | null;
  snoozed: boolean;
  acknowledgedAt: string | null;
  createdAt: string;
  updatedAt: string;
  closedAt: string | null;
}

export interface CreatePendingHandoffParams {
  consultantId: string;
  issueThreadId: string;
  groupId: string;
  shortCode: string;
  customerQuestion: string | null;
}

export interface UpdateHandoffStatusParams {
  id: string;
  status: PendingHandoffStatus;
  updatedBy: string;
  reason?: string | null;
}

export interface PendingHandoffRepository {
  create(params: CreatePendingHandoffParams): Promise<PendingHandoff>;
  findActionableByConsultant(consultantId: string): Promise<PendingHandoff[]>;
  /** @deprecated use findActionableByConsultant */
  findOpenByConsultant(consultantId: string): Promise<PendingHandoff[]>;
  findActionableByConsultantAndShortCode(
    consultantId: string,
    shortCode: string
  ): Promise<PendingHandoff | null>;
  /** @deprecated use findActionableByConsultantAndShortCode */
  findOpenByConsultantAndShortCode(
    consultantId: string,
    shortCode: string
  ): Promise<PendingHandoff | null>;
  findByConsultant(consultantId: string): Promise<PendingHandoff[]>;
  findById(id: string): Promise<PendingHandoff | null>;
  findActionableByGroup(groupId: string): Promise<PendingHandoff[]>;
  findActionableByThread(groupId: string, issueThreadId: string): Promise<PendingHandoff[]>;
  updateStatus(params: UpdateHandoffStatusParams): Promise<PendingHandoff | null>;
  /** @deprecated use updateStatus to resolved */
  markClosed(id: string): Promise<PendingHandoff | null>;
  /** @deprecated use updateStatus to ignored */
  /** @deprecated legacy 欄位；新流程請使用 reason，勿再寫入 invalid_reason */
  markInvalid(id: string, reason: PendingHandoffInvalidReason): Promise<PendingHandoff | null>;
  /** @deprecated 請改用 handoffStatusService.markHandoffsIgnoredByGroup（含 audit log） */
  markInvalidByGroup(groupId: string, reason: PendingHandoffInvalidReason): Promise<number>;
  /** @deprecated 請改用 handoffStatusService.markHandoffsIgnoredByThread（含 audit log） */
  markInvalidByThread(
    groupId: string,
    issueThreadId: string,
    reason: PendingHandoffInvalidReason
  ): Promise<number>;
  markSnoozed(id: string): Promise<PendingHandoff | null>;
  findActionableByConsultantAndGroup(
    consultantId: string,
    groupId: string
  ): Promise<PendingHandoff[]>;
  /** @deprecated use findActionableByConsultantAndGroup */
  findOpenByConsultantAndGroup(
    consultantId: string,
    groupId: string
  ): Promise<PendingHandoff[]>;
  transferActionableHandoffs(params: {
    fromConsultantId: string;
    toConsultantId: string;
    groupId: string;
  }): Promise<number>;
  /** @deprecated use transferActionableHandoffs */
  transferOpenHandoffs(params: {
    fromConsultantId: string;
    toConsultantId: string;
    groupId: string;
  }): Promise<number>;
  clear(): Promise<void>;
}
