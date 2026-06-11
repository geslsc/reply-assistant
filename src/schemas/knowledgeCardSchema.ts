import { RiskLevel } from '../types';
import { SourceConsultantInput } from './knowledgeCardDraftSchema';

/** 正式知識卡 schema，人手填與 AI 產出共用 */
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
  'core_question',
  'match_features',
  'applicability_rules',
  'exclusion_rules',
  'reasoning',
  'handoff_conditions',
  'source_consultant_input',
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
  core_question?: string | null;
  match_features?: string[] | null;
  applicability_rules?: string[] | null;
  exclusion_rules?: string[] | null;
  reasoning?: string | null;
  handoff_conditions?: string[] | null;
  source_consultant_input?: SourceConsultantInput | null;
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
  core_question: '',
  match_features: [],
  applicability_rules: [],
  exclusion_rules: [],
  reasoning: '',
  handoff_conditions: [],
  source_consultant_input: {
    customer_question: '',
    consultant_reply: '',
    raw_input: '',
  },
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
你可以根據顧問提供的店家問題與回答方式，推估 core_question、patterns、match_features、applicability_rules、exclusion_rules、reasoning、handoff_conditions。
必須保留 source_consultant_input（customer_question、consultant_reply、raw_input），不得改寫顧問原文事實。
public_answer_draft 對應 standard_answer；patterns 為店家可能問法。
不得發明功能、步驟、入口；不得補未確認的金流/刷卡/第三方資訊；不得把需手動改寫成可自動；不得把保守說法改成肯定承諾；不得判斷實際帳務狀態。
命中帳務、入帳、儲值、退款、交易內容、權限、敏感資訊等硬紅線時，risk_level 不得為 low，can_public_reply 必須為 false。
只允許以下欄位：
${JSON.stringify(KNOWLEDGE_CARD_JSON_SCHEMA, null, 2)}
risk_level 只能是 low、mid、high、unknown 之一。
status 只能是「可用」或「暫停」。
命中金流、帳務、權限、資料異常等敏感關鍵字時，risk_level 不得為 low。`;

/** low 風險才可公開回覆；mid / high / unknown 一律 false */
export function deriveCanPublicReply(riskLevel: RiskLevel): boolean {
  return riskLevel === RiskLevel.LOW;
}
