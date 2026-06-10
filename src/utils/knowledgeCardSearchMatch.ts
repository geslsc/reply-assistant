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
  return scoreKnowledgeCardSearchMatch(record, query) > 0;
}

export function scoreKnowledgeCardSearchMatch(record: DbKnowledgeCardRecord, query: string): number {
  const q = normalizeKnowledgeSearchText(query);
  if (!q) {
    return 0;
  }
  const normalizedCardId = normalizeKnowledgeSearchText(record.cardId);
  if (normalizedCardId === q) {
    return 100;
  }
  if (normalizedCardId.endsWith(q) && q.length >= 3) {
    return 95;
  }

  const title = normalizeKnowledgeSearchText(record.title);
  if (title === q) {
    return 90;
  }
  if (title.includes(q)) {
    return 80;
  }

  const patternScores = record.patterns.map((pattern) => {
    const normalized = normalizeKnowledgeSearchText(pattern);
    if (normalized === q) {
      return 75;
    }
    return normalized.includes(q) ? 70 : 0;
  });
  const bestPatternScore = Math.max(0, ...patternScores);
  if (bestPatternScore > 0) {
    return bestPatternScore;
  }

  const haystack = normalizeKnowledgeSearchText(
    [
      record.standardAnswer,
      ...record.notApplicable,
      ...record.escalateToConsultant,
    ].join(' ')
  );
  if (haystack.includes(q)) {
    return 45;
  }

  const tokens = queryMatchTokens(q);
  const tokenTargets = [title, ...record.patterns.map(normalizeKnowledgeSearchText)];
  if (
    q.length >= 4 &&
    tokens.length > 1 &&
    tokenTargets.some((target) => tokens.every((token) => target.includes(token)))
  ) {
    return 35;
  }

  return 0;
}
