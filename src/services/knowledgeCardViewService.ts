import { BotReply } from '../types';
import { getRepos } from '../repositories';
import { isActiveAdmin, isActiveConsultantOrAdmin, getConsultant } from './consultantWhitelist';
import { splitLongText } from './knowledgeCardExportService';
import { dbRecordToExportJson } from '../schemas/knowledgeCardDbSchema';
import { DbKnowledgeCardRecord } from '../schemas/knowledgeCardDbSchema';

function formatAdminCardSummary(record: DbKnowledgeCardRecord): string {
  const exported = dbRecordToExportJson(record);
  return [
    `- ${exported.card_id}｜${exported.title}`,
    `  status=${exported.status} risk=${exported.risk_level}`,
    `  created_by=${exported.created_by} confirmed_by=${exported.confirmed_by}`,
    `  created_at=${exported.created_at}`,
    exported.updated_at ? `  updated_by=${exported.updated_by} updated_at=${exported.updated_at}` : '',
  ]
    .filter(Boolean)
    .join('\n');
}

function formatConsultantCardSummary(record: DbKnowledgeCardRecord): string {
  return `- ${record.cardId}｜${record.title}｜risk=${record.riskLevel}`;
}

async function ensureCanViewKnowledgeCards(userId: string): Promise<BotReply[] | null> {
  if (await isActiveConsultantOrAdmin(userId)) {
    return null;
  }
  const record = await getConsultant(userId);
  const status = record?.status ?? 'pending';
  return [
    {
      type: 'push',
      userId,
      text: `您目前身份（${status}）不可查看知識庫。`,
    },
  ];
}

export async function listAllKnowledgeCards(userId: string): Promise<BotReply[]> {
  const blocked = await ensureCanViewKnowledgeCards(userId);
  if (blocked) {
    return blocked;
  }

  const isAdmin = await isActiveAdmin(userId);
  const records = isAdmin
    ? await getRepos().knowledgeCards.findAll()
    : await getRepos().knowledgeCards.findByStatus('active');

  const lines = [
    isAdmin ? '【知識卡清單｜全部】' : '【知識卡清單｜active】',
    `共 ${records.length} 張`,
    '',
  ];
  for (const record of records) {
    lines.push(
      isAdmin ? formatAdminCardSummary(record) : formatConsultantCardSummary(record)
    );
  }
  return splitLongText(lines.join('\n')).map((text) => ({ type: 'push' as const, userId, text }));
}

export async function listActiveKnowledgeCards(userId: string): Promise<BotReply[]> {
  const blocked = await ensureCanViewKnowledgeCards(userId);
  if (blocked) {
    return blocked;
  }

  const isAdmin = await isActiveAdmin(userId);
  const records = await getRepos().knowledgeCards.findByStatus('active');
  const lines = ['【active 知識卡】', `共 ${records.length} 張`, ''];
  for (const record of records) {
    lines.push(
      isAdmin ? formatAdminCardSummary(record) : formatConsultantCardSummary(record)
    );
  }
  return splitLongText(lines.join('\n')).map((text) => ({ type: 'push' as const, userId, text }));
}

export async function searchLoginRelatedCards(userId: string): Promise<BotReply[]> {
  const blocked = await ensureCanViewKnowledgeCards(userId);
  if (blocked) {
    return blocked;
  }

  const isAdmin = await isActiveAdmin(userId);
  const records = await getRepos().knowledgeCards.search('登入');
  const filtered = isAdmin ? records : records.filter((record) => record.status === 'active');

  const lines = ['【登入相關知識卡】', `共 ${filtered.length} 張`, ''];
  for (const record of filtered) {
    lines.push(
      isAdmin ? formatAdminCardSummary(record) : formatConsultantCardSummary(record)
    );
  }
  if (filtered.length === 0) {
    lines.push('（找不到相關知識卡）');
  }
  return [{ type: 'push', userId, text: lines.join('\n') }];
}

export function parseViewCommand(text: string): 'all' | 'active' | 'login' | null {
  const trimmed = text.trim();
  if (trimmed === '列出所有知識卡') {
    return 'all';
  }
  if (trimmed === '列出 active 的卡') {
    return 'active';
  }
  if (trimmed === '找跟登入有關的卡') {
    return 'login';
  }
  return null;
}

export async function handleViewCommand(
  userId: string,
  command: 'all' | 'active' | 'login'
): Promise<BotReply[]> {
  if (command === 'all') {
    return listAllKnowledgeCards(userId);
  }
  if (command === 'active') {
    return listActiveKnowledgeCards(userId);
  }
  return searchLoginRelatedCards(userId);
}
