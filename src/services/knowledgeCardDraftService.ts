import {
  KNOWLEDGE_CARD_LLM_SYSTEM_PROMPT,
  KnowledgeCard,
} from '../schemas/knowledgeCardSchema';
import { enforceKnowledgeCardRules, ValidationResult } from './knowledgeCardValidator';

export type KnowledgeDraftOperation =
  | 'create'
  | 'supplement'
  | 'modify'
  | 'split'
  | 'merge';

export interface LlmClient {
  complete(systemPrompt: string, userPrompt: string): Promise<string>;
}

export interface SingleCardDraftResult {
  kind: 'single_card';
  operation: 'create' | 'supplement' | 'modify';
  validation: ValidationResult;
  draftJson: string | null;
  reasonText: string | null;
}

export interface SuggestionDraftResult {
  kind: 'suggestion_only';
  operation: 'split' | 'merge';
  text: string;
}

export type KnowledgeDraftResult = SingleCardDraftResult | SuggestionDraftResult;

let llmClient: LlmClient | null = null;

export function setLlmClient(client: LlmClient | null): void {
  llmClient = client;
}

export function getLlmClient(): LlmClient | null {
  return llmClient;
}

function parseJsonOnly(text: string): unknown {
  const trimmed = text.trim();
  const start = trimmed.indexOf('{');
  const end = trimmed.lastIndexOf('}');
  if (start === -1 || end === -1 || end <= start) {
    throw new Error('LLM 輸出不是有效 JSON 物件');
  }
  return JSON.parse(trimmed.slice(start, end + 1));
}

function buildUserPrompt(
  operation: KnowledgeDraftOperation,
  consultantRequest: string,
  existingCard?: KnowledgeCard | null
): string {
  const base = `顧問要求：${consultantRequest}`;
  if (existingCard && (operation === 'modify' || operation === 'supplement')) {
    return `${base}\n\n現有知識卡：\n${JSON.stringify(existingCard, null, 2)}`;
  }
  return base;
}

function buildSplitMergeSuggestion(operation: 'split' | 'merge', consultantRequest: string): string {
  const action = operation === 'split' ? '拆分' : '合併';
  return [
    `【知識卡${action}建議】`,
    `顧問要求：${consultantRequest}`,
    '',
    `建議：請人工審核後再決定是否${action}。`,
    '本操作不提供可直接貼入 knowledge_items.json 的多卡 JSON，以避免手動貼錯。',
    '若需新增或修改單卡，請改用「整理知識卡」或「修改知識卡」指令。',
  ].join('\n');
}

export async function generateKnowledgeCardDraft(params: {
  operation: KnowledgeDraftOperation;
  consultantRequest: string;
  existingCard?: KnowledgeCard | null;
  updatedReason?: string;
}): Promise<KnowledgeDraftResult> {
  const { operation, consultantRequest, existingCard, updatedReason } = params;

  if (operation === 'split' || operation === 'merge') {
    return {
      kind: 'suggestion_only',
      operation,
      text: buildSplitMergeSuggestion(operation, consultantRequest),
    };
  }

  const client = getLlmClient();
  if (!client) {
    return {
      kind: 'single_card',
      operation,
      validation: {
        valid: false,
        errors: [{ field: '_llm', message: 'AI 草稿整理尚未啟用' }],
      },
      draftJson: null,
      reasonText: updatedReason ?? null,
    };
  }

  const userPrompt = buildUserPrompt(operation, consultantRequest, existingCard);
  const rawLlmOutput = await client.complete(KNOWLEDGE_CARD_LLM_SYSTEM_PROMPT, userPrompt);
  let parsed: unknown;
  try {
    parsed = parseJsonOnly(rawLlmOutput);
  } catch (error) {
    return {
      kind: 'single_card',
      operation,
      validation: {
        valid: false,
        errors: [
          {
            field: '_llm',
            message: error instanceof Error ? error.message : 'LLM 輸出解析失敗',
          },
        ],
      },
      draftJson: null,
      reasonText: updatedReason ?? null,
    };
  }

  const validation = enforceKnowledgeCardRules(parsed);
  if (!validation.valid || !validation.normalized) {
    return {
      kind: 'single_card',
      operation,
      validation,
      draftJson: null,
      reasonText: updatedReason ?? null,
    };
  }

  const draftJson = JSON.stringify(validation.normalized, null, 2);
  return {
    kind: 'single_card',
    operation,
    validation,
    draftJson,
    reasonText: updatedReason ?? null,
  };
}

/** 格式化草稿回覆文字；修改原因只寫在文字，不進 JSON */
export function formatDraftReply(result: KnowledgeDraftResult): string {
  if (result.kind === 'suggestion_only') {
    return result.text;
  }

  const lines: string[] = ['【知識卡草稿】', '※ 草稿不會自動生效，請人工貼入 knowledge_items.json 後 commit。'];

  if (result.reasonText) {
    lines.push('', `【修改原因】${result.reasonText}`);
  }

  if (!result.validation.valid || !result.draftJson) {
    lines.push('', '【驗證失敗】');
    const llmDisabled = result.validation.errors.some((e) => e.field === '_llm');
    if (llmDisabled) {
      lines.push('AI 草稿整理尚未啟用');
    }
    for (const err of result.validation.errors) {
      lines.push(`- ${err.field}: ${err.message}`);
    }
    return lines.join('\n');
  }

  lines.push('', '【可直接貼入 JSON 的單卡草稿】', result.draftJson);
  return lines.join('\n');
}

/** 明確禁止自動寫入正式 JSON */
export function assertNoAutoWriteKnowledgeJson(): void {
  // 草稿服務不提供任何寫入 knowledge_items.json 的方法
}
