export enum ConsultantIntent {
  SELF_INTRO = 'SELF_INTRO',
  REQUEST_CUSTOMER_INFO = 'REQUEST_CUSTOMER_INFO',
  PAUSE_ASSISTANT = 'PAUSE_ASSISTANT',
  RESUME_ASSISTANT = 'RESUME_ASSISTANT',
  ORGANIZE_KNOWLEDGE_CARD = 'ORGANIZE_KNOWLEDGE_CARD',
  MODIFY_KNOWLEDGE_CARD = 'MODIFY_KNOWLEDGE_CARD',
  SUMMARIZE_CUSTOMER_QUESTION = 'SUMMARIZE_CUSTOMER_QUESTION',
  PAUSE_KNOWLEDGE_CARD = 'PAUSE_KNOWLEDGE_CARD',
  REPLY_TO_GROUP = 'REPLY_TO_GROUP',
  ENABLE_NANNY_PERIOD = 'ENABLE_NANNY_PERIOD',
  UNKNOWN = 'UNKNOWN',
}

export interface ClassifiedIntent {
  intent: ConsultantIntent;
  /** 原始匹配到的標準語法（若有） */
  matchedStandardPhrase?: string;
  /** 擷取的回覆內容（代回群組等） */
  payload?: string;
  /** 問題短碼（代回群組指定時） */
  shortCode?: string;
}

/** 保母期啟用：只收標準語法，不得自然語法 */
export const NANNY_PERIOD_STANDARD_PHRASES = [
  '小助手啟用保母期 30 天',
  '小助手開始協助 30 天',
] as const;

const STANDARD_PHRASE_MAP: Record<string, ConsultantIntent> = {
  '小助手自我介紹一下': ConsultantIntent.SELF_INTRO,
  '小助手先休息': ConsultantIntent.PAUSE_ASSISTANT,
  '小助手回來': ConsultantIntent.RESUME_ASSISTANT,
  '這篇要改': ConsultantIntent.PAUSE_KNOWLEDGE_CARD,
  '小助手啟用保母期 30 天': ConsultantIntent.ENABLE_NANNY_PERIOD,
  '小助手開始協助 30 天': ConsultantIntent.ENABLE_NANNY_PERIOD,
};

const NATURAL_PATTERNS: Array<{ intent: ConsultantIntent; patterns: RegExp[] }> = [
  {
    intent: ConsultantIntent.SELF_INTRO,
    patterns: [/自我介紹/, /介紹一下小助手/, /跟店家介紹/],
  },
  {
    intent: ConsultantIntent.REQUEST_CUSTOMER_INFO,
    patterns: [/請店家補充/, /請他補充/, /再問一下店家/, /請提供更多資訊/],
  },
  {
    intent: ConsultantIntent.PAUSE_ASSISTANT,
    patterns: [/小助手先休息/, /小助手暫停/, /先讓小助手休息/, /小助手先別回/],
  },
  {
    intent: ConsultantIntent.RESUME_ASSISTANT,
    patterns: [/小助手回來/, /恢復小助手/, /小助手可以回了/, /喚醒小助手/],
  },
  {
    intent: ConsultantIntent.ORGANIZE_KNOWLEDGE_CARD,
    patterns: [/整理知識卡/, /新增知識卡/, /幫我整理.*知識卡/],
  },
  {
    intent: ConsultantIntent.MODIFY_KNOWLEDGE_CARD,
    patterns: [/修改知識卡/, /更新知識卡/, /調整知識卡/],
  },
  {
    intent: ConsultantIntent.SUMMARIZE_CUSTOMER_QUESTION,
    patterns: [/摘要店家問題/, /幫我摘要/, /摘要這題/, /整理問題摘要/],
  },
  {
    intent: ConsultantIntent.PAUSE_KNOWLEDGE_CARD,
    patterns: [/暫停知識卡/, /這張卡先暫停/, /知識卡先下架/],
  },
  {
    intent: ConsultantIntent.REPLY_TO_GROUP,
    patterns: [
      /^回覆這題[:：]?\s*(.+)/,
      /^代回群組[:：]?\s*(.+)/,
      /^幫我回群組[:：]?\s*(.+)/,
      /^(Q-[A-Z0-9-]+)\s+(.+)/,
    ],
  },
];

const SHORT_CODE_PATTERN = /Q-\d{8}-\d{4}-[A-Z0-9]{2}/;

