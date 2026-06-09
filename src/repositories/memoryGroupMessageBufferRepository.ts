import { v4 as uuidv4 } from 'uuid';
import {
  AppendGroupMessageBufferParams,
  GroupMessageBuffer,
  GroupMessageBufferRepository,
  GroupMessageBufferStatus,
} from './groupMessageBufferTypes';

export function createMemoryGroupMessageBufferRepository(): GroupMessageBufferRepository {
  const store = new Map<string, GroupMessageBuffer>();

  return {
    async create(params) {
      const now = new Date().toISOString();
      const buffer: GroupMessageBuffer = {
        bufferId: uuidv4(),
        groupId: params.groupId,
        customerUserId: params.customerUserId,
        issueThreadId: params.issueThreadId,
        messages: [params.message],
        status: 'collecting',
        createdAt: now,
        updatedAt: now,
      };
      store.set(buffer.bufferId, buffer);
      return { ...buffer, messages: [...buffer.messages] };
    },

    async findById(bufferId) {
      const buffer = store.get(bufferId);
      return buffer ? { ...buffer, messages: [...buffer.messages] } : null;
    },

    async findCollectingByGroupAndCustomer(groupId, customerUserId) {
      const buffer = Array.from(store.values()).find(
        (b) =>
          b.groupId === groupId &&
          b.customerUserId === customerUserId &&
          b.status === 'collecting'
      );
      return buffer ? { ...buffer, messages: [...buffer.messages] } : null;
    },

    async findCollectingByGroup(groupId) {
      return Array.from(store.values())
        .filter((b) => b.groupId === groupId && b.status === 'collecting')
        .map((b) => ({ ...b, messages: [...b.messages] }));
    },

    async findExpiredCollecting(cutoffIso) {
      return Array.from(store.values())
        .filter(
          (b) => b.status === 'collecting' && b.updatedAt <= cutoffIso
        )
        .map((b) => ({ ...b, messages: [...b.messages] }));
    },

    async appendMessage(bufferId, message) {
      const buffer = store.get(bufferId);
      if (!buffer || buffer.status !== 'collecting') {
        return null;
      }
      buffer.messages.push(message);
      buffer.updatedAt = new Date().toISOString();
      return { ...buffer, messages: [...buffer.messages] };
    },

    async updateStatus(bufferId, status: GroupMessageBufferStatus) {
      const buffer = store.get(bufferId);
      if (!buffer) {
        return null;
      }
      buffer.status = status;
      buffer.updatedAt = new Date().toISOString();
      return { ...buffer, messages: [...buffer.messages] };
    },

    async clear() {
      store.clear();
    },
  };
}
