import * as fs from 'fs';
import * as path from 'path';
import { deriveCanPublicReply, KnowledgeCard } from '../schemas/knowledgeCardSchema';
import {
  appStatusToDb,
  knowledgeCardToDbFields,
} from '../schemas/knowledgeCardDbSchema';
import { getEnv } from '../config/env';
import { logger } from '../config/logger';
import { getRepos } from '../repositories';
import { RiskLevel } from '../types';
import { validateKnowledgeCard } from './knowledgeCardValidator';
import { TRACKING_FIELDS } from '../schemas/knowledgeCardDbSchema';
import {
  logKnowledgeCardValidationFailure,
  logKnowledgeCardWrite,
} from './knowledgeCardEventLog';
import { writeKnowledgeCardWithValidation } from './knowledgeCardWriteGate';

const DEFAULT_KNOWLEDGE_PATH = path.join(
  __dirname,
  '..',
  'data',
  'knowledge_items.json'
);

export const MIGRATION_ACTOR = 'migration_from_json';

export interface MigrationCardResult {
  cardId: string;
  success: boolean;
  reason?: string;
}

export interface MigrationRunResult {
  success: MigrationCardResult[];
  failed: MigrationCardResult[];
  jsonCount: number;
  dbCount: number;
  countMatch: boolean;
}

function normalizeLegacyCard(raw: Record<string, unknown>): Record<string, unknown> {
  const cardId = String(raw.card_id ?? raw.id ?? '');
  const patterns = (raw.patterns ?? raw.common_questions ?? []) as string[];
  const riskLevel = (raw.risk_level ?? RiskLevel.LOW) as RiskLevel;
  const statusRaw = raw.status ?? '可用';
  const status =
    statusRaw === 'active' || statusRaw === '可用'
      ? '可用'
      : statusRaw === 'paused' || statusRaw === '暫停'
        ? '暫停'
        : statusRaw;
  return {
    card_id: cardId,
    title: String(raw.title ?? cardId),
    patterns,
    risk_level: riskLevel,
    can_public_reply: deriveCanPublicReply(riskLevel),
    standard_answer: String(raw.standard_answer ?? ''),
    not_applicable: (raw.not_applicable ?? []) as string[],
    escalate_to_consultant: (raw.escalate_to_consultant ?? []) as string[],
    status,
  };
}

export function readKnowledgeItemsJson(filePath?: string): unknown[] {
  const targetPath = filePath ?? DEFAULT_KNOWLEDGE_PATH;
  return JSON.parse(fs.readFileSync(targetPath, 'utf-8')) as unknown[];
}

export function getDefaultKnowledgeJsonPath(): string {
  return DEFAULT_KNOWLEDGE_PATH;
}

export function validateJsonCard(raw: unknown): { card?: KnowledgeCard; reason?: string } {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    return { reason: '必須是 JSON 物件' };
  }
  const obj = raw as Record<string, unknown>;
  for (const field of TRACKING_FIELDS) {
    if (field in obj) {
      return { reason: `不允許欄位 ${field}` };
    }
  }
  const normalized = normalizeLegacyCard(obj);
  const validated = validateKnowledgeCard(normalized);
  if (!validated.valid || !validated.normalized) {
    const reason = validated.errors.map((e) => `${e.field}: ${e.message}`).join('; ');
    return { reason: reason || '驗證失敗' };
  }
  return { card: validated.normalized };
}

