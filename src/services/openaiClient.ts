import { getEnv } from '../config/env';
import { logger } from '../config/logger';
import { LlmClient, setLlmClient } from './knowledgeCardDraftService';

const DEFAULT_MODEL = 'gpt-4o-mini';

export function createOpenAiLlmClient(apiKey: string, model = DEFAULT_MODEL): LlmClient {
  return {
    async complete(systemPrompt: string, userPrompt: string): Promise<string> {
      const response = await fetch('https://api.openai.com/v1/chat/completions', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${apiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          model,
          temperature: 0,
          messages: [
            { role: 'system', content: systemPrompt },
            { role: 'user', content: userPrompt },
          ],
        }),
      });

      if (!response.ok) {
        const body = await response.text();
        throw new Error(`OpenAI API error ${response.status}: ${body}`);
      }

      const data = (await response.json()) as {
        choices?: Array<{ message?: { content?: string } }>;
      };
      const content = data.choices?.[0]?.message?.content;
      if (!content) {
        throw new Error('OpenAI API returned empty content');
      }
      return content;
    },
  };
}

/** 僅注入顧問私訊草稿流程；缺 key 不 throw，production 可正常啟動 */
export function initConsultantDraftAi(): void {
  const apiKey = getEnv().OPENAI_API_KEY;
  if (!apiKey) {
    setLlmClient(null);
    logger.info('OPENAI_API_KEY not set; AI draft assist disabled');
    return;
  }
  setLlmClient(createOpenAiLlmClient(apiKey));
  logger.info('OpenAI client initialized for consultant private draft assist only');
}

export function isAiDraftEnabled(): boolean {
  return Boolean(getEnv().OPENAI_API_KEY);
}
