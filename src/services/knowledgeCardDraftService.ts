import {
  KNOWLEDGE_CARD_LLM_SYSTEM_PROMPT,
  KnowledgeCard,
} from '../schemas/knowledgeCardSchema';
import {
  SourceConsultantInput,
} from '../schemas/knowledgeCardDraftSchema';
import { RiskLevel } from '../types';
import { DmSessionDraftData, PublicReplyPreference } from '../repositories/dmSessionTypes';
import { cardContainsSensitiveContent, enforceKnowledgeCardRules, ValidationResult } from './knowledgeCardValidator';
import { formatValidationErrorsForHuman } from './knowledgeCardValidationMessages';
import { KnowledgeDraftMode } from './knowledgeCardDraftModeService';
import { isPlaceholderCardId, PENDING_CARD_ID, formatCardDisplayId } from './knowledgeCardIdService';
import {
  applyPublicReplyPreference,
  describeAppliedPublicReplyState,
  resolveEffectivePublicReplyPreference,
} from './knowledgeCardPublicReplyService';

export type KnowledgeDraftOperation =
  | 'create'
  | 'supplement'
  | 'modify'
  | 'split'
  | 'merge';

export interface LlmClient {
  complete(systemPrompt: string, userPrompt: string): Promise<string>;
}

export interface SingleCardDraftResult {
  kind: 'single_card';
  operation: 'create' | 'supplement' | 'modify';
  validation: ValidationResult;
  draftJson: string | null;
  reasonText: string | null;
  attemptedCard?: KnowledgeCard | null;
}

export interface SuggestionDraftResult {
  kind: 'suggestion_only';
  operation: 'split' | 'merge';
  text: string;
}

export type KnowledgeDraftResult = SingleCardDraftResult | SuggestionDraftResult;

let llmClient: LlmClient | null = null;

export function setLlmClient(client: LlmClient | null): void {
  llmClient = client;
}

export function getLlmClient(): LlmClient | null {
  return llmClient;
}

function parseJsonOnly(text: string): unknown {
  const trimmed = text.trim();
  const start = trimmed.indexOf('{');
  const end = trimmed.lastIndexOf('}');
  if (start === -1 || end === -1 || end <= start) {
    throw new Error('LLM 輸出不是有效 JSON 物件');
  }
  return JSON.parse(trimmed.slice(start, end + 1));
}

function buildUserPrompt(
  operation: KnowledgeDraftOperation,
  consultantRequest: string,
  existingCard?: KnowledgeCard | null,
  draftMode?: KnowledgeDraftMode
): string {
  const base = `顧問要求：${consultantRequest}`;
  const modeHint =
    draftMode === 'update'
      ? '這是修改既有知識卡，請保留 card_id 不變，並保留 standard_answer 的段落與換行。'
      : '這是新增知識卡，card_id 請填 "__pending__"。';
  if (existingCard && (operation === 'modify' || operation === 'supplement' || draftMode === 'update')) {
    return `${base}\n\n${modeHint}\n\n現有知識卡：\n${JSON.stringify(existingCard, null, 2)}`;
  }
  return `${base}\n\n${modeHint}`;
}

export interface DraftSessionContext {
  draftMode?: KnowledgeDraftMode;
  targetCardId?: string;
  targetCardTitle?: string;
  publicReplyPreference?: PublicReplyPreference;
  isAdmin?: boolean;
}

export function postProcessDraftCard(
  card: KnowledgeCard,
  context: DraftSessionContext
): KnowledgeCard {
  let processed: KnowledgeCard = { ...card };

  if (context.draftMode === 'update' && context.targetCardId) {
    processed.card_id = context.targetCardId;
  } else if (context.draftMode !== 'update' && isPlaceholderCardId(processed.card_id)) {
    processed.card_id = PENDING_CARD_ID;
  }

  const effectivePreference = resolveEffectivePublicReplyPreference({
    preference: context.publicReplyPreference,
    isAdmin: context.isAdmin ?? false,
  });
  processed = applyPublicReplyPreference(processed, effectivePreference);

  return processed;
}

