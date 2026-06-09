import {
  containsHardSensitiveKeyword,
  matchesOperationTutorial,
  removeNegationContexts,
} from './sensitiveContentClassifier';
import { detectSensitiveCategories } from './knowledgeCardValidator';

/** 群組高風險關鍵字：命中後不等 debounce，直接 handoff */
export function isHighRiskCustomerMessage(text: string): boolean {
  if (containsHardSensitiveKeyword(text)) {
    return true;
  }

  const cleaned = removeNegationContexts(text);
  const categories = detectSensitiveCategories([cleaned]);
  if (categories.length === 0) {
    return false;
  }

  if (matchesOperationTutorial(text)) {
    return false;
  }

  return true;
}

export function highRiskHandoffReason(text: string): string {
  if (containsHardSensitiveKeyword(text)) {
    return '高風險關鍵字命中，需顧問確認';
  }
  const categories = detectSensitiveCategories([removeNegationContexts(text)]);
  if (categories.length > 0) {
    return `高風險議題（${categories.join('、')}），需顧問確認`;
  }
  return '高風險問題，需顧問確認';
}
