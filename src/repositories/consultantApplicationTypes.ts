export type ConsultantApplicationStatus = 'pending' | 'approved' | 'rejected';

export interface ConsultantApplicationRecord {
  applicationId: string;
  applicationCode: string;
  userId: string;
  displayName: string | null;
  status: ConsultantApplicationStatus;
  appliedAt: string;
  resolvedAt: string | null;
  resolvedBy: string | null;
  adminResponse: string | null;
}

export interface ConsultantApplicationRepository {
  create(params: {
    applicationId: string;
    applicationCode: string;
    userId: string;
    displayName: string | null;
    appliedAt: string;
  }): Promise<ConsultantApplicationRecord>;
  findByCode(applicationCode: string): Promise<ConsultantApplicationRecord | null>;
  findPendingByUserId(userId: string): Promise<ConsultantApplicationRecord | null>;
  listPending(): Promise<ConsultantApplicationRecord[]>;
  listAllCodes(): Promise<string[]>;
  approve(params: {
    applicationCode: string;
    resolvedBy: string;
    resolvedAt: string;
  }): Promise<ConsultantApplicationRecord | null>;
  reject(params: {
    applicationCode: string;
    resolvedBy: string;
    resolvedAt: string;
    adminResponse?: string | null;
  }): Promise<ConsultantApplicationRecord | null>;
  clear(): Promise<void>;
}
