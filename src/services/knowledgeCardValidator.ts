import {
  deriveCanPublicReply,
  FORBIDDEN_KNOWLEDGE_CARD_FIELDS,
  KnowledgeCard,
  KnowledgeCardStatus,
} from '../schemas/knowledgeCardSchema';
import { SourceConsultantInput } from '../schemas/knowledgeCardDraftSchema';
import { RiskLevel } from '../types';
import {
  containsHardSensitiveKeyword,
  detectHardRedlineCategories,
  isTutorialExemptKeyword,
  matchesOperationTutorial,
  removeNegationContexts,
} from './sensitiveContentClassifier';
import { validateStandardAnswerProvenance } from './knowledgeCardProvenanceValidator';

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

const LEGACY_REQUIRED_FIELDS = [
  'card_id',
  'title',
  'patterns',
  'risk_level',
  'can_public_reply',
  'standard_answer',
  'not_applicable',
  'escalate_to_consultant',
  'status',
] as const;

const ENHANCED_REQUIRED_FIELDS = ['core_question', 'source_consultant_input'] as const;

const JSONB_STRING_ARRAY_FIELDS = [
  'match_features',
  'applicability_rules',
  'exclusion_rules',
  'handoff_conditions',
] as const;

const RISK_BLOCKING_FIELDS = [
  'title',
  'patterns',
  'standard_answer',
  'core_question',
  'reasoning',
  'match_features',
  'applicability_rules',
  'exclusion_rules',
  'handoff_conditions',
] as const;

/** @deprecated 使用 detectHardRedlineCategories；保留供舊測試 */
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

function collectTextFromField(value: unknown): string[] {
  if (typeof value === 'string') {
    return [value];
  }
  if (Array.isArray(value)) {
    return value.filter((v): v is string => typeof v === 'string');
  }
  if (value && typeof value === 'object') {
    return Object.values(value as Record<string, unknown>)
      .filter((v): v is string => typeof v === 'string');
  }
  return [];
}

export function detectSensitiveCategories(texts: string[]): string[] {
  const hard = detectHardRedlineCategories(texts);
  if (hard.length > 0) {
    return hard;
  }
  return detectSoftSensitiveCategories(texts);
}

