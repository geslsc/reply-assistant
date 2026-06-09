export type GroupConsultantAssignmentStatus = 'active' | 'left';

export interface GroupConsultantAssignmentRecord {
  id: number;
  groupId: string;
  groupCode: string;
  groupName: string | null;
  primaryConsultantUserId: string | null;
  secondaryConsultantUserId: string | null;
  status: GroupConsultantAssignmentStatus;
  createdAt: string;
  updatedAt: string;
  updatedBy: string | null;
  lastConsultantActionAt: string | null;
  lastCustomerMessageAt: string | null;
}

export interface GroupConsultantAssignmentRepository {
  create(params: {
    groupId: string;
    groupCode: string;
    groupName: string | null;
    updatedBy: string | null;
  }): Promise<GroupConsultantAssignmentRecord>;
  findByGroupId(groupId: string): Promise<GroupConsultantAssignmentRecord | null>;
  findByGroupCode(groupCode: string): Promise<GroupConsultantAssignmentRecord | null>;
  findByGroupName(groupName: string): Promise<GroupConsultantAssignmentRecord[]>;
  listAll(): Promise<GroupConsultantAssignmentRecord[]>;
  listAllGroupCodes(): Promise<string[]>;
  findByConsultantUserId(userId: string): Promise<GroupConsultantAssignmentRecord[]>;
  findGroupsWherePrimary(userId: string): Promise<GroupConsultantAssignmentRecord[]>;
  update(
    groupId: string,
    patch: Partial<
      Pick<
        GroupConsultantAssignmentRecord,
        | 'groupName'
        | 'primaryConsultantUserId'
        | 'secondaryConsultantUserId'
        | 'status'
        | 'updatedBy'
        | 'lastConsultantActionAt'
        | 'lastCustomerMessageAt'
      >
    >
  ): Promise<GroupConsultantAssignmentRecord | null>;
  clear(): Promise<void>;
}
