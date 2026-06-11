import { KnowledgeCard } from '../schemas/knowledgeCardSchema';
import { RiskLevel } from '../types';
import { getActiveCards, isOfficialCsCard } from './knowledgeBaseService';
import { isQuestionUnclear } from './riskRouter';

export interface ScoredCardCandidate {
  card: KnowledgeCard;
  score: number;
  excluded: boolean;
}

const BROAD_CATEGORY_TERMS = [
  '預約',
  '設定',
  '會員',
  '結帳',
  '登入',
  '票券',
  '儲值',
  '報表',
  '操作',
  '功能',
] as const;

const SPECIFIC_FEATURE_PATTERNS: RegExp[] = [
  /團體課/u,
  /團課/u,
  /計次券/u,
  /儲值卡/u,
  /快速結帳/u,
  /新增預約/u,
  /登入後台/u,
  /忘記密碼/u,
  /匯出報表/u,
  /新增商品/u,
  /票券管理/u,
  /會員管理/u,
  /訂單/u,
];

const NO_NEW_INFO_PATTERNS: RegExp[] = [
  /^不知道$/u,
  /^看不懂$/u,
  /^你幫我看$/u,
  /^都可以$/u,
  /^我也不清楚$/u,
  /^不清楚$/u,
  /^還是不清楚$/u,
  /^随便/u,
  /^隨便/u,
  /^不知道欸$/u,
  /^沒有$/u,
  /^無$/u,
];

function normalize(text: string): string {
  return text.toLowerCase().replace(/\s+/g, '').trim();
}

function extractTokens(text: string): string[] {
  return [...new Set((text.match(/[\u4e00-\u9fff]{2,}|[a-z0-9]{2,}/gi) ?? []).map(normalize))];
}

function textContainsPhrase(text: string, phrase: string): boolean {
  const normText = normalize(text);
  const normPhrase = normalize(phrase);
  if (!normPhrase) {
    return false;
  }
  if (normText.includes(normPhrase)) {
    return true;
  }
  const tokens = extractTokens(phrase);
  return tokens.length > 0 && tokens.every((token) => normText.includes(token));
}

function countTokenOverlap(a: string, b: string): number {
  const tokensA = extractTokens(a);
  const tokensB = extractTokens(b);
  if (tokensA.length === 0 || tokensB.length === 0) {
    return 0;
  }
  return tokensA.filter((token) => tokensB.includes(token)).length;
}

function isExcludedByRules(card: KnowledgeCard, question: string): boolean {
  const rules = [...(card.exclusion_rules ?? []), ...(card.not_applicable ?? [])];
  return rules.some((rule) => textContainsPhrase(question, rule));
}

function applicabilityBoost(card: KnowledgeCard, question: string): number {
  const rules = [...(card.applicability_rules ?? [])];
  if (rules.length === 0) {
    return 0;
  }
  const matched = rules.filter((rule) => textContainsPhrase(question, rule)).length;
  if (matched === 0) {
    return -2;
  }
  return matched * 2;
}

function patternAuxiliaryScore(card: KnowledgeCard, question: string): number {
  const normQ = normalize(question);
  let best = 0;
  for (const pattern of card.patterns) {
    const normPattern = normalize(pattern);
    if (!normPattern) {
      continue;
    }
    if (normQ === normPattern) {
      best = Math.max(best, 12);
      continue;
    }
    if (normQ.includes(normPattern) || normPattern.includes(normQ)) {
      best = Math.max(best, Math.min(Math.max(normPattern.length * 0.5, 4), 10));
    }
  }
  return best;
}

function broadTermAffinityScore(card: KnowledgeCard, question: string): number {
  const normQ = normalize(question);
  const cardText = normalize(
    [
      card.title,
      card.core_question ?? '',
      ...(card.patterns ?? []),
      ...(card.match_features ?? []),
      ...(card.applicability_rules ?? []),
    ].join('')
  );
  let score = 0;
  for (const term of BROAD_CATEGORY_TERMS) {
    const normTerm = normalize(term);
    if (normQ.includes(normTerm) && cardText.includes(normTerm)) {
      score += 5;
    }
  }
  return score;
}

export function scoreCardForQuestion(card: KnowledgeCard, question: string): number {
  if (isOfficialCsCard(card)) {
    return 0;
  }
  if (isExcludedByRules(card, question)) {
    return -1;
  }

  let score = 0;
  const coreQuestion = card.core_question ?? card.title;
  score += countTokenOverlap(question, coreQuestion) * 3;
  if (textContainsPhrase(question, coreQuestion) || textContainsPhrase(coreQuestion, question)) {
    score += 4;
  }

  for (const feature of card.match_features ?? []) {
    if (textContainsPhrase(question, feature)) {
      score += 3;
    }
  }

  score += applicabilityBoost(card, question);
  score += patternAuxiliaryScore(card, question);
  score += broadTermAffinityScore(card, question);

  return Math.max(0, score);
}

export async function rankEnhancedCardCandidates(
  question: string,
  cards?: KnowledgeCard[]
): Promise<ScoredCardCandidate[]> {
  const activeCards = cards ?? (await getActiveCards());
  const ranked = activeCards
    .map((card) => {
      const score = scoreCardForQuestion(card, question);
      return {
        card,
        score,
        excluded: score < 0,
      };
    })
    .filter((item) => !item.excluded && item.score > 0)
    .sort((a, b) => b.score - a.score);

  return ranked;
}