function buildSplitMergeSuggestion(operation: 'split' | 'merge', consultantRequest: string): string {
  const action = operation === 'split' ? '拆分' : '合併';
  return [
    `【知識卡${action}建議】`,
    `顧問要求：${consultantRequest}`,
    '',
    `建議：請人工審核後再決定是否${action}。`,
    '本操作不提供可直接貼入 knowledge_items.json 的多卡 JSON，以避免手動貼錯。',
    '若需新增或修改單卡，請改用「整理知識卡」或「修改知識卡」指令。',
  ].join('\n');
}

function cleanInputLine(line: string): string {
  return line
    .replace(/^[\s\-*•、，,。.:：]+/u, '')
    .replace(/^\d+[.)、]\s*/u, '')
    .trim();
}

function extractLinesAfterLabel(text: string, labelPattern: RegExp): string[] {
  const lines = text
    .split(/\r?\n/u)
    .map(cleanInputLine)
    .filter(Boolean);
  const result: string[] = [];
  let collecting = false;

  for (const line of lines) {
    if (labelPattern.test(line)) {
      collecting = true;
      continue;
    }
    if (collecting && /(我的回覆|建議回覆|回答|解法|適用|不適用|導入|教練)/u.test(line)) {
      break;
    }
    if (collecting) {
      result.push(line);
    }
  }

  return result;
}

function inferPatternsFromRequest(text: string): string[] {
  const explicitQuestions = extractLinesAfterLabel(text, /(店家問題|店家常問|可能會問|問題範例)/u);
  const candidates = explicitQuestions.length > 0
    ? explicitQuestions
    : text
        .split(/\r?\n/u)
        .map(cleanInputLine)
        .filter((line) => hasProblemClue(line));

  return [...new Set(candidates)]
    .filter((line) => !/(我的回覆|建議回覆|回答|解法|適用|不適用|導入|教練)/u.test(line))
    .slice(0, 5);
}

function inferTitleFromPatterns(patterns: string[]): string {
  const first = patterns[0]?.replace(/[？?。.!！]/gu, '').trim();
  if (!first) {
    return '操作使用常見問題';
  }
  return `${first}常見問題`;
}

function inferSourceConsultantInput(
  rawCard: Partial<KnowledgeCard>,
  consultantRequest: string
): SourceConsultantInput {
  if (rawCard.source_consultant_input) {
    return rawCard.source_consultant_input;
  }
  const explicitQuestions = extractLinesAfterLabel(consultantRequest, /(店家問題|店家常問|可能會問|問題範例)/u);
  const explicitReply = extractLinesAfterLabel(consultantRequest, /(建議回覆|我的回覆|回答|解法)/u).join('\n');
  const customerQuestion =
    explicitQuestions[0] ??
    rawCard.core_question ??
    rawCard.patterns?.[0] ??
    consultantRequest.trim();
  const consultantReply =
    explicitReply ||
    (typeof rawCard.standard_answer === 'string' ? rawCard.standard_answer : consultantRequest.trim());
  return {
    customer_question: customerQuestion.trim(),
    consultant_reply: consultantReply.trim(),
    raw_input: consultantRequest.trim(),
  };
}