function extractReplyPayload(text: string): { payload?: string; shortCode?: string } {
  const shortCodeMatch = text.match(/^(Q-\d{8}-\d{4}-[A-Z0-9]{2})\s+(.+)/);
  if (shortCodeMatch) {
    return { shortCode: shortCodeMatch[1], payload: shortCodeMatch[2].trim() };
  }
  const prefixMatch = text.match(/^(?:回覆這題|代回群組|幫我回群組)[:：]?\s*(.+)/);
  if (prefixMatch) {
    const body = prefixMatch[1].trim();
    const codeInBody = body.match(/^(Q-\d{8}-\d{4}-[A-Z0-9]{2})\s+(.+)/);
    if (codeInBody) {
      return { shortCode: codeInBody[1], payload: codeInBody[2].trim() };
    }
    return { payload: body };
  }
  if (text.trim() === '回覆這題' || text.trim() === '代回群組') {
    return {};
  }
  return {};
}

export function classifyConsultantIntent(text: string): ClassifiedIntent {
  const trimmed = text.trim();

  if (NANNY_PERIOD_STANDARD_PHRASES.includes(trimmed as (typeof NANNY_PERIOD_STANDARD_PHRASES)[number])) {
    return {
      intent: ConsultantIntent.ENABLE_NANNY_PERIOD,
      matchedStandardPhrase: trimmed,
    };
  }

  const exact = STANDARD_PHRASE_MAP[trimmed];
  if (exact) {
    return { intent: exact, matchedStandardPhrase: trimmed };
  }

  for (const { intent, patterns } of NATURAL_PATTERNS) {
    for (const pattern of patterns) {
      if (pattern.test(trimmed)) {
        if (intent === ConsultantIntent.REPLY_TO_GROUP) {
          const extracted = extractReplyPayload(trimmed);
          return { intent, payload: extracted.payload, shortCode: extracted.shortCode };
        }
        return { intent };
      }
    }
  }

  if (SHORT_CODE_PATTERN.test(trimmed)) {
    const extracted = extractReplyPayload(trimmed);
    if (extracted.shortCode) {
      return {
        intent: ConsultantIntent.REPLY_TO_GROUP,
        shortCode: extracted.shortCode,
        payload: extracted.payload,
      };
    }
  }

  return { intent: ConsultantIntent.UNKNOWN };
}

/** 需二次確認的高副作用意圖 */
export function requiresConfirmation(intent: ConsultantIntent): boolean {
  return (
    intent === ConsultantIntent.PAUSE_KNOWLEDGE_CARD ||
    intent === ConsultantIntent.REPLY_TO_GROUP
  );
}

/** 可直接執行（聽錯也可逆）的意圖 */
export function isDirectExecuteIntent(intent: ConsultantIntent): boolean {
  return [
    ConsultantIntent.SELF_INTRO,
    ConsultantIntent.REQUEST_CUSTOMER_INFO,
    ConsultantIntent.PAUSE_ASSISTANT,
    ConsultantIntent.RESUME_ASSISTANT,
  ].includes(intent);
}

/** 只產草稿、不自動寫入 JSON 的意圖 */
export function isDraftOnlyIntent(intent: ConsultantIntent): boolean {
  return (
    intent === ConsultantIntent.ORGANIZE_KNOWLEDGE_CARD ||
    intent === ConsultantIntent.MODIFY_KNOWLEDGE_CARD
  );
}

/** 需 LLM 輔助、僅限顧問私訊的意圖 */
export function isConsultantPrivateAiIntent(intent: ConsultantIntent): boolean {
  return (
    isDraftOnlyIntent(intent) ||
    intent === ConsultantIntent.SUMMARIZE_CUSTOMER_QUESTION
  );
}

export function isNannyPeriodPhrase(text: string): boolean {
  const trimmed = text.trim();
  return NANNY_PERIOD_STANDARD_PHRASES.includes(
    trimmed as (typeof NANNY_PERIOD_STANDARD_PHRASES)[number]
  );
}

const NANNY_PERIOD_APPROXIMATE_PATTERNS: RegExp[] = [
  /^啟用保母期$/u,
  /^開始保母期$/u,
  /^保母期$/u,
  /^啟用\s*30\s*天$/u,
  /^開始協助$/u,
];

export const NANNY_PERIOD_STANDARD_SYNTAX_HINT = `保母期啟用請使用標準語法：
「小助手啟用保母期 30 天」
或
「小助手開始協助 30 天」`;

export function isNannyPeriodApproximatePhrase(text: string): boolean {
  const trimmed = text.trim();
  if (isNannyPeriodPhrase(trimmed)) {
    return false;
  }
  return NANNY_PERIOD_APPROXIMATE_PATTERNS.some((pattern) => pattern.test(trimmed));
}
