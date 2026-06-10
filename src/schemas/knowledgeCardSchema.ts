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
新增知識卡時 card_id 一律填 "__pending__"，由系統在確認更新時分配唯一 id。
修改既有知識卡時必須保留現有 card_id 不變。
standard_answer 必須保留換行與段落，適合 LINE 閱讀；步驟請用編號或條列，不要壓成一大段。
你只能整理顧問提供的內容，不要發明產品功能或政策。
你可以根據顧問提供的店家問題與回答方式，推估店家可能會輸入的等價問句 patterns。
若顧問已提供操作步驟，可依內容整理適用、不適用、需導入教練確認的情境；不得新增顧問未提供的產品步驟。
不確定時請在 escalate_to_consultant 標示需要導入教練確認。
請依草稿內容建議 not_applicable 與 escalate_to_consultant 範例；若資訊不足可留空陣列。
一般操作教學（如結帳步驟、儲值卡設定、計次券使用）若未涉及金額/帳務/權限/資料異常，risk_level 可為 low。
真正帳務/金流/權限/資料異常（如金額錯誤、餘額異常、退款、對帳）不得設為 low。
只允許以下 9 欄位：
${JSON.stringify(KNOWLEDGE_CARD_JSON_SCHEMA, null, 2)}
risk_level 只能是 low、mid、high、unknown 之一。
status 只能是「可用」或「暫停」。
命中金流、帳務、權限、資料異常等敏感關鍵字時，risk_level 不得為 low。`;

/** low 風險才可公開回覆；mid / high / unknown 一律 false */
export function deriveCanPublicReply(riskLevel: RiskLevel): boolean {
  return riskLevel === RiskLevel.LOW;
}
