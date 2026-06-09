import {
  deriveCanPublicReply,
  FORBIDDEN_KNOWLEDGE_CARD_FIELDS,
  KNOWLEDGE_CARD_FIELDS,
  KnowledgeCard,
  KnowledgeCardStatus,
} from '../schemas/knowledgeCardSchema';
import { RiskLevel } from '../types';

export interface ValidationError {
  field: string;
  message: string;
}

export interface ValidationResult {
  valid: boolean;
  errors: ValidationError[];
  normalized?: KnowledgeCard;
}

const VALID_RISK_LEVELS = new Set<string>(Object.values(RiskLevel));
const VALID_STATUSES = new Set<KnowledgeCardStatus>(['可用', '暫停']);

import {
  containsHardSensitiveKeyword,
  isTutorialExemptKeyword,
  matchesOperationTutorial,
  removeNegationContexts,
} from './sensitiveContentClassifier';

/** 敏感類型關鍵字：金流、帳務、權限、資料異常 */
export const SENSITIVE_KEYWORD_GROUPS: Record<string, string[]> = {
  金流: ['金流', '付款', '收款', '匯款', '信用卡', '第三方支付', '藍新', '綠界', 'stripe', 'paypal'],
  帳務: ['帳務', '帳款', '對帳', '發票', '退款', '請款', '帳單', '結算', '財務'],
  權限: ['權限', '授權', '角色', '管理員', 'admin', '存取', '開通', '停用帳號'],
  資料異常: [
    '資料異常',
    '同步失敗',
    '同步錯誤',
    '資料不一致',
    '資料遺失',
    '資料錯誤',
    '異常紀錄',
    '錯誤代碼',
  ],
};

/** 僅用於判斷可否 low / 公開回答；不含 not_applicable / escalate_to_consultant */
const RISK_BLOCKING_FIELDS = ['title', 'patterns', 'standard_answer'] as const;

function collectTextFromField(value: unknown): string[] {
  if (typeof value === 'string') {
    return [value];
  }
  if (Array.isArray(value)) {
    return value.filter((v): v is string => typeof v === 'string');
  }
  return [];
}

export function detectSensitiveCategories(texts: string[]): string[] {
  const combined = texts.join(' ');
  const cleaned = removeNegationContexts(combined);

  if (containsHardSensitiveKeyword(cleaned)) {
    const matched: string[] = [];
    for (const [category, keywords] of Object.entries(SENSITIVE_KEYWORD_GROUPS)) {
      if (keywords.some((kw) => cleaned.toLowerCase().includes(kw.toLowerCase()))) {
        matched.push(category);
      }
    }
    if (matched.length === 0) {
      if (/權限/u.test(cleaned)) {
        matched.push('權限');
      } else if (/資料/u.test(cleaned) || /同步/u.test(cleaned)) {
        matched.push('資料異常');
      } else {
        matched.push('帳務');
      }
    }
    return [...new Set(matched)];
  }

  const isTutorial = matchesOperationTutorial(cleaned);
  const lower = cleaned.toLowerCase();
  const matched: string[] = [];

  for (const [category, keywords] of Object.entries(SENSITIVE_KEYWORD_GROUPS)) {
    for (const keyword of keywords) {
      if (!lower.includes(keyword.toLowerCase())) {
        continue;
      }
      if (isTutorial && isTutorialExemptKeyword(keyword)) {
        continue;
      }
      matched.push(category);
      break;
    }
  }

  return [...new Set(matched)];
}