export function detectSoftSensitiveCategories(texts: string[]): string[] {
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

function collectCardContentTexts(card: Partial<KnowledgeCard>): string[] {
  const texts: string[] = [];
  for (const field of RISK_BLOCKING_FIELDS) {
    texts.push(...collectTextFromField(card[field as keyof KnowledgeCard]));
  }
  return texts;
}

export function cardContainsSensitiveContent(card: Partial<KnowledgeCard>): string[] {
  return detectSensitiveCategories(collectCardContentTexts(card));
}

export function cardContainsHardRedlineContent(card: Partial<KnowledgeCard>): string[] {
  return detectHardRedlineCategories(collectCardContentTexts(card));
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function validateStringArrayField(
  field: string,
  value: unknown,
  errors: ValidationError[],
  allowEmpty = true
): string[] | null {
  if (value === null || value === undefined) {
    return [];
  }
  if (!Array.isArray(value)) {
    errors.push({ field, message: `${field} 必須是字串陣列` });
    return null;
  }
  if (!value.every((item) => typeof item === 'string')) {
    errors.push({ field, message: `${field} 必須是字串陣列` });
    return null;
  }
  const trimmed = value.map((item) => item.trim());
  if (!allowEmpty && trimmed.length === 0) {
    errors.push({ field, message: `${field} 不可為空陣列` });
  }
  return trimmed;
}

function validateSourceConsultantInput(
  value: unknown,
  errors: ValidationError[]
): SourceConsultantInput | null {
  if (!isPlainObject(value)) {
    errors.push({ field: 'source_consultant_input', message: 'source_consultant_input 必須是物件' });
    return null;
  }
  const customerQuestion = value.customer_question;
  const consultantReply = value.consultant_reply;
  if (typeof customerQuestion !== 'string' || customerQuestion.trim() === '') {
    errors.push({
      field: 'source_consultant_input.customer_question',
      message: 'source_consultant_input.customer_question 必填',
    });
  }
  if (typeof consultantReply !== 'string' || consultantReply.trim() === '') {
    errors.push({
      field: 'source_consultant_input.consultant_reply',
      message: 'source_consultant_input.consultant_reply 必填',
    });
  }
  if (errors.some((e) => e.field.startsWith('source_consultant_input'))) {
    return null;
  }
  return {
    customer_question: (customerQuestion as string).trim(),
    consultant_reply: (consultantReply as string).trim(),
    raw_input:
      typeof value.raw_input === 'string' && value.raw_input.trim() !== ''
        ? value.raw_input.trim()
        : undefined,
  };
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

  for (const field of [...LEGACY_REQUIRED_FIELDS, ...ENHANCED_REQUIRED_FIELDS]) {
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
  if (typeof card.core_question !== 'string' || card.core_question.trim() === '') {
    errors.push({ field: 'core_question', message: 'core_question 必填' });
  }
  if (
    !Array.isArray(card.patterns) ||
    card.patterns.length === 0 ||
    !card.patterns.every((p) => typeof p === 'string' && p.trim() !== '')
  ) {
    errors.push({ field: 'patterns', message: 'patterns 必須是非空字串陣列' });
  }
  if (typeof card.standard_answer !== 'string' || card.standard_answer.trim() === '') {
    errors.push({ field: 'standard_answer', message: 'standard_answer 必填' });
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

  const sourceInput = validateSourceConsultantInput(card.source_consultant_input, errors);
  const matchFeatures = validateStringArrayField('match_features', card.match_features, errors);
  const applicabilityRules = validateStringArrayField(
    'applicability_rules',
    card.applicability_rules,
    errors
  );
  const exclusionRules = validateStringArrayField('exclusion_rules', card.exclusion_rules, errors);
  const handoffConditions = validateStringArrayField(
    'handoff_conditions',
    card.handoff_conditions,
    errors
  );

  if (card.reasoning !== undefined && card.reasoning !== null && typeof card.reasoning !== 'string') {
    errors.push({ field: 'reasoning', message: 'reasoning 必須是字串或 null' });
  }

  if (errors.length > 0) {
    return { valid: false, errors };
  }

  let resolvedRisk = card.risk_level as RiskLevel;
  const partial: Partial<KnowledgeCard> = {
    title: card.title as string,
    patterns: card.patterns as string[],
    standard_answer: card.standard_answer as string,
    core_question: card.core_question as string,
    reasoning: (card.reasoning as string | null | undefined) ?? null,
    match_features: matchFeatures ?? [],
    applicability_rules: applicabilityRules ?? [],
    exclusion_rules: exclusionRules ?? [],
    handoff_conditions: handoffConditions ?? [],
    not_applicable: card.not_applicable as string[],
    escalate_to_consultant: card.escalate_to_consultant as string[],
    risk_level: resolvedRisk,
    source_consultant_input: sourceInput ?? undefined,
  };

  const hardRedlines = cardContainsHardRedlineContent(partial);
  if (hardRedlines.length > 0) {
    if (card.can_public_reply === true) {
      errors.push({
        field: 'can_public_reply',
        message: `命中硬紅線（${hardRedlines.join('、')}），不得公開回答`,
      });
    }
    if (resolvedRisk === RiskLevel.LOW) {
      resolvedRisk = RiskLevel.MID;
    }
  }

  const softCategories = detectSoftSensitiveCategories(collectCardContentTexts(partial));
  if (softCategories.length > 0 && resolvedRisk === RiskLevel.LOW) {
    errors.push({
      field: 'risk_level',
      message: `risk_level 不可為 low（命中 ${softCategories.join('、')}）`,
    });
  }

  const resolvedCanPublic =
    hardRedlines.length > 0 || softCategories.length > 0
      ? false
      : deriveCanPublicReply(resolvedRisk);

  if (card.can_public_reply === true && resolvedCanPublic === false) {
    if (!errors.some((error) => error.field === 'can_public_reply')) {
      errors.push({
        field: 'can_public_reply',
        message: 'can_public_reply 與內容風險不一致，不得公開回答',
      });
    }
  }

  if (card.can_public_reply === true && resolvedRisk !== RiskLevel.LOW) {
    errors.push({
      field: 'can_public_reply',
      message: 'can_public_reply=true 時 risk_level 必須是 low',
    });
  }

  if (
    hardRedlines.length === 0 &&
    softCategories.length === 0 &&
    card.can_public_reply !== resolvedCanPublic
  ) {
    errors.push({
      field: 'can_public_reply',
      message: `can_public_reply 必須由 risk_level 推導為 ${resolvedCanPublic}，不得自行設定`,
    });
  }

  errors.push(...validateStandardAnswerProvenance(card.standard_answer as string, sourceInput));

  if (errors.length > 0) {
    return { valid: false, errors };
  }

  const normalized: KnowledgeCard = {
    card_id: (card.card_id as string).trim(),
    title: (card.title as string).trim(),
    patterns: (card.patterns as string[]).map((p) => p.trim()),
    risk_level: resolvedRisk,
    can_public_reply: resolvedCanPublic,
    standard_answer: (card.standard_answer as string).trim(),
    not_applicable: (card.not_applicable as string[]).map((p) => p.trim()),
    escalate_to_consultant: (card.escalate_to_consultant as string[]).map((p) => p.trim()),
    status: card.status as KnowledgeCardStatus,
    core_question: (card.core_question as string).trim(),
    match_features: matchFeatures ?? [],
    applicability_rules: applicabilityRules ?? [],
    exclusion_rules: exclusionRules ?? [],
    reasoning: typeof card.reasoning === 'string' ? card.reasoning.trim() : null,
    handoff_conditions: handoffConditions ?? [],
    source_consultant_input: sourceInput,
  };

  return { valid: true, errors: [], normalized };
}

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
