import {
  KnowledgeItem,
  PUBLIC_REPLY_SUFFIX,
  RiskLevel,
  RouteAction,
} from '../types';
import { isOfficialCsCard, matchKnowledgeCard } from './knowledgeBaseService';

const CLARIFY_PROMPT =
  '想再確認一下,您是指哪個步驟遇到問題呢?可以描述一下畫面上看到的狀況嗎?';

export function buildPublicAnswer(standardAnswer: string): string {
  if (standardAnswer.includes(PUBLIC_REPLY_SUFFIX)) {
    return standardAnswer;
  }
  return `${standardAnswer}\n\n${PUBLIC_REPLY_SUFFIX}`;
}

export async function routeQuestion(
  question: string,
  options?: {
    clarifyRound?: number;
    isUnclear?: boolean;
  }
): Promise<RouteAction> {
  const match = await matchKnowledgeCard(question);

  if (match.confidence === 'miss' || !match.card) {
    return { type: 'knowledge_miss', question };
  }

  const card = match.card;

  if (isOfficialCsCard(card)) {
    return { type: 'official_cs', card };
  }

  if (options?.isUnclear || (match.confidence === 'partial' && (options?.clarifyRound ?? 0) < 2)) {
    if ((options?.clarifyRound ?? 0) >= 2) {
      return {
        type: 'handoff',
        card,
        reason: '釐清 2 輪後仍無法收斂',
        riskLevel: card.risk_level,
      };
    }
    return { type: 'clarify', question: CLARIFY_PROMPT };
  }

  return routeByRisk(card, question);
}

export function routeByRisk(card: KnowledgeItem, question: string): RouteAction {
  switch (card.risk_level) {
    case RiskLevel.LOW:
      if (card.can_public_reply) {
        return { type: 'public_answer', card };
      }
      return {
        type: 'handoff',
        card,
        reason: '低風險但不可公開回覆',
        riskLevel: RiskLevel.LOW,
      };
    case RiskLevel.MID:
    case RiskLevel.HIGH:
    case RiskLevel.UNKNOWN:
      return {
        type: 'handoff',
        card,
        reason: `${card.risk_level} 風險需顧問確認`,
        riskLevel: card.risk_level,
      };
    default:
      return { type: 'knowledge_miss', question };
  }
}

export function isQuestionUnclear(question: string): boolean {
  const trimmed = question.trim();
  if (trimmed.length < 4) {
    return true;
  }
  const vaguePatterns = ['怎麼辦', '不行', '有問題', '壞了', '不能用', '???', '？'];
  const hasVague = vaguePatterns.some((p) => trimmed.includes(p));
  const hasSpecific = /如何|怎麼|哪裡|步驟|設定|登入|密碼|訂單|報表/.test(trimmed);
  return hasVague && !hasSpecific;
}
