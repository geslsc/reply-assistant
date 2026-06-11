import { getEnv } from '../config/env';
import { getLlmClient } from './knowledgeCardDraftService';

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
];

const PRODUCT_OR_PROBLEM_CLUES: RegExp[] = [
  /怎麼|如何|為什麼|哪裡|步驟|設定|新增|修改|刪除|查詢|預約|結帳|儲值|會員|票券|登入|報表|發票|訂單|錯誤|失敗|異常|不行|不能|找不到|畫面/u,
];

function normalizeText(text: string): string {
  return text.trim().replace(/\s+/g, '');
}

export function isQuestionOpeningMessage(text: string): boolean {
  const trimmed = normalizeText(text);
  if (!trimmed) {
    return false;
  }
  if (PRODUCT_OR_PROBLEM_CLUES.some((pattern) => pattern.test(trimmed))) {
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
  if (PRODUCT_OR_PROBLEM_CLUES.some((pattern) => pattern.test(trimmed))) {
    return false;
  }
  return PURE_CHITCHAT_PATTERNS.some((pattern) => pattern.test(trimmed));
}

function fallbackChitchatReply(text: string): string {
  if (/謝謝|感謝/u.test(text)) {
    return '不客氣🙂 之後有操作問題也可以直接描述給我。';
  }
  if (/辛苦/u.test(text)) {
    return '謝謝你～有操作卡住的地方也可以直接丟給我🙂';
  }
  if (/晚安/u.test(text)) {
    return '晚安🙂 有操作問題時再直接找我就好。';
  }
  if (/早安|午安/u.test(text)) {
    return '嗨嗨，我在這邊🙂 有操作問題可以直接描述給我。';
  }
  return '哈囉～我在這邊🙂 有操作問題可以直接描述給我。';
}

function sanitizeChitchatReply(reply: string, originalText: string): string {
  const firstLine = reply
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter(Boolean)[0];
  if (!firstLine) {
    return fallbackChitchatReply(originalText);
  }
  const trimmed = firstLine.length > 80 ? `${firstLine.slice(0, 77)}...` : firstLine;
  if (/操作問題|操作卡住|問題/u.test(trimmed)) {
    return trimmed;
  }
  return `${trimmed} 有操作問題可以直接描述給我🙂`;
}

export async function buildChitchatReply(text: string): Promise<string> {
  const llm = getLlmClient();
  if (!llm || !getEnv().OPENAI_API_KEY) {
    return fallbackChitchatReply(text);
  }

  try {
    const raw = await llm.complete(
      [
        '你是客立樂教學小助手的閒聊語氣模組。',
        '只能產生一句短回覆，語氣自然、有一點活潑，可以使用最多一個 emoji。',
        '不可回答產品操作、不可猜測問題、不可承諾人工會立刻處理。',
        '句尾要自然提醒店家：有操作問題可以直接描述給我。',
      ].join('\n'),
      `店家閒聊訊息：${text}`
    );
    return sanitizeChitchatReply(raw, text);
  } catch {
    return fallbackChitchatReply(text);
  }
}
