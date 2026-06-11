import { getEnv } from '../config/env';
import { KnowledgeCard } from '../schemas/knowledgeCardSchema';
import { getKnowledgeItems, getCardById } from './knowledgeBaseService';
import { getLlmClient } from './knowledgeCardDraftService';
import {
  canApplySingleCardDirectly,
  enhancedMatchToConfidence,
  isBroadCategoryAmbiguity,
  isVagueGroupQuestion,
  rankEnhancedCardCandidates,
  ScoredCardCandidate,
} from './groupEnhancedCardMatchingService';
import { isQuestionUnclear } from './riskRouter';

export type SemanticConfidence = 'high' | 'medium' | 'low';

export interface SemanticClassification {
  intentClear: boolean;
  cardId: string | null;
  confidence: SemanticConfidence;
  clarifyQuestion: string | null;
  summary: string;
  usedLlm: boolean;
  isChitchat?: boolean;
  candidateCardIds?: string[];
  requiresConvergence?: boolean;
}

const GROUP_ROUTING_SYSTEM_PROMPT = `你是客立樂教學小助手的語意判斷模組。

你要判斷店家這段訊息在問什麼，對應到哪一張知識卡，輸出 card_id 與信心高/中/低。
你要判斷意圖是否清楚到足以挑卡。
你只做挑卡與清晰度判斷，不生成給店家的答案。
看不懂或無對應卡時，誠實回報，不要硬湊一張卡。
若意圖模糊，請產生一句客製釐清問題（針對聽不懂的部分，不可使用固定罐頭）。
你只能依顧問知識庫內容判斷，不可發明產品功能。
若問題只命中大分類（例如只提到預約、設定、會員）而無法唯一對應，intent_clear 必須為 false。

請只輸出 JSON，格式：
{
  "intent_clear": boolean,
  "card_id": string | null,
  "confidence": "high" | "medium" | "low",
  "clarify_question": string | null,
  "summary": string,
  "is_chitchat": boolean
}

若訊息明顯是閒聊、打招呼、與教學操作無關，請設 is_chitchat=true 且 card_id=null。`;

function buildKnowledgeCatalog(): string {
  return getKnowledgeItems()
    .filter((card) => card.status === '可用')
    .map((card) => {
      const lines = [
        `- card_id: ${card.card_id}`,
        `  topic: ${card.title}`,
        `  core_question: ${card.core_question ?? card.title}`,
        `  match_features: ${(card.match_features ?? []).join('、') || '（無）'}`,
        `  applicability_rules: ${(card.applicability_rules ?? []).join('、') || '（無）'}`,
        `  exclusion_rules: ${(card.exclusion_rules ?? []).join('、') || '（無）'}`,
        `  patterns: ${card.patterns.join('、')}`,
        `  risk_level: ${card.risk_level}`,
        `  can_public_reply: ${card.can_public_reply}`,
      ];
      return lines.join('\n');
    })
    .join('\n');
}

function parseClassificationJson(raw: string): SemanticClassification | null {
  const match = raw.match(/\{[\s\S]*\}/);
  if (!match) {
    return null;
  }
  try {
    const parsed = JSON.parse(match[0]) as {
      intent_clear?: boolean;
      card_id?: string | null;
      confidence?: string;
      clarify_question?: string | null;
      summary?: string;
      is_chitchat?: boolean;
    };
    const confidence = parsed.confidence?.toLowerCase();
    if (confidence !== 'high' && confidence !== 'medium' && confidence !== 'low') {
      return null;
    }
    return {
      intentClear: Boolean(parsed.intent_clear),
      cardId: parsed.card_id ?? null,
      confidence,
      clarifyQuestion: parsed.clarify_question ?? null,
      summary: parsed.summary?.trim() || '',
      usedLlm: true,
      isChitchat: Boolean(parsed.is_chitchat),
    };
  } catch {
    return null;
  }
}

