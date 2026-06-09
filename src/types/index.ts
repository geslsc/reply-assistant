/** 固定 5 種狀態，不得新增 */
export enum ThreadState {
  IDLE = 'IDLE',
  AI_CLARIFYING = 'AI_CLARIFYING',
  AI_ANSWERING = 'AI_ANSWERING',
  CONSULTANT_HANDOFF = 'CONSULTANT_HANDOFF',
  OUT_OF_SERVICE_PERIOD = 'OUT_OF_SERVICE_PERIOD',
}

export enum EventType {
  STATE_TRANSITION = 'state_transition',
  AI_ANSWER = 'ai_answer',
  KNOWLEDGE_HIT = 'knowledge_hit',
  KNOWLEDGE_MISS = 'knowledge_miss',
  HANDOFF_TO_CONSULTANT = 'handoff_to_consultant',
  CONSULTANT_OVERRIDE = 'consultant_override',
  CONSULTANT_CORRECTION = 'consultant_correction',
  OFFICIAL_CS_REDIRECT = 'official_cs_redirect',
  UNKNOWN_QUESTION = 'unknown_question',
  CONSULTANT_MUTE = 'consultant_mute',
}

export enum Actor {
  BOT = 'bot',
  CONSULTANT = 'consultant',
  CUSTOMER = 'customer',
  SYSTEM = 'system',
}

export enum RiskLevel {
  LOW = 'low',
  MID = 'mid',
  HIGH = 'high',
  UNKNOWN = 'unknown',
}

export enum ConsultantRole {
  ADMIN = 'admin',
  CONSULTANT = 'consultant',
}

export enum ConsultantStatus {
  ACTIVE = 'active',
  DISABLED = 'disabled',
}

export enum IssueThreadStatus {
  ACTIVE = 'active',
  RESOLVED = 'resolved',
  WAITING = 'waiting',
}

export interface EventLogEntry {
  event_id: string;
  timestamp: string;
  event_type: EventType;
  group_id: string | null;
  issue_thread_id: string | null;
  actor: Actor;
  actor_user_id: string | null;
  risk_level: RiskLevel | null;
  from_state: ThreadState | null;
  to_state: ThreadState | null;
  knowledge_card_id: string | null;
  detail: string | null;
  service_day: number | null;
}

export interface GroupFlags {
  groupId: string;
  groupName: string | null;
  waitingFlag: boolean;
  waitingFlagSetAt: string | null;
  mute: boolean;
  muteUntil: string | null;
  serviceStartAt: string | null;
  serviceEndAt: string | null;
  activeIssueThreadId: string | null;
  serviceReactivationPending: boolean;
  botLeftAt: string | null;
  servicePeriodEndNotified: boolean;
}

export interface IssueThread {
  issueThreadId: string;
  groupId: string;
  state: ThreadState;
  status: IssueThreadStatus;
  createdAt: string;
  updatedAt: string;
  lastStateChangeAt: string;
  clarifyRound: number;
  hasSubstantiveAnswer: boolean;
  consultantAnswered: boolean;
  lastKnowledgeCardId: string | null;
  customerQuestion: string | null;
  autoReplyBlocked?: boolean;
}

export interface ConsultantRecord {
  userId: string;
  role: ConsultantRole;
  status: ConsultantStatus;
  inviteCode: string | null;
  displayName: string | null;
  consultantCode: string | null;
  createdAt: string;
  updatedAt?: string | null;
  approvedBy: string | null;
  approvedAt: string | null;
  disabledBy: string | null;
  disabledAt: string | null;
  lastKnowledgeExportAt?: string | null;
}

/** @deprecated 請改用 KnowledgeCard；保留別名供既有程式過渡 */
export type { KnowledgeCard as KnowledgeItem } from '../schemas/knowledgeCardSchema';
export { deriveCanPublicReply } from '../schemas/knowledgeCardSchema';

export interface CardMatchResult {
  card: import('../schemas/knowledgeCardSchema').KnowledgeCard | null;
  confidence: 'hit' | 'partial' | 'miss';
}

export type RouteAction =
  | { type: 'public_answer'; card: import('../schemas/knowledgeCardSchema').KnowledgeCard }
  | { type: 'clarify'; question: string }
  | {
      type: 'handoff';
      card: import('../schemas/knowledgeCardSchema').KnowledgeCard | null;
      reason: string;
      riskLevel: RiskLevel;
    }
  | { type: 'knowledge_miss'; question: string }
  | { type: 'official_cs'; card: import('../schemas/knowledgeCardSchema').KnowledgeCard }
  | { type: 'no_action' };

export interface BotReply {
  type: 'group' | 'push';
  userId?: string;
  text: string;
  /** 知識卡待審推送：供記錄 bot messageId → reviewId */
  trackReviewId?: string;
}

export interface ProcessResult {
  replies: BotReply[];
  events: EventLogEntry[];
}

export const PUBLIC_REPLY_SUFFIX =
  '如果這步驟和您畫面不一樣,再跟我說,或等顧問確認喔。';

/** 不公開回答時對店家的固定緩衝話術（不可由 LLM 生成） */
export const CUSTOMER_HANDOFF_BUFFER_MESSAGE =
  '您的問題我已經記下並請顧問協助確認，請稍等一下喔。';

export const STANDBY_PHRASES = [
  '有什麼可以協助您的嗎?',
  '有什麼可以協助您的嗎？',
  '有什麼可以協助您嗎?',
  '有什麼可以協助您嗎？',
  '請問有什麼可以協助您的嗎?',
  '請問有什麼可以協助您的嗎？',
];

export const CLOSING_SIGNALS = [
  'OK',
  'ok',
  '👍',
  '👌',
  '✅',
  '您再試看看',
  '有問題再跟我說',
];

export const REOPEN_SIGNALS = ['還是不行', '還是一樣'];

export const TIMEOUT_MS = {
  WAITING_FLAG: 10 * 60 * 1000,
  AI_CLARIFYING: 15 * 60 * 1000,
  AI_ANSWERING: 10 * 60 * 1000,
  CONSULTANT_HANDOFF: 30 * 60 * 1000,
} as const;

export const SERVICE_PERIOD_DAYS = 30;
