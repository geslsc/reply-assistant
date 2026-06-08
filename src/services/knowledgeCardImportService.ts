import { deriveCanPublicReply, KnowledgeCard } from '../schemas/knowledgeCardSchema';
import { BotReply, RiskLevel } from '../types';
import { getRepos } from '../repositories';
import { validateKnowledgeCard } from './knowledgeCardValidator';
import { TRACKING_FIELDS } from '../schemas/knowledgeCardDbSchema';
import { isActiveAdmin } from './consultantWhitelist';
import { writeKnowledgeCardToDb } from './knowledgeCardMigrationService';
import { refreshKnowledgeCache } from './knowledgeBaseService';
import { CONFIRM_BULK_IMPORT_PHRASE } from './knowledgeCardWriteService';
import { logKnowledgeCardValidationFailure } from './knowledgeCardEventLog';

export interface BulkImportPreviewItem {
  cardId: string;
  action: 'create' | 'update';
}

export interface BulkImportRejectedItem {
  cardId: string;
  reasons: string[];
}

export interface BulkImportPreview {
  toCreate: BulkImportPreviewItem[];
  toUpdate: BulkImportPreviewItem[];
  rejected: BulkImportRejectedItem[];
}

const pendingImports = new Map<string, { cards: KnowledgeCard[]; preview: BulkImportPreview }>();

export function clearBulkImportState(): void {
  pendingImports.clear();
}

function prepareImportRaw(raw: unknown): Record<string, unknown> | null {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    return null;
  }
  const obj = raw as Record<string, unknown>;
  for (const field of TRACKING_FIELDS) {
    if (field in obj) {
      return null;
    }
  }
  const cardId = String(obj.card_id ?? obj.id ?? '');
  const patterns = (obj.patterns ?? obj.common_questions ?? []) as string[];
  const riskLevel = (obj.risk_level ?? RiskLevel.LOW) as RiskLevel;
  return {
    card_id: cardId,
    title: String(obj.title ?? cardId),
    patterns,
    risk_level: riskLevel,
    can_public_reply: obj.can_public_reply ?? deriveCanPublicReply(riskLevel),
    standard_answer: String(obj.standard_answer ?? ''),
    not_applicable: (obj.not_applicable ?? []) as string[],
    escalate_to_consultant: (obj.escalate_to_consultant ?? []) as string[],
    status: obj.status ?? '可用',
  };
}

function normalizeImportItem(raw: unknown): { card?: KnowledgeCard; reasons: string[] } {
  const prepared = prepareImportRaw(raw);
  if (!prepared) {
    const obj = raw as Record<string, unknown> | null;
    if (obj && typeof obj === 'object') {
      for (const field of TRACKING_FIELDS) {
        if (field in obj) {
          return { reasons: [`不允許欄位 ${field}`] };
        }
      }
    }
    return { reasons: ['必須是有效 JSON 物件'] };
  }
  const validated = validateKnowledgeCard(prepared);
  if (!validated.valid || !validated.normalized) {
    return {
      reasons: validated.errors.map((e) => `${e.field}: ${e.message}`),
    };
  }
  return { card: validated.normalized, reasons: [] };
}

export async function previewBulkImport(
  adminUserId: string,
  jsonText: string
): Promise<{ ok: boolean; message: string; replies: BotReply[] }> {
  if (!(await isActiveAdmin(adminUserId))) {
    return {
      ok: false,
      message: 'denied',
      replies: [{ type: 'push', userId: adminUserId, text: '只有 active admin 可批量匯入。' }],
    };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(jsonText);
  } catch {
    return {
      ok: false,
      message: 'invalid json',
      replies: [{ type: 'push', userId: adminUserId, text: 'JSON 格式無效，請確認後再試。' }],
    };
  }

  if (!Array.isArray(parsed)) {
    return {
      ok: false,
      message: 'not array',
      replies: [{ type: 'push', userId: adminUserId, text: '批量匯入 JSON 必須是陣列。' }],
    };
  }

  const preview: BulkImportPreview = { toCreate: [], toUpdate: [], rejected: [] };
  const validCards: KnowledgeCard[] = [];

  for (const item of parsed) {
    const cardId =
      typeof item === 'object' && item !== null
        ? String((item as Record<string, unknown>).card_id ?? '')
        : '';
    const result = normalizeImportItem(item);
    if (!result.card) {
      preview.rejected.push({
        cardId: cardId || '(unknown)',
        reasons: result.reasons.length > 0 ? result.reasons : ['驗證失敗'],
      });
      continue;
    }
    validCards.push(result.card);
    const existing = await getRepos().knowledgeCards.findById(result.card.card_id);
    if (existing) {
      preview.toUpdate.push({ cardId: result.card.card_id, action: 'update' });
    } else {
      preview.toCreate.push({ cardId: result.card.card_id, action: 'create' });
    }
  }

  pendingImports.set(adminUserId, { cards: validCards, preview });

  const duplicateIds = preview.toUpdate.map((i) => i.cardId);
  const lines = [
    '【批量匯入預覽｜尚未寫入】',
    `將新增 ${preview.toCreate.length} 張`,
    `將更新 ${preview.toUpdate.length} 張`,
    duplicateIds.length > 0
      ? `重複 card_id（更新候選）：${duplicateIds.join(', ')}`
      : '重複 card_id（更新候選）：無',
    `被 validator 擋下 ${preview.rejected.length} 張`,
  ];

  for (const rejected of preview.rejected) {
    lines.push(`- ${rejected.cardId}: ${rejected.reasons.join('; ')}`);
  }

  lines.push('', '若確認覆蓋更新，請回覆「確認批量匯入」。');

  return {
    ok: true,
    message: 'preview ok',
    replies: [{ type: 'push', userId: adminUserId, text: lines.join('\n') }],
  };
}

