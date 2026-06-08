import * as fs from 'fs';
import * as path from 'path';
import { KnowledgeCard } from '../schemas/knowledgeCardSchema';
import { dbRecordToKnowledgeCard } from '../schemas/knowledgeCardDbSchema';
import { getRepos } from '../repositories';
import { CardMatchResult, RiskLevel } from '../types';
import {
  getDefaultKnowledgeJsonPath,
  pauseKnowledgeCardInDb,
  seedKnowledgeBaseFromJson,
} from './knowledgeCardMigrationService';

let knowledgeCache: KnowledgeCard[] = [];

function normalize(text: string): string {
  return text.toLowerCase().replace(/\s+/g, '').trim();
}

export async function refreshKnowledgeCache(): Promise<void> {
  const records = await getRepos().knowledgeCards.findAll();
  knowledgeCache = records.map(dbRecordToKnowledgeCard);
}

export function getKnowledgeJsonBackupPath(): string {
  return getDefaultKnowledgeJsonPath();
}

export function knowledgeJsonBackupExists(): boolean {
  return fs.existsSync(getDefaultKnowledgeJsonPath());
}

/** @deprecated 保留供 migration 讀取 JSON；正式來源已改 DB */
export function loadKnowledgeBase(filePath?: string): KnowledgeCard[] {
  const targetPath = filePath ?? getDefaultKnowledgeJsonPath();
  void targetPath;
  return knowledgeCache;
}

export async function initKnowledgeBase(filePath?: string): Promise<{ knowledgeEmpty: boolean }> {
  const { getEnv } = await import('../config/env');
  const { logger } = await import('../config/logger');
  const env = getEnv();
  const count = await getRepos().knowledgeCards.count();

  if (count > 0) {
    await refreshKnowledgeCache();
    return { knowledgeEmpty: false };
  }

  if (env.NODE_ENV === 'production') {
    logger.warn(
      'knowledge_cards table is empty; run npm run db:migrate && npm run db:migrate:knowledge'
    );
    return { knowledgeEmpty: true };
  }

  await seedKnowledgeBaseFromJson(filePath);
  await refreshKnowledgeCache();
  return { knowledgeEmpty: false };
}

export async function isKnowledgeBaseEmpty(): Promise<boolean> {
  return (await getRepos().knowledgeCards.count()) === 0;
}

export function getKnowledgeItems(): KnowledgeCard[] {
  return knowledgeCache;
}

export function getLoadedFromPath(): string | null {
  return knowledgeJsonBackupExists() ? getDefaultKnowledgeJsonPath() : null;
}

async function getEffectiveStatus(item: KnowledgeCard): Promise<'可用' | '暫停'> {
  const override = await getRepos().knowledgeOverrides.findByCardId(item.card_id);
  if (override?.statusOverride === '暫停') {
    return '暫停';
  }
  const dbRecord = await getRepos().knowledgeCards.findById(item.card_id);
  if (dbRecord?.status === 'paused') {
    return '暫停';
  }
  return item.status;
}

export async function getActiveCards(): Promise<KnowledgeCard[]> {
  if (knowledgeCache.length === 0) {
    await refreshKnowledgeCache();
  }
  const active: KnowledgeCard[] = [];
  for (const item of knowledgeCache) {
    const status = await getEffectiveStatus(item);
    if (status === '可用') {
      active.push({ ...item, status });
    }
  }
  return active;
}

export function getCardById(id: string): KnowledgeCard | undefined {
  return knowledgeCache.find((item) => item.card_id === id);
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
  await pauseKnowledgeCardInDb(cardId, updatedBy, reason);
  const paused = { ...card, status: '暫停' as const };
  knowledgeCache = knowledgeCache.map((c) => (c.card_id === cardId ? paused : c));
  return paused;
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
  knowledgeCache = items;
}

export async function clearKnowledgeOverrides(): Promise<void> {
  await getRepos().knowledgeOverrides.clear();
}

export async function getCardByIdFromDb(id: string): Promise<KnowledgeCard | null> {
  const record = await getRepos().knowledgeCards.findById(id);
  return record ? dbRecordToKnowledgeCard(record) : null;
}