export function hasSpecificFeature(question: string): boolean {
  return SPECIFIC_FEATURE_PATTERNS.some((pattern) => pattern.test(question));
}

export function containsBroadCategoryTerm(question: string): boolean {
  return BROAD_CATEGORY_TERMS.some((term) => question.includes(term));
}

export function isVagueGroupQuestion(question: string): boolean {
  const trimmed = question.trim();
  if (trimmed.length < 4) {
    return true;
  }
  if (/不知道/u.test(trimmed) && !hasSpecificFeature(trimmed)) {
    return true;
  }
  if (/這個|那個|怎麼用/u.test(trimmed) && !hasSpecificFeature(trimmed)) {
    return true;
  }
  if (!isQuestionUnclear(trimmed)) {
    return false;
  }
  return true;
}

export function isBroadCategoryAmbiguity(
  candidates: ScoredCardCandidate[],
  question: string
): boolean {
  if (candidates.length < 2) {
    return false;
  }
  const top = candidates[0]?.score ?? 0;
  const closeCount = candidates.filter(
    (item) => top > 0 && item.score >= top * 0.7
  ).length;
  if (closeCount >= 2 && containsBroadCategoryTerm(question)) {
    return true;
  }
  if (closeCount >= 2 && isVagueGroupQuestion(question)) {
    return true;
  }
  return closeCount >= 2 && top < 12;
}

export function canApplySingleCardDirectly(
  candidates: ScoredCardCandidate[],
  question: string
): ScoredCardCandidate | null {
  if (candidates.length === 0) {
    return null;
  }
  const top = candidates[0];
  const second = candidates[1];
  if (top.score < 6) {
    return null;
  }
  if (isVagueGroupQuestion(question)) {
    return null;
  }
  if (isBroadCategoryAmbiguity(candidates, question)) {
    return null;
  }
  if (second && top.score < second.score * 1.35) {
    return null;
  }
  return top;
}

export function narrowCandidatesWithinPreviousSet(params: {
  followUpText: string;
  previousIds: string[];
  candidates: ScoredCardCandidate[];
}): ScoredCardCandidate[] {
  const allowed = new Set(params.previousIds);
  const filtered = params.candidates.filter((item) => allowed.has(item.card.card_id));
  if (filtered.length === 0) {
    return [];
  }
  const topScore = filtered[0]?.score ?? 0;
  if (topScore <= 0) {
    return [];
  }
  const minScore = Math.max(topScore * 0.65, 6);
  return filtered.filter((item) => item.score >= minScore);
}

export function hasCandidateSetNarrowed(
  previousIds: string[],
  nextIds: string[]
): boolean {
  if (previousIds.length === 0 || nextIds.length === 0) {
    return false;
  }
  if (nextIds.length >= previousIds.length) {
    return false;
  }
  const prevSet = new Set(previousIds);
  return nextIds.every((id) => prevSet.has(id));
}

export function isNoInformationReply(text: string): boolean {
  const trimmed = text.trim();
  if (!trimmed) {
    return true;
  }
  return NO_NEW_INFO_PATTERNS.some((pattern) => pattern.test(trimmed));
}

export function parseOptionSelection(text: string, maxOption: number): number | null {
  const trimmed = text.trim();
  const digitMatch = trimmed.match(/^([1-9]\d*)$/);
  if (digitMatch) {
    const value = Number(digitMatch[1]);
    return value >= 1 && value <= maxOption ? value : null;
  }
  const zhMatch = trimmed.match(/第?([1-9一二三四])[个個項選]?/u);
  if (zhMatch) {
    const map: Record<string, number> = { 一: 1, 二: 2, 三: 3, 四: 4 };
    const raw = zhMatch[1];
    const value = map[raw] ?? Number(raw);
    return value >= 1 && value <= maxOption ? value : null;
  }
  if (/選\s*([1-9])/u.test(trimmed)) {
    const value = Number(trimmed.match(/選\s*([1-9])/u)![1]);
    return value >= 1 && value <= maxOption ? value : null;
  }
  return null;
}

export function buildOptionLabel(card: KnowledgeCard): string {
  return (card.core_question ?? card.title).trim();
}

export function pickConvergenceOptions(
  candidates: ScoredCardCandidate[],
  minCount: number,
  maxCount: number
): ScoredCardCandidate[] {
  const picked = candidates.slice(0, maxCount);
  if (picked.length >= minCount) {
    return picked;
  }
  return picked;
}

export function shouldImmediateHandoffForCard(card: KnowledgeCard): boolean {
  return (
    card.risk_level === RiskLevel.HIGH ||
    card.risk_level === RiskLevel.MID ||
    !card.can_public_reply
  );
}

export function enhancedMatchToConfidence(
  candidate: ScoredCardCandidate | null,
  candidates: ScoredCardCandidate[]
): 'high' | 'medium' | 'low' {
  if (!candidate) {
    return 'low';
  }
  const second = candidates[1];
  if (candidate.score >= 12 && (!second || candidate.score >= second.score * 1.5)) {
    return 'high';
  }
  if (candidate.score >= 8) {
    return 'medium';
  }
  return 'low';
}
