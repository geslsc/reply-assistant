import { CLOSING_SIGNALS } from '../types';

const NON_SUBSTANTIVE_EXACT = new Set([
  'ok',
  'okay',
  '好的',
  '好',
  '謝謝',
  '谢谢',
  '謝啦',
  '了解',
  '知道了',
  '收到',
  '嗯',
  '恩',
  '喔',
  '哦',
  '嗯嗯',
]);

const EMOJI_ONLY_PATTERN =
  /^[\s\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}\u{FE00}-\u{FE0F}\u{200D}\u{20E3}\u{E0020}-\u{E007F}]+$/u;

export function isEmojiOnlyMessage(text: string): boolean {
  const trimmed = text.trim();
  if (!trimmed) {
    return true;
  }
  return EMOJI_ONLY_PATTERN.test(trimmed);
}

export function isNonSubstantiveCustomerMessage(text: string): boolean {
  const trimmed = text.trim();
  if (!trimmed) {
    return true;
  }
  if (isEmojiOnlyMessage(trimmed)) {
    return true;
  }
  const normalized = trimmed.toLowerCase();
  if (NON_SUBSTANTIVE_EXACT.has(normalized)) {
    return true;
  }
  if (CLOSING_SIGNALS.some((signal) => signal.toLowerCase() === normalized)) {
    return true;
  }
  return false;
}

export function hasSubstantiveConvergedContent(text: string): boolean {
  const trimmed = text.trim();
  if (trimmed.length < 4) {
    return false;
  }
  if (isNonSubstantiveCustomerMessage(trimmed)) {
    return false;
  }
  const lines = trimmed
    .split(/\n+/)
    .map((line) => line.trim())
    .filter(Boolean);
  if (lines.length === 0) {
    return false;
  }
  return lines.some((line) => !isNonSubstantiveCustomerMessage(line));
}

export function combineBufferMessages(messages: Array<{ text: string }>): string {
  return messages.map((m) => m.text.trim()).filter(Boolean).join('\n');
}
