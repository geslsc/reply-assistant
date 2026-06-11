/** 操作教學型關鍵句：命中時不因弱敏感字判定為帳務/金流問題 */
export const OPERATION_TUTORIAL_PATTERNS: RegExp[] = [
  /新增結帳單/u,
  /建立快速結帳單/u,
  /快速結帳單/u,
  /臨時客.*結帳/u,
  /怎麼結帳/u,
  /如何結帳/u,
  /結帳單/u,
  /儲值卡.*設定/u,
  /儲值卡在哪/u,
  /如何建立儲值卡/u,
  /如何新增儲值卡/u,
  /儲值卡設定路徑/u,
  /儲值卡新增/u,
  /儲值卡建立/u,
  /按鈕在哪/u,
  /操作步驟/u,
  /操作教學/u,
  /怎麼操作/u,
  /如何操作/u,
];

/** 儲值卡操作教學：可公開，不因「儲值」二字本身判為硬紅線 */
export const STORED_VALUE_TUTORIAL_PATTERNS: RegExp[] = [
  /如何設定儲值卡/u,
  /怎麼設定儲值卡/u,
  /如何建立儲值卡/u,
  /如何新增儲值卡/u,
  /儲值卡功能在哪/u,
  /儲值卡.*在哪/u,
  /儲值卡操作/u,
  /儲值卡方案/u,
  /儲值卡.*開啟/u,
  /儲值卡.*關閉/u,
  /儲值卡.*入口/u,
  /儲值卡.*頁面/u,
  /儲值卡使用規則/u,
  /儲值卡設定/u,
  /儲值卡新增/u,
  /儲值卡建立/u,
];

/** 儲值 / 金流 / 帳務個案：涉及實際交易或個案資料時命中硬紅線 */
export const STORED_VALUE_BILLING_REDLINE_PATTERNS: RegExp[] = [
  /這筆儲值/u,
  /儲值有沒有成功/u,
  /這筆儲值有沒有入帳/u,
  /儲值.*有沒有入帳/u,
  /儲值.*入帳/u,
  /入帳.*儲值/u,
  /儲值金額/u,
  /儲值紀錄/u,
  /會員儲值/u,
  /儲值.*成功/u,
  /儲值.*失敗/u,
  /查.*儲值紀錄/u,
  /儲值紀錄.*查/u,
  /退款狀態/u,
  /實際交易/u,
  /個案.*儲值/u,
  /儲值.*狀態/u,
  /付款.*入帳/u,
  /查詢.*退款/u,
];

/** 否定語意：整段移除後再判斷，避免「沒有涉及帳務」誤觸發 */
const NEGATION_CONTEXT_PATTERNS: RegExp[] = [
  /沒有涉及帳務[^。；\n]*/gu,
  /並沒有[^。；\n]*涉及帳務[^。；\n]*/gu,
  /不是[^。；\n]*帳務[^。；\n]*/gu,
  /不涉及帳務[^。；\n]*/gu,
  /不是金額異常[^。；\n]*/gu,
  /不是付款問題[^。；\n]*/gu,
  /只是操作教學[^。；\n]*/gu,
  /並沒有真的涉及帳務問題[^。；\n]*/gu,
];

/** 一律視為敏感、不得 low / 公開回答 */
export const HARD_SENSITIVE_KEYWORDS: string[] = [
  '金額錯誤',
  '儲值金額錯誤',
  '儲值金額有誤',
  '餘額異常',
  '扣抵異常',
  '付款失敗',
  '退款',
  '對帳',
  '發票',
  '請款',
  '帳務異常',
  '資料異常',
  '權限問題',
  '同步失敗',
  '資料不一致',
  '資料遺失',
];

/** 操作教學語境下可忽略的弱敏感字（仍會被 HARD 關鍵字攔截） */
const TUTORIAL_EXEMPT_KEYWORDS = new Set([
  '結帳',
  '結帳單',
  '快速結帳單',
  '付款',
  '帳單',
  '帳款',
  '帳務',
  '結算',
  '財務',
  '金流',
  '儲值',
  '儲值卡',
]);

export function removeNegationContexts(text: string): string {
  let result = text;
  for (const pattern of NEGATION_CONTEXT_PATTERNS) {
    result = result.replace(pattern, ' ');
  }
  return result;
}

export function matchesOperationTutorial(text: string): boolean {
  return OPERATION_TUTORIAL_PATTERNS.some((pattern) => pattern.test(text));
}

export function matchesStoredValueTutorial(text: string): boolean {
  if (STORED_VALUE_TUTORIAL_PATTERNS.some((pattern) => pattern.test(text))) {
    return true;
  }
  return matchesOperationTutorial(text) && /儲值卡/u.test(text);
}

function detectStoredValueBillingRedline(text: string): boolean {
  if (STORED_VALUE_BILLING_REDLINE_PATTERNS.some((pattern) => pattern.test(text))) {
    return true;
  }
  if (!/儲值/u.test(text)) {
    return false;
  }
  if (matchesStoredValueTutorial(text)) {
    return false;
  }
  if (/儲值卡/u.test(text)) {
    return false;
  }
  return true;
}

export function containsHardSensitiveKeyword(text: string): boolean {
  const lower = text.toLowerCase();
  return HARD_SENSITIVE_KEYWORDS.some((keyword) => lower.includes(keyword.toLowerCase()));
}

export function isTutorialExemptKeyword(keyword: string): boolean {
  return TUTORIAL_EXEMPT_KEYWORDS.has(keyword);
}

/** 硬紅線：優先於白名單，命中時不得公開回答（「儲值」另依帳務/交易語意判斷） */
export const HARD_REDLINE_KEYWORDS = [
  '帳務',
  '入帳',
  '退款',
  '交易內容',
  '權限',
  '敏感資訊',
] as const;

function containsHardRedlineKeyword(text: string, keyword: string): boolean {
  if (keyword === '入帳') {
    const withoutInputAccount = text.replace(/輸入帳[號戶户]/gu, '');
    return withoutInputAccount.toLowerCase().includes('入帳');
  }
  return text.toLowerCase().includes(keyword.toLowerCase());
}

export function detectHardRedlineCategories(texts: string[]): string[] {
  const combined = texts.join(' ');
  const cleaned = removeNegationContexts(combined);
  const matched: string[] = [];
  for (const keyword of HARD_REDLINE_KEYWORDS) {
    if (containsHardRedlineKeyword(cleaned, keyword)) {
      matched.push(keyword);
    }
  }
  if (detectStoredValueBillingRedline(cleaned)) {
    matched.push('儲值');
  }
  return [...new Set(matched)];
}
