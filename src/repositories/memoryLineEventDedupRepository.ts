import { LineEventDedupRepository } from './interfaces';

export function createMemoryLineEventDedupRepository(): LineEventDedupRepository {
  const claimed = new Set<string>();

  return {
    async claim(eventId) {
      if (claimed.has(eventId)) {
        return false;
      }
      claimed.add(eventId);
      return true;
    },
    async clear() {
      claimed.clear();
    },
  };
}
