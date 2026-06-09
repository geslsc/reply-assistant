import { v4 as uuidv4 } from 'uuid';
import { getRepos } from '../repositories';

/** 新增模式草稿占位 card_id，確認更新時由系統分配唯一 id */
export const PENDING_CARD_ID = '__pending__';

const PLACEHOLDER_CARD_IDS = new Set([
  PENDING_CARD_ID,
  '001',
  'pending',
  'new',
  'draft',
]);

export function isPlaceholderCardId(cardId: string): boolean {
  const normalized = cardId.trim().toLowerCase();
  return PLACEHOLDER_CARD_IDS.has(normalized) || normalized.length === 0;
}

export async function allocateUniqueCardId(): Promise<string> {
  const existingIds = new Set((await getRepos().knowledgeCards.findAll()).map((record) => record.cardId));
  const date = new Date().toISOString().slice(0, 10).replace(/-/g, '');

  for (let seq = 1; seq < 10000; seq += 1) {
    const candidate = `kc-${date}-${String(seq).padStart(3, '0')}`;
    if (!existingIds.has(candidate)) {
      return candidate;
    }
  }

  return `kc-${date}-${uuidv4().replace(/-/g, '').slice(0, 6)}`;
}

export function formatCardDisplayId(cardId: string): string {
  const digits = cardId.replace(/\D/g, '');
  if (digits.length >= 3) {
    return digits.slice(-3).padStart(3, '0');
  }
  return cardId.slice(-3).padStart(3, '0');
}
