import { BotReply, RiskLevel } from '../types';
import { getRepos } from '../repositories';
import { isActiveAdmin, isActiveConsultantOrAdmin, getConsultant } from './consultantWhitelist';
import { splitLongText } from './knowledgeCardExportService';
import { DbKnowledgeCardRecord } from '../schemas/knowledgeCardDbSchema';
import { dbRecordToKnowledgeCard } from '../schemas/knowledgeCardDbSchema';
import {
  scoreKnowledgeCardSearchMatch,
} from '../utils/knowledgeCardSearchMatch';

function describePublicReplyForView(record: DbKnowledgeCardRecord): { label: string; reason?: string } {
  if (record.canPublicReply && record.riskLevel === RiskLevel.LOW) {
    return { label: '會' };
  }
  if (record.riskLevel !== RiskLevel.LOW) {
    return {
      label: '不會',
      reason: '涉及金額或帳務確認時，需要導入教練協助。',
    };
  }
  return {
    label: '不會',
    reason: '這張卡僅作為導入教練參考，不會自動公開回答。',
  };
}

function formatCardNumber(cardId: string): string {
  const digits = cardId.replace(/\D/g, '');
  if (digits.length >= 3) {
    return digits.slice(-3).padStart(3, '0');
  }
  return cardId.slice(-3).padStart(3, '0');
}

export function formatHumanReadableKnowledgeCardView(record: DbKnowledgeCardRecord): string {
  const card = dbRecordToKnowledgeCard(record);
  const publicReply = describePublicReplyForView(record);
  const shortNumber = formatCardNumber(card.card_id);
  const lines: string[] = [
    `【知識卡】${card.title}（${shortNumber}）`,
    `知識卡編號：${card.card_id}`,
    '',
    '店家可能會問：',
    ...card.patterns.map((pattern) => `- ${pattern}`),
    '',
    '建議回答：',
    card.standard_answer,
  ];

  if (card.not_applicable.length > 0) {
    lines.push('', '不適用情況：', ...card.not_applicable.map((item) => `- ${item}`));
  }

  if (card.escalate_to_consultant.length > 0) {
    lines.push(
      '',
      '需要導入教練協助：',
      ...card.escalate_to_consultant.map((item) => `- ${item}`)
    );
  }

  lines.push('', '小助手是否會自動回群組：', publicReply.label);
  if (publicReply.reason) {
    lines.push(`原因：${publicReply.reason}`);
  }

  lines.push(
    '',
    '可複製指令：',
    `- 查詢知識卡 ${card.card_id}`,
    `- 修改知識卡 ${card.card_id}`,
    `- 暫停知識卡 ${card.card_id}`,
    `- 恢復知識卡 ${card.card_id}`
  );

  return lines.join('\n');
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

async function filterRecordsForUser(
  userId: string,
  records: DbKnowledgeCardRecord[]
): Promise<DbKnowledgeCardRecord[]> {
  const isAdmin = await isActiveAdmin(userId);
  return isAdmin ? records : records.filter((record) => record.status === 'active');
}

function formatResultList(params: {
  title: string;
  records: DbKnowledgeCardRecord[];
  emptyMessage: string;
}): string {
  const lines = [params.title, `共 ${params.records.length} 張`, ''];
  if (params.records.length === 0) {
    lines.push(params.emptyMessage);
    return lines.join('\n');
  }
  for (const record of params.records) {
    lines.push(formatHumanReadableKnowledgeCardView(record), '');
  }
  return lines.join('\n').trim();
}

export async function listAllKnowledgeCards(userId: string): Promise<BotReply[]> {
  const blocked = await ensureCanViewKnowledgeCards(userId);
  if (blocked) {
    return blocked;
  }

  const records = await filterRecordsForUser(userId, await getRepos().knowledgeCards.findAll());
  const text = formatResultList({
    title: '【知識卡清單】',
    records,
    emptyMessage: '（目前沒有知識卡）',
  });
  return splitLongText(text).map((chunk) => ({ type: 'push' as const, userId, text: chunk }));
}

export async function listActiveKnowledgeCards(userId: string): Promise<BotReply[]> {
  const blocked = await ensureCanViewKnowledgeCards(userId);
  if (blocked) {
    return blocked;
  }

  const records = await filterRecordsForUser(
    userId,
    await getRepos().knowledgeCards.findByStatus('active')
  );
  const text = formatResultList({
    title: '【active 知識卡】',
    records,
    emptyMessage: '（目前沒有 active 知識卡）',
  });
  return splitLongText(text).map((chunk) => ({ type: 'push' as const, userId, text: chunk }));
}

export async function searchKnowledgeCards(userId: string, query: string): Promise<BotReply[]> {
  const blocked = await ensureCanViewKnowledgeCards(userId);
  if (blocked) {
    return blocked;
  }

  const normalizedQuery = query.trim();
  const exact = await getRepos().knowledgeCards.findById(normalizedQuery);
  const exactVisible = exact ? await filterRecordsForUser(userId, [exact]) : [];
  const ranked =
    exactVisible.length > 0
      ? exactVisible
      : (await filterRecordsForUser(userId, await getRepos().knowledgeCards.findAll()))
          .map((record) => ({
            record,
            score: scoreKnowledgeCardSearchMatch(record, normalizedQuery),
          }))
          .filter((item) => item.score > 0)
          .sort((a, b) => b.score - a.score || a.record.cardId.localeCompare(b.record.cardId))
          .slice(0, 5)
          .map((item) => item.record);

  const text = formatResultList({
    title: `【知識卡查詢：${query}】`,
    records: ranked,
    emptyMessage: '（找不到相關知識卡）',
  });
  return splitLongText(text).map((chunk) => ({ type: 'push' as const, userId, text: chunk }));
}

export function parseViewCommand(text: string): 'all' | 'active' | 'login' | null {
  const trimmed = text.trim();
  if (
    trimmed === '列出所有知識卡' ||
    trimmed === '列出所有知識哪' ||
    trimmed === '列出所有知識' ||
    trimmed === '所有知識卡'
  ) {
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

export function parseKnowledgeSearchQuery(text: string): string | null {
  const trimmed = text.trim();
  const patterns: RegExp[] = [
    /^查詢知識卡[:：]?\s*(.+)$/u,
    /^找跟(.+?)相關的知識卡$/u,
    /^找跟(.+?)有關的卡$/u,
    /^找(.+?)相關知識卡$/u,
    /^搜尋[:：]?\s*(.+)$/u,
    /^有沒有(.+?)的知識卡$/u,
    /^查[:：]?\s*(.+)$/u,
    /^找[:：]?\s*(.+)$/u,
  ];

  for (const pattern of patterns) {
    const match = trimmed.match(pattern);
    if (match?.[1]?.trim()) {
      return match[1].trim();
    }
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
  return searchKnowledgeCards(userId, '登入');
}

export async function handleKnowledgeSearchCommand(
  userId: string,
  query: string
): Promise<BotReply[]> {
  return searchKnowledgeCards(userId, query);
}
