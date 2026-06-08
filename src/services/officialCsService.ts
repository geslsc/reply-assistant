import { getEnv } from '../config/env';
import { KnowledgeItem } from '../types';

export function buildOfficialCsAnswer(fallback: KnowledgeItem): string {
  const env = getEnv();
  const parts: string[] = [];

  if (
    env.OFFICIAL_CS_NAME ||
    env.OFFICIAL_CS_PHONE ||
    env.OFFICIAL_CS_LINE ||
    env.OFFICIAL_CS_FORM_URL ||
    env.OFFICIAL_CS_SERVICE_HOURS
  ) {
    parts.push('如需官方客服協助,請使用以下方式:');
    if (env.OFFICIAL_CS_NAME) {
      parts.push(`客服名稱:${env.OFFICIAL_CS_NAME}`);
    }
    if (env.OFFICIAL_CS_PHONE) {
      parts.push(`客服專線:${env.OFFICIAL_CS_PHONE}`);
    }
    if (env.OFFICIAL_CS_LINE) {
      parts.push(`LINE 官方帳號:${env.OFFICIAL_CS_LINE}`);
    }
    if (env.OFFICIAL_CS_FORM_URL) {
      parts.push(`客服表單:${env.OFFICIAL_CS_FORM_URL}`);
    }
    if (env.OFFICIAL_CS_SERVICE_HOURS) {
      parts.push(`服務時間:${env.OFFICIAL_CS_SERVICE_HOURS}`);
    }
    return parts.join('\n');
  }

  return fallback.standard_answer;
}