function repairDraftCardStructure(
  rawCard: Partial<KnowledgeCard>,
  consultantRequest: string
): Partial<KnowledgeCard> {
  const repaired: Partial<KnowledgeCard> = { ...rawCard };
  const patterns = Array.isArray(repaired.patterns)
    ? repaired.patterns.filter((pattern): pattern is string => typeof pattern === 'string' && pattern.trim() !== '')
    : [];

  if (patterns.length === 0) {
    repaired.patterns = inferPatternsFromRequest(consultantRequest);
  }

  if (typeof repaired.core_question !== 'string' || repaired.core_question.trim() === '') {
    repaired.core_question = repaired.patterns?.[0] ?? consultantRequest.trim();
  }

  if (typeof repaired.title !== 'string' || repaired.title.trim() === '') {
    repaired.title = inferTitleFromPatterns(repaired.patterns ?? []);
  }

  if (!Array.isArray(repaired.match_features)) {
    repaired.match_features = [];
  }
  if (!Array.isArray(repaired.applicability_rules)) {
    repaired.applicability_rules = [];
  }
  if (!Array.isArray(repaired.exclusion_rules)) {
    repaired.exclusion_rules = [];
  }
  if (!Array.isArray(repaired.handoff_conditions)) {
    repaired.handoff_conditions = [];
  }
  if (repaired.reasoning === undefined) {
    repaired.reasoning = null;
  }

  repaired.source_consultant_input = inferSourceConsultantInput(repaired, consultantRequest);

  if (!Array.isArray(repaired.not_applicable)) {
    repaired.not_applicable = [];
  }

  if (!Array.isArray(repaired.escalate_to_consultant)) {
    repaired.escalate_to_consultant = [];
  }

  if (repaired.not_applicable.length === 0) {
    repaired.not_applicable = ['店家畫面或流程與草稿步驟不一致時，不適用直接照此回覆。'];
  }

  if (repaired.escalate_to_consultant.length === 0) {
    repaired.escalate_to_consultant = ['店家仍找不到設定入口、畫面異常，或涉及金額/帳務/權限時，請導入教練協助確認。'];
  }

  if (typeof repaired.status !== 'string' || repaired.status.trim() === '') {
    repaired.status = '可用';
  }

  if (typeof repaired.card_id !== 'string' || repaired.card_id.trim() === '') {
    repaired.card_id = PENDING_CARD_ID;
  }

  return repaired;
}

export async function generateKnowledgeCardDraft(params: {
  operation: KnowledgeDraftOperation;
  consultantRequest: string;
  existingCard?: KnowledgeCard | null;
  updatedReason?: string;
  sessionContext?: DraftSessionContext;
}): Promise<KnowledgeDraftResult> {
  const { operation, consultantRequest, existingCard, updatedReason, sessionContext } = params;

  if (operation === 'split' || operation === 'merge') {
    return {
      kind: 'suggestion_only',
      operation,
      text: buildSplitMergeSuggestion(operation, consultantRequest),
    };
  }

  if (operation === 'create') {
    const payload = extractOrganizePayloadFromText(consultantRequest);
    if (!hasMinimumDraftInput(payload)) {
      return {
        kind: 'single_card',
        operation,
        validation: {
          valid: false,
          errors: [{ field: '_input', message: INSUFFICIENT_DRAFT_INPUT_MESSAGE }],
        },
        draftJson: null,
        reasonText: updatedReason ?? null,
      };
    }
  }

  const client = getLlmClient();
  if (!client) {
    return {
      kind: 'single_card',
      operation,
      validation: {
        valid: false,
        errors: [{ field: '_llm', message: 'AI 草稿整理尚未啟用' }],
      },
      draftJson: null,
      reasonText: updatedReason ?? null,
    };
  }

  const userPrompt = buildUserPrompt(
    operation,
    consultantRequest,
    existingCard,
    sessionContext?.draftMode
  );
  const rawLlmOutput = await client.complete(KNOWLEDGE_CARD_LLM_SYSTEM_PROMPT, userPrompt);
  let parsed: unknown;
  try {
    parsed = parseJsonOnly(rawLlmOutput);
  } catch (error) {
    return {
      kind: 'single_card',
      operation,
      validation: {
        valid: false,
        errors: [
          {
            field: '_llm',
            message: error instanceof Error ? error.message : 'LLM 輸出解析失敗',
          },
        ],
      },
      draftJson: null,
      reasonText: updatedReason ?? null,
    };
  }

  const attemptedCard =
    typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)
      ? postProcessDraftCard(
          repairDraftCardStructure(parsed as Partial<KnowledgeCard>, consultantRequest) as KnowledgeCard,
          sessionContext ?? {}
        )
      : null;
  const validation = enforceKnowledgeCardRules(attemptedCard ?? parsed);
  if (!validation.valid || !validation.normalized) {
    return {
      kind: 'single_card',
      operation,
      validation,
      draftJson: attemptedCard ? JSON.stringify(attemptedCard, null, 2) : null,
      reasonText: updatedReason ?? null,
      attemptedCard,
    };
  }

  const normalized = postProcessDraftCard(validation.normalized, sessionContext ?? {});
  const finalValidation = enforceKnowledgeCardRules(normalized);
  if (!finalValidation.valid || !finalValidation.normalized) {
    return {
      kind: 'single_card',
      operation,
      validation: finalValidation,
      draftJson: JSON.stringify(normalized, null, 2),
      reasonText: updatedReason ?? null,
      attemptedCard: normalized,
    };
  }

  const draftJson = JSON.stringify(finalValidation.normalized, null, 2);
  return {
    kind: 'single_card',
    operation,
    validation: finalValidation,
    draftJson,
    reasonText: updatedReason ?? null,
  };
}