function buildEnhancedClassification(
  question: string,
  candidates: ScoredCardCandidate[]
): SemanticClassification {
  const candidateCardIds = candidates.map((item) => item.card.card_id);
  const direct = canApplySingleCardDirectly(candidates, question);
  const requiresConvergence =
    isVagueGroupQuestion(question) && !canApplySingleCardDirectly(candidates, question);

  if (requiresConvergence) {
    return {
      intentClear: false,
      cardId: null,
      confidence: 'low',
      clarifyQuestion: null,
      summary: question,
      usedLlm: false,
      candidateCardIds,
      requiresConvergence: true,
    };
  }

  if (direct) {
    return {
      intentClear: true,
      cardId: direct.card.card_id,
      confidence: enhancedMatchToConfidence(direct, candidates),
      clarifyQuestion: null,
      summary: question,
      usedLlm: false,
      candidateCardIds,
      requiresConvergence: false,
    };
  }

  if (candidates.length === 0) {
    return {
      intentClear: !isQuestionUnclear(question),
      cardId: null,
      confidence: 'low',
      clarifyQuestion: null,
      summary: question,
      usedLlm: false,
      candidateCardIds: [],
      requiresConvergence: false,
    };
  }

  return {
    intentClear: !isVagueGroupQuestion(question) && !isQuestionUnclear(question),
    cardId: null,
    confidence: 'low',
    clarifyQuestion: null,
    summary: question,
    usedLlm: false,
    candidateCardIds,
    requiresConvergence: isVagueGroupQuestion(question),
  };
}

async function reconcileLlmClassification(
  question: string,
  parsed: SemanticClassification
): Promise<SemanticClassification> {
  const candidates = await rankEnhancedCardCandidates(question);
  const candidateCardIds = candidates.map((item) => item.card.card_id);
  const enhanced = buildEnhancedClassification(question, candidates);

  if (parsed.isChitchat) {
    return { ...parsed, candidateCardIds, requiresConvergence: false };
  }

  if (parsed.cardId && !getCardById(parsed.cardId)) {
    return {
      ...parsed,
      cardId: null,
      confidence: 'low',
      intentClear: false,
      candidateCardIds,
      requiresConvergence: true,
    };
  }

  if (enhanced.requiresConvergence) {
    return {
      ...parsed,
      intentClear: false,
      cardId: null,
      confidence: 'low',
      candidateCardIds,
      requiresConvergence: true,
    };
  }

  if (parsed.intentClear && parsed.cardId) {
    const cardAllowed = enhanced.cardId === parsed.cardId || enhanced.intentClear;
    if (!cardAllowed) {
      return {
        ...parsed,
        intentClear: false,
        cardId: null,
        confidence: 'low',
        candidateCardIds,
        requiresConvergence: true,
      };
    }
  }

  return {
    ...parsed,
    candidateCardIds,
    requiresConvergence: enhanced.requiresConvergence,
  };
}

export async function classifyCustomerQuestion(
  question: string,
  _options?: { clarifyRound?: number }
): Promise<SemanticClassification> {
  const llm = getLlmClient();
  if (llm && getEnv().OPENAI_API_KEY) {
    try {
      const raw = await llm.complete(
        GROUP_ROUTING_SYSTEM_PROMPT,
        `知識庫清單：\n${buildKnowledgeCatalog()}\n\n店家訊息：\n${question}`
      );
      const parsed = parseClassificationJson(raw);
      if (parsed) {
        return reconcileLlmClassification(question, parsed);
      }
    } catch {
      // fall through to enhanced routing
    }
  }

  const candidates = await rankEnhancedCardCandidates(question);
  return buildEnhancedClassification(question, candidates);
}

export function resolveCardFromClassification(
  classification: SemanticClassification
): KnowledgeCard | null {
  if (!classification.cardId) {
    return null;
  }
  return getCardById(classification.cardId) ?? null;
}

export async function rankCandidatesForQuestion(question: string): Promise<ScoredCardCandidate[]> {
  return rankEnhancedCardCandidates(question);
}
