import {
  GroupConsultantAssignmentRecord,
  GroupConsultantAssignmentRepository,
  GroupConsultantAssignmentStatus,
} from './groupConsultantAssignmentTypes';

let nextId = 1;

export function createMemoryGroupConsultantAssignmentRepository(): GroupConsultantAssignmentRepository {
  const byGroupId = new Map<string, GroupConsultantAssignmentRecord>();

  return {
    async create(params) {
      const now = new Date().toISOString();
      const record: GroupConsultantAssignmentRecord = {
        id: nextId++,
        groupId: params.groupId,
        groupCode: params.groupCode,
        groupName: params.groupName,
        primaryConsultantUserId: null,
        secondaryConsultantUserId: null,
        status: 'active',
        createdAt: now,
        updatedAt: now,
        updatedBy: params.updatedBy,
        lastConsultantActionAt: null,
        lastCustomerMessageAt: null,
      };
      byGroupId.set(params.groupId, record);
      return { ...record };
    },
    async findByGroupId(groupId) {
      const record = byGroupId.get(groupId);
      return record ? { ...record } : null;
    },
    async findByGroupCode(groupCode) {
      const record = Array.from(byGroupId.values()).find((item) => item.groupCode === groupCode);
      return record ? { ...record } : null;
    },
    async findByGroupName(groupName) {
      return Array.from(byGroupId.values())
        .filter((item) => item.groupName === groupName)
        .map((item) => ({ ...item }));
    },
    async listAll() {
      return Array.from(byGroupId.values()).map((item) => ({ ...item }));
    },
    async listAllGroupCodes() {
      return Array.from(byGroupId.values()).map((item) => item.groupCode);
    },
    async findByConsultantUserId(userId) {
      return Array.from(byGroupId.values())
        .filter(
          (item) =>
            item.primaryConsultantUserId === userId || item.secondaryConsultantUserId === userId
        )
        .map((item) => ({ ...item }));
    },
    async findGroupsWherePrimary(userId) {
      return Array.from(byGroupId.values())
        .filter((item) => item.primaryConsultantUserId === userId)
        .map((item) => ({ ...item }));
    },
    async update(groupId, patch) {
      const record = byGroupId.get(groupId);
      if (!record) {
        return null;
      }
      const now = new Date().toISOString();
      if (patch.groupName !== undefined) {
        record.groupName = patch.groupName;
      }
      if (patch.primaryConsultantUserId !== undefined) {
        record.primaryConsultantUserId = patch.primaryConsultantUserId;
      }
      if (patch.secondaryConsultantUserId !== undefined) {
        record.secondaryConsultantUserId = patch.secondaryConsultantUserId;
      }
      if (patch.status !== undefined) {
        record.status = patch.status as GroupConsultantAssignmentStatus;
      }
      if (patch.updatedBy !== undefined) {
        record.updatedBy = patch.updatedBy;
      }
      if (patch.lastConsultantActionAt !== undefined) {
        record.lastConsultantActionAt = patch.lastConsultantActionAt;
      }
      if (patch.lastCustomerMessageAt !== undefined) {
        record.lastCustomerMessageAt = patch.lastCustomerMessageAt;
      }
      record.updatedAt = now;
      return { ...record };
    },
    async clear() {
      byGroupId.clear();
      nextId = 1;
    },
  };
}
