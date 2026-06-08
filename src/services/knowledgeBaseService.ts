import * as fs from 'fs';
import * as path from 'path';
import { CardMatchResult, KnowledgeItem, RiskLevel } from '../types';
import { getRepos } from '../repositories';

let knowledgeItems: KnowledgeItem[] = [];
let loadedFromPath: string | null = null;

const DEFAULT_KNOWLEDGE_PATH = path.join(
  __dirname,
  '..',
  'data',
  'knowledge_items.json'
);

function normalize(text: string): string {
  return text.toLowerCase().replace(/\s+/g, '').trim();
}

export function loadKnowledgeBase(filePath?: string): KnowledgeItem[] {
  const targetPath = filePath ?? DEFAULT_KNOWLEDGE_PATH;
  const raw = fs.readFileSync(targetPath, 'utf-8');
  knowledgeItems = JSON.parse(raw) as KnowledgeItem[];
  loadedFromPath = targetPath;
  return knowledgeItems;
}

export function getKnowledgeItems(): KnowledgeItem[] {
  if (knowledgeItems.length === 0) {
    loadKnowledgeBase();
  }
  return knowledgeItems;
}

export function getLoadedFromPath(): string | null {
  return loadedFromPath;
}

async function getEffectiveStatus(item: KnowledgeItem): Promise<'可用' | '暫停'> {
  const override = await getRepos().knowledgeOverrides.findByCardId(item.id);
  if (override?.statusOverride === '暫停') {
    return '暫停';
  }
  return item.status;
}

export async function getActiveCards(): Promise<KnowledgeItem[]> {
  const items = getKnowledgeItems();
  const active: KnowledgeItem[] = [];
  for (const item of items) {
    const status = await getEffectiveStatus(item);
    if (status === '可用') {
      active.push({ ...item, status });
    }
  }
  return active;
}

export function getCardById(id: string): KnowledgeItem | undefined {
  return getKnowledgeItems().find((item) => item.id === id);
}

export async function pauseCard(
  cardId: string,
  updatedBy: string,
  reason?: string
): Promise<KnowledgeItem | undefined> {
  const card = getCardById(cardId);
  if (!card) {
    return undefined;
  }
  await getRepos().knowledgeOverrides.setPaused(cardId, updatedBy, reason);
  return { ...card, status: '暫停' };
}

export async function pauseLastReferencedCard(
  cardId: string | null,
  updatedBy: string
): Promise<KnowledgeItem | undefined> {
  if (!cardId) {
    return undefined;
  }
  return pauseCard(cardId, updatedBy);
}

export async function matchKnowledgeCard(question: string): Promise<CardMatchResult> {
  const normalizedQ = normalize(question);
  const activeCards = await getActiveCards();

  let bestCard: KnowledgeItem | null = null;
  let bestScore = 0;

  for (const card of activeCards) {
    for (const cq of card.common_questions) {
      const normalizedCq = normalize(cq);
      if (normalizedQ === normalizedCq) {
        return { card, confidence: 'hit' };
      }
      if (
        normalizedQ.includes(normalizedCq) ||
        normalizedCq.includes(normalizedQ)
      ) {
        const score = normalizedCq.length;
        if (score > bestScore) {
          bestScore = score;
          bestCard = card;
        }
      }
    }
  }

  if (bestCard && bestScore > 0) {
    return { card: bestCard, confidence: 'partial' };
  }

  return { card: null, confidence: 'miss' };
}

export function isOfficialCsCard(card: KnowledgeItem): boolean {
  return card.id.startsWith('official-cs') || card.risk_level === RiskLevel.UNKNOWN;
}

export function resetKnowledgeBase(items: KnowledgeItem[]): void {
  knowledgeItems = items;
}

export async function clearKnowledgeOverrides(): Promise<void> {
  await getRepos().knowledgeOverrides.clear();
}
