import { getEnv } from '../config/env';
import { KnowledgeCard } from '../schemas/knowledgeCardSchema';
import { getKnowledgeItems, getCardById, matchKnowledgeCard } from './knowledgeBaseService';
import { getLlmClient } from './knowledgeCardDraftService';
import { isQuestionUnclear } from './riskRouter';

export type SemanticConfidence = 'high' | 'medium' | 'low';

export interface SemanticClassification {
  intentClear: boolean;
  cardId: string | null;
  confidence: SemanticConfidence;
  clarifyQuestion: string | null;
  summary: string;
  usedLlm: boolean;
}

const GROUP_ROUTING_SYSTEM_PROMPT = `你是客立樂教學小助手的語意判斷模組。

你要判斷店家這段訊息在問什麼，對應到哪一張知識卡，輸出 card_id 與信心高/中/低。
你要判斷意圖是否清楚到足以挑卡。
你只做挑卡與清晰度判斷，不生成給店家的答案。
看不懂或無對應卡時，誠實回報，不要硬湊一張卡。
若意圖模糊，請產生一句客製釐清問題（針對聽不懂的部分，不可使用固定罐頭）。
你只能依顧問知識庫內容判斷，不可發明產品功能。

請只輸出 JSON，格式：
{
  "intent_clear": boolean,
  "card_id": string | null,
  "confidence": "high" | "medium" | "low",
  "clarify_question": string | null,
  "summary": string
}`;

function buildKnowledgeCatalog(): string {
  return getKnowledgeItems()
    .filter((card) => card.status === '可用')
    .map(
      (card) =>
        `- card_id: ${card.card_id}\n  title: ${card.title}\n  patterns: ${card.patterns.join('、')}`
    )
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
    };
  } catch {
    return null;
  }
}

function buildFallbackClarifyQuestion(text: string, cards: KnowledgeCard[]): string {
  const sampleTitles = cards
    .filter((c) => c.status === '可用' && c.card_id !== 'official-cs-redirect')
    .slice(0, 3)
    .map((c) => c.title.replace(/教學|操作|設定/g, '').trim())
    .filter(Boolean);
  const examples = sampleTitles.length > 0 ? sampleTitles.join('、') : '登入、訂單、會員';
  if (/這個|那個|怎麼用/u.test(text)) {
    return `您是想問哪個功能呢？例如${examples}？`;
  }
  return `想再確認一下，您是指哪個功能或哪個步驟呢？例如${examples}？`;
}

export async function classifyCustomerQuestion(
  question: string,
  options?: { clarifyRound?: number }
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
        if (parsed.cardId && !getCardById(parsed.cardId)) {
          parsed.cardId = null;
          parsed.confidence = 'low';
        }
        return parsed;
      }
    } catch {
      // fall through to keyword routing
    }
  }

  return classifyWithoutLlm(question, options?.clarifyRound ?? 0);
}

async function classifyWithoutLlm(
  question: string,
  clarifyRound: number
): Promise<SemanticClassification> {
  const match = await matchKnowledgeCard(question);
  const unclear = isQuestionUnclear(question);

  if (unclear && clarifyRound < 2) {
    return {
      intentClear: false,
      cardId: match.card?.card_id ?? null,
      confidence: 'low',
      clarifyQuestion: buildFallbackClarifyQuestion(question, getKnowledgeItems()),
      summary: question,
      usedLlm: false,
    };
  }

  if (match.confidence === 'miss' || !match.card) {
    return {
      intentClear: clarifyRound >= 2 ? false : !unclear,
      cardId: null,
      confidence: 'low',
      clarifyQuestion: null,
      summary: question,
      usedLlm: false,
    };
  }

  const confidence: SemanticConfidence =
    match.confidence === 'hit' ? 'high' : match.confidence === 'partial' ? 'medium' : 'low';

  return {
    intentClear: !unclear || match.confidence === 'hit',
    cardId: match.card.card_id,
    confidence,
    clarifyQuestion: null,
    summary: question,
    usedLlm: false,
  };
}

export function resolveCardFromClassification(
  classification: SemanticClassification
): KnowledgeCard | null {
  if (!classification.cardId) {
    return null;
  }
  return getCardById(classification.cardId) ?? null;
}
