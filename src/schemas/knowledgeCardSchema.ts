import { RiskLevel } from '../types';

/** 正式知識卡 9 欄位 schema，人手填與 AI 產出共用 */
export const KNOWLEDGE_CARD_FIELDS = [
  'card_id',
  'title',
  'patterns',
  'risk_level',
  'can_public_reply',
  'standard_answer',
  'not_applicable',
  'escalate_to_consultant',
  'status',
] as const;

export type KnowledgeCardField = (typeof KNOWLEDGE_CARD_FIELDS)[number];

export const FORBIDDEN_KNOWLEDGE_CARD_FIELDS = ['version', 'updated_reason', 'source'] as const;

export type KnowledgeCardStatus = '可用' | '暫停';

export interface KnowledgeCard {
  card_id: string;
  title: string;
  patterns: string[];
  risk_level: RiskLevel;
  can_public_reply: boolean;
  standard_answer: string;
  not_applicable: string[];
  escalate_to_consultant: string[];
  status: KnowledgeCardStatus;
}

export const KNOWLEDGE_CARD_JSON_SCHEMA = {
  card_id: '',
  title: '',
  patterns: [],
  risk_level: '',
  can_public_reply: false,
  standard_answer: '',
  not_applicable: [],
  escalate_to_consultant: [],
  status: '',
} as const;

export const KNOWLEDGE_CARD_LLM_SYSTEM_PROMPT = `你是客立樂教學小助手的知識卡整理助手。
只在顧問明確要求整理知識卡時才回應。
輸出必須是單一 JSON 物件，不得有多餘文字。
不得輸出 version、updated_reason、source 欄位。
不得自行決定 can_public_reply，系統會依 risk_level 推導。
只允許以下 9 欄位：
${JSON.stringify(KNOWLEDGE_CARD_JSON_SCHEMA, null, 2)}
risk_level 只能是 low、mid、high、unknown 之一。
status 只能是「可用」或「暫停」。
命中金流、帳務、權限、資料異常等敏感關鍵字時，risk_level 不得為 low。`;

/** low 風險才可公開回覆；mid / high / unknown 一律 false */
export function deriveCanPublicReply(riskLevel: RiskLevel): boolean {
  return riskLevel === RiskLevel.LOW;
}
