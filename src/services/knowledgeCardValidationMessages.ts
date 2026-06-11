import { ValidationError } from './knowledgeCardValidator';

const INSUFFICIENT_DRAFT_INPUT =
  '目前內容還不夠明確，請至少補充店家遇到的問題，或您建議的解法。';

const SENSITIVE_RISK_LEVEL_PATTERN = /命中敏感類型/u;

export function formatValidationErrorsForHuman(errors: ValidationError[]): string {
  const llmDisabled = errors.some((e) => e.field === '_llm');
  const inputInsufficient = errors.some((e) => e.field === '_input');
  const sensitiveRiskError = errors.find(
    (e) => e.field === 'risk_level' && SENSITIVE_RISK_LEVEL_PATTERN.test(e.message)
  );
  const hardRedlineError = errors.find(
    (e) => e.field === 'can_public_reply' && /命中硬紅線/u.test(e.message)
  );
  const canPublicReplyError = errors.find((e) => e.field === 'can_public_reply');

  if (sensitiveRiskError || hardRedlineError) {
    return [
      '這張知識卡涉及儲值、金額或帳務相關內容，因此不會設定成小助手自動公開回答。',
      '',
      '我可以先幫您整理成「導入教練參考用知識卡」，讓之後遇到類似問題時提醒導入教練協助確認。',
      '',
      '您可以回覆：',
      '- 修改：...',
      '- 確認送出',
      '- 取消',
    ].join('\n');
  }

  const lines: string[] = [];

  if (llmDisabled) {
    lines.push('AI 草稿整理尚未啟用');
  }
  if (inputInsufficient) {
    lines.push(INSUFFICIENT_DRAFT_INPUT);
  }
  if (canPublicReplyError) {
    lines.push('這張知識卡的小助手公開回答設定與內容風險不一致，請調整內容後再試。');
  }

  for (const err of errors) {
    if (err.field === '_input' || err.field === '_llm') {
      continue;
    }
    if (err.field === 'risk_level' && SENSITIVE_RISK_LEVEL_PATTERN.test(err.message)) {
      continue;
    }
    if (err.field === 'can_public_reply') {
      continue;
    }
    if (err.field === 'patterns') {
      lines.push('請至少提供一個店家可能會問的問題範例。');
    } else if (err.field === 'standard_answer') {
      lines.push('請提供建議的回覆方向或操作步驟。');
    } else if (err.field === 'title') {
      lines.push('請提供知識卡主題。');
    } else if (lines.length === 0) {
      lines.push('草稿內容還需要調整，請修改後再試。');
    }
  }

  if (lines.length === 0) {
    lines.push('草稿內容還需要調整，請修改後再試。');
  }

  return lines.join('\n');
}

export function formatValidationFailureSummary(errors: ValidationError[]): string {
  return formatValidationErrorsForHuman(errors);
}
