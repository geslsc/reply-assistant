import { getEnv } from '../config/env';
import { getLlmClient, LlmClient } from './knowledgeCardDraftService';
import {
  CHITCHAT_REDIRECT_POOL,
  getChitchatRedirectByIndex,
  pickDeterministicChitchatRedirectIndex,
} from './groupReplyCopyService';

const QUESTION_OPENING_PATTERNS: RegExp[] = [
  /我.*(想|要|可以|能不能).*(問|發問|請問).*問題?/u,
  /我.*又.*(有問題|想問|要問)/u,
  /有問題.*(想問|要問|請問)/u,
  /可以問(一下|個問題)?嗎/u,
  /能問(一下|個問題)?嗎/u,
  /想請問(一下)?/u,
  /哈囉.*(想問|發問|請問)/u,
  /小助手.*(在嗎|可以問嗎|能問嗎)/u,
];

const PURE_CHITCHAT_PATTERNS: RegExp[] = [
  /^哈囉[～~!！。]*$/u,
  /^hello[!！。]*$/iu,
  /^hi[!！。]*$/iu,
  /^你好[～~!！。]*$/u,
  /^嗨[～~!！。]*$/u,
  /^(好的)?謝謝[～~!！。]*$/u,
  /^感謝[～~!！。]*$/u,
  /^辛苦了[～~!！。]*$/u,
  /^不客氣[～~!！。]*$/u,
  /^晚安[～~!！。]*$/u,
  /^早安[～~!！。]*$/u,
  /^午安[～~!！。]*$/u,
  /^我好無聊[～~!！。]*$/u,
  /^好無聊[～~!！。]*$/u,
  /^無聊[～~!！。]*$/u,
];

const PRODUCT_OR_OPERATION_CLUES: RegExp[] = [
  /客立樂/u,
  /預約/u,
  /結帳/u,
  /儲值/u,
  /會員/u,
  /票券/u,
  /登入/u,
  /報表/u,
  /發票/u,
  /訂單/u,
  /設定/u,
  /後台/u,
  /按鈕/u,
  /畫面/u,
  /步驟/u,
  /功能/u,
  /怎麼|如何|為什麼|哪裡|哪裡/u,
  /錯誤|失敗|異常|不行|不能|找不到/u,
];

const LLM_FORBIDDEN_CLUES: RegExp[] = [
  ...PRODUCT_OR_OPERATION_CLUES,
  /[？?]/u,
  /請問/u,
  /你可以/u,
  /要不要/u,
  /試試/u,
  /建議/u,
];

function normalizeText(text: string): string {
  return text.trim().replace(/\s+/g, '');
}

function poolOnlyReply(text: string): string {
  return getChitchatRedirectByIndex(pickDeterministicChitchatRedirectIndex(text));
}

function canUseLlm(): boolean {
  return Boolean(getLlmClient() && getEnv().OPENAI_API_KEY);
}

export function hasOperationalQuestionClues(text: string): boolean {
  const trimmed = normalizeText(text);
  if (!trimmed) {
    return false;
  }
  return PRODUCT_OR_OPERATION_CLUES.some((pattern) => pattern.test(trimmed));
}

export function isQuestionOpeningMessage(text: string): boolean {
  const trimmed = normalizeText(text);
  if (!trimmed) {
    return false;
  }
  if (hasOperationalQuestionClues(trimmed)) {
    return false;
  }
  return QUESTION_OPENING_PATTERNS.some((pattern) => pattern.test(trimmed));
}

export function buildQuestionOpeningReply(): string {
  return '可以呀，直接把你遇到的畫面或想操作的功能描述給我，我會幫你判斷🙂';
}

export function isPureChitchatMessage(text: string): boolean {
  const trimmed = normalizeText(text);
  if (!trimmed) {
    return false;
  }
  if (hasOperationalQuestionClues(trimmed)) {
    return false;
  }
  return PURE_CHITCHAT_PATTERNS.some((pattern) => pattern.test(trimmed));
}

function sanitizeLlmOpening(raw: string, round: 1 | 2): string | null {
  const firstLine = raw
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter(Boolean)[0];
  if (!firstLine) {
    return null;
  }
  if (LLM_FORBIDDEN_CLUES.some((pattern) => pattern.test(firstLine))) {
    return null;
  }
  const maxLen = round === 1 ? 24 : 12;
  return firstLine.length > maxLen ? `${firstLine.slice(0, maxLen - 1)}…` : firstLine;
}

function parsePoolIndex(raw: string): number | null {
  const match = raw.match(/\{[\s\S]*\}/);
  if (!match) {
    return null;
  }
  try {
    const parsed = JSON.parse(match[0]) as { index?: number | string };
    const value = Number(parsed.index);
    if (!Number.isInteger(value)) {
      return null;
    }
    if (value < 1 || value > CHITCHAT_REDIRECT_POOL.length) {
      return null;
    }
    return value;
  } catch {
    return null;
  }
}

async function pickChitchatRedirectIndexWithLlm(text: string, llm: LlmClient): Promise<number | null> {
  const raw = await llm.complete(
    [
      '你是客立樂教學小助手的閒聊語氣模組。',
      '你只能從 1-8 選一個 index，代表要接哪一段固定收斂語法池。',
      '不可輸出語法池原文，不可改寫，不可補字。',
      '請只輸出 JSON：{"index": number}',
    ].join('\n'),
    `店家閒聊訊息：${text}`
  );
  return parsePoolIndex(raw);
}

async function buildLlmOpeningWithLlm(
  text: string,
  round: 1 | 2,
  llm: LlmClient
): Promise<string | null> {
  const raw = await llm.complete(
    [
      '你是客立樂教學小助手的閒聊語氣模組。',
      round === 1
        ? '只能產生一句短情緒接話，最多 24 字，可含最多一個 emoji。'
        : '只能產生更短的一句情緒接話，最多 12 字，可含最多一個 emoji。',
      '禁止反問、禁止開新話題。',
      '禁止提到客立樂、禁止提到任何功能名稱、禁止提到設定路徑、禁止提到操作步驟。',
      '只輸出接話本身，不要 JSON。',
    ].join('\n'),
    `店家閒聊訊息：${text}`
  );
  return sanitizeLlmOpening(raw, round);
}

export async function buildChitchatReply(text: string, round: 1 | 2): Promise<string> {
  if (!canUseLlm()) {
    return poolOnlyReply(text);
  }

  const llm = getLlmClient();
  if (!llm) {
    return poolOnlyReply(text);
  }

  try {
    const [opening, poolIndex] = await Promise.all([
      buildLlmOpeningWithLlm(text, round, llm),
      pickChitchatRedirectIndexWithLlm(text, llm),
    ]);
    if (!opening || poolIndex === null) {
      return poolOnlyReply(text);
    }
    return `${opening}\n\n${getChitchatRedirectByIndex(poolIndex)}`;
  } catch {
    return poolOnlyReply(text);
  }
}
