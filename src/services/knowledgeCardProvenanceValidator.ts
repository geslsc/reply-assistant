import { ValidationError } from './knowledgeCardValidator';
import { SourceConsultantInput } from '../schemas/knowledgeCardDraftSchema';
import { sourceConsultantInputToText } from './knowledgeCardDraftMappingService';

const INVENTED_CAPABILITY_PATTERNS: RegExp[] = [
  /系統可以/u,
  /系統會自動/u,
  /會自動完成/u,
  /自動同步/u,
  /自動入帳/u,
  /自動退款/u,
  /自動更新/u,
  /自動處理/u,
  /自動設定/u,
  /一定會成功/u,
  /保證可以/u,
  /肯定可以/u,
  /必定/u,
  /支援串接/u,
  /支援刷卡機/u,
  /支援第三方金流/u,
  /支援第三方串接/u,
  /可查詢交易/u,
  /可直接處理/u,
  /可自動退款/u,
];

const UNCONFIRMED_DOMAIN_PATTERNS: RegExp[] = [
  /金流/u,
  /刷卡/u,
  /刷卡機/u,
  /第三方串接/u,
  /第三方整合/u,
  /第三方金流/u,
  /(?<![輸])入帳(?![號戶户])/u,
  /交易狀態/u,
  /交易內容/u,
  /付款完成後/u,
];

const ENTRANCE_ACTION_PATTERNS: RegExp[] = [
  /點選/u,
  /點擊/u,
  /按下/u,
  /進入.{0,12}頁面/u,
  /頁面入口/u,
  /選單/u,
];

const STEP_SEQUENCE_PATTERNS: RegExp[] = [
  /先.{2,60}再.{2,60}/u,
  /先.{2,60}最後/u,
  /第[一二三四1234]+步/u,
  /步驟/u,
  /接著/u,
  /依序/u,
  /完成後/u,
  /點新增/u,
  /按儲存/u,
  /輸入金額/u,
];

const CONSERVATIVE_TO_PROMISE_PATTERNS: Array<{ conservative: RegExp; promise: RegExp }> = [
  { conservative: /需手動/u, promise: /可自動/u },
  { conservative: /需要手動/u, promise: /會自動/u },
  { conservative: /可能需要/u, promise: /一定/u },
  { conservative: /建議/u, promise: /保證/u },
  { conservative: /必要時/u, promise: /系統會自動/u },
];

function normalizeText(text: string): string {
  return text
    .replace(/\s+/g, '')
    .replace(/[>＞]/g, '>')
    .toLowerCase();
}

function containsPattern(text: string, pattern: RegExp): boolean {
  return pattern.test(text);
}

function extractSignificantTokens(text: string): string[] {
  return [...new Set((text.match(/[\u4e00-\u9fffA-Za-z0-9]{2,}/g) ?? []).map((t) => t.trim()))].filter(
    (token) => token.length >= 2
  );
}

function phraseSupportedInSource(phrase: string, sourceText: string): boolean {
  const phraseNorm = normalizeText(phrase);
  const sourceNorm = normalizeText(sourceText);
  if (phraseNorm.length >= 2 && sourceNorm.includes(phraseNorm)) {
    return true;
  }
  const tokens = extractSignificantTokens(phrase);
  if (tokens.length === 0) {
    return true;
  }
  return tokens.every((token) => sourceNorm.includes(normalizeText(token)));
}

function extractMenuPathSegments(answer: string): string[][] {
  const groups: string[][] = [];
  const pathLike = answer.match(
    /(?:到|請到|進入|前往)?[^。\n；]{0,20}(?:[\u4e00-\u9fffA-Za-z0-9]+(?:\s*[>＞]\s*[\u4e00-\u9fffA-Za-z0-9]+)+)/gu
  );
  if (!pathLike) {
    return groups;
  }
  for (const raw of pathLike) {
    const cleaned = raw.replace(/^.*?(?:到|請到|進入|前往)/u, '');
    const segments = cleaned
      .split(/[>＞]/)
      .map((segment) => segment.trim())
      .filter(Boolean);
    if (segments.length >= 2) {
      groups.push(segments);
    }
  }
  return groups;
}