export async function migrateKnowledgeCardsFromJson(options: {
  dryRun?: boolean;
  filePath?: string;
  executedAt?: string;
}): Promise<MigrationRunResult> {
  const dryRun = options.dryRun ?? false;
  const executedAt = options.executedAt ?? new Date().toISOString();
  const rawItems = readKnowledgeItemsJson(options.filePath);
  const success: MigrationCardResult[] = [];
  const failed: MigrationCardResult[] = [];

  for (const raw of rawItems) {
    const cardId =
      typeof raw === 'object' && raw !== null
        ? String((raw as Record<string, unknown>).card_id ?? (raw as Record<string, unknown>).id ?? '')
        : '';
    const validated = validateJsonCard(raw);
    if (!validated.card) {
      failed.push({
        cardId: cardId || '(unknown)',
        success: false,
        reason: validated.reason,
      });
      continue;
    }

    if (dryRun) {
      success.push({ cardId: validated.card.card_id, success: true });
      continue;
    }

    const validation = validateKnowledgeCard(validated.card);
    if (!validation.valid || !validation.normalized) {
      const reason = validation.errors.map((e) => `${e.field}: ${e.message}`).join('; ');
      await logKnowledgeCardValidationFailure({
        cardId: validated.card.card_id,
        operation: 'migration',
        operatorUserId: MIGRATION_ACTOR,
        reasons: validation.errors.map((e) => `${e.field}: ${e.message}`),
      });
      failed.push({ cardId: validated.card.card_id, success: false, reason });
      continue;
    }

    try {
      const fields = knowledgeCardToDbFields(validation.normalized);
      await getRepos().knowledgeCards.insert({
        ...fields,
        createdBy: MIGRATION_ACTOR,
        createdAt: executedAt,
        updatedBy: null,
        updatedAt: null,
        confirmedBy: MIGRATION_ACTOR,
        confirmedAt: executedAt,
      });
      await logKnowledgeCardWrite({
        cardId: validation.normalized.card_id,
        operation: 'import',
        operatorUserId: MIGRATION_ACTOR,
        summary: 'migration_from_json',
        timestamp: executedAt,
      });
      success.push({ cardId: validated.card.card_id, success: true });
    } catch (error) {
      failed.push({
        cardId: validated.card.card_id,
        success: false,
        reason: error instanceof Error ? error.message : String(error),
      });
    }
  }

  const jsonCount = rawItems.length;
  const dbCount = dryRun ? 0 : await getRepos().knowledgeCards.count();
  const countMatch = dryRun ? failed.length === 0 : dbCount === jsonCount;

  return { success, failed, jsonCount, dbCount, countMatch };
}

export async function seedKnowledgeBaseFromJson(filePath?: string): Promise<void> {
  const env = getEnv();
  if (env.NODE_ENV === 'production') {
    return;
  }
  const count = await getRepos().knowledgeCards.count();
  if (count > 0) {
    return;
  }
  const result = await migrateKnowledgeCardsFromJson({ dryRun: false, filePath });
  if (!result.countMatch) {
    throw new Error(
      `Knowledge seed count mismatch: JSON=${result.jsonCount}, DB=${result.dbCount}`
    );
  }
}

export async function writeKnowledgeCardToDb(params: {
  card: KnowledgeCard;
  operatorUserId: string;
  operation: 'create' | 'update' | 'import';
  summary: string;
}): Promise<'create' | 'update' | null> {
  const result = await writeKnowledgeCardWithValidation({
    card: params.card,
    operatorUserId: params.operatorUserId,
    operation: params.operation,
    summary: params.summary,
    validationOperation: params.operation,
  });
  if (!result.ok) {
    return null;
  }
  return result.effectiveOperation ?? null;
}

export async function pauseKnowledgeCardInDb(
  cardId: string,
  operatorUserId: string,
  reason?: string
): Promise<boolean> {
  const now = new Date().toISOString();
  const updated = await getRepos().knowledgeCards.setStatus(cardId, 'paused', {
    updatedBy: operatorUserId,
    confirmedBy: operatorUserId,
    confirmedAt: now,
  });
  if (!updated) {
    return false;
  }
  await logKnowledgeCardWrite({
    cardId,
    operation: 'pause',
    operatorUserId,
    summary: reason ? `paused: ${reason}` : 'paused',
  });
  return true;
}

export function mapDbStatusForApp(dbStatus: string): '可用' | '暫停' {
  return dbStatus === 'active' ? '可用' : '暫停';
}

export function formatMigrationReport(result: MigrationRunResult, dryRun: boolean): string {
  const lines = [
    dryRun ? '【Migration Dry Run】' : '【Migration 正式執行】',
    `JSON 卡數：${result.jsonCount}`,
    dryRun ? `預計成功：${result.success.length}` : `DB 卡數：${result.dbCount}`,
    `失敗：${result.failed.length}`,
    dryRun ? '' : `卡數比對：${result.countMatch ? '一致' : '不一致（告警）'}`,
    '',
    '成功清單：',
    ...result.success.map((s) => `- ${s.cardId}`),
  ];
  if (result.failed.length > 0) {
    lines.push('', '失敗清單：');
    for (const fail of result.failed) {
      lines.push(`- ${fail.cardId}: ${fail.reason ?? 'unknown'}`);
    }
  }
  return lines.join('\n');
}

export { appStatusToDb };
