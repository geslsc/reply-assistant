import { getEnv } from '../config/env';
import { KnowledgeCard } from '../schemas/knowledgeCardSchema';
import { IssueThread } from '../types';
import { getCardById } from './knowledgeBaseService';
import { getLlmClient } from './knowledgeCardDraftService';
import {
  buildOptionLabel,
  pickConvergenceOptions,
  ScoredCardCandidate,
} from './groupEnhancedCardMatchingService';

export interface ConvergenceOption {
  index: number;
  cardId: string;
  label: string;
}

export interface ConvergenceState {
  candidateCardIds: string[];
  round2Options?: ConvergenceOption[];
  round3Options?: ConvergenceOption[];
}

const CONVERGENCE_CLARIFY_SYSTEM_PROMPT = `你是客立樂教學小助手的釐清問句生成模組。

你只能根據提供的候選知識卡資料，生成給店家的釐清問句。
不可發明功能、操作入口、操作步驟、系統能力、金流、刷卡機或第三方串接資訊。
不可生成公開答案。
不可引用候選卡以外的 card_id 或功能。

請只輸出 JSON：
{
  "intro": string,
  "follow_up_hint": string
}

intro：一句針對模糊問題的引導語
follow_up_hint：有提供選項時，提醒店家可回覆選項編號，或補充更具體描述；沒有選項時，不可提到選項編號，只能請店家補充具體情境。`;

function buildCandidateCatalog(candidates: ScoredCardCandidate[]): string {
  return candidates
    .map(({ card }) => {
      const lines = [
        `- card_id: ${card.card_id}`,
        `  topic: ${card.title}`,
        `  core_question: ${card.core_question ?? card.title}`,
        `  match_features: ${(card.match_features ?? []).join('、') || '（無）'}`,
        `  applicability_rules: ${(card.applicability_rules ?? []).join('、') || '（無）'}`,
        `  exclusion_rules: ${(card.exclusion_rules ?? []).join('、') || '（無）'}`,
        `  risk_level: ${card.risk_level}`,
        `  can_public_reply: ${card.can_public_reply}`,
      ];
      return lines.join('\n');
    })
    .join('\n\n');
}

function parseClarifyJson(raw: string): { intro: string; followUpHint: string } | null {
  const match = raw.match(/\{[\s\S]*\}/);
  if (!match) {
    return null;
  }
  try {
    const parsed = JSON.parse(match[0]) as {
      intro?: string;
      follow_up_hint?: string;
    };
    const intro = parsed.intro?.trim();
    if (!intro) {
      return null;
    }
    return {
      intro,
      followUpHint:
        parsed.follow_up_hint?.trim() ??
        '您也可以直接回覆選項編號，或補充更具體的操作情境。',
    };
  } catch {
    return null;
  }
}

function buildFallbackIntro(round: 1 | 2 | 3): string {
  if (round === 1) {
    return '想先確認一下，您目前是想了解哪個功能或操作方向呢？';
  }
  if (round === 3) {
    return '想再幫您縮小範圍，請看看下面哪一項比較接近您的情況：';
  }
  return '為了更準確協助您，請看看下面哪一項比較接近，或直接補充更具體的描述：';
}

export async function generateConvergenceIntro(params: {
  question: string;
  candidates: ScoredCardCandidate[];
  round: 1 | 2 | 3;
}): Promise<{ intro: string; followUpHint: string }> {
  const hasOptions = params.round !== 1 && params.candidates.length > 0;
  const fallback = {
    intro: buildFallbackIntro(params.round),
    followUpHint: hasOptions
      ? '您也可以直接回覆選項編號，或補充更具體的操作情境。'
      : '請直接補充您想操作的功能、所在畫面，或目前卡住的地方。',
  };

  const llm = getLlmClient();
  if (!llm || !getEnv().OPENAI_API_KEY) {
    return fallback;
  }

  try {
    const raw = await llm.complete(
      CONVERGENCE_CLARIFY_SYSTEM_PROMPT,
      [
        `候選知識卡：\n${buildCandidateCatalog(params.candidates)}`,
        `目前收斂輪次：第 ${params.round} 輪`,
        `店家訊息：\n${params.question}`,
      ].join('\n\n')
    );
    const parsed = parseClarifyJson(raw) ?? fallback;
    if (!hasOptions) {
      return {
        intro: parsed.intro,
        followUpHint: fallback.followUpHint,
      };
    }
    return parsed;
  } catch {
    return fallback;
  }
}

export function buildConvergenceOptions(
  candidates: ScoredCardCandidate[],
  minCount: number,
  maxCount: number
): ConvergenceOption[] {
  return pickConvergenceOptions(candidates, minCount, maxCount).map((item, index) => ({
    index: index + 1,
    cardId: item.card.card_id,
    label: buildOptionLabel(item.card),
  }));
}

export function formatConvergenceOptionsMessage(
  intro: string,
  options: ConvergenceOption[],
  followUpHint: string
): string {
  const lines = [intro, ''];
  for (const option of options) {
    lines.push(`${option.index}. ${option.label}`);
  }
  lines.push('', followUpHint);
  return lines.join('\n');
}

export async function buildRound1ClarifyMessage(params: {
  question: string;
  candidates: ScoredCardCandidate[];
}): Promise<string> {
  const { intro, followUpHint } = await generateConvergenceIntro({
    question: params.question,
    candidates: params.candidates,
    round: 1,
  });
  return [intro, '', followUpHint].join('\n');
}

export async function buildRound2ClarifyMessage(params: {
  question: string;
  candidates: ScoredCardCandidate[];
}): Promise<{ message: string; options: ConvergenceOption[] }> {
  const options = buildConvergenceOptions(params.candidates, 2, 4);
  const optionCandidates = options
    .map((option) => params.candidates.find((item) => item.card.card_id === option.cardId))
    .filter((item): item is ScoredCardCandidate => Boolean(item));
  const { intro, followUpHint } = await generateConvergenceIntro({
    question: params.question,
    candidates: optionCandidates.length > 0 ? optionCandidates : params.candidates,
    round: 2,
  });
  return {
    options,
    message: formatConvergenceOptionsMessage(intro, options, followUpHint),
  };
}

export async function buildRound3ClarifyMessage(params: {
  question: string;
  candidates: ScoredCardCandidate[];
}): Promise<{ message: string; options: ConvergenceOption[] }> {
  const options = buildConvergenceOptions(params.candidates, 2, 3);
  const optionCandidates = options
    .map((option) => params.candidates.find((item) => item.card.card_id === option.cardId))
    .filter((item): item is ScoredCardCandidate => Boolean(item));
  const { intro, followUpHint } = await generateConvergenceIntro({
    question: params.question,
    candidates: optionCandidates.length > 0 ? optionCandidates : params.candidates,
    round: 3,
  });
  return {
    options,
    message: formatConvergenceOptionsMessage(intro, options, followUpHint),
  };
}

export function getConvergenceState(thread: IssueThread | null | undefined): ConvergenceState | null {
  return thread?.convergenceState ?? null;
}

export function resolveOptionCard(options: ConvergenceOption[] | undefined, selection: number): KnowledgeCard | null {
  if (!options) {
    return null;
  }
  const option = options.find((item) => item.index === selection);
  if (!option) {
    return null;
  }
  return getCardById(option.cardId) ?? null;
}
