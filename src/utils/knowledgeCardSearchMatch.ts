import { DbKnowledgeCardRecord } from '../schemas/knowledgeCardDbSchema';

export function normalizeKnowledgeSearchText(text: string): string {
  return text.toLowerCase().replace(/\s+/g, '').trim();
}

function queryMatchTokens(query: string): string[] {
  const q = normalizeKnowledgeSearchText(query);
  if (!q) {
    return [];
  }
  if (q.length <= 2) {
    return [q];
  }
  const mid = Math.ceil(q.length / 2);
  return [q.slice(0, mid), q.slice(mid)].filter(Boolean);
}

export function knowledgeCardMatchesQuery(record: DbKnowledgeCardRecord, query: string): boolean {
  const q = normalizeKnowledgeSearchText(query);
  if (!q) {
    return false;
  }
  const haystack = normalizeKnowledgeSearchText(
    [
      record.title,
      record.standardAnswer,
      ...record.patterns,
      ...record.notApplicable,
      ...record.escalateToConsultant,
    ].join(' ')
  );
  if (haystack.includes(q)) {
    return true;
  }
  const tokens = queryMatchTokens(q);
  return tokens.length > 0 && tokens.every((token) => haystack.includes(token));
}
