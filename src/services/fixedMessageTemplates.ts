import { getEnv } from '../config/env';

export function buildConsultantDisableFallbackMessage(): string {
  const url = getEnv().OFFICIAL_LINE_URL?.trim();
  if (url) {
    return [
      '不好意思，您的問題我們正在為您安排顧問協助。',
      '如需即時處理，可先聯繫我們的官方客服：',
      `👉 ${url}`,
    ].join('\n');
  }
  return [
    '不好意思，您的問題我們正在為您安排顧問協助。',
    '如需即時處理，可先聯繫我們的官方客服。',
  ].join('\n');
}

export function buildServicePeriodEndedMessage(): string {
  const url = getEnv().OFFICIAL_LINE_URL?.trim();
  if (url) {
    return [
      '感謝您使用教學陪跑服務，30 天教學協助期已結束。',
      '後續如有任何操作問題，歡迎隨時 tag 小助手詢問。',
      '如需更進一步協助，也歡迎加入我們的官方客服 LINE，由客服團隊為您服務：',
      `👉 ${url}`,
    ].join('\n');
  }
  return [
    '感謝您使用教學陪跑服務，30 天教學協助期已結束。',
    '後續如有任何操作問題，歡迎隨時 tag 小助手詢問。',
    '如需更進一步協助，也歡迎聯繫官方客服。',
  ].join('\n');
}