export function cardContainsSensitiveContent(card: Partial<KnowledgeCard>): string[] {
  const texts: string[] = [];
  for (const field of RISK_BLOCKING_FIELDS) {
    texts.push(...collectTextFromField(card[field]));
  }
  return detectSensitiveCategories(texts);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function validateKnowledgeCard(raw: unknown): ValidationResult {
  const errors: ValidationError[] = [];

  if (!isPlainObject(raw)) {
    return { valid: false, errors: [{ field: '_root', message: '必須是 JSON 物件' }] };
  }

  for (const forbidden of FORBIDDEN_KNOWLEDGE_CARD_FIELDS) {
    if (forbidden in raw) {
      errors.push({ field: forbidden, message: `不允許欄位 ${forbidden}` });
    }
  }

  for (const key of Object.keys(raw)) {
    if (!(KNOWLEDGE_CARD_FIELDS as readonly string[]).includes(key)) {
      errors.push({ field: key, message: `不允許額外欄位 ${key}` });
    }
  }

  for (const field of KNOWLEDGE_CARD_FIELDS) {
    if (!(field in raw)) {
      errors.push({ field, message: `缺少必填欄位 ${field}` });
    }
  }

  if (errors.length > 0) {
    return { valid: false, errors };
  }

  const card = raw as Record<string, unknown>;

  if (typeof card.card_id !== 'string' || card.card_id.trim() === '') {
    errors.push({ field: 'card_id', message: 'card_id 必須是非空字串' });
  }
  if (typeof card.title !== 'string' || card.title.trim() === '') {
    errors.push({ field: 'title', message: 'title 必須是非空字串' });
  }
  if (
    !Array.isArray(card.patterns) ||
    card.patterns.length === 0 ||
    !card.patterns.every((p) => typeof p === 'string' && p.trim() !== '')
  ) {
    errors.push({ field: 'patterns', message: 'patterns 必須是非空字串陣列' });
  }
  if (typeof card.standard_answer !== 'string' || card.standard_answer.trim() === '') {
    errors.push({ field: 'standard_answer', message: 'standard_answer 必須是非空字串' });
  }
  if (
    !Array.isArray(card.not_applicable) ||
    !card.not_applicable.every((p) => typeof p === 'string')
  ) {
    errors.push({ field: 'not_applicable', message: 'not_applicable 必須是字串陣列' });
  }
  if (
    !Array.isArray(card.escalate_to_consultant) ||
    !card.escalate_to_consultant.every((p) => typeof p === 'string')
  ) {
    errors.push({
      field: 'escalate_to_consultant',
      message: 'escalate_to_consultant 必須是字串陣列',
    });
  }
  if (typeof card.risk_level !== 'string' || !VALID_RISK_LEVELS.has(card.risk_level)) {
    errors.push({
      field: 'risk_level',
      message: 'risk_level 必須是 low、mid、high、unknown 之一',
    });
  }
  if (typeof card.status !== 'string' || !VALID_STATUSES.has(card.status as KnowledgeCardStatus)) {
    errors.push({ field: 'status', message: 'status 必須是「可用」或「暫停」' });
  }
  if (typeof card.can_public_reply !== 'boolean') {
    errors.push({ field: 'can_public_reply', message: 'can_public_reply 必須是 boolean' });
  }

  if (errors.length > 0) {
    return { valid: false, errors };
  }

  const riskLevel = card.risk_level as RiskLevel;
  const expectedCanPublicReply = deriveCanPublicReply(riskLevel);

  if (card.can_public_reply !== expectedCanPublicReply) {
    errors.push({
      field: 'can_public_reply',
      message: `can_public_reply 必須由 risk_level 推導為 ${expectedCanPublicReply}，不得自行設定`,
    });
  }

  const partial: Partial<KnowledgeCard> = {
    title: card.title as string,
    patterns: card.patterns as string[],
    standard_answer: card.standard_answer as string,
    not_applicable: card.not_applicable as string[],
    escalate_to_consultant: card.escalate_to_consultant as string[],
    risk_level: riskLevel,
  };

  const sensitiveCategories = cardContainsSensitiveContent(partial);
  if (sensitiveCategories.length > 0 && riskLevel === RiskLevel.LOW) {
    errors.push({
      field: 'risk_level',
      message: `命中敏感類型（${sensitiveCategories.join('、')}），risk_level 不得為 low`,
    });
  }

  if (errors.length > 0) {
    return { valid: false, errors };
  }

  const normalized: KnowledgeCard = {
    card_id: (card.card_id as string).trim(),
    title: (card.title as string).trim(),
    patterns: (card.patterns as string[]).map((p) => p.trim()),
    risk_level: riskLevel,
    can_public_reply: expectedCanPublicReply,
    standard_answer: (card.standard_answer as string).trim(),
    not_applicable: (card.not_applicable as string[]).map((p) => p.trim()),
    escalate_to_consultant: (card.escalate_to_consultant as string[]).map((p) => p.trim()),
    status: card.status as KnowledgeCardStatus,
  };

  return { valid: true, errors: [], normalized };
}

/** 正規化並強制覆寫 can_public_reply，供 LLM 輸出後處理 */
export function enforceKnowledgeCardRules(raw: unknown): ValidationResult {
  if (!isPlainObject(raw)) {
    return validateKnowledgeCard(raw);
  }
  const copy = { ...raw } as Record<string, unknown>;
  if (typeof copy.risk_level === 'string' && VALID_RISK_LEVELS.has(copy.risk_level)) {
    copy.can_public_reply = deriveCanPublicReply(copy.risk_level as RiskLevel);
  }
  return validateKnowledgeCard(copy);
}
