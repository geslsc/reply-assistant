import { getRepos } from '../repositories';
import { DbKnowledgeCardRecord } from '../schemas/knowledgeCardDbSchema';
import { dbRecordToKnowledgeCard } from '../schemas/knowledgeCardDbSchema';
import { KnowledgeCard } from '../schemas/knowledgeCardSchema';
import { formatCardDisplayId } from './knowledgeCardIdService';
import { knowledgeCardMatchesQuery } from '../utils/knowledgeCardSearchMatch';

export type KnowledgeDraftMode = 'create' | 'update';

export interface ModifyKnowledgeCardIntent {
  reference: string;
  content?: string;
}

const MODIFY_START_PATTERNS: RegExp[] = [
  /^修改知識卡[:：]?\s*(.+)$/su,
  /^更新知識卡[:：]?\s*(.+)$/su,
  /^修改「(.+?)」這張(?:[:：]\s*(.+))?$/su,
  /^修改「(.+?)」(?:[:：]\s*(.+))?$/su,
  /^更新跟(.+?)有關的知識卡(?:[:：]\s*(.+))?$/su,
  /^更新跟(.+?)相關的知識卡(?:[:：]\s*(.+))?$/su,
  /^更新「(.+?)」這張知識卡(?:[:：]\s*(.+))?$/su,
];

export function parseModifyKnowledgeCardIntent(text: string): ModifyKnowledgeCardIntent | null {
  const trimmed = text.trim();
  for (const pattern of MODIFY_START_PATTERNS) {
    const match = trimmed.match(pattern);
    if (!match?.[1]?.trim()) {
      continue;
    }
    const rawReference = match[1].trim();
    const inlineSplit = rawReference.match(/^(\S+?)[:：]\s*(.+)$/s);
    if (inlineSplit) {
      return {
        reference: inlineSplit[1].trim(),
        content: inlineSplit[2].trim(),
      };
    }
    const content = match[2]?.trim();
    if (content && content.length > 0) {
      return { reference: rawReference, content };
    }
    return { reference: rawReference };
  }
  return null;
}

function normalizeReference(reference: string): string {
  return reference.trim().replace(/^["「]|["」]$/g, '');
}

async function findByDisplayNumber(displayNumber: string): Promise<DbKnowledgeCardRecord[]> {
  const normalized = displayNumber.replace(/\D/g, '').padStart(3, '0');
  const all = await getRepos().knowledgeCards.findAll();
  return all.filter((record) => formatCardDisplayId(record.cardId) === normalized);
}

export async function resolveExistingKnowledgeCard(
  reference: string
): Promise<{ card: KnowledgeCard; record: DbKnowledgeCardRecord } | { error: string }> {
  const normalizedRef = normalizeReference(reference);

  const byId = await getRepos().knowledgeCards.findById(normalizedRef);
  if (byId) {
    return { card: dbRecordToKnowledgeCard(byId), record: byId };
  }

  const byDisplay = await findByDisplayNumber(normalizedRef);
  if (byDisplay.length === 1) {
    return { card: dbRecordToKnowledgeCard(byDisplay[0]!), record: byDisplay[0]! };
  }
  if (byDisplay.length > 1) {
    const titles = byDisplay.map((record) => `${formatCardDisplayId(record.cardId)}｜${record.title}`).join('、');
    return { error: `找到多張符合編號「${normalizedRef}」的知識卡：${titles}，請改用 card_id 或完整標題指定。` };
  }

  const searchResults = (await getRepos().knowledgeCards.search(normalizedRef)).filter((record) =>
    knowledgeCardMatchesQuery(record, normalizedRef)
  );
  if (searchResults.length === 1) {
    return { card: dbRecordToKnowledgeCard(searchResults[0]!), record: searchResults[0]! };
  }
  if (searchResults.length > 1) {
    const titles = searchResults.map((record) => `${record.cardId}｜${record.title}`).join('、');
    return { error: `找到多張相關知識卡：${titles}，請更明確指定 card_id 或標題。` };
  }

  return {
    error: `找不到知識卡「${normalizedRef}」。請改用 card_id（例如 op-login）或「修改知識卡 001」指定編號。`,
  };
}