/** 格式化草稿回覆文字；修改原因只寫在文字，不進 JSON */
export function describeAutoPublicReply(card: KnowledgeCard): string {
  if (card.can_public_reply) {
    return '是';
  }
  const sensitive = cardContainsSensitiveContent(card);
  if (sensitive.some((category) => category === '帳務' || category === '金流')) {
    return '否，這張卡涉及儲值 / 金額 / 帳務相關情境，僅作為導入教練參考。';
  }
  if (card.risk_level !== RiskLevel.LOW) {
    return '否，這張卡不會設定成小助手自動公開回答，僅作為導入教練參考。';
  }
  return '否，這張卡不會設定成小助手自動公開回答，僅作為導入教練參考。';
}

export const NO_ACTIVE_DRAFT_SESSION_MESSAGE =
  '目前沒有進行中的知識卡草稿。若要重新開始，請輸入「幫我整理知識卡」。';

export function formatDraftActionHints(isAdmin: boolean): string {
  const lines = [
    '您可以回覆：',
    '- 補充：...',
    '- 修改：...',
    '- 設為可公開回答',
    '- 設為導入教練參考',
    '- 轉成 JSON',
  ];
  if (isAdmin) {
    lines.push('- 確認更新', '- 取消');
  } else {
    lines.push('- 確認送出', '- 取消');
  }
  return lines.join('\n');
}

export interface HumanReadableDraftOptions {
  isAdmin?: boolean;
  draftMode?: KnowledgeDraftMode;
  targetCardId?: string;
  targetCardTitle?: string;
  publicReplyPreference?: PublicReplyPreference;
}

function buildDraftHeader(options?: HumanReadableDraftOptions): string[] {
  if (options?.draftMode === 'update' && options.targetCardId) {
    const displayId = formatCardDisplayId(options.targetCardId);
    const title = options.targetCardTitle ?? '（未知標題）';
    return [
      '【知識卡草稿｜修改】',
      `將更新既有知識卡：${displayId}｜${title}`,
      '※ 確認更新後會覆蓋這張知識卡。',
    ];
  }
  return ['【知識卡草稿｜新增】', '※ 草稿不會自動生效。'];
}

export function formatHumanReadableKnowledgeCard(
  card: KnowledgeCard,
  options?: HumanReadableDraftOptions
): string {
  const lines: string[] = [
    ...buildDraftHeader(options),
    '',
    '主題：',
    card.title,
    '',
    '核心問題：',
    card.core_question ?? card.title,
    '',
    '店家可能會這樣問：',
    ...card.patterns.map((pattern) => `- ${pattern}`),
    '',
    '建議回覆內容：',
    card.standard_answer,
  ];

  if (card.not_applicable.length > 0) {
    lines.push('', '不適用情況：', ...card.not_applicable.map((item) => `- ${item}`));
  }

  if (card.escalate_to_consultant.length > 0) {
    lines.push(
      '',
      '需要導入教練協助的情況：',
      ...card.escalate_to_consultant.map((item) => `- ${item}`)
    );
  }

  lines.push(
    '',
    describeAppliedPublicReplyState({
      card,
      preference: options?.publicReplyPreference,
      isAdmin: options?.isAdmin ?? false,
    })
  );
  lines.push('', formatDraftActionHints(options?.isAdmin ?? false));
  return lines.join('\n');
}

