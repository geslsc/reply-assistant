import * as fs from 'fs';
import * as path from 'path';
import {
  deriveCanPublicReply,
  KnowledgeCard,
} from '../schemas/knowledgeCardSchema';
import { enforceKnowledgeCardRules } from './knowledgeCardValidator';
import { CardMatchResult, RiskLevel } from '../types';
import { getRepos } from '../repositories';

let knowledgeItems: KnowledgeCard[] = [];
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

/** 載入時正規化舊格式（id / common_questions）→ 新 9 欄位 */
function normalizeLegacyCard(raw: Record<string, unknown>): KnowledgeCard {
  const cardId = String(raw.card_id ?? raw.id ?? '');
  const patterns = (raw.patterns ?? raw.common_questions ?? []) as string[];
  const riskLevel = (raw.risk_level ?? RiskLevel.LOW) as RiskLevel;
  const candidate = {
    card_id: cardId,
    title: String(raw.title ?? cardId),
    patterns,
    risk_level: riskLevel,
    can_public_reply: deriveCanPublicReply(riskLevel),
    standard_answer: String(raw.standard_answer ?? ''),
    not_applicable: (raw.not_applicable ?? []) as string[],
    escalate_to_consultant: (raw.escalate_to_consultant ?? []) as string[],
    status: (raw.status ?? '可用') as '可用' | '暫停',
  };
  const validated = enforceKnowledgeCardRules(candidate);
  if (validated.valid && validated.normalized) {
    return validated.normalized;
  }
  return candidate as KnowledgeCard;
}

export function loadKnowledgeBase(filePath?: string): KnowledgeCard[] {
  const targetPath = filePath ?? DEFAULT_KNOWLEDGE_PATH;
  const raw = JSON.parse(fs.readFileSync(targetPath, 'utf-8')) as unknown[];
  knowledgeItems = raw.map((item) =>
    normalizeLegacyCard(item as Record<string, unknown>)
  );
  loadedFromPath = targetPath;
  return knowledgeItems;
}

export function getKnowledgeItems(): KnowledgeCard[] {
  if (knowledgeItems.length === 0) {
    loadKnowledgeBase();
  }
  return knowledgeItems;
}

export function getLoadedFromPath(): string | null {
  return loadedFromPath;
}

async function getEffectiveStatus(item: KnowledgeCard): Promise<'可用' | '暫停'> {
  const override = await getRepos().knowledgeOverrides.findByCardId(item.card_id);
  if (override?.statusOverride === '暫停') {
    return '暫停';
  }
  return item.status;
}

export async function getActiveCards(): Promise<KnowledgeCard[]> {
  const items = getKnowledgeItems();
  const active: KnowledgeCard[] = [];
  for (const item of items) {
    const status = await getEffectiveStatus(item);
    if (status === '可用') {
      active.push({ ...item, status });
    }
  }
  return active;
}

export function getCardById(id: string): KnowledgeCard | undefined {
  return getKnowledgeItems().find((item) => item.card_id === id);
}

export async function pauseCard(
  cardId: string,
  updatedBy: string,
  reason?: string
): Promise<KnowledgeCard | undefined> {
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
): Promise<KnowledgeCard | undefined> {
  if (!cardId) {
    return undefined;
  }
  return pauseCard(cardId, updatedBy);
}

export async function matchKnowledgeCard(question: string): Promise<CardMatchResult> {
  const normalizedQ = normalize(question);
  const activeCards = await getActiveCards();

  let bestCard: KnowledgeCard | null = null;
  let bestScore = 0;

  for (const card of activeCards) {
    for (const pattern of card.patterns) {
      const normalizedPattern = normalize(pattern);
      if (normalizedQ === normalizedPattern) {
        return { card, confidence: 'hit' };
      }
      if (
        normalizedQ.includes(normalizedPattern) ||
        normalizedPattern.includes(normalizedQ)
      ) {
        const score = normalizedPattern.length;
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

export function isOfficialCsCard(card: KnowledgeCard): boolean {
  return card.card_id.startsWith('official-cs') || card.risk_level === RiskLevel.UNKNOWN;
}

export function resetKnowledgeBase(items: KnowledgeCard[]): void {
  knowledgeItems = items;
}

export async function clearKnowledgeOverrides(): Promise<void> {
  await getRepos().knowledgeOverrides.clear();
}