export async function executeBulkImport(adminUserId: string): Promise<BotReply[]> {
  if (!(await isActiveAdmin(adminUserId))) {
    return [{ type: 'push', userId: adminUserId, text: '只有 active admin 可批量匯入。' }];
  }

  const pending = pendingImports.get(adminUserId);
  if (!pending) {
    return [{ type: 'push', userId: adminUserId, text: '目前沒有待確認的批量匯入，請先送「批量匯入」+ JSON。' }];
  }

  let created = 0;
  let updated = 0;
  const failures: Array<{ cardId: string; reason: string }> = [];

  for (const card of pending.cards) {
    const revalidated = validateKnowledgeCard(card);
    if (!revalidated.valid || !revalidated.normalized) {
      const reason = revalidated.errors.map((e) => `${e.field}: ${e.message}`).join('; ');
      failures.push({ cardId: card.card_id, reason });
      await logKnowledgeCardValidationFailure({
        cardId: card.card_id,
        operation: 'import',
        operatorUserId: adminUserId,
        reasons: revalidated.errors.map((e) => `${e.field}: ${e.message}`),
      });
      continue;
    }

    const existing = await getRepos().knowledgeCards.findById(revalidated.normalized.card_id);
    const writeResult = await writeKnowledgeCardToDb({
      card: revalidated.normalized,
      operatorUserId: adminUserId,
      operation: 'import',
      summary: existing ? 'bulk import update' : 'bulk import create',
    });

    if (writeResult === null) {
      failures.push({ cardId: revalidated.normalized.card_id, reason: '寫入前驗證失敗' });
      continue;
    }

    if (existing) {
      updated += 1;
    } else {
      created += 1;
    }
  }

  pendingImports.delete(adminUserId);
  await refreshKnowledgeCache();

  const lines = [
    `批量匯入完成：成功 ${created + updated} 筆（新增 ${created}、更新 ${updated}）`,
    `失敗 ${failures.length} 筆`,
  ];
  for (const fail of failures) {
    lines.push(`- ${fail.cardId}: ${fail.reason}`);
  }

  return [{ type: 'push', userId: adminUserId, text: lines.join('\n') }];
}

export function parseBulkImportPayload(text: string): string | null {
  const trimmed = text.trim();
  if (trimmed === '批量匯入') {
    return null;
  }
  const match = trimmed.match(/^批量匯入\s*([\s\S]+)/);
  return match ? match[1].trim() : null;
}

export function isBulkImportStart(text: string): boolean {
  return text.trim() === '批量匯入' || /^批量匯入\s/.test(text.trim());
}

export function isConfirmBulkImportPhrase(text: string): boolean {
  return text.trim() === CONFIRM_BULK_IMPORT_PHRASE;
}

export function getPendingImportPreview(adminUserId: string): BulkImportPreview | undefined {
  return pendingImports.get(adminUserId)?.preview;
}

/** 測試用：直接注入待確認批量匯入 */
export function seedPendingImportForTest(adminUserId: string, cards: KnowledgeCard[]): void {
  pendingImports.set(adminUserId, {
    cards,
    preview: { toCreate: [], toUpdate: [], rejected: [] },
  });
}
