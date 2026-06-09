export type GroupMessageBufferStatus = 'collecting' | 'resolved' | 'expired';

export interface GroupMessageBufferEntry {
  message_id: string;
  text: string;
  timestamp: string;
  sequence: number;
}

export interface GroupMessageBuffer {
  bufferId: string;
  groupId: string;
  customerUserId: string;
  issueThreadId: string;
  messages: GroupMessageBufferEntry[];
  status: GroupMessageBufferStatus;
  createdAt: string;
  updatedAt: string;
}

export interface AppendGroupMessageBufferParams {
  groupId: string;
  customerUserId: string;
  issueThreadId: string;
  message: GroupMessageBufferEntry;
}

export interface GroupMessageBufferRepository {
  create(params: AppendGroupMessageBufferParams): Promise<GroupMessageBuffer>;
  findById(bufferId: string): Promise<GroupMessageBuffer | null>;
  findCollectingByGroupAndCustomer(
    groupId: string,
    customerUserId: string
  ): Promise<GroupMessageBuffer | null>;
  findCollectingByGroup(groupId: string): Promise<GroupMessageBuffer[]>;
  findExpiredCollecting(cutoffIso: string): Promise<GroupMessageBuffer[]>;
  appendMessage(
    bufferId: string,
    message: GroupMessageBufferEntry
  ): Promise<GroupMessageBuffer | null>;
  updateStatus(
    bufferId: string,
    status: GroupMessageBufferStatus
  ): Promise<GroupMessageBuffer | null>;
  clear(): Promise<void>;
}