function validateInventedEntrances(
  answer: string,
  sourceText: string,
  errors: ValidationError[]
): void {
  for (const segments of extractMenuPathSegments(answer)) {
    for (const segment of segments) {
      if (!phraseSupportedInSource(segment, sourceText)) {
        errors.push({
          field: 'standard_answer',
          message: 'standard_answer 補充了 source_consultant_input 未提供的入口或選單路徑',
        });
        return;
      }
    }
  }

  for (const pattern of ENTRANCE_ACTION_PATTERNS) {
    if (containsPattern(answer, pattern) && !containsPattern(sourceText, pattern)) {
      errors.push({
        field: 'standard_answer',
        message: 'standard_answer 補充了 source_consultant_input 未提供的入口操作描述',
      });
      return;
    }
  }
}

function validateInventedSteps(
  answer: string,
  sourceText: string,
  errors: ValidationError[]
): void {
  for (const pattern of STEP_SEQUENCE_PATTERNS) {
    const match = answer.match(pattern);
    if (!match) {
      continue;
    }
    if (phraseSupportedInSource(match[0], sourceText)) {
      continue;
    }
    errors.push({
      field: 'standard_answer',
      message: 'standard_answer 補充了 source_consultant_input 未提供的操作步驟',
    });
    return;
  }
}

function validateInventedCapabilities(
  answer: string,
  sourceText: string,
  errors: ValidationError[]
): void {
  for (const pattern of INVENTED_CAPABILITY_PATTERNS) {
    if (containsPattern(answer, pattern) && !containsPattern(sourceText, pattern)) {
      errors.push({
        field: 'standard_answer',
        message: 'standard_answer 補充了 source_consultant_input 未提供的功能能力描述',
      });
      return;
    }
  }
}

function validateUnconfirmedDomains(
  answer: string,
  sourceText: string,
  errors: ValidationError[]
): void {
  for (const pattern of UNCONFIRMED_DOMAIN_PATTERNS) {
    if (containsPattern(answer, pattern) && !containsPattern(sourceText, pattern)) {
      errors.push({
        field: 'standard_answer',
        message: 'standard_answer 補充了未在顧問原文確認的金流/刷卡/第三方/入帳資訊',
      });
      return;
    }
  }
}

function validateConservativeRewrite(
  answer: string,
  sourceText: string,
  errors: ValidationError[]
): void {
  if (/手動/u.test(sourceText) && /自動/u.test(answer) && !/自動/u.test(sourceText)) {
    errors.push({
      field: 'standard_answer',
      message: 'standard_answer 將手動處理改寫成自動能力，超出顧問原文範圍',
    });
    return;
  }

  for (const pair of CONSERVATIVE_TO_PROMISE_PATTERNS) {
    if (containsPattern(sourceText, pair.conservative) && containsPattern(answer, pair.promise)) {
      errors.push({
        field: 'standard_answer',
        message: 'standard_answer 將保守說法改寫成肯定承諾，超出顧問原文範圍',
      });
      return;
    }
  }
}

export function validateStandardAnswerProvenance(
  standardAnswer: string,
  source: SourceConsultantInput | null | undefined
): ValidationError[] {
  const errors: ValidationError[] = [];
  if (!source) {
    errors.push({
      field: 'source_consultant_input',
      message: '缺少 source_consultant_input，無法做溯源檢查',
    });
    return errors;
  }

  const sourceText = sourceConsultantInputToText(source);
  if (!sourceText.trim()) {
    errors.push({
      field: 'source_consultant_input',
      message: 'source_consultant_input 不可為空',
    });
    return errors;
  }

  const answer = standardAnswer.trim();
  const sourceNorm = normalizeText(sourceText);
  const answerNorm = normalizeText(answer);

  validateInventedEntrances(answer, sourceText, errors);
  if (errors.length > 0) {
    return errors;
  }

  validateInventedSteps(answer, sourceText, errors);
  if (errors.length > 0) {
    return errors;
  }

  validateInventedCapabilities(answer, sourceText, errors);
  if (errors.length > 0) {
    return errors;
  }

  validateUnconfirmedDomains(answer, sourceText, errors);
  if (errors.length > 0) {
    return errors;
  }

  validateConservativeRewrite(answer, sourceText, errors);
  if (errors.length > 0) {
    return errors;
  }

  if (/實際帳務/u.test(answer) && !/實際帳務/u.test(sourceText)) {
    errors.push({
      field: 'standard_answer',
      message: 'standard_answer 不可判斷實際帳務狀態',
    });
  }

  if (answerNorm.length > sourceNorm.length * 2 + 120) {
    errors.push({
      field: 'standard_answer',
      message: 'standard_answer 內容超出 source_consultant_input 可合理溯源範圍',
    });
  }

  return errors;
}
