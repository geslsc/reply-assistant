import { BotReply } from '../types';
import { dbRecordToExportJson } from '../schemas/knowledgeCardDbSchema';
import { getRepos } from '../repositories';
import { RiskLevel } from '../types';
import { isActiveAdmin } from './consultantWhitelist';

const LINE_TEXT_LIMIT = 5000;

export function splitLongText(text: string, limit = LINE_TEXT_LIMIT): string[] {
  if (text.length <= limit) {
    return [text];
  }
  const parts: string[] = [];
  let remaining = text;
  let index = 1;
  const total = Math.ceil(text.length / limit);
  while (remaining.length > 0) {
    const chunk = remaining.slice(0, limit);
    parts.push(`（第 ${index}/${total} 段，請依序合併）\n${chunk}`);
    remaining = remaining.slice(limit);
    index += 1;
  }
  return parts;
}

export type ExportFilter = 'all' | 'low_risk' | 'active';

export async function exportKnowledgeCards(
  adminUserId: string,
  filter: ExportFilter
): Promise<{ ok: boolean; message: string; replies: BotReply[] }> {
  if (!(await isActiveAdmin(adminUserId))) {
    return {
      ok: false,
      message: '只有 active admin 可匯出知識卡。',
      replies: [{ type: 'push', userId: adminUserId, text: '只有 active admin 可匯出知識卡。' }],
    };
  }

  let records = await getRepos().knowledgeCards.findAll();
  if (filter === 'low_risk') {
    records = records.filter((r) => r.riskLevel === RiskLevel.LOW);
  } else if (filter === 'active') {
    records = records.filter((r) => r.status === 'active');
  }

  const payload = records.map((r) => dbRecordToExportJson(r));
  const json = JSON.stringify(payload, null, 2);
  const header =
    filter === 'all'
      ? '【匯出所有知識卡】'
      : filter === 'low_risk'
        ? '【匯出 low risk 知識卡】'
        : '【匯出 active 知識卡】';
  const fullText = `${header}\n${json}`;
  const chunks = splitLongText(fullText);

  if (filter === 'all') {
    await getRepos().consultants.setLastKnowledgeExportAt(
      adminUserId,
      new Date().toISOString()
    );
  }

  const replies: BotReply[] = chunks.map((chunk) => ({
    type: 'push' as const,
    userId: adminUserId,
    text: chunk,
  }));

  return { ok: true, message: 'export ok', replies };
}

export function parseExportCommand(text: string): ExportFilter | null {
  const trimmed = text.trim();
  if (trimmed === '匯出所有知識卡') {
    return 'all';
  }
  if (trimmed === '匯出 low risk 的卡') {
    return 'low_risk';
  }
  if (trimmed === '匯出 active 的卡') {
    return 'active';
  }
  return null;
}
