export function isUnclearVisionText(text: string): boolean {
  const trimmed = text.trim();
  if (trimmed.length === 0) {
    return true;
  }
  return /看不清|無法辨識|無法看清|畫面空白|完全空白|太模糊/u.test(trimmed);
}

export function parseVisionText(visionText: string): {
  customerQuestion: string;
  answerDirection: string;
} {
  const trimmed = visionText.trim();
  const customerMatch = trimmed.match(/店家問題[：:]\s*([^\n]+)/u);
  const answerMatch = trimmed.match(/顧問回覆[：:]\s*([^\n]+)/u);

  if (customerMatch || answerMatch) {
    return {
      customerQuestion: customerMatch?.[1]?.trim() || '（未能明確辨識，請補充說明）',
      answerDirection: answerMatch?.[1]?.trim() || '（未能明確辨識，請補充說明）',
    };
  }

  return {
    customerQuestion: trimmed,
    answerDirection: '（截圖中未明確看到回答方向，請補充說明）',
  };
}

export function buildVisionSummaryMessage(visionText: string): string {
  const { customerQuestion, answerDirection } = parseVisionText(visionText);
  return [
    '【截圖理解摘要】',
    '',
    '我先整理一下我從截圖看到的內容：',
    '',
    '店家想問：',
    customerQuestion,
    '',
    '目前看到的回答方向：',
    answerDirection,
    '',
    '我理解得對嗎？',
    '',
    '您可以直接回覆：',
    '- 對，幫我整理成知識卡',
    '- 補充：...',
    '- 修改：...',
    '- 取消',
  ].join('\n');
}

export const VISION_CONFIRM_PATTERN = /^對[，,]?\s*幫我整理成知識卡$/u;

export function isVisionConfirmPhrase(text: string): boolean {
  return VISION_CONFIRM_PATTERN.test(text.trim());
}

export function isVisionSummaryAdjustPhrase(text: string): boolean {
  return /^補充[:：]/u.test(text.trim()) || /^修改[:：]/u.test(text.trim());
}
