export enum PendingHandoffStatus {
  OPEN = 'open',
  CLOSED = 'closed',
  INVALID = 'invalid',
}

/** pending_handoffs.invalid_reason 允許值（不是 event_type） */
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

export interface PendingHandoff {
  id: string;
  consultantId: string;
  issueThreadId: string;
  groupId: string;
  shortCode: string;
  status: PendingHandoffStatus;
  invalidReason: PendingHandoffInvalidReason | null;
  customerQuestion: string | null;
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

export interface PendingHandoffRepository {
  create(params: CreatePendingHandoffParams): Promise<PendingHandoff>;
  findOpenByConsultant(consultantId: string): Promise<PendingHandoff[]>;
  findOpenByConsultantAndShortCode(
    consultantId: string,
    shortCode: string
  ): Promise<PendingHandoff | null>;
  findByConsultant(consultantId: string): Promise<PendingHandoff[]>;
  markClosed(id: string): Promise<PendingHandoff | null>;
  markInvalid(
    id: string,
    reason: PendingHandoffInvalidReason
  ): Promise<PendingHandoff | null>;
  markInvalidByGroup(groupId: string, reason: PendingHandoffInvalidReason): Promise<number>;
  markInvalidByThread(
    groupId: string,
    issueThreadId: string,
    reason: PendingHandoffInvalidReason
  ): Promise<number>;
  clear(): Promise<void>;
}