export function formatDraftJson(card: KnowledgeCard): string {
  return JSON.stringify(card, null, 2);
}

export function extractOrganizePayloadFromText(text: string): string {
  return text
    .replace(/^整理知識卡[:：]\s*/u, '')
    .replace(/^幫我整理知識卡[:：]\s*/u, '')
    .trim();
}

export const INSUFFICIENT_DRAFT_INPUT_MESSAGE =
  '目前內容還不夠明確，請至少補充店家遇到的問題，或您建議的解法。';

const PROBLEM_CLUE_PATTERNS: RegExp[] = [
  /店家問/u,
  /客人遇到/u,
  /顧客遇到/u,
  /登入不了/u,
  /無法操作/u,
  /發票開錯/u,
  /權限不對/u,
  /帳務異常/u,
  /資料不見/u,
  /無法/u,
  /不能/u,
  /不了/u,
  /失敗/u,
  /錯誤/u,
  /異常/u,
  /不對/u,
  /不見/u,
  /[？?]/u,
  /嗎/u,
  /問題/u,
  /怎麼/u,
  /如何/u,
  /為什麼/u,
  /遇到/u,
];

const SOLUTION_CLUE_PATTERNS: RegExp[] = [
  /建議/u,
  /請他/u,
  /請其/u,
  /回覆/u,
  /操作方式/u,
  /先確認/u,
  /到後台/u,
  /聯絡顧問/u,
  /操作步驟/u,
  /步驟/u,
  /做法/u,
  /回答/u,
  /告知/u,
  /指引/u,
  /請店家/u,
  /可以請/u,
];

export function hasProblemClue(text: string): boolean {
  const trimmed = text.trim();
  if (trimmed.length === 0) {
    return false;
  }
  return PROBLEM_CLUE_PATTERNS.some((pattern) => pattern.test(trimmed));
}

export function hasSolutionClue(text: string): boolean {
  const trimmed = text.trim();
  if (trimmed.length === 0) {
    return false;
  }
  return SOLUTION_CLUE_PATTERNS.some((pattern) => pattern.test(trimmed));
}

export function hasMinimumDraftInput(text: string): boolean {
  const trimmed = text.trim();
  if (trimmed.length < 2) {
    return false;
  }
  return hasProblemClue(trimmed) || hasSolutionClue(trimmed);
}

/** 格式化草稿回覆文字；修改原因只寫在文字，不進 JSON */
export function formatDraftReply(
  result: KnowledgeDraftResult,
  options?: {
    isAdmin?: boolean;
    repeatValidationFailure?: boolean;
    draftMode?: KnowledgeDraftMode;
    targetCardId?: string;
    targetCardTitle?: string;
    publicReplyPreference?: PublicReplyPreference;
  }
): string {
  if (result.kind === 'suggestion_only') {
    return result.text;
  }

  const lines: string[] = [];

  if (result.reasonText) {
    lines.push(`【修改原因】${result.reasonText}`, '');
  }

  if (!result.validation.valid || !result.validation.normalized) {
    if (options?.repeatValidationFailure) {
      lines.push(
        '這份草稿仍未通過驗證，我已保留草稿。請再用「修改：…」調整內容，或使用「設為可公開回答／設為導入教練參考」覆核。'
      );
      return lines.join('\n');
    }
    lines.push('【驗證失敗】', formatValidationErrorsForHuman(result.validation.errors));
    return lines.join('\n');
  }

  lines.push(
    formatHumanReadableKnowledgeCard(result.validation.normalized, {
      isAdmin: options?.isAdmin,
      draftMode: options?.draftMode,
      targetCardId: options?.targetCardId,
      targetCardTitle: options?.targetCardTitle,
      publicReplyPreference: options?.publicReplyPreference,
    })
  );
  return lines.join('\n');
}

/** 明確禁止自動寫入正式 JSON */
export function assertNoAutoWriteKnowledgeJson(): void {
  // 草稿服務不提供任何寫入 knowledge_items.json 的方法
}
