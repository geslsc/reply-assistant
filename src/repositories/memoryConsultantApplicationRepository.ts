import {
  ConsultantApplicationRecord,
  ConsultantApplicationRepository,
} from './consultantApplicationTypes';

export function createMemoryConsultantApplicationRepository(): ConsultantApplicationRepository {
  const applications = new Map<string, ConsultantApplicationRecord>();

  return {
    async create(params) {
      const record: ConsultantApplicationRecord = {
        applicationId: params.applicationId,
        applicationCode: params.applicationCode,
        userId: params.userId,
        displayName: params.displayName,
        status: 'pending',
        appliedAt: params.appliedAt,
        resolvedAt: null,
        resolvedBy: null,
        adminResponse: null,
      };
      applications.set(params.applicationId, record);
      return { ...record };
    },
    async findByCode(applicationCode) {
      const match = Array.from(applications.values()).find(
        (item) => item.applicationCode === applicationCode
      );
      return match ? { ...match } : null;
    },
    async findPendingByUserId(userId) {
      const match = Array.from(applications.values()).find(
        (item) => item.userId === userId && item.status === 'pending'
      );
      return match ? { ...match } : null;
    },
    async listPending() {
      return Array.from(applications.values())
        .filter((item) => item.status === 'pending')
        .map((item) => ({ ...item }));
    },
    async listAllCodes() {
      return Array.from(applications.values()).map((item) => item.applicationCode);
    },
    async approve(params) {
      const record = Array.from(applications.values()).find(
        (item) => item.applicationCode === params.applicationCode && item.status === 'pending'
      );
      if (!record) {
        return null;
      }
      record.status = 'approved';
      record.resolvedAt = params.resolvedAt;
      record.resolvedBy = params.resolvedBy;
      return { ...record };
    },
    async reject(params) {
      const record = Array.from(applications.values()).find(
        (item) => item.applicationCode === params.applicationCode && item.status === 'pending'
      );
      if (!record) {
        return null;
      }
      record.status = 'rejected';
      record.resolvedAt = params.resolvedAt;
      record.resolvedBy = params.resolvedBy;
      record.adminResponse = params.adminResponse ?? null;
      return { ...record };
    },
    async clear() {
      applications.clear();
    },
  };
}
